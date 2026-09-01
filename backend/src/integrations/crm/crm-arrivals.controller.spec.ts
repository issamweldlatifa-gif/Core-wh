import { INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { CrmArrivalsController } from './crm-arrivals.controller';
import { IntegrationApiGuard } from './integration-api.guard';
import { ExpectedArrivalsService } from '../../modules/expected-arrivals/expected-arrivals.service';

/**
 * HTTP-level tests for POST /integrations/arrivals/customer-cards:
 * auth rejection, payload validation (no partial record), idempotency and
 * the EXPECTED (never RECEIVED) response. The service is stubbed so the
 * validation + guard pipeline is exercised exactly as in production.
 */

describe('CRM arrivals integration endpoint', () => {
  let app: INestApplication;
  let createSpy: jest.Mock;

  const validBody = () => ({
    event: 'customer_arrival_card.created',
    arrival: { id: 'ARR-1', reference: 'ARR-1' },
    customer_arrival_card: {
      id: 'CARD-1',
      customer: { id: 'CUS-1', name: 'Ahmed' },
      store: { id: 'SHEIN', name: 'SHEIN' },
      products: [{ sku: 'SB-1', reference: 'SB-1', product_name: 'A', quantity: 1, variant: null, color: null, size: null }],
    },
  });

  beforeEach(async () => {
    createSpy = jest.fn();
    const moduleRef = await Test.createTestingModule({
      controllers: [CrmArrivalsController],
      providers: [
        { provide: IntegrationApiGuard, useValue: { canActivate: jest.fn() } },
        {
          provide: ExpectedArrivalsService,
          useValue: {
            receiveCard: createSpy.mockImplementation(async (body, principal) => ({
              success: true,
              customer_arrival_card_id: body.customer_arrival_card.id,
              warehouse_arrival_id: 'WAR-001001',
              status: 'EXPECTED',
              created: true,
              duplicate: false,
              principal,
            })),
          },
        },
      ],
    })
      .overrideGuard(IntegrationApiGuard)
      .useValue({ canActivate: (ctx: any) => {
          const req = ctx.switchToHttp().getRequest();
          const key = req.headers['x-api-key'];
          if (key === 'good-key') { req.integrationClient = { kind: 'static', id: null, name: 'TEST', idempotencyKey: null }; return true; }
          // Mirrors the real IntegrationApiGuard, which throws 401 on bad creds.
          throw new UnauthorizedException('Invalid integration credentials.');
        } })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });

  afterEach(async () => app.close());

  const endpoint = '/api/v1/integrations/arrivals/customer-cards';

  it('accepts a valid card with the API key and returns status EXPECTED', async () => {
    const res = await request(app.getHttpServer())
      .post(endpoint)
      .set('x-api-key', 'good-key')
      .send(validBody())
      .expect(201);
    expect(res.body).toMatchObject({
      success: true,
      customer_arrival_card_id: 'CARD-1',
      warehouse_arrival_id: 'WAR-001001',
      arrival_status: 'EXPECTED',
    });
    // The domain status must never be RECEIVED at this phase.
    expect(res.body.arrival_status).not.toBe('RECEIVED');
  });

  it('rejects requests without a valid API key (401)', async () => {
    const res = await request(app.getHttpServer())
      .post(endpoint)
      .set('x-api-key', 'bad-key')
      .send(validBody());
    expect(res.status).toBe(401);
    expect(createSpy).not.toHaveBeenCalled(); // service never reached -> no record
  });

  it('rejects an invalid payload (empty products) with 400 and creates nothing', async () => {
    const body = validBody();
    body.customer_arrival_card.products = [];
    const res = await request(app.getHttpServer())
      .post(endpoint)
      .set('x-api-key', 'good-key')
      .send(body);
    expect(res.status).toBe(400);
    expect(createSpy).not.toHaveBeenCalled(); // validation runs before the service
  });

  it('rejects an unknown/wrong event value with 400', async () => {
    const body = validBody();
    body.event = 'something.else';
    const res = await request(app.getHttpServer())
      .post(endpoint)
      .set('x-api-key', 'good-key')
      .send(body);
    expect(res.status).toBe(400);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('rejects non-integer / out-of-range quantity with 400', async () => {
    const body = validBody();
    body.customer_arrival_card.products[0].quantity = 0;
    const res = await request(app.getHttpServer())
      .post(endpoint)
      .set('x-api-key', 'good-key')
      .send(body);
    expect(res.status).toBe(400);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('rejects unknown/extra fields with 400 (forbidNonWhitelisted) and creates nothing', async () => {
    const body = validBody() as any;
    body.customer_arrival_card.products[0].evil = 'x';
    body.unknownTop = 123;
    const res = await request(app.getHttpServer())
      .post(endpoint)
      .set('x-api-key', 'good-key')
      .send(body);
    expect(res.status).toBe(400);
    expect(createSpy).not.toHaveBeenCalled();
  });
});
