import { ConflictException } from '@nestjs/common';
import { WorkflowService } from './workflow.service';

/**
 * Workflow separation guard — unit tests (mocked prisma, no DB).
 *
 * A carton identifier (carton id / reference / QR / barcode / suivi /
 * tracking) presented at a product-only station (Temporary Storage, Sorting,
 * Packing, Shipping) is REJECTED with the carton-flow-ended message and an
 * audited guard row. Product/operational codes pass through untouched.
 */

function model() {
  return { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn() };
}

describe('WorkflowService', () => {
  function setup() {
    const prisma: any = {
      workflowEvent: model(),
      warehouseCarton: model(),
      warehouseShipment: model(),
      receivingCarton: model(),
    };
    const audit = { log: jest.fn().mockResolvedValue({}) } as any;
    return { prisma, audit, svc: new WorkflowService(prisma, audit) };
  }

  test('assertNotCartonIdentifier passes product codes through', async () => {
    const { svc, audit } = setup();
    (svc as any).prisma.warehouseCarton.findFirst.mockResolvedValue(null);
    (svc as any).prisma.warehouseShipment.findFirst.mockResolvedValue(null);
    (svc as any).prisma.receivingCarton.findFirst.mockResolvedValue(null);
    await expect(
      svc.assertNotCartonIdentifier('SKU-A-123', 'SORTING', { id: 'w-1' }),
    ).resolves.toBeUndefined();
    expect(audit.log).not.toHaveBeenCalled();
  });

  test('assertNotCartonIdentifier rejects a carton QR at Temporary Storage', async () => {
    const { svc, audit } = setup();
    (svc as any).prisma.warehouseCarton.findFirst.mockResolvedValue({
      id: 'c-1', externalCartonId: 'CTN-1', status: 'RECEIVED',
    });
    (svc as any).prisma.workflowEvent.create.mockResolvedValue({ id: 'ev-1' });
    await expect(
      svc.assertNotCartonIdentifier('QR-CTN-1', 'TEMPORARY_STORAGE', { id: 'w-1', ip: '10.0.0.1' }),
    ).rejects.toThrow(/Carton flow ended at Receiving/);
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log.mock.calls[0][0].action).toBe('WORKFLOW_GUARD_REJECTED');
    expect((svc as any).prisma.workflowEvent.create).toHaveBeenCalledTimes(1);
    const row = (svc as any).prisma.workflowEvent.create.mock.calls[0][0].data;
    expect(row.flow).toBe('CARTON');
    expect(row.event).toBe('GUARD_REJECTED_CARTON');
    expect(row.entityType).toBe('carton');
  });

  test('assertNotCartonIdentifier rejects a shipment tracking number at Packing', async () => {
    const { svc } = setup();
    (svc as any).prisma.warehouseCarton.findFirst.mockResolvedValue(null);
    (svc as any).prisma.warehouseShipment.findFirst.mockResolvedValue({ id: 's-1', code: 'SHP-1' });
    (svc as any).prisma.workflowEvent.create.mockResolvedValue({ id: 'ev-2' });
    await expect(
      svc.assertNotCartonIdentifier('TRK-123', 'PACKING', { id: 'w-1' }),
    ).rejects.toThrow(ConflictException);
  });

  test('logEvent appends to the ledger', async () => {
    const { svc } = setup();
    (svc as any).prisma.workflowEvent.create.mockImplementation(async ({ data }: any) => ({ id: 'ev-9', ...data }));
    const row = await svc.logEvent({
      flow: 'PRODUCT',
      event: 'PRODUCT_HANDOFF_TEMP',
      entityType: 'product',
      entityId: 'rp-1',
      entityCode: 'SKU-A',
      receivingSessionId: 'sess-1',
      fromStation: 'RECEIVING',
      toStation: 'TEMPORARY_STORAGE',
      actorId: 'w-1',
    });
    expect(row.flow).toBe('PRODUCT');
    expect(row.event).toBe('PRODUCT_HANDOFF_TEMP');
  });
});
