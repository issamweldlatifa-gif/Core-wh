import { ConflictException } from '@nestjs/common';
import { PutawayService } from './putaway.service';

/**
 * Unit tests for the Putaway invariants that matter operationally:
 *   - only received cartons may be stowed,
 *   - a blocked/inactive location cannot accept stock,
 *   - re-scanning the same location is a no-op (no duplicate ledger rows),
 *   - a real move CLOSES the previous placement and appends a new one,
 *     rather than rewriting history.
 */

type AnyFn = jest.Mock;

function makePrisma(overrides: Record<string, unknown> = {}) {
  const tx = {
    warehouseCarton: {
      findUnique: jest.fn(),
      update: jest.fn(async ({ data }: any) => ({
        id: 'carton-1', externalCartonId: 'CTN-1', ...data,
      })),
    },
    cartonPlacement: {
      updateMany: jest.fn(async () => ({ count: 1 })),
      create: jest.fn(async () => ({ id: 'placement-1' })),
    },
    station: { findFirst: jest.fn(async () => null) },
    putawaySession: { count: jest.fn(async () => 0), findUnique: jest.fn(async () => null), create: jest.fn() },
  };

  const prisma: any = {
    _tx: tx,
    $transaction: jest.fn(async (fn: any) => fn(tx)),
    putawaySession: { findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    warehouseCarton: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(async () => 0) },
    location: { findFirst: jest.fn() },
    ...overrides,
  };
  return prisma;
}

const audit = { log: jest.fn(async () => undefined) } as any;
// Destination resolution is configuration-driven; unit tests here exercise
// placement invariants only, so the categories collaborator is a stub.
const categoriesStub = {
  resolveDestination: jest.fn(async () => ({ kind: 'NEEDS_REVIEW' })),
} as any;

const ACTOR = { id: 'worker-1', name: 'Ahmed' };

