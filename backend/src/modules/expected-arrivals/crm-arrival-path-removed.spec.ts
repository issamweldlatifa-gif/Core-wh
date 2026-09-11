import 'reflect-metadata';
import { Prisma } from '@prisma/client';
import {
  CartonCardsModule,
} from '../../modules/carton-cards/carton-cards.module';
import { OrdersModule } from '../../modules/orders/orders.module';
import { ShipmentsModule } from '../../modules/shipments/shipments.module';
import { ExpectedArrivalsController } from './expected-arrivals.controller';
import { ExpectedArrivalsModule } from './expected-arrivals.module';
import { ExpectedArrivalsService } from './expected-arrivals.service';

/**
 * PHASE 1 REGRESSION — AYROVI Batch architecture.
 *
 * The legacy CRM Arrival OPERATIONAL path was removed:
 *   POST /integrations/arrivals/customer-cards (CrmArrivalsController)
 *     -> ExpectedArrivalsService.receiveCard -> auto-dispatch + push.
 *
 * What MUST stay true forever after this phase:
 *  1. The CRM can no longer create operational Arrivals (the intake
 *     controller/service operation no longer exist in the module wiring).
 *  2. Historical arrival data stays reachable (the Warehouse-UI controller
 *     and the read/manage service surface are untouched).
 *  3. The UNRELATED CRM flows (carton cards / orders / shipments) keep their
 *     own intake controllers wired exactly as before.
 *  4. No Batch entity/UI/logic exists yet (Phase 1 scope guard).
 */
describe('Phase 1 — legacy CRM Arrival operational path is removed', () => {
  const controllerNames = (moduleClass: any): string[] =>
    (Reflect.getMetadata('controllers', moduleClass) ?? []).map((c: any) => c?.name);

  it('the arrival module no longer registers the CRM intake controller', () => {
    const names = controllerNames(ExpectedArrivalsModule);
    expect(names).toEqual(['ExpectedArrivalsController']);
    expect(names).not.toContain('CrmArrivalsController');
  });

  it('historical arrival data stays reachable through the Warehouse-UI surface', () => {
    const names = controllerNames(ExpectedArrivalsModule);
    expect(names).toContain('ExpectedArrivalsController');

    const proto = ExpectedArrivalsService.prototype as any;
    expect(typeof proto.list).toBe('function');
    expect(typeof proto.detail).toBe('function');
    expect(typeof proto.changeItemCategory).toBe('function');
  });

  it('the intake operation itself is gone from the service', () => {
    const proto = ExpectedArrivalsService.prototype as any;
    expect(proto.receiveCard).toBeUndefined();
  });

  it('unrelated CRM flows keep their own intake wiring (cartons / orders / shipments)', () => {
    const cartons = controllerNames(CartonCardsModule);
    expect(cartons).toContain('CrmCartonCardsController');
    expect(cartons).toContain('CrmCartonCardsLegacyController');
    expect(controllerNames(OrdersModule)).toContain('CrmOrdersController');
    expect(controllerNames(ShipmentsModule)).toContain('CrmShipmentsController');
  });

  it('PHASE SCOPE GUARD: the data model still has no Batch entities', () => {
    // Real generated Prisma datamodel: Phase 1 must not introduce
    // Batch/BatchItem models or states. A later phase updates this guard
    // DELIBERATELY when it adds them.
    const modelNames: string[] = Prisma.dmmf.datamodel.models.map((m) => m.name);
    expect(modelNames).toContain('ExpectedArrival');
    expect(modelNames).not.toContain('Batch');
    expect(modelNames).not.toContain('BatchItem');
  });
});
