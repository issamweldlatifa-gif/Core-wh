# 06 · AYROVI Industrial Terminal Design System

Implementation owner: `mobile/design-system`. Independent AYROVI identity, no Zebra/Honeywell logo, assets, exact palette or copied UI. The provided written hierarchy, not an unattached image, guides the design.

## Visual language

**v1.4.1 pilot / CT40-oriented update:** two centrally owned contrast modes: WHITE (`#FFFFFF` background) and BLACK (`#000000` background). No blue-grey page backdrop. Flat 4dp cards, clear outlines, restrained semantic scan/status accents and monochrome primary actions. One header button switches themes without recreating the Activity, ViewModels or active receipt. Non-sensitive display preferences persist independently from encrypted auth/recovery data.

Tokens remain centralized in `TerminalTheme.kt`:
- spacing 4/8/12/16/24/32dp; handheld body/panel padding12dp;
- 4dp radii; 0/2dp elevation;
- minimum56dp touch targets, primary64dp; fixed header Back and White/Black controls;
- body16sp, labels12sp, title22sp, instruction24sp, quantity32sp; system font scaling honored;
- icon20/24dp; camera preview180dp; semantic neutral/instruction/success/warning/error tones.

The header Back action replaces the repeated full-width queue button in the Receiving footer. A sticky `Carton / Produit` selector remains visible during scrolling. Task cards and routine success/info notices are denser; errors retain expected/scanned/reason. Camera/manual controls share a row, manual input expands on demand and remains selected across scan steps. No critical code is ellipsized to force a fit.

This is an independent AYROVI design, not vendor certification or copied Zebra/Honeywell assets. CT40 actual firmware/density/font/glove validation remains mandatory.

## Information hierarchy

1. TerminalHeader: operation, authenticated worker/station, connection state.
2. TaskHeader/TaskNumber: which real session/arrival.
3. TaskInstruction: one thing to do now.
4. LocationBlock/ProductBlock: known server context, never parsed into invented warehouse coordinates.
5. ScanZone: source-aware capture + explicit camera/manual fallback.
6. ScanResult/operational state: identified ≠ accepted; show expected/scanned context.
7. TerminalFooter: next action pinned predictably. Review/confirm only where an action really commits.

The repository's location hierarchy is Warehouse→Zone→Aisle→Rack→Level→Location. The example Zone/Aisle/Bay/Level/Position is **not** permission to invent Bay/Position data. Display those dimensions only if the backend supplies them.

## Component catalog

| Family | Shared components |
|---|---|
| Shell / navigation | TerminalShell, TerminalHeader, TerminalFooter, TerminalModeSelector |
| Task | TaskHeader, TaskNumber, TaskInstruction, TaskStatus |
| Location | LocationBlock, LocationCode, LocationHierarchy |
| Product | ProductBlock, ProductIdentity, SKUBlock, BarcodeDisplay |
| Scanner | ScanZone, ScanStatus, ScanResult |
| Quantity | QuantityDisplay, QuantityInput, QuantityStepper, NumericInput |
| Progress | ProgressIndicator, StepIndicator |
| Outcomes | SuccessState, ErrorState, WarningState, ExceptionState, LoadingState, EmptyState, ModalException, TerminalNotice |
| Actions | PrimaryAction, SecondaryAction, DangerAction, ConfirmAction, RejectAction, RetryAction, PauseAction |
| Connection | ConnectionStatus, SyncStatus, OfflineStatus |

Aliases such as ConfirmAction and PauseAction delegate to the same action primitive; they are not independently styled buttons. BarcodeDisplay displays a real code as readable text; it does not draw decorative bars pretending to be a printable barcode. Scanner camera/lifecycle integration stays in `:app`, not in a design component.

## Governance

New operational screens must use these primitives and receive state/intents only. New token/component requires an audit of equivalents and a documented reason. Frozen rollback screens are explicitly transitional exceptions, not examples for future development. Do not rewrite other workflows as mockups before Receiving passes hardware acceptance.

## Executed token review (v1.4.1)

Calculated contrast against each palette's actual card surface:

| Pair | White | Black |
|---|---:|---:|
| Primary text | 18.88:1 | 19.03:1 |
| Secondary text | 9.24:1 | 11.33:1 |
| Scan instruction | 7.84:1 | 11.86:1 |
| Success | 7.03:1 | 12.22:1 |
| Warning | 7.34:1 | 13.22:1 |
| Error | 6.57:1 | 10.67:1 |
| Card/control outline | 3.40:1 | 4.45:1 |

Text exceeds 4.5:1 and outlines exceed 3:1. Android tests cover palette values/contrast, preference persistence, theme switching without stock mutation, sticky mode/back/primary controls and 150% fonts. Current execution evidence is in report15; calculations are not glare/warehouse/physical-device certification.

## Design acceptance (pending device evidence)

360dp-class handheld; 200% text; long SKU/name; landscape if device supports it; IME visible; bright/low light; gloves and one hand; TalkBack focus/order; status announcements; no color-only meaning; no hidden primary action under system bars/keyboard. Contrast/token review and screenshot tests are not substitutes for physical warehouse usability.