describe('PutawayService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('scanCarton', () => {
    it('rejects an unknown carton without throwing', async () => {
      const prisma = makePrisma();
      prisma.warehouseCarton.findFirst.mockResolvedValue(null);
      const svc = new PutawayService(prisma, audit, categoriesStub);

      await expect(svc.scanCarton('CTN-NOPE')).resolves.toEqual({
        kind: 'UNKNOWN_CARTON', code: 'CTN-NOPE',
      });
    });

    it('refuses a carton that was never physically received', async () => {
      const prisma = makePrisma();
      prisma.warehouseCarton.findFirst.mockResolvedValue({
        id: 'c1', externalCartonId: 'CTN-1', status: 'EXPECTED',
        currentLocation: null, shipment: null,
      });
      const svc = new PutawayService(prisma, audit, categoriesStub);

      const flash = await svc.scanCarton('CTN-1');
      expect(flash.kind).toBe('CARTON_NOT_RECEIVED');
    });

    it('accepts a RECEIVED carton', async () => {
      const prisma = makePrisma();
      prisma.warehouseCarton.findFirst.mockResolvedValue({
        id: 'c1', externalCartonId: 'CTN-1', status: 'RECEIVED',
        currentLocation: null, shipment: null,
      });
      const svc = new PutawayService(prisma, audit, categoriesStub);

      const flash = await svc.scanCarton('CTN-1');
      expect(flash.kind).toBe('CARTON_READY');
    });
  });

  describe('scanLocation', () => {
    it('refuses a location that is not ACTIVE', async () => {
      const prisma = makePrisma();
      prisma.location.findFirst.mockResolvedValue({
        id: 'l1', locationCode: 'A-01', locationType: 'STORAGE', status: 'BLOCKED',
      });
      const svc = new PutawayService(prisma, audit, categoriesStub);

      await expect(svc.scanLocation('A-01')).resolves.toMatchObject({
        kind: 'LOCATION_UNAVAILABLE', status: 'BLOCKED',
      });
    });

    it('uppercases the scanned location code before lookup', async () => {
      const prisma = makePrisma();
      prisma.location.findFirst.mockResolvedValue({
        id: 'l1', locationCode: 'A-01', locationType: 'STORAGE', status: 'ACTIVE',
      });
      const svc = new PutawayService(prisma, audit, categoriesStub);

      await svc.scanLocation('a-01');
      const where = prisma.location.findFirst.mock.calls[0][0].where;
      expect(JSON.stringify(where)).toContain('A-01');
    });
  });

  describe('place', () => {
    function arrange(cartonState: { currentLocationId: string | null }) {
      const prisma = makePrisma();
      prisma.putawaySession.findUnique.mockResolvedValue({ id: 's1', status: 'ACTIVE' });
      prisma.warehouseCarton.findFirst.mockResolvedValue({
        id: 'carton-1', externalCartonId: 'CTN-1', status: 'RECEIVED',
        currentLocation: null, shipment: null,
      });
      prisma.location.findFirst.mockResolvedValue({
        id: 'loc-A', locationCode: 'A-01', locationType: 'STORAGE', status: 'ACTIVE',
      });
      prisma._tx.warehouseCarton.findUnique.mockResolvedValue({
        id: 'carton-1', externalCartonId: 'CTN-1', ...cartonState,
      });
      const svc = new PutawayService(prisma, audit, categoriesStub);
      // detail() is exercised separately; stub it to keep these tests focused.
      jest.spyOn(svc, 'detail').mockResolvedValue({} as any);
      return { prisma, svc };
    }

    it('refuses to write into a session that is not active', async () => {
      const prisma = makePrisma();
      prisma.putawaySession.findUnique.mockResolvedValue({ id: 's1', status: 'COMPLETED' });
      const svc = new PutawayService(prisma, audit, categoriesStub);

      await expect(
        svc.place('s1', { cartonCode: 'CTN-1', locationCode: 'A-01' }, ACTOR),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('stores a carton that has no location yet', async () => {
      const { prisma, svc } = arrange({ currentLocationId: null });

      const res: any = await svc.place('s1', { cartonCode: 'CTN-1', locationCode: 'A-01' }, ACTOR);

      expect(res.flash.kind).toBe('STORED');
      expect(res.flash.moved).toBe(false);
      expect((prisma._tx.cartonPlacement.create as AnyFn)).toHaveBeenCalledTimes(1);
      // Nothing to release on a first placement.
      expect((prisma._tx.cartonPlacement.updateMany as AnyFn)).not.toHaveBeenCalled();
    });

    it('is a no-op when the carton is re-scanned into the same location', async () => {
      const { prisma, svc } = arrange({ currentLocationId: 'loc-A' });

      const res: any = await svc.place('s1', { cartonCode: 'CTN-1', locationCode: 'A-01' }, ACTOR);

      expect(res.flash.moved).toBe(false);
      // No new ledger row, no release, and no misleading audit entry.
      expect((prisma._tx.cartonPlacement.create as AnyFn)).not.toHaveBeenCalled();
      expect((prisma._tx.cartonPlacement.updateMany as AnyFn)).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('closes the previous placement and appends a new one when moved', async () => {
      const { prisma, svc } = arrange({ currentLocationId: 'loc-OTHER' });

      const res: any = await svc.place('s1', { cartonCode: 'CTN-1', locationCode: 'A-01' }, ACTOR);

      expect(res.flash.moved).toBe(true);
      // History is closed, never rewritten...
      const release = (prisma._tx.cartonPlacement.updateMany as AnyFn).mock.calls[0][0];
      expect(release.where).toMatchObject({ cartonId: 'carton-1', releasedAt: null });
      expect(release.data.releasedAt).toBeInstanceOf(Date);
      // ...and a fresh row is appended.
      expect((prisma._tx.cartonPlacement.create as AnyFn)).toHaveBeenCalledTimes(1);
    });

    it('does not commit anything when the carton is rejected', async () => {
      const prisma = makePrisma();
      prisma.putawaySession.findUnique.mockResolvedValue({ id: 's1', status: 'ACTIVE' });
      prisma.warehouseCarton.findFirst.mockResolvedValue(null); // unknown carton
      const svc = new PutawayService(prisma, audit, categoriesStub);

      const res: any = await svc.place('s1', { cartonCode: 'NOPE', locationCode: 'A-01' }, ACTOR);

      expect(res.flash.kind).toBe('UNKNOWN_CARTON');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
