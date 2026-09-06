package com.ayrovi.worker.scanner

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import androidx.core.content.ContextCompat

/** Managed DataWedge profile required; broadcasts are untrusted input, never authorization. */
class ZebraDataWedgeScanner(context: Context, private val onBarcode: (String, ScanSymbology) -> Unit) {
    private val context = context.applicationContext
    private var receiver: BroadcastReceiver? = null

    fun start() {
        if (!isZebraDevice() || receiver != null) return
        val listener = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                if (intent?.action != SCAN_ACTION) return
                val raw = intent.getStringExtra("com.symbol.datawedge.data_string") ?: return
                val label = intent.getStringExtra("com.symbol.datawedge.label_type").orEmpty()
                onBarcode(raw, if (label.contains("QRCODE", ignoreCase = true)) ScanSymbology.QR else ScanSymbology.BARCODE)
            }
        }
        ContextCompat.registerReceiver(context, listener,
            IntentFilter(SCAN_ACTION).apply { addCategory(Intent.CATEGORY_DEFAULT) }, ContextCompat.RECEIVER_EXPORTED)
        receiver = listener
    }

    fun softTrigger(): Boolean {
        if (receiver == null) return false
        command("START_SCANNING")
        return true
    }

    fun stop() {
        if (receiver != null) command("STOP_SCANNING")
        receiver?.let { runCatching { context.unregisterReceiver(it) } }
        receiver = null
    }

    private fun command(value: String) {
        context.sendBroadcast(Intent("com.symbol.datawedge.api.ACTION")
            .setPackage("com.symbol.datawedge")
            .putExtra("com.symbol.datawedge.api.SOFT_SCAN_TRIGGER", value))
    }

    companion object {
        const val SCAN_ACTION = "com.ayrovi.worker.SCAN"
        fun isZebraDevice() = listOf(Build.MANUFACTURER, Build.BRAND).any { brand ->
            listOf("zebra", "symbol", "motorola solutions").any { brand.orEmpty().contains(it, ignoreCase = true) }
        }
    }
}
