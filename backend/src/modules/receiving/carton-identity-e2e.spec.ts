import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ShipmentCardEventDto } from '../../integrations/crm/dto/shipment-card.dto';
import { ShipmentsService } from '../shipments/shipments.service';
import { ReceivingService } from './receiving.service';

/**
 * CARTON CARD INGESTION — real payload traced end to end.
 *
 *   External project -> DTO -> ShipmentsService -> DB rows
 *                    -> Admin detail shape -> Worker API (workerHome)
 *
 * The carton must stay a CARTON: its own identity, suivi/tracking code, QR
 * and barcode survive every hop and are never replaced by a product SKU.
 */

/** A REAL Carton Card as the external project sends it. */
const CARTON_CARD: any = {
  event: 'shipment.created',
  schema_version: '1.0',
  arrival: { id: 'ARR-2026-00087', reference: 'ARR-2026-00087' },
  shipment: {
    id: 'SHP-2026-000145',
    reference: 'SHEIN-TN-2026-00145',
    source: { type: 'CARRIER_API', reference: 'dhl-ref-1' },
    carrier: { id: 'DHL', name: 'DHL', code: 'DHL', service: 'Express' },
    tracking: { tracking_number: 'TRK-938472', tracking_url: 'https://dhl.test/TRK-938472', status: 'IN_TRANSIT' },
    sender: { name: 'Shenzhen Trading', company: 'Shenzhen Trading Co', country: 'CN', city: 'Shenzhen' },
    destination: { country: 'TN', city: 'Tunis', code: 'AYROVI-WH-TN' },
    dates: { shipped_at: '2026-09-01T10:00:00.000Z' },
    summary: { total_cartons: 2, total_products: 12, total_units: 12, total_weight: 25, weight_unit: 'KG' },
    cartons: [
      {
        id: 'CTN-000123', reference: 'SHP145-01',
        qr_code_value: 'QR-CTN-000123', barcode_value: 'BC-CTN-000123',
        carton_number: 1, total_cartons: 2, weight: 12.5, weight_unit: 'KG',
        dimensions: { length: 40, width: 30, height: 20, unit: 'CM' },
      },
      {
        id: 'CTN-000124', reference: 'SHP145-02',
        qr_code_value: 'QR-CTN-000124', barcode_value: 'BC-CTN-000124',
        carton_number: 2, total_cartons: 2, weight: 12.5, weight_unit: 'KG',
      },
    ],
  },
};

async function validationErrors(cls: any, payload: any): Promise<number> {
  const dto = plainToInstance(cls, payload, { enableImplicitConversion: true });
  return (await validate(dto as object, { whitelist: true, forbidNonWhitelisted: true })).length;
}

function prismaMock(): any {
  const model = () => ({
    findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn(), update: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    count: jest.fn().mockResolvedValue(0), aggregate: jest.fn(),
  });
  return {
    expectedArrival: model(), warehouseShipment: model(), warehouseCarton: model(),
    workerTaskAssignment: model(), receivingSession: model(), receivingProduct: model(),
    receivingCarton: model(), receivingScanEvent: model(), receivingDiscrepancy: model(),
    receivingWorkerLog: model(), station: model(), user: model(), auditLog: model(),
  };
}

describe('CARTON CARD — contract and routing', () => {
  it('TEST 1: the real carton payload is valid on the SHIPMENT (carton) endpoint', async () => {
    expect(await validationErrors(ShipmentCardEventDto, CARTON_CARD)).toBe(0);
  });

  it('a carton having SKU-like references does not make it a product card', async () => {
    const withRefs = JSON.parse(JSON.stringify(CARTON_CARD));
    withRefs.shipment.cartons[0].reference = 'sb25092090066487374'; // looks exactly like a SKU
    expect(await validationErrors(ShipmentCardEventDto, withRefs)).toBe(0);
  });
});

