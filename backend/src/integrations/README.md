# External Integration Boundary — Phase 0

This directory is the **contract boundary** for future external integrations.

**Phase 0 rule:** no live external system. We ship interfaces/contracts only.
No real credentials, no real data, no network calls to third parties.

## Planned structure (future phases)

```
integrations/
├── shipping/           # carriers (DHL, UPS, ...) — later phase
├── crm/                # AYROVI CRM — later phase
├── notifications/      # email / WhatsApp — later phase
├── external-services/  # OCR (Google Vision), payments, ...
└── ...
```

## How an integration is meant to plug in

A future module should depend on an **interface** (e.g. `ShippingProvider`)
defined in the domain, and the concrete adapter lives here. This keeps
AYROVI Warehouse Core decoupled so it can be ported to any provider and any
host without rewriting the domain.

## Explicitly out of scope for Phase 0

- CRM integration
- Shipping / carrier providers
- Google Vision / OCR
- WhatsApp / email providers
- Payment providers
- Any external API

These are NOT implemented. See `docs/OPEN-DECISIONS.md`.
