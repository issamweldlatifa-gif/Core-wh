import { Module } from '@nestjs/common';

/**
 * External Integration Boundary.
 *
 * Phase 0 ships CONTRACTS / INTERFACES only — no live external systems.
 * Each future integration (CRM, shipping carriers, notifications,
 * OCR/vision, payment, email) will live in its own folder here and will be
 * reached exclusively through its published interface so that Warehouse Core
 * never depends on a concrete third-party SDK.
 *
 * Nothing here makes network calls, uses real credentials, or processes
 * real data in Phase 0.
 */
@Module({})
export class IntegrationsModule {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  constructor() {}
}
