import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { WorkflowService } from './workflow.service';

/**
 * Station-chain workflow — display stage 2 contract.
 *
 * The station screens follow the chain live, so an intake accepted at a
 * Temporary Storage station must ping `station.activity` (the SSE topic the
 * displays listen to). The invariant under test is the ORDER: the ping is
 * emitted AFTER the transaction committed — a rolled-back acceptance can never
 * wake the screens, and a display refresh can never fail a business write.
 */

type AnyFn = jest.Mock;

const ACTOR = { id: 'worker-1', ip: null };

function makePrisma(order: string[], overrides: Record<string, unknown> = {}) {
  const tx = {
    productStationMove: { update: jest.fn(async () => ({ id: 'move-1' })) },
  };
  const prisma: any = {
    _tx: tx,
    $transaction: jest.fn(async (fn: any) => {
      const result = await fn(tx);
      order.push('commit');
      return result;
    }),
    station: { findUnique: jest.fn() },
    productStationMove: { findUnique: jest.fn(), findFirst: jest.fn(async () => null) },
    ...overrides,
  };
  return prisma;
}

const audit = { log: jest.fn(async () => undefined) } as any;

const STAGING_STATION = {
  id: 'st-ts-1',
  code: 'ST-STG-01',
  name: 'Temporary Storage 1',
  department: 'STAGING',
  status: 'ACTIVE',
};

const MOVE = {
  id: 'move-1',
  sku: 'SA-4471',
  toDepartment: 'STAGING',
  acceptedAt: null,
  reportLineId: 'line-1',
  confirmedQuantity: 12,
  createdAt: new Date('2026-09-16T10:00:00Z'),
};

describe('WorkflowService — station activity push', () => {
  beforeEach(() => jest.clearAllMocks());

  it('pings the station screen with the station id, AFTER the commit', async () => {
    const order: string[] = [];
    const prisma = makePrisma(order);
    prisma.station.findUnique.mockResolvedValue(STAGING_STATION);
    prisma.productStationMove.findUnique.mockResolvedValue(MOVE);
    const events = { emit: jest.fn(() => order.push('emit')) } as any;
    const svc = new WorkflowService(prisma, audit, events);

    const res = await svc.acceptAtStaging('move-1', 'st-ts-1', ACTOR);

    expect(res).toMatchObject({ moveId: 'move-1' });
    expect((prisma._tx.productStationMove.update as AnyFn)).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith(
      'station.activity',
      expect.objectContaining({ stationId: 'st-ts-1', kind: 'STAGING_ACCEPT', ref: 'move-1' }),
    );
    // The ping is a consequence of a COMMITTED move, never of the attempt.
    expect(order).toEqual(['commit', 'emit']);
  });

  it('refuses a station that is not a Temporary Storage station and pings nobody', async () => {
    const order: string[] = [];
    const prisma = makePrisma(order);
    prisma.station.findUnique.mockResolvedValue({ ...STAGING_STATION, department: 'PACKING' });
    const events = { emit: jest.fn() } as any;
    const svc = new WorkflowService(prisma, audit, events);

    await expect(svc.acceptAtStaging('move-1', 'st-ts-1', ACTOR)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(events.emit).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses an inactive station and pings nobody', async () => {
    const order: string[] = [];
    const prisma = makePrisma(order);
    prisma.station.findUnique.mockResolvedValue({ ...STAGING_STATION, status: 'INACTIVE' });
    const events = { emit: jest.fn() } as any;
    const svc = new WorkflowService(prisma, audit, events);

    await expect(svc.acceptAtStaging('move-1', 'st-ts-1', ACTOR)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('refuses an unknown move, an already-accepted move and a superseded move', async () => {
    const order: string[] = [];
    const prisma = makePrisma(order);
    prisma.station.findUnique.mockResolvedValue(STAGING_STATION);
    const events = { emit: jest.fn() } as any;
    const svc = new WorkflowService(prisma, audit, events);

    prisma.productStationMove.findUnique.mockResolvedValue(null);
    await expect(svc.acceptAtStaging('nope', 'st-ts-1', ACTOR)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    prisma.productStationMove.findUnique.mockResolvedValue({ ...MOVE, acceptedAt: new Date() });
    await expect(svc.acceptAtStaging('move-1', 'st-ts-1', ACTOR)).rejects.toBeInstanceOf(
      ConflictException,
    );

    prisma.productStationMove.findUnique.mockResolvedValue(MOVE);
    prisma.productStationMove.findFirst.mockResolvedValue({ id: 'move-2' });
    await expect(svc.acceptAtStaging('move-1', 'st-ts-1', ACTOR)).rejects.toBeInstanceOf(
      ConflictException,
    );

    // Three refusals, zero screen wake-ups.
    expect(events.emit).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('hands receiving output to STAGING without emitting (the submit owns that ping)', async () => {
    const order: string[] = [];
    const prisma = makePrisma(order);
    const events = { emit: jest.fn() } as any;
    const svc = new WorkflowService(prisma, audit, events);
    const tx = {
      receivingSession: { findUnique: jest.fn(async () => ({ id: 's1', code: 'RCV-1', stationId: 'st-rec-1' })) },
      receivingReport: { findUnique: jest.fn(async () => ({ lines: [] })) },
      productStationMove: { findFirst: jest.fn(), create: jest.fn() },
    } as any;

    const res = await svc.handoffReceivingToStaging(tx, 's1', ACTOR);

    expect(res).toEqual({ moved: 0 });
    // Receiving's own submit emits REPORT_SUBMITTED after ITS commit — a second
    // emit from inside this transaction would be a push for an uncommitted row.
    expect(events.emit).not.toHaveBeenCalled();
  });
});