describe('CARTON CARD — ingestion preserves the original data', () => {
  let svc: ShipmentsService; let db: any; let push: any;

  beforeEach(() => {
    db = prismaMock();
    db.$transaction = jest.fn((fn: any) => fn(db));
    db.warehouseShipment.findFirst.mockResolvedValue(null);
    db.warehouseShipment.findMany.mockResolvedValue([]);
    db.expectedArrival.findFirst.mockResolvedValue(null);
    db.expectedArrival.findMany.mockResolvedValue([]);
    db.expectedArrival.create.mockResolvedValue({ id: 'arr-1', code: 'WAR-001001' });
    db.warehouseShipment.create.mockImplementation(async ({ data }: any) => ({
      id: 'shp-1', code: 'WSH-000001', ...data,
    }));
    db.warehouseCarton.create.mockImplementation(async ({ data }: any) => ({
      id: `carton-${data.externalCartonId}`, ...data,
    }));
    db.expectedArrivalItem = { create: jest.fn().mockResolvedValue({ id: 'item-1' }), findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) };
    push = { notifyNewCartonCard: jest.fn().mockResolvedValue(3) };
    svc = new ShipmentsService(db, { log: jest.fn() } as any, { dispatch: jest.fn() } as any, push);
  });

  const principal: any = { id: 'crm', name: 'CRM', idempotencyKey: 'key-1' };

  it('TEST 2: suivi/tracking, QR, barcode and carton identity are all persisted', async () => {
    const dto = plainToInstance(ShipmentCardEventDto, CARTON_CARD, { enableImplicitConversion: true });
    await svc.receiveShipment(dto as any, principal, null);

    const data = db.warehouseShipment.create.mock.calls[0][0].data;
    // Shipment-level suivi survives exactly as sent — not regenerated.
    expect(data.trackingNumber).toBe('TRK-938472');
    expect(data.externalShipmentId).toBe('SHP-2026-000145');

    // Cartons are stored as ONE warehouseCarton row each (the CARTON FIX
    // refactor writes cartons separately, never as a nested create).
    const rows = db.warehouseCarton.create.mock.calls.map((c: any) => c[0].data);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(expect.objectContaining({
      externalCartonId: 'CTN-000123',
      cartonReference: 'SHP145-01',
      qrCodeValue: 'QR-CTN-000123',
      barcodeValue: 'BC-CTN-000123',
      cartonNumber: 1,
    }));
    // Second carton keeps its OWN identity (no collapsing onto the first).
    expect(rows[1]).toEqual(expect.objectContaining({
      externalCartonId: 'CTN-000124', qrCodeValue: 'QR-CTN-000124', barcodeValue: 'BC-CTN-000124',
    }));
  });

  it('no product card is fabricated from the carton contents', async () => {
    const dto = plainToInstance(ShipmentCardEventDto, CARTON_CARD, { enableImplicitConversion: true });
    await svc.receiveShipment(dto as any, principal, null);
    // The carton lane never writes product/receiving-product rows.
    expect(db.receivingProduct.create).not.toHaveBeenCalled();
    expect(db.expectedArrival.create).toHaveBeenCalledTimes(1);
    const stub = db.expectedArrival.create.mock.calls[0][0].data;
    // The stub arrival is anchored on the SHIPMENT, never on a product SKU.
    expect(stub.customerArrivalCardId).toBe('shipment:SHP-2026-000145');
  });

  it('a QR-less carton falls back to its own id, never to a product SKU', async () => {
    const noQr = JSON.parse(JSON.stringify(CARTON_CARD));
    delete noQr.shipment.cartons[0].qr_code_value;
    const dto = plainToInstance(ShipmentCardEventDto, noQr, { enableImplicitConversion: true });
    await svc.receiveShipment(dto as any, principal, null);
    const rows = db.warehouseCarton.create.mock.calls.map((c: any) => c[0].data);
    expect(rows[0].qrCodeValue).toBe('CTN-000123');
  });

  it('TEST: a new carton card notifies the receiving floor with its suivi code', async () => {
    const dto = plainToInstance(ShipmentCardEventDto, CARTON_CARD, { enableImplicitConversion: true });
    await svc.receiveShipment(dto as any, principal, null);
    expect(push.notifyNewCartonCard).toHaveBeenCalledWith(expect.any(String), 2, 'TRK-938472');
  });
});

