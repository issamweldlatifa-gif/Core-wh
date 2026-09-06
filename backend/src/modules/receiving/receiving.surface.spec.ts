import 'reflect-metadata';
import { APPLICATION_KEY } from '../../common/decorators/require-application.decorator';
import { ReceivingController } from './receiving.controller';
import { OperationsController } from '../operations/operations.controller';
import { PutawayController } from '../putaway/putaway.controller';

/**
 * AYROVI ADMIN_WEB / WORKER endpoint-contract regression (Order #3).
 *
 * The reported defect was an ADMIN_WEB session reaching the worker Receiving
 * surface. The backend was already correct — this spec pins the contract so a
 * future refactor cannot silently open or invert the surfaces:
 *
 *   - Receiving execution endpoints (scan/receive/complete)  -> WORKER_NATIVE
 *   - Admin operational oversight (sessions, containers, …)  -> ADMIN_WEB
 *   - Putaway execution                                       -> WORKER_NATIVE
 *
 * ADMIN_WEB -> worker endpoint must stay DENIED and WORKER_NATIVE -> admin
 * endpoint must stay DENIED (enforced by ApplicationGuard, verified by the
 * guard's own spec).
 */
function surfaceOf(target: Function): string[] | undefined {
  return Reflect.getMetadata(APPLICATION_KEY, target) as string[] | undefined;
}

describe('Receiving application-surface contract', () => {
  it('reserves the Receiving terminal API for WORKER_NATIVE sessions', () => {
    expect(surfaceOf(ReceivingController)).toEqual(['WORKER_NATIVE']);
  });

  it('serves the admin operational oversight API to ADMIN_WEB sessions only', () => {
    // This is the endpoint family the Admin Web Receiving card must use
    // (/operations/sessions/:id, /operations/overview, /operations/exceptions).
    expect(surfaceOf(OperationsController)).toEqual(['ADMIN_WEB']);
  });

  it('reserves the Putaway terminal API for WORKER_NATIVE sessions', () => {
    expect(surfaceOf(PutawayController)).toEqual(['WORKER_NATIVE']);
  });
});
