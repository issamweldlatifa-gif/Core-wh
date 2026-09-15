package com.ayrovi.worker.printer

/**
 * PRINTER MANAGER — shared types (pure Kotlin, unit-testable).
 *
 * OWNER TASK 2026-09-15: production printing on the Honeywell CT40 —
 * PM-241-BT thermal label printer over Bluetooth Classic (SPP/RFCOMM),
 * TSPL II command generation, NO Labelife, NO Zebra APIs, NO Android
 * system printing. The admin web (Chrome on the same CT40) drives this
 * manager through the local PrintBridge loopback HTTP server.
 */

/** Connection states the UI must reflect (task §10). */
enum class PrinterConnectionState { DISCONNECTED, CONNECTING, CONNECTED, PRINTING, ERROR }

/** A discovered / saved printer (no MAC hard-coding anywhere — task §9/§26). */
data class PrinterInfo(
    val name: String,
    val address: String,
    val model: String? = null,
    val firmware: String? = null,
    val lastConnectedAt: Long? = null,
    val lastStatus: String? = null,
)

/**
 * Business label data (task §16): the business layer fills this in, the
 * renderer turns it into printer commands. Nothing here knows Bluetooth.
 */
data class LabelSpec(
    val title: String? = null,
    val lines: List<String> = emptyList(),
    val customerName: String? = null,
    val containerCode: String? = null,
    val section: String? = null,
    val qrPayload: String? = null,
    val barcodeValue: String? = null,
    val widthMm: Int = 76,
    val heightMm: Int = 50,
    val gapMm: Int = 2,
)

/** Machine-readable error + the simple user-facing sentence (task §20). */
data class PrinterError(val code: String, val userMessage: String, val detail: String? = null)

/** Result of one print job (task §18: duplicate protection included). */
data class PrintOutcome(val ok: Boolean, val duplicate: Boolean, val error: PrinterError? = null)

/** Snapshot served to the admin web through the bridge (task §10/§12). */
data class ManagerStatus(
    val state: PrinterConnectionState,
    val savedPrinter: PrinterInfo?,
    val connectedName: String?,
    val connectedAddress: String?,
    val firmware: String?,
    val lastError: PrinterError?,
)
