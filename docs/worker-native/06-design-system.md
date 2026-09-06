# 06 · AYROVI Industrial Terminal Design System

Implementation owner: `mobile/design-system`. Independent AYROVI identity, no Zebra/Honeywell logo, assets, exact palette or copied UI. The provided written hierarchy, not an unattached image, guides the design.

## Visual language

Graphite/steel surfaces, pale high-contrast text, restrained copper primary action, blue scan guidance, mint success, amber warnings and coral errors. Flat/low-radius panels, bold operational instruction, monospaced identifiers, minimal motion. No navigation bar, promotional tiles, decorative graphs, fake barcodes or made-up task totals in the migrated shell.

Tokens centralized in `TerminalTheme.kt`:
- spacing: 4/8/12/16/24/32dp;
- panel radius: 4/8dp; elevation: 0/2dp;
- touch targets: minimum56dp, primary64dp;
- typography: body16sp, labels12sp, title22sp, instruction28sp, large quantity36sp (system font scaling honored);
- icon/status indicator sizes: 20/24dp;
- semantic tones: neutral, instruction, success, warning, error, offline/auth.

Screens consume semantic tokens/components, not inline colors, radii or spacing. Long product/SKU/location codes wrap; critical codes are never truncated to make a card fit. Readable text + symbol + tone communicate state. Retain contrast for gloved/one-hand use and label controls for TalkBack. Sounds/vibration supplement text, never replace it.

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
| Shell | TerminalShell, TerminalHeader, TerminalFooter |
| Task | TaskHeader, TaskNumber, TaskInstruction, TaskStatus |
| Location | LocationBlock, LocationCode, LocationHierarchy |
| Product | ProductBlock, ProductIdentity, SKUBlock, BarcodeDisplay |
| Scanner | ScanZone, ScanStatus, ScanResult |
| Quantity | QuantityDisplay, QuantityInput, QuantityStepper, NumericInput |
| Progress | ProgressIndicator, StepIndicator |
| Outcomes | SuccessState, ErrorState, WarningState, ExceptionState, LoadingState, EmptyState, ModalException |
| Actions | PrimaryAction, SecondaryAction, DangerAction, ConfirmAction, RejectAction, RetryAction, PauseAction |
| Connection | ConnectionStatus, SyncStatus, OfflineStatus |

Aliases such as ConfirmAction and PauseAction delegate to the same action primitive; they are not independently styled buttons. BarcodeDisplay displays a real code as readable text; it does not draw decorative bars pretending to be a printable barcode. Scanner camera/lifecycle integration stays in `:app`, not in a design component.

## Governance

New operational screens must use these primitives and receive state/intents only. New token/component requires an audit of equivalents and a documented reason. Frozen rollback screens are explicitly transitional exceptions, not examples for future development. Do not rewrite other workflows as mockups before Receiving passes hardware acceptance.

## Executed token review

Relative-luminance calculation against actual `surface #19222B`: primary text **14.54:1**, muted text **8.83:1**, instruction **9.85:1**, success **9.94:1**, warning **10.51:1**, error **8.92:1**. These nominal pairs exceed 4.5:1. This calculation does not certify disabled controls, OEM rendering, glare, text clipping or practical gloved use; those remain device/accessibility checks.

## Design acceptance (pending device evidence)

360dp-class handheld; 200% text; long SKU/name; landscape if device supports it; IME visible; bright/low light; gloves and one hand; TalkBack focus/order; status announcements; no color-only meaning; no hidden primary action under system bars/keyboard. Contrast/token review and screenshot tests are not substitutes for physical warehouse usability.
