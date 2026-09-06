import { ServiceUnavailableException } from '@nestjs/common';
import { SystemService } from './system.service';

describe('Production health', () => {
  it('does not report a healthy service when the database probe fails', async () => {
    const service = new SystemService({ $queryRaw: jest.fn().mockRejectedValue(new Error('private database connection details')) } as never, {} as never);
    try { await service.health(); fail('expected readiness failure'); }
    catch (error) {
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(error.getStatus()).toBe(503);
      expect(error.getResponse()).toMatchObject({ status: 'unavailable', database: 'down' });
      expect(JSON.stringify(error.getResponse())).not.toContain('private database');
    }
  });
  it('reports database up only after a successful probe', async () => {
    const service = new SystemService({ $queryRaw: jest.fn().mockResolvedValue([{ ok: 1 }]) } as never, {} as never);
    expect(await service.health()).toMatchObject({ status: 'ok', database: 'up' });
  });
});
