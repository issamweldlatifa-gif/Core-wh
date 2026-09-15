package com.ayrovi.worker.printer

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.content.Context
import java.util.UUID

/**
 * Bluetooth CLASSIC SPP/RFCOMM transport (task §4): standard Android
 * Bluetooth APIs, the SPP UUID, NO Zebra anything, NO system printing.
 * Writes are serialized (one link, one job in flight — task §17).
 */
class SppPrinterTransport(private val context: Context) : PrinterTransport {

    companion object {
        /** Standard Bluetooth Classic Serial Port Profile. */
        private val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
    }

    private val adapter: BluetoothAdapter?
        get() = (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

    @Volatile
    private var socket: android.bluetooth.BluetoothSocket? = null

    @Volatile
    private var currentAddress: String? = null

    override val connected: Boolean
        get() = socket?.isConnected == true

    @SuppressLint("MissingPermission") // BLUETOOTH_CONNECT is enforced by the service before calls.
    override fun connect(address: String) {
        val mgr = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        val bt = mgr?.adapter ?: throw PrinterException(PrinterError("NO_ADAPTER", "Bluetooth is disabled."))
        if (!bt.isEnabled) throw PrinterException(PrinterError("BT_OFF", "Bluetooth is disabled."))
        val device: BluetoothDevice = try {
            bt.getRemoteDevice(address)
        } catch (e: IllegalArgumentException) {
            throw PrinterException(PrinterError("BAD_ADDRESS", "Printer not found.", e.message))
        }
        try {
            bt.cancelDiscovery()
        } catch (_: SecurityException) { /* not fatal */ }
        disconnect()
        val s = try {
            device.createRfcommSocketToServiceRecord(SPP_UUID)
        } catch (e: SecurityException) {
            throw PrinterException(PrinterError("PERMISSION", "Bluetooth permission is required to connect to the printer.", e.message))
        } catch (e: java.io.IOException) {
            throw PrinterException(PrinterError("CONNECT_FAILED", "Printer disconnected.", e.message))
        }
        try {
            s.connect()
        } catch (e: SecurityException) {
            closeQuietly(s)
            throw PrinterException(PrinterError("PERMISSION", "Bluetooth permission is required to connect to the printer.", e.message))
        } catch (e: java.io.IOException) {
            closeQuietly(s)
            throw PrinterException(PrinterError("CONNECT_FAILED", "Printer not found.", e.message ?: "connect failed"))
        }
        socket = s
        currentAddress = address
    }

    override fun write(data: ByteArray) {
        val s = socket ?: throw PrinterException(PrinterError("NOT_CONNECTED", "Printer disconnected."))
        try {
            synchronized(this) {
                s.outputStream.write(data)
                s.outputStream.flush()
            }
        } catch (e: SecurityException) {
            throw PrinterException(PrinterError("PERMISSION", "Bluetooth permission is required to connect to the printer.", e.message))
        } catch (e: java.io.IOException) {
            closeQuietly(s)
            socket = null
            throw PrinterException(PrinterError("LINK_LOST", "Printer connection lost.", e.message))
        }
    }

    override fun disconnect() {
        val s = socket ?: return
        closeQuietly(s)
        socket = null
        currentAddress = null
    }

    private fun closeQuietly(s: android.bluetooth.BluetoothSocket?) {
        try { s?.close() } catch (_: java.io.IOException) { /* already closed */ }
    }
}
