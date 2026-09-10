package com.ayrovi.worker.presentation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.ayrovi.worker.data.ShipResult
import com.ayrovi.worker.data.ShipmentView
import com.ayrovi.worker.data.TraceChain
import com.ayrovi.worker.data.TraceView
import com.ayrovi.worker.data.WorkerRepository
import com.ayrovi.worker.domain.AudioFeedback
import com.ayrovi.worker.domain.MessageTone
import com.ayrovi.worker.domain.OperationalMessage
import com.ayrovi.worker.scanner.ScannerManager
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** SHIPPING + TRACE gateways — the frozen app's fulfillment shipping contract. */
interface ShippingGateway {
    suspend fun scan(code: String): ShipmentView
    suspend fun ship(code: String): ShipResult
}

class RepoShippingGateway(private val repo: WorkerRepository) : ShippingGateway {
    override suspend fun scan(code: String): ShipmentView = repo.shippingScan(code)
    override suspend fun ship(code: String): ShipResult = repo.ship(code)
}

interface TraceGateway {
    suspend fun trace(code: String): TraceView
}

class RepoTraceGateway(private val repo: WorkerRepository) : TraceGateway {
    override suspend fun trace(code: String): TraceView = repo.trace(code)
}

data class ShippingUiState(
    val busy: Boolean = false,
    val view: ShipmentView? = null,
    val shippedToday: Int = 0,
    val message: OperationalMessage? = null,
    val scanEpoch: Int = 0,
    val authExpired: Boolean = false,
)

data class TraceUiState(
    val busy: Boolean = false,
    val view: TraceView? = null,
    val message: OperationalMessage? = null,
    val scanEpoch: Int = 0,
    val authExpired: Boolean = false,
)

/**
 * SHIPPING station view model (native worker app / CT40).
 *
 * Dispatch is irreversible — the ONE deliberate confirm button in the whole
 * app lives here. Scanning a shipment reveals its cards (destination,
 * contents); CONFIRM DISPATCH creates the green DISPATCHED flash which
 * re-arms for the next carton. An already-shipped label is a persistent
 * amber stop verdict; the next hardware scan replaces any verdict (§28).
 */
class ShippingViewModel(
    private val gateway: ShippingGateway,
    private val audio: AudioFeedback = AudioFeedback.Silent,
) : ViewModel() {
    private val mutable = MutableStateFlow(ShippingUiState())
    val state = mutable.asStateFlow()
    val scanner = ScannerManager()

    private var foreground = false
    private var available = true

    val captureAllowed: Boolean get() = foreground && available && !mutable.value.busy

    fun setForeground(value: Boolean) {
        foreground = value
    }

    fun setAvailable(value: Boolean) {
        available = value
    }

    private fun signal(tone: MessageTone) {
        if (!foreground) return
        when (tone) {
            MessageTone.SUCCESS -> audio.success()
            MessageTone.ERROR -> audio.error()
            MessageTone.WARNING -> audio.warning()
            MessageTone.INFO -> Unit
        }
    }

    fun onScan(result: com.ayrovi.worker.scanner.ScanResult) = scan(result.value)

    fun scan(value: String) {
        val current = mutable.value
        if (current.busy) return
        val term = value.trim()
        if (term.isEmpty()) return
        mutable.value = current.copy(busy = true, message = null)
        viewModelScope.launch {
            try {
                val s = gateway.scan(term)
                if (s.status == "SHIPPED") {
                    mutable.value = ShippingUiState(
                        busy = false, scanEpoch = mutable.value.scanEpoch + 1,
                        message = OperationalMessage("ALREADY SHIPPED", s.code, MessageTone.WARNING),
                    )
                    signal(MessageTone.WARNING)
                } else {
                    // Guidance only — no overlay: the cards + CONFIRM are the work interface.
                    mutable.value = mutable.value.copy(
                        busy = false, view = s, scanEpoch = mutable.value.scanEpoch + 1,
                        message = OperationalMessage("CONFIRM DISPATCH", "${s.code} · carrier ${s.carrier ?: "internal"}", MessageTone.INFO),
                    )
                    signal(MessageTone.INFO)
                }
            } catch (ex: WorkerRepository.ApiException) {
                if (ex.code == 401) {
                    mutable.value = mutable.value.copy(busy = false, authExpired = true)
                } else {
                    stop("NOT FOUND", ex.message ?: term, MessageTone.ERROR)
                }
            } catch (ex: Exception) {
                stop("ERROR", ex.message ?: "The request failed.", MessageTone.ERROR)
            }
        }
    }

    /** The deliberate dispatch confirmation (irreversible). */
    fun confirmDispatch() {
        val current = mutable.value
        val s = current.view ?: return
        if (current.busy || s.status == "SHIPPED") return
        mutable.value = current.copy(busy = true, message = null)
        viewModelScope.launch {
            try {
                gateway.ship(s.code)
                mutable.value = mutable.value.copy(
                    busy = false, view = null, shippedToday = mutable.value.shippedToday + 1,
                    scanEpoch = mutable.value.scanEpoch + 1,
                    message = OperationalMessage("DISPATCHED", s.code, MessageTone.SUCCESS),
                )
                signal(MessageTone.SUCCESS)
            } catch (ex: WorkerRepository.ApiException) {
                if (ex.code == 401) {
                    mutable.value = mutable.value.copy(busy = false, authExpired = true)
                } else {
                    stop("COULD NOT SHIP", ex.message ?: s.code, MessageTone.ERROR)
                }
            } catch (ex: Exception) {
                stop("COULD NOT SHIP", ex.message ?: "The request failed.", MessageTone.ERROR)
            }
        }
    }

    private fun stop(title: String, detail: String, tone: MessageTone) {
        mutable.value = mutable.value.copy(busy = false, scanEpoch = mutable.value.scanEpoch + 1,
            message = OperationalMessage(title, detail, tone))
        signal(tone)
    }

    fun dismissResult() {
        mutable.value = mutable.value.copy(message = null)
    }

    fun clearView() {
        mutable.value = mutable.value.copy(view = null, message = null, scanEpoch = mutable.value.scanEpoch + 1)
    }
}

