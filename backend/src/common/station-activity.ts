import { EventEmitter2 } from '@nestjs/event-emitter';

/**
 * STATION ACTIVITY PING (owner report 2026-09-16, display stage 2).
 *
 * The Station Display screens subscribe to `station.activity` over SSE so a
 * write lands on the wall screen the moment it happens. Before this helper,
 * ONLY the fulfillment module (picking/packing/shipping) emitted events, so
 * receiving / temporary storage / putaway / batch stations were refreshed by
 * the 3s reconcile tick alone — the instant topics they listened for almost
 * never fired.
 *
 * Contract:
 *  - fire-and-forget: a display refresh must NEVER break or delay a write;
 *  - called AFTER the transaction commits (never inside it), so a rolled-back
 *    write can not ping the screens;
 *  - the payload carries `stationId` when the writer knows it (batch writes
 *    only know the worker — the display resolves those by assigned worker).
 */
export function publishStationActivity(
  events: EventEmitter2,
  payload: { stationId?: string | null; kind: string; ref?: string | null },
): void {
  try {
    events.emit('station.activity', {
      stationId: payload.stationId ?? null,
      kind: payload.kind,
      ref: payload.ref ?? null,
      t: Date.now(),
    });
  } catch {
    /* the display refresh is never worth failing a business write */
  }
}
