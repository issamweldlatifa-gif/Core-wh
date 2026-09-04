package com.ayrovi.worker.scanner

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Bundle
import androidx.core.content.ContextCompat

/**
 * Honeywell rugged-device scanner integration (CT40 / CT30 / CN80 ...).
 *
 * A CT40 has TWO scanners: the phone-style camera (read by [CameraScanner])
 * and a dedicated 1D/2D **imager** fired by the physical SIDE TRIGGER. The
 * imager does not go through the camera pipeline — Honeywell's scanner
 * service broadcasts the decoded value and the app must listen for it.
 *
 * We use the official **Data Collection Intent API** (no Honeywell SDK jar
 * needed): claim the imager by intent, then receive barcode broadcasts while
 * the station screen is active. Whatever value arrives is pushed into the
 * same [ScanCoordinator] as camera/OCR values, so dedupe/debounce/validate
 * behaviour is identical — a scan is a scan regardless of its source.
 *
 * On non-Honeywell phones [start] is a no-op and the camera stays the only
 * source, so normal phone behaviour is unchanged.
 */
class HoneywellScanner(
    context: Context,
    private val onBarcode: (value: String) -> Unit,
) {
    private val appContext = context.applicationContext
    private var receiver: BroadcastReceiver? = null
    private var claimed = false

    /** Wire the trigger while the workflow screen is active. */
    @SuppressLint("UnspecifiedRegisterReceiverFlag")
    fun start() {
        if (!isHoneywellDevice()) return // phones: camera is the scanner
        if (receiver != null) return

        val r = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                if (!isTrustedSender(getSendingUid())) return
                val value = extractBarcode(intent) ?: return
                onBarcode(value)
            }
        }
        val filter = IntentFilter().apply {
            // The default action Honeywell's scanner service broadcasts on;
            // our claim below pins DPR_DATA_INTENT_ACTION to this same action.
            addAction(ACTION_BARCODE_READ)
            addAction("com.ayrovi.worker.action.BARCODE")
        }
        // RECEIVER_EXPORTED: the Honeywell scanner service (a different app)
        // must be able to deliver barcode broadcasts to us.
        ContextCompat.registerReceiver(
            appContext,
            r,
            filter,
            ContextCompat.RECEIVER_EXPORTED,
        )
        receiver = r
        claimScanner()
    }

    /** Release the imager + stop listening (screen left / app backgrounded). */
    fun stop() {
        receiver?.let { r ->
            try {
                appContext.unregisterReceiver(r)
            } catch (_: IllegalArgumentException) {
                // already unregistered
            }
            receiver = null
        }
        releaseScanner()
    }

    private fun claimScanner() {
        if (claimed) return
        val properties = Bundle().apply {
            // Ask the scanner service to deliver decoded values as a
            // broadcast intent (DataIntent mode) on our chosen action.
            putBoolean("DPR_DATA_INTENT", true)
            putString("DPR_DATA_INTENT_ACTION", ACTION_BARCODE_READ)
        }
        appContext.sendBroadcast(
            Intent(ACTION_CLAIM_SCANNER)
                .putExtra(EXTRA_SCANNER, SCANNER_IMAGER)
                .putExtra(EXTRA_PROPERTIES, properties),
        )
        claimed = true
    }

    private fun releaseScanner() {
        if (!claimed) return
        appContext.sendBroadcast(
            Intent(ACTION_RELEASE_SCANNER)
                .putExtra(EXTRA_SCANNER, SCANNER_IMAGER),
        )
        claimed = false
    }

    /**
     * Only trust broadcasts sent by the Honeywell scanner service (or the
     * system). On Honeywell devices the service runs under a "honeywell"
     * package; spoofing protection keeps a rogue local app from injecting
     * fake barcodes into the receiving flow.
     */
    private fun isTrustedSender(uid: Int): Boolean {
        if (Build.VERSION.SDK_INT < 19) return true
        if (uid == 0 || uid == ProcessInfo.SYSTEM_UID) return true
        val pkgs = appContext.packageManager.getPackagesForUid(uid) ?: return false
        return pkgs.any { it.contains("honeywell", ignoreCase = true) }
    }

    private fun extractBarcode(intent: Intent?): String? {
        if (intent == null) return null
        for (key in BARCODE_EXTRA_CANDIDATES) {
            intent.getStringExtra(key)
                ?.trim()
                ?.takeIf { it.isNotEmpty() }
                ?.let { return it }
        }
        // Fallback: some profiles deliver the code as the intent data URI.
        intent.data?.toString()?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
        return null
    }

    private object ProcessInfo {
        const val SYSTEM_UID = 1000
    }

    companion object {
        /** Source label reported to the warehouse API (receiving audit). */
        const val SOURCE = "EXTERNAL_SCANNER"

        // --- Data Collection Intent API constants ---------------------------
        private const val ACTION_CLAIM_SCANNER =
            "com.honeywell.aidc.action.ACTION_CLAIM_SCANNER"
        private const val ACTION_RELEASE_SCANNER =
            "com.honeywell.aidc.action.ACTION_RELEASE_SCANNER"
        private const val ACTION_BARCODE_READ =
            "com.honeywell.aidc.action.ACTION_BARCODE_READ_EVENT"

        private const val EXTRA_SCANNER = "com.honeywell.aidc.extra.EXTRA_SCANNER"
        private const val EXTRA_PROPERTIES = "com.honeywell.aidc.extra.EXTRA_PROPERTIES"

        // The internal 1D/2D imager fired by the side trigger.
        private const val SCANNER_IMAGER = "dcs.scanner.imager"

        private val BARCODE_EXTRA_CANDIDATES = listOf(
            "data",
            "com.honeywell.aidc.extra.EXTRA_BARCODE_DATA",
            "barcodeData",
            "com.honeywell.scanner.extra.DATA",
            "SCAN_DATA",
        )

        /** True on Honeywell rugged devices (CT40/CT30/CN80/...). */
        fun isHoneywellDevice(): Boolean {
            val manufacturer = Build.MANUFACTURER ?: ""
            val brand = Build.BRAND ?: ""
            return manufacturer.contains("honeywell", ignoreCase = true) ||
                brand.contains("honeywell", ignoreCase = true)
        }
    }
}