describe('CARTON CARD — Worker API returns it AS A CARTON', () => {
  let receiving: ReceivingService; let db: any;

  // The DB rows the ingestion above produced, as the worker feed reads them.
  const storedArrival = {
    id: 'arr-1', code: 'WAR-001001', status: 'EXPECTED', productCount: 0,
    customerId: 'Shenzhen Trading Co', customerName: 'Shenzhen Trading Co', storeName: null,
    items: [],
    shipments: [{
      id: 'shp-1', trackingNumber: 'TRK-938472', senderName: 'Shenzhen Trading',
      shippedAt: new Date('2026-09-01T10:00:00.000Z'),
      cartons: [{
        id: 'ctn-row-1', externalCartonId: 'CTN-000123', cartonReference: 'SHP145-01',
        qrCodeValue: 'QR-CTN-000123', barcodeValue: 'BC-CTN-000123',
        cartonNumber: 1, totalCartons: 2, weight: 12.5, weightUnit: 'KG',
        length: 40, width: 30, height: 20, dimensionUnit: 'CM', status: 'EXPECTED',
      }],
    }],
  };

  beforeEach(() => {
    db = prismaMock();
    db.$transaction = jest.fn((fn: any) => fn(db));
    db.expectedArrival.findMany.mockResolvedValue([storedArrival]);
    db.receivingProduct.findMany.mockResolvedValue([]);
    db.workerTaskAssignment.findMany.mockResolvedValue([]);
    receiving = new ReceivingService(db, { log: jest.fn() } as any,
      { assertOperationalAccess: jest.fn(), receivingStarted: jest.fn() } as any,
      { onReceivingCompleted: jest.fn() } as any);
  });

  const ACTOR: any = { id: 'w-1', name: 'Worker', ip: null };

  it('TEST 4: the card reaches the worker as a CARTON with its identity intact', async () => {
    const home = await receiving.workerHome('w-1', ACTOR);

    expect(home.cartonCardsPending).toBe(1);
    // Crucially: NOT surfaced as a product.
    expect(home.productCardsPending).toBe(0);

    const carton: any = home.cartonCards[0];
    expect(carton.externalCartonId).toBe('CTN-000123');
    expect(carton.reference).toBe('SHP145-01');
    expect(carton.qrCodeValue).toBe('QR-CTN-000123');
    expect(carton.barcodeValue).toBe('BC-CTN-000123');
    expect(carton.trackingNumber).toBe('TRK-938472'); // suivi survived to the app
    expect(carton.cartonNumber).toBe(1);
    expect(carton.totalCartons).toBe(2);
  });

  it('TEST 6: every carton identifier is scannable (id, ref, QR, barcode, suivi)', async () => {
    const home = await receiving.workerHome('w-1', ACTOR);
    const ids: string[] = (home.cartonCards[0] as any).identifiers;
    for (const value of ['CTN-000123', 'SHP145-01', 'QR-CTN-000123', 'BC-CTN-000123', 'TRK-938472']) {
      expect(ids).toContain(value);
    }
  });

  it('the carton list shows the suivi code, not a SKU', async () => {
    const home = await receiving.workerHome('w-1', ACTOR);
    expect(home.cartonList[0]).toEqual(expect.objectContaining({
      reference: 'CTN-000123', tracking: 'TRK-938472',
    }));
  });

  it('TEST 10: a product-only arrival still produces PRODUCT cards (no regression)', async () => {
    db.expectedArrival.findMany.mockResolvedValue([{
      id: 'arr-2', code: 'WAR-001002', status: 'EXPECTED', productCount: 1,
      customerId: 'C', customerName: 'Cust', storeName: null,
      items: [{
        id: 'i1', sku: 'SKU-1', reference: 'REF-1', productName: 'Widget', quantity: 2,
        category: null, subcategory: null, categoryStatus: 'NEEDS_REVIEW', storeId: null, storeName: null,
      }],
      shipments: [],
    }]);
    const home = await receiving.workerHome('w-1', ACTOR);
    expect(home.productCardsPending).toBe(1);
    expect(home.cartonCardsPending).toBe(0);
  });

  it('TEST 3/15: a mixed arrival keeps BOTH lanes with the correct type each', async () => {
    db.expectedArrival.findMany.mockResolvedValue([{
      ...storedArrival,
      productCount: 1,
      items: [{
        id: 'i1', sku: 'SKU-1', reference: 'REF-1', productName: 'Widget', quantity: 1,
        category: null, subcategory: null, categoryStatus: 'NEEDS_REVIEW', storeId: null, storeName: null,
      }],
    }]);
    const home = await receiving.workerHome('w-1', ACTOR);
    expect(home.productCardsPending).toBe(1);
    expect(home.cartonCardsPending).toBe(1);
    // The carton did not leak into the product lane.
    expect((home.productCards[0] as any).sku).toBe('SKU-1');
    expect((home.cartonCards[0] as any).externalCartonId).toBe('CTN-000123');
  });

  it('a received carton leaves the queue and is not re-offered', async () => {
    const received = JSON.parse(JSON.stringify(storedArrival));
    received.shipments[0].cartons[0].status = 'RECEIVED';
    db.expectedArrival.findMany.mockResolvedValue([received]);
    const home = await receiving.workerHome('w-1', ACTOR);
    expect(home.cartonCardsPending).toBe(0);
  });
});
