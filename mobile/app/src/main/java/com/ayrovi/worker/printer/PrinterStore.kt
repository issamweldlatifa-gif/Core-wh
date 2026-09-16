package com.ayrovi.worker.printer

import android.content.Context
import android.content.SharedPreferences

/**
 * Saved printer + job-id + bridge preference persistence on the CT40
 * (task §11/§18). Flat preference keys — no JSON dependency, unit-testable
 * through the [PrinterPersistence] interface.
 *
 * The claimed job ids are kept in CLAIM ORDER (one newline-separated string,
 * oldest first) rather than a `StringSet`: a set has no order, so trimming it
 * to the window dropped an arbitrary id — possibly the label the server is
 * still offering — and the next poll printed it twice. See [JobIdWindow].
 * Ids written by an older build are read from the legacy set once and merged
 * in front (they are the oldest) so no install loses its protection.
 */
class PrinterStore(context: Context) : PrinterPersistence {

    private val prefs: SharedPreferences =
        context.getSharedPreferences("printer_manager", Context.MODE_PRIVATE)

    override fun loadSaved(): PrinterInfo? {
        val address = prefs.getString(KEY_ADDRESS, null) ?: return null
        return PrinterInfo(
            name = prefs.getString(KEY_NAME, null) ?: address,
            address = address,
            model = prefs.getString(KEY_MODEL, null),
            firmware = prefs.getString(KEY_FIRMWARE, null),
            lastConnectedAt = if (prefs.contains(KEY_LAST_OK)) prefs.getLong(KEY_LAST_OK, 0L) else null,
            lastStatus = prefs.getString(KEY_LAST_STATUS, null),
        )
    }

    override fun saveSaved(printer: PrinterInfo) {
        prefs.edit()
            .putString(KEY_NAME, printer.name)
            .putString(KEY_ADDRESS, printer.address)
            .putString(KEY_MODEL, printer.model)
            .putString(KEY_FIRMWARE, printer.firmware)
            .putLong(KEY_LAST_OK, printer.lastConnectedAt ?: 0L)
            .putString(KEY_LAST_STATUS, printer.lastStatus)
            .apply()
    }

    override fun clearSaved() {
        prefs.edit().remove(KEY_NAME).remove(KEY_ADDRESS).remove(KEY_MODEL)
            .remove(KEY_FIRMWARE).remove(KEY_LAST_OK).remove(KEY_LAST_STATUS).apply()
    }

    override fun seenJob(jobId: String): Boolean = claimedWindow().contains(jobId)

    override fun rememberJob(jobId: String) {
        val window = claimedWindow()
        window.remember(jobId)
        prefs.edit()
            .putString(KEY_JOB_ORDER, window.ids().joinToString(SEPARATOR))
            .remove(KEY_JOBS) // legacy unordered key is folded in above
            .apply()
    }

    /** The window as it stands on disk: legacy ids first (oldest), then the ring. */
    private fun claimedWindow(): JobIdWindow {
        val legacy = prefs.getStringSet(KEY_JOBS, emptySet()).orEmpty()
        val ordered = prefs.getString(KEY_JOB_ORDER, null)
            ?.split(SEPARATOR)
            ?.filter(String::isNotBlank)
            .orEmpty()
        return JobIdWindow.of(legacy.toList() + ordered, MAX_JOBS)
    }

    override fun bridgeEnabled(): Boolean = prefs.getBoolean(KEY_BRIDGE, false)

    override fun setBridgeEnabled(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_BRIDGE, enabled).apply()
    }

    /** Optional shared secret (Admin → Printers → Advanced). Empty = open loopback. */
    fun bridgeToken(): String? = prefs.getString(KEY_TOKEN, null)?.takeIf { it.isNotBlank() }

    fun setBridgeToken(token: String?) {
        if (token.isNullOrBlank()) prefs.edit().remove(KEY_TOKEN).apply()
        else prefs.edit().putString(KEY_TOKEN, token).apply()
    }

    private companion object {
        const val KEY_NAME = "printer_name"
        const val KEY_ADDRESS = "printer_address"
        const val KEY_MODEL = "printer_model"
        const val KEY_FIRMWARE = "printer_firmware"
        const val KEY_LAST_OK = "printer_last_ok"
        const val KEY_LAST_STATUS = "printer_last_status"
        const val KEY_JOBS = "recent_job_ids"
        const val KEY_JOB_ORDER = "recent_job_ids_order"
        const val SEPARATOR = "\n"
        const val KEY_BRIDGE = "bridge_enabled"
        const val KEY_TOKEN = "bridge_token"
        const val MAX_JOBS = 200
    }
}
