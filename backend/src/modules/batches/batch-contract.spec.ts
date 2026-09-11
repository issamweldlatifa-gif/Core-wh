import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Prisma } from '@prisma/client';
import {
  BatchCreateDto,
  BatchUnitInputDto,
  unitInputViolations,
} from './dto/batch-card.dto';
import { assertBatchTransition, nextBatchStatus, BATCH_STATUSES } from './batch-status';
import {
  BATCH_CODE_RE,
  UNIT_CODE_RE,
  nextBatchCode,
  nextUnitCode,
} from './batch-codes';
import { BATCH_FEATURE_FLAG, flagEnabled, isBatchEnabled } from './batch-feature-flag';
import { BATCH_PERMISSIONS } from './batch-permissions';

async function errors(cls: any, payload: any): Promise<number> {
  const dto = plainToInstance(cls, payload);
  return (await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).length;
}

const UNIT = {
  idempotencyKey: 'item-key-0001',
  identifierType: 'SKU',
  identifierValue: 'SB123',
  originalBarcode: '5901234567890',
  originalSku: 'SB123',
};

describe('Batch Phase 2 — DTO contract', () => {
  const CREATE = {
    idempotencyKey: 'create-key-0001',
    customer: { name: 'Ahmed Akrmi' },
    firstItem: UNIT,
  };

  it('accepts a well-formed create payload (customer + first unit)', async () => {
    expect(await errors(BatchCreateDto, CREATE)).toBe(0);
  });

  it('rejects a create without the idempotency anchor', async () => {
    const bad: any = { ...CREATE };
    delete bad.idempotencyKey;
    expect(await errors(BatchCreateDto, bad)).toBeGreaterThan(0);
  });

  it('rejects an unknown/misspelled identifierType (strict enum)', async () => {
    const bad: any = { ...CREATE, firstItem: { ...UNIT, identifierType: 'SKK' } };
    expect(await errors(BatchCreateDto, bad)).toBeGreaterThan(0);
  });

  it('rejects unknown extra fields (whitelist)', async () => {
    const bad: any = { ...CREATE, cargoWeight: 12 };
    expect(await errors(BatchCreateDto, bad)).toBeGreaterThan(0);
  });

  it('identifierValue is REQUIRED unless MANUAL', () => {
    expect(unitInputViolations({ ...UNIT } as BatchUnitInputDto)).toEqual([]);
    expect(
      unitInputViolations({ idempotencyKey: 'k2', identifierType: 'MANUAL' } as BatchUnitInputDto),
    ).toEqual([]);
    expect(
      unitInputViolations({ idempotencyKey: 'k3', identifierType: 'SKU' } as BatchUnitInputDto).length,
    ).toBe(1);
  });

  it('MANUAL must never invent original identity values (PRODUCT IDENTITY rule)', () => {
    const bad = unitInputViolations({
      idempotencyKey: 'k4',
      identifierType: 'MANUAL',
      originalSku: 'MADE-UP',
    } as BatchUnitInputDto);
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain('must NOT invent');
  });
});

describe('Batch Phase 2 — lifecycle state machine', () => {
  it('walks the full happy path exactly as the implementation command defines it', () => {
    let s = 'CREATED' as any;
    s = assertBatchTransition(s, 'submit');
    expect(s).toBe('SUBMITTED');
    s = assertBatchTransition(s, 'accept');
    expect(s).toBe('ACCEPTED');
    s = assertBatchTransition(s, 'send');
    expect(s).toBe('SENT_TO_RECEIVING');
    s = assertBatchTransition(s, 'startReceiving');
    expect(s).toBe('RECEIVING_IN_PROGRESS');
    s = assertBatchTransition(s, 'completeReceiving');
    expect(s).toBe('RECEIVING_COMPLETED');
    expect(BATCH_STATUSES).toContain(s);
  });

  it('forbids the classic shortcuts (CREATED->ACCEPT, CLOSED re-entry, etc.)', () => {
    expect(nextBatchStatus('CREATED', 'accept')).toBeNull();
    expect(nextBatchStatus('CREATED', 'send')).toBeNull();
    expect(nextBatchStatus('SUBMITTED', 'send')).toBeNull();
    expect(nextBatchStatus('RECEIVING_COMPLETED', 'void')).toBeNull();
    expect(nextBatchStatus('VOIDED', 'submit')).toBeNull();
    expect(() => assertBatchTransition('CREATED', 'completeReceiving' as any)).toThrow(
      /FORBIDDEN_BATCH_TRANSITION/,
    );
  });

  it('VOID is reachable from every non-terminal state (audit-safe, never a delete)', () => {
    for (const st of ['CREATED', 'SUBMITTED', 'ACCEPTED', 'SENT_TO_RECEIVING', 'RECEIVING_IN_PROGRESS']) {
      expect(nextBatchStatus(st as any, 'void')).toBe('VOIDED');
    }
  });
});

