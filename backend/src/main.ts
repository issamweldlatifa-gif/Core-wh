import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

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

  // OpenAPI / Swagger documentation (http://localhost:3000/api/docs)
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

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`AYROVI Warehouse Core API listening on :${port}`);
}

bootstrap();
