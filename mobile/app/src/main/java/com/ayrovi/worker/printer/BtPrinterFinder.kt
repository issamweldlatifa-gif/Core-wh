package com.ayrovi.worker.printer

import android.annotation.SuppressLint
import android.bluetooth.BluetoothClass
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import androidx.core.content.ContextCompat

/**
 * Bluetooth CLASSIC discovery (task §9): paired devices first, plus a
 * bounded live scan. Printer recognition is HEURISTIC (name patterns +
 * Bluetooth device class) — never a hard-coded MAC.
 */
class BtPrinterFinder(private val context: Context) : PrinterFinder {

    companion object {
        private val NAME_HINTS = Regex("(?i)(pm-?241|phomemo|printer|prt[-_ ]|label|thermal)")
        fun isLikelyPrinter(name: String?, clazz: BluetoothClass?): Boolean {
            if (name != null && NAME_HINTS.containsMatchIn(name)) return true
            if (clazz != null) {
                if (clazz.deviceClass == BluetoothClass.Device.PRINTER) return true
                if (clazz.majorDeviceClass == BluetoothClass.Device.Major.IMAGING) return true
            }
            return false
        }
    }

    private val adapter: BluetoothAdapter?
        get() = (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

    private var receiver: BroadcastReceiver? = null

    @SuppressLint("MissingPermission")
    override fun bonded(): List<PrinterInfo> {
        val bt = adapter ?: throw PrinterException(PrinterError("NO_ADAPTER", "Bluetooth is disabled."))
        if (!bt.isEnabled) throw PrinterException(PrinterError("BT_OFF", "Bluetooth is disabled."))
        val devices = try {
            bt.bondedDevices.orEmpty()
        } catch (e: SecurityException) {
            throw PrinterException(PrinterError("PERMISSION", "Bluetooth permission is required to connect to the printer.", e.message))
        }
        return devices.map { d ->
            PrinterInfo(
                name = d.name ?: d.address,
                address = d.address,
                model = if (isLikelyPrinter(d.name, d.bluetoothClass)) "PM-241 family" else null,
            )
        }.sortedWith(compareByDescending<PrinterInfo> { isLikelyPrinter(it.name, null) }.thenBy { it.name })
    }

    @SuppressLint("MissingPermission")
    override fun startScan(onDevice: (PrinterInfo) -> Unit, onFinished: () -> Unit): Boolean {
        val bt = adapter ?: throw PrinterException(PrinterError("NO_ADAPTER", "Bluetooth is disabled."))
        if (!bt.isEnabled) throw PrinterException(PrinterError("BT_OFF", "Bluetooth is disabled."))
        stopScan()
        val seen = HashSet<String>()
        val recv = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                when (intent.action) {
                    BluetoothDevice.ACTION_FOUND -> {
                        val d: BluetoothDevice = intent.getParcelableExtraCompat(BluetoothDevice.EXTRA_DEVICE) ?: return
                        if (seen.add(d.address)) {
                            onDevice(PrinterInfo(name = d.name ?: d.address, address = d.address))
                        }
                    }
                    BluetoothAdapter.ACTION_DISCOVERY_FINISHED -> onFinished()
                }
            }
        }
        receiver = recv
        val filter = IntentFilter(BluetoothDevice.ACTION_FOUND).apply {
            addAction(BluetoothAdapter.ACTION_DISCOVERY_FINISHED)
        }
        ContextCompat.registerReceiver(context, recv, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        return try {
            bt.startDiscovery()
        } catch (e: SecurityException) {
            stopScan()
            throw PrinterException(PrinterError("PERMISSION", "Bluetooth permission is required to connect to the printer.", e.message))
        }
    }

    @SuppressLint("MissingPermission")
    override fun stopScan() {
        receiver?.let { runCatching { context.unregisterReceiver(it) } }
        receiver = null
        runCatching { adapter?.cancelDiscovery() }
    }
}

/** getParcelableExtra is deprecated on 33+; one small helper keeps it clean. */
private inline fun <reified T : android.os.Parcelable> android.content.Intent.getParcelableExtraCompat(name: String): T? =
    if (android.os.Build.VERSION.SDK_INT >= 33) {
        getParcelableExtra(name, T::class.java)
    } else {
        @Suppress("DEPRECATION")
        getParcelableExtra(name) as? T
    }
