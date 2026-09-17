package com.ayrovi.worker.printer

import android.content.Context

/**
 * THE PRINTER RUNTIME — ONE printer stack for the whole process.
 *
 * There must never be two [PrinterManager]s in one app: two of them would own
 * two RFCOMM sockets to the same printer, two duplicate-protection windows and
 * two finders, and the queue's "one job in flight" rule would stop meaning
 * anything (owner standing rule: no parallel printer implementation, no
 * duplicated manager/service/listener).
 *
 * The stack used to be built inside [com.ayrovi.worker.printer.PrintBridgeService],
 * which made the printer reachable ONLY through the loopback bridge — i.e. only
 * from the web admin on this device, and only while the bridge was enabled. The
 * CT40 app itself has a printer screen now, so the printer has to exist whether
 * or not the bridge is on: the stack lives here, the service and the UI both
 * borrow it, and the singleton is what guarantees they are the same object.
 *
 * Nothing here holds a socket: [PrinterManager.connect] does that on demand, and
 * the link stays open for whichever caller needs it next.
 */
object PrinterRuntime {

    /** The process-wide printer objects (one instance each, forever). */
    class Stack internal constructor(
        val store: PrinterStore,
        val transport: SppPrinterTransport,
        val finder: BtPrinterFinder,
        val queue: PrintQueue,
        val manager: PrinterManager,
    )

    @Volatile
    private var stack: Stack? = null

    /**
     * The ONE stack. Safe to call from any thread and from any component
     * (service, Compose UI) — the first caller builds it, everybody else gets
     * the same objects.
     */
    @Synchronized
    fun of(context: Context): Stack = stack ?: run {
        val app = context.applicationContext
        val store = PrinterStore(app)
        // ONE SPP link shared by manager + queue: two transports would mean the
        // queue writing to a socket that was never connected.
        val spp = SppPrinterTransport(app)
        val finder = BtPrinterFinder(app)
        // …and ONE queue for that link: the same instance for the manager and
        // for anyone reading the stack, never a second executor.
        val queue = PrintQueue(spp, store)
        val manager = PrinterManager(store, spp, finder, queue)
        Stack(store, spp, finder, queue = queue, manager = manager)
            .also {
                stack = it
                // The terminal shows the SAME state the printer screen drives —
                // attached once, here, so no second listener is ever added.
                PrintBridgeService.BridgeStatus.attach(manager)
            }
    }
}
