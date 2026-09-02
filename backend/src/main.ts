// Load .env BEFORE anything reads process.env (the fail-fast check below and
// JwtStrategy's constructor both read env vars before ConfigModule kicks in).
import * as dotenv from 'dotenv';
import { resolve } from 'path';
dotenv.config();
dotenv.config({ path: resolve(process.cwd(), '..', '.env') });

import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import * as express from 'express';
import { existsSync } from 'fs';
import * as path from 'path';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { repairSchemaDriftIfNeeded } from './bootstrap-schema-repair';

async function bootstrap() {
  // SCHEMA SELF-REPAIR (in-process): production proved that start.sh's repair
  // path is not guaranteed to run (the service may start `node dist/main.js`
  // directly). The entrypoint is the ONLY code guaranteed to execute, so the
  // guarded, additive drift repair runs here before anything queries the DB.
  await repairSchemaDriftIfNeeded();

  // FAIL FAST: refuse to boot without real JWT secrets. Previously the config
  // loader silently fell back to .env.example placeholders, which would let a
  // production instance sign tokens with publicly known keys.
  for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const) {
    const value = process.env[key];
    if (!value || value.startsWith('replace_with_')) {
      // eslint-disable-next-line no-console
      console.error(
        `FATAL: ${key} is missing or still a placeholder. ` +
          'Set a strong random value (e.g. `openssl rand -hex 32`) before starting.',
      );
      process.exit(1);
    }
  }

  const app = await NestFactory.create(AppModule);

  // Behind a reverse proxy (Render, nginx, the sandbox preview) Express must
  // trust X-Forwarded-* so req.ip is the real client IP — otherwise the
  // login rate limiter throttles ALL users together under the proxy's IP.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  // Global API versioning -> /api/v1/*
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

  // Global prefix for all routes
  app.setGlobalPrefix('api');

  // Security hardening (production uses HTTPS at the proxy/domain layer).
  app.use(helmet());

  // CORS is configured explicitly from env (never wildcard in production).
  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  });

  // Global validation + payload abuse protection.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Uniform error responses.
  app.useGlobalFilters(new AllExceptionsFilter());

  // OpenAPI / Swagger documentation (http://localhost:3000/api/docs).
  // BUGFIX: SWAGGER_ENABLED was documented in .env.example and render.yaml
  // but never actually read — docs were always exposed. Now honoured.
  if ((process.env.SWAGGER_ENABLED ?? 'true').toLowerCase() !== 'false') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('AYROVI Warehouse Core API')
      .setDescription('Phase 0 — Core system (auth, RBAC, audit, system). REST v1.')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
  }

  const publicDir = path.join(__dirname, '..', 'public');
  const indexFile = path.join(publicDir, 'index.html');

  if (existsSync(publicDir)) {
    // SINGLE-BUNDLE PRODUCTION MODE:
    // The built React SPA lives in backend/public and is served from the SAME
    // Node process as the API (one service, easy Render deploy).
    //
    // These are registered BEFORE Nest initializes its router so they run
    // first in the middleware chain:
    //   - express.static serves real assets (js/css/index.html),
    //   - the `*` fallback sends index.html for any other non-API GET,
    //   - any /api/* request is passed to next() so it reaches the Nest router.
    const server = app.getHttpAdapter().getInstance();
    server.use(express.static(publicDir));
    server.get('*', (req, res, next) => {
      // BUGFIX: also exclude the bare '/api' path (previously only '/api/'
      // was excluded, so GET /api returned the SPA instead of reaching Nest).
      if (req.path === '/api' || req.path.startsWith('/api/')) return next();
      res.sendFile(indexFile);
    });
  } else {
    // API-ONLY MODE (local dev with Vite, or backend used by another client):
    // friendly landing at the bare server root instead of a confusing 404.
    const server = app.getHttpAdapter().getInstance();
    server.get('/', (_req, res) => {
      res.json({
        app: 'AYROVI Warehouse Core API',
        phase: '0',
        version: '0.1.0',
        status: 'operational',
        docs: '/api/docs',
        health: '/api/v1/system/health',
        base: '/api/v1',
      });
    });
  }

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`AYROVI Warehouse Core API listening on :${port}`);
}

bootstrap();
