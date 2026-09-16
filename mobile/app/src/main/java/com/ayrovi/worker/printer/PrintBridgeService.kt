package com.ayrovi.worker.printer

import android.app.Service
import android.bluetooth.BluetoothDevice
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.IBinder
import com.ayrovi.worker.AyroviWorkerApplication
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * PRINT BRIDGE SERVICE — hosts the loopback HTTP server + the printer
 * manager while the worker app lives on the CT40 (started from the app's
 * SETTINGS sheet / app open; auto-restore on app start when enabled).
 * Plain started service: the admin prints while the app process is alive.
 */
class PrintBridgeService : Service() {

    private var server: PrintBridgeServer? = null
    private var manager: PrinterManager? = null
    private var finder: BtPrinterFinder? = null

    /** PRINT AGENT (open item «PC → CT40 printer»): while this service runs,
     *  the app also claims the labels queued for this worker's stations and
     *  prints them on the paired printer. Same lifecycle as the bridge, same
     *  already-paired link — no extra permission dance, nothing to enable. */
    private var agentRunner: PrintAgentRunner? = null
    private val agentScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val aclReceiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
            if (intent.action == BluetoothDevice.ACTION_ACL_DISCONNECTED) {
                manager?.onConnectionLost("ACL_DISCONNECTED")
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        val store = PrinterStore(this)
        val scanFinder = BtPrinterFinder(this)
        finder = scanFinder
        // ONE SPP link shared by manager + queue — two transports would mean
        // the queue writing to a socket that was never connected. Same rule for
        // the finder: the manager and the /printers routes get the SAME object,
        // so there is exactly one discovery component on this device.
        val spp = SppPrinterTransport(this)
        val queue = PrintQueue(spp, store)
        val mgr = PrinterManager(store, spp, scanFinder, queue)
        manager = mgr
        BridgeStatus.attach(mgr)
        androidx.core.content.ContextCompat.registerReceiver(
            this, aclReceiver, IntentFilter(BluetoothDevice.ACTION_ACL_DISCONNECTED),
            androidx.core.content.ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        server = PrintBridgeServer(PrintBridgeServer.DEFAULT_PORT, store.bridgeToken()) { request ->
            handle(request, mgr, finder!!, store)
        }
        server?.start()
        BridgeStatus.bridgeRunning.value = true

        // The agent only needs the worker's own session (WorkerTransport) — the
        // server scopes every label to the stations assigned to that worker.
        runCatching {
            val container = (application as AyroviWorkerApplication).container
            agentRunner = PrintAgentRunner(container.repository.transport, mgr, store, agentScope) { printed, error ->
                BridgeStatus.agentPrinted.value += printed
                BridgeStatus.agentDetail.value = error
                BridgeStatus.agentLastCycleAt.value = System.currentTimeMillis()
            }.also { it.start() }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        BridgeStatus.bridgeRunning.value = false
        agentRunner?.stop()
        agentScope.cancel()
        server?.shutdown()
        manager?.disconnect()
        finder?.stopScan()
        manager = null
        runCatching { unregisterReceiver(aclReceiver) }
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ------------------------------------------------------------ HTTP routes

    private fun handle(request: PrintBridgeServer.Request, mgr: PrinterManager, finder: BtPrinterFinder, store: PrinterStore): PrintBridgeServer.Response {
        val json = { v: String -> PrintBridgeServer.jsonEscape(v) }
        return when {
            request.method == "GET" && request.path == "/status" -> {
                val s = mgr.status()
                PrintBridgeServer.Response(
                    200,
                    """{"bridge":true,"state":"${s.state}","printer":{"name":"${json(s.connectedName ?: s.savedPrinter?.name ?: "")}",""" +
                        """"address":"${json(s.connectedAddress ?: s.savedPrinter?.address ?: "")}",""" +
                        """"firmware":"${json(s.firmware ?: s.savedPrinter?.firmware ?: "")}"},""" +
                        """"detail":"${json(mgr.lastError?.userMessage ?: "")}"}""",
                )
            }
            request.method == "GET" && request.path == "/printers" -> {
                val list = mgr.bondedPrinters()
                val items = list.joinToString(",") { p ->
                    """{"name":"${json(p.name)}","address":"${json(p.address)}","likely":${BtPrinterFinder.isLikelyPrinter(p.name, null)}}"""
                }
                PrintBridgeServer.Response(200, """{"printers":[$items]}""")
            }
            request.method == "POST" && request.path == "/printers/scan" -> {
                val found = StringBuilder()
                var done = false
                val started = finder.startScan(
                    onDevice = { p -> if (BtPrinterFinder.isLikelyPrinter(p.name, null)) found.append(if (found.isEmpty()) "" else ",").append("""{"name":"${json(p.name)}","address":"${json(p.address)}","likely":true}""") },
                    onFinished = { done = true },
                )
                if (!started) {
                    PrintBridgeServer.Response(409, """{"error":"SCAN_NOT_STARTED","detail":"${json(mgr.lastError?.userMessage ?: "Bluetooth is disabled.")}"}""")
                } else {
                    // Bounded wait (task §9): ~11 s of discovery, then stop.
                    val deadline = System.currentTimeMillis() + 11_000
                    while (!done && System.currentTimeMillis() < deadline) Thread.sleep(250)
                    finder.stopScan()
                    val extra = mgr.bondedPrinters().filter { BtPrinterFinder.isLikelyPrinter(it.name, null) }
                        .joinToString(",") { p -> """{"name":"${json(p.name)}","address":"${json(p.address)}","likely":true}""" }
                    val merged = listOf(found.toString(), extra).filter { it.isNotEmpty() }.joinToString(",")
                    PrintBridgeServer.Response(200, """{"printers":[$merged]}""")
                }
            }
            request.method == "POST" && request.path == "/connect" -> {
                val address = jsonField(request.body, "address")
                val name = jsonField(request.body, "name")
                val ok = if (address != null) mgr.connect(address, name) else false
                if (ok) PrintBridgeServer.Response(200, """{"ok":true,"state":"${mgr.state}"}""")
                else PrintBridgeServer.Response(409, """{"ok":false,"error":"${json(mgr.lastError?.code ?: "CONNECT_FAILED")}","detail":"${json(mgr.lastError?.userMessage ?: "Printer not found.")}"}""")
            }
            request.method == "POST" && request.path == "/disconnect" -> {
                val saved = mgr.status().savedPrinter
                mgr.disconnect()
                // Keep the saved printer for auto-reconnect; just report.
                PrintBridgeServer.Response(200, """{"ok":true,"state":"${mgr.state}","saved":"${json(saved?.address ?: "")}"}""")
            }
            request.method == "POST" && request.path == "/reconnect" -> {
                val ok = mgr.reconnect()
                if (ok) PrintBridgeServer.Response(200, """{"ok":true,"state":"${mgr.state}"}""")
                else PrintBridgeServer.Response(409, """{"ok":false,"error":"${json(mgr.lastError?.code ?: "NO_PRINTER")}","detail":"${json(mgr.lastError?.userMessage ?: "Printer unavailable.")}"}""")
            }
            request.method == "POST" && request.path == "/forget" -> {
                store.clearSaved()
                mgr.disconnect()
                PrintBridgeServer.Response(200, """{"ok":true}""")
            }
            request.method == "POST" && (request.path == "/print" || request.path == "/print/test" || request.path == "/print/qr" || request.path == "/print/barcode") -> {
                // The id is the duplicate-protection key (queue + server). A
                // made-up id per request would give every retry a fresh label,
                // so a caller that sends none is answered, not served.
                val jobId = jsonField(request.body, "jobId")
                if (jobId.isNullOrBlank()) {
                    return PrintBridgeServer.Response(
                        400,
                        """{"ok":false,"error":"JOB_ID_REQUIRED","detail":"Send a jobId — it is what stops the same label printing twice."}""",
                    )
                }
                val outcome = when (request.path) {
                    "/print/test" -> mgr.testPrint(jobId, jsonField(request.body, "printerName"))
                    "/print/qr" -> mgr.printQrLabel(jobId, labelFrom(request.body))
                    "/print/barcode" -> mgr.printBarcodeLabel(jobId, labelFrom(request.body))
                    else -> {
                        val kind = jsonField(request.body, "kind") ?: "test"
                        when (kind) {
                            "test" -> mgr.testPrint(jobId, jsonField(request.body, "printerName"))
                            "qr" -> mgr.printQrLabel(jobId, labelFrom(request.body))
                            else -> mgr.printBarcodeLabel(jobId, labelFrom(request.body))
                        }
                    }
                }
                if (outcome.ok) {
                    PrintBridgeServer.Response(200, """{"ok":true,"duplicate":${outcome.duplicate},"jobId":"${json(jobId)}","state":"${mgr.state}"}""")
                } else {
                    PrintBridgeServer.Response(409, """{"ok":false,"error":"${json(outcome.error?.code ?: "PRINT_FAILED")}","detail":"${json(outcome.error?.userMessage ?: "Printing failed. Check the printer.")}"}""")
                }
            }
            else -> PrintBridgeServer.Response(404, """{"error":"NOT_FOUND"}""")
        }
    }

    /** Minimal JSON string-field reader (no org.json — unit-test-free zone). */
    private fun jsonField(body: String, field: String): String? {
        val needle = "\"$field\""
        val keyIdx = body.indexOf(needle)
        if (keyIdx < 0) return null
        var i = keyIdx + needle.length
        while (i < body.length && body[i] != ':') i += 1
        i += 1
        while (i < body.length && body[i].isWhitespace()) i += 1
        if (i >= body.length || body[i] != '"') return null
        i += 1
        val sb = StringBuilder()
        while (i < body.length) {
            val c = body[i]
            if (c == '\\' && i + 1 < body.length) {
                when (body[i + 1]) {
                    'n' -> sb.append('\n'); 't' -> sb.append('\t'); 'r' -> sb.append('\r')
                    '"' -> sb.append('"'); '\\' -> sb.append('\\')
                    else -> sb.append(body[i + 1])
                }
                i += 2
            } else if (c == '"') {
                return sb.toString()
            } else {
                sb.append(c); i += 1
            }
        }
        return sb.toString()
    }

    private fun labelFrom(body: String): LabelSpec = LabelSpec(
        title = jsonField(body, "title"),
        customerName = jsonField(body, "customerName"),
        containerCode = jsonField(body, "containerCode"),
        section = jsonField(body, "section"),
        qrPayload = jsonField(body, "qrPayload"),
        barcodeValue = jsonField(body, "barcodeValue"),
    )

    /** Observable state for the in-app SETTINGS sheet. */
    object BridgeStatus {
        val bridgeRunning = MutableStateFlow(false)
        val printerState = MutableStateFlow(PrinterConnectionState.DISCONNECTED)
        val detail = MutableStateFlow<String?>(null)
        /** PRINT AGENT liveness — what the terminal shows instead of guessing. */
        val agentPrinted = MutableStateFlow(0)
        val agentDetail = MutableStateFlow<String?>(null)
        val agentLastCycleAt = MutableStateFlow<Long?>(null)
        private var manager: PrinterManager? = null

        fun attach(mgr: PrinterManager) {
            manager = mgr
            printerState.value = mgr.state
            mgr.addListener { state, detail ->
                printerState.value = state
                this.detail.value = detail
            }
        }
    }
}