describe('Batch Phase 2 — code generators (AYB / AYP)', () => {
  it('formats production and TEST batch codes exactly as the command defines', () => {
    const c = nextBatchCode('2026-09-11', [], false);
    expect(c).toMatch(BATCH_CODE_RE);
    expect(c.startsWith('AYB-20260911-')).toBe(true);
    const t = nextBatchCode('2026-09-11', [], true);
    expect(t.startsWith('AYBTEST-20260911-')).toBe(true);
    expect(t).toMatch(BATCH_CODE_RE);
  });

  it('sequences within the day from the highest existing code (never count-based)', () => {
    const day = '20260911';
    const existing = [`AYB-${day}-00001`, `AYB-${day}-00007`];
    expect(nextBatchCode('2026-09-11', existing)).toBe(`AYB-${day}-00008`);
  });

  it('walks past collisions and starts a fresh daily sequence', () => {
    const day = '20260911';
    const existing = [`AYB-${day}-00001`, `AYB-${day}-00002`];
    const next = nextBatchCode('2026-09-11', [...existing, `AYB-${day}-00003`]);
    expect(next).toBe(`AYB-${day}-00004`);
    expect(nextBatchCode('2026-09-12', existing).endsWith('-00001')).toBe(true);
  });

  it('generates unit identities AYP-NNNNNNNNN (global sequence) + TEST prefix', () => {
    const u = nextUnitCode(['AYP-000000001', 'AYP-000000123'], false);
    expect(u).toBe('AYP-000000124');
    expect(u).toMatch(UNIT_CODE_RE);
    const t = nextUnitCode([], true);
    expect(t.startsWith('AYPTEST-')).toBe(true);
    expect(t).toMatch(UNIT_CODE_RE);
  });
});

describe('Batch Phase 2 — feature flag & permissions', () => {
  it('batch.enabled is OFF by default (absent = OFF) and needs an explicit true', () => {
    expect(isBatchEnabled([])).toBe(false);
    expect(isBatchEnabled([{ key: BATCH_FEATURE_FLAG, value: false }])).toBe(false);
    expect(isBatchEnabled([{ key: BATCH_FEATURE_FLAG, value: 'true' }])).toBe(true);
    expect(flagEnabled('TRUE')).toBe(true);
    expect(flagEnabled(undefined)).toBe(false);
  });

  it('exposes the exact permission set from the implementation command', () => {
    expect([...BATCH_PERMISSIONS]).toEqual([
      'batch.view',
      'batch.create',
      'batch.execute',
      'batch.accept',
      'batch.send',
      'batch.receive',
      'batch.void',
    ]);
  });
});

describe('Batch Phase 2 — data model guard (real dmmf)', () => {
  it('has the four contract models with the command field names', () => {
    const models = Prisma.dmmf.datamodel.models;
    const names = models.map((m) => m.name);
    expect(names).toEqual(expect.arrayContaining(['Batch', 'BatchItem', 'AyroviUnit', 'BatchCustomer']));
    const batch = models.find((m) => m.name === 'Batch')!;
    const fields = batch.fields.map((f) => f.name);
    for (const f of [
      'batchCode', 'source', 'status', 'totalExpected', 'totalScanned',
      'createdAt', 'submittedAt', 'completedAt', 'voidedAt', 'idempotencyKey',
    ]) {
      expect(fields).toContain(f);
    }
    const item = models.find((m) => m.name === 'BatchItem')!;
    const itemFields = item.fields.map((f) => f.name);
    for (const f of ['identifierType', 'identifierValue', 'normalizedIdentifier', 'status', 'scannedAt']) {
      expect(itemFields).toContain(f);
    }
    const unit = models.find((m) => m.name === 'AyroviUnit')!;
    const unitFields = unit.fields.map((f) => f.name);
    for (const f of ['code', 'originalBarcode', 'originalSku', 'originalReference']) {
      expect(unitFields).toContain(f);
    }
  });

  it('has the exact BatchStatus values of the state machine (no extra states)', () => {
    const status = Prisma.dmmf.datamodel.enums.find((e) => e.name === 'BatchStatus')!;
    expect(status.values.map((v) => v.name)).toEqual([
      'CREATED', 'SUBMITTED', 'ACCEPTED', 'SENT_TO_RECEIVING',
      'RECEIVING_IN_PROGRESS', 'RECEIVING_COMPLETED', 'VOIDED',
    ]);
  });
});
