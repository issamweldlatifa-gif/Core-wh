import { Global, Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';

/**
 * Internal event bus (modular-monolith decoupling).
 * Domain modules can emit events (e.g. "user.created") for other modules to
 * react to through the EVENT_SEPARATED domain interface, so that no module
 * reaches directly into another module's tables. Later this can be swapped
 * for a queue/outbox without changing module code.
 *
 * Phase 0: no workflow events are emitted yet — the infrastructure is what
 * we are shipping (integration-ready).
 */
@Global()
@Module({
  imports: [
    EventEmitterModule.forRoot({
      wildcard: false,
      delimiter: '.',
      maxListeners: 20,
    }),
  ],
  exports: [EventEmitterModule],
})
export class EventsModule {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  constructor() {}
}