/**
 * ARCHIVE / TRACE station view model — read-only lookup: scan an article,
 * see its full chain. Any worker can consult it; nothing is written.
 */
class TraceViewModel(
    private val gateway: TraceGateway,
    private val audio: AudioFeedback = AudioFeedback.Silent,
) : ViewModel() {
    private val mutable = MutableStateFlow(TraceUiState())
    val state = mutable.asStateFlow()
    val scanner = ScannerManager()

    private var foreground = false
    private var available = true

    val captureAllowed: Boolean get() = foreground && available && !mutable.value.busy

    fun setForeground(value: Boolean) {
        foreground = value
    }

    fun setAvailable(value: Boolean) {
        available = value
    }

    private fun signal(tone: MessageTone) {
        if (!foreground) return
        when (tone) {
            MessageTone.SUCCESS -> audio.success()
            MessageTone.ERROR -> audio.error()
            MessageTone.WARNING -> audio.warning()
            MessageTone.INFO -> Unit
        }
    }

    fun onScan(result: com.ayrovi.worker.scanner.ScanResult) = scan(result.value)

    fun scan(value: String) {
        val current = mutable.value
        if (current.busy) return
        val term = value.trim()
        if (term.isEmpty()) return
        mutable.value = current.copy(busy = true, message = null)
        viewModelScope.launch {
            try {
                val v = gateway.trace(term)
                mutable.value = mutable.value.copy(busy = false, view = v, scanEpoch = mutable.value.scanEpoch + 1)
                signal(MessageTone.INFO)
            } catch (ex: WorkerRepository.ApiException) {
                if (ex.code == 401) {
                    mutable.value = mutable.value.copy(busy = false, authExpired = true)
                } else {
                    stop("NOT FOUND", term, MessageTone.WARNING)
                }
            } catch (ex: Exception) {
                stop("ERROR", ex.message ?: "The request failed.", MessageTone.ERROR)
            }
        }
    }

    private fun stop(title: String, detail: String, tone: MessageTone) {
        mutable.value = mutable.value.copy(busy = false, scanEpoch = mutable.value.scanEpoch + 1,
            message = OperationalMessage(title, detail, tone))
        signal(tone)
    }

    fun dismissResult() {
        mutable.value = mutable.value.copy(message = null)
    }

    fun clearView() {
        mutable.value = mutable.value.copy(view = null, message = null, scanEpoch = mutable.value.scanEpoch + 1)
    }

    /** The stage timeline of a loaded trace (stage name → value or null when pending). */
    fun stages(t: TraceChain?): List<Pair<String, String?>> {
        if (t == null) return emptyList()
        return listOf(
            "ARRIVAL" to t.expectedArrival,
            "INBOUND SHIPMENT" to t.inboundShipment,
            "SOURCE CARTON" to t.sourceCarton,
            "RECEIVING" to t.receivingSession,
            "CONTAINER" to t.container?.let { c -> "${c.label ?: ""} (${c.code})".trim() },
            "STORAGE LOCATION" to t.storageLocation?.let { loc -> "${loc.code} (zone ${loc.zone})" },
            "CUSTOMER ORDER" to t.customerOrder,
            "CUSTOMER" to t.customer,
            "OUTBOUND SHIPMENT" to t.outboundShipment,
            "TRACKING" to t.tracking,
        )
    }
}
