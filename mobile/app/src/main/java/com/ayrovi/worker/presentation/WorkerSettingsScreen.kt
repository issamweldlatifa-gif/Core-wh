package com.ayrovi.worker.presentation

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ayrovi.worker.data.ReportHistoryRow
import com.ayrovi.worker.data.WorkerRepository
import com.ayrovi.worker.design.*
import com.ayrovi.worker.domain.MessageTone
import com.ayrovi.worker.domain.OperationalMessage
import com.ayrovi.worker.scanner.WorkerDevice
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * WORKER SETTINGS — secondary/system actions moved OUT of the operational
 * Home queue (Order §11/§17). Home stays focused on receiving work; Settings
 * groups Account / Operations / Support / System. No internal database ids,
 * no API/debug dumps — only operationally useful information (app version,
 * connection, device class).
 */

internal enum class SupportForm { NONE, REPORT, PROBLEM }

/** Problem categories reuse the operational language of the receiving floor. */
internal enum class ProblemCategory(val label: String, val backendType: String) {
    SCANNER("Scanner problem", "SCANNER_PROBLEM"),
    OCR("OCR / label reading problem", "OCR_PROBLEM"),
    CARD("Card problem (product / carton)", "CARD_PROBLEM"),
    NETWORK("Network / connection problem", "NETWORK_PROBLEM"),
    BATCH("Batch problem", "BATCH_PROBLEM"),
    OTHER("Other problem", "MANUAL_REPORT");

    companion object {
        /**
         * ORDER 01 follow-up (settings cleanup): the picker lists the flows
         * that actually exist on THIS build. The CT40 app has no OCR / card
         * lane (camera tools are imager-replaced), and batch problems only
         * exist where the batch station is served.
         */
        fun forDevice(device: WorkerDevice, hasBatch: Boolean): List<ProblemCategory> = when {
            device == WorkerDevice.CT40 -> buildList {
                add(SCANNER); if (hasBatch) add(BATCH); add(NETWORK); add(OTHER)
            }
            else -> entries.toList()
        }
    }
}

internal data class WorkerSettingsState(
    val busy: Boolean = false,
    val sent: Boolean = false,
    val form: SupportForm = SupportForm.NONE,
    val message: OperationalMessage? = null,
    /** REPORT HISTORY (settings only): null = not loaded yet. */
    val history: List<ReportHistoryRow>? = null,
    val historyLoading: Boolean = false,
)

internal class WorkerSettingsViewModel(
    private val repository: WorkerRepository,
    private val appVersion: String,
    private val deviceCode: String,
    private val deviceClass: String,
) : ViewModel() {
    private val mutable = MutableStateFlow(WorkerSettingsState())
    val state = mutable.asStateFlow()

    /**
     * REPORT HISTORY lives ONLY here (§5): past reported sessions, newest
     * first. Loaded once per dialog open; never shown in the operational UI.
     */
    fun loadHistory() {
        if (mutable.value.history != null || mutable.value.historyLoading) return
        mutable.update { it.copy(historyLoading = true) }
        viewModelScope.launch {
            try {
                val rows = repository.reportHistory()
                mutable.update { it.copy(historyLoading = false, history = rows) }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) {
                mutable.update { it.copy(historyLoading = false, history = emptyList()) }
            }
        }
    }

    fun openReport() = mutable.update { it.copy(form = SupportForm.REPORT, sent = false, message = null) }
    fun openProblem() = mutable.update { it.copy(form = SupportForm.PROBLEM, sent = false, message = null) }
    fun closeForm() = mutable.update { it.copy(form = SupportForm.NONE, message = null) }

    /**
     * Submit a support item through the EXISTING backend exceptions endpoint.
     * Diagnostic context (device id, app version, device class, timestamp) is
     * attached server-side metadata-safe: it is sent in the reason text only as
     * operational context the supervisor needs, never as credentials/IDs the
     * worker must interpret.
     */
    fun submit(kind: SupportForm, category: ProblemCategory?, description: String, reference: String) {
        if (mutable.value.busy) return
        val detail = description.trim()
        if (detail.length < 5) {
            mutable.update { it.copy(message = OperationalMessage("DETAILS REQUIRED", "Describe the issue in a few words so the supervisor can help.", MessageTone.ERROR)) }
            return
        }
        mutable.update { it.copy(busy = true, message = null) }
        viewModelScope.launch {
            try {
                val stage = if (kind == SupportForm.PROBLEM) "WORKER_APP:PROBLEM" else "WORKER_APP:REPORT"
                val type = category?.backendType ?: "OPERATIONAL_REPORT"
                val context = "device ${deviceClass} · app $appVersion · ${deviceCode.take(6)}… · ${java.time.Instant.now()}"
                val ref = reference.trim().ifBlank { null }
                val reason = buildString {
                    append(detail)
                    if (!ref.isNullOrBlank()) append(" · ref: $ref")
                    append(" (").append(context).append(")")
                }.take(900)
                repository.reportProblem(stage = stage, type = type, reason = reason, entityCode = ref)
                mutable.update {
                    it.copy(busy = false, sent = true, form = SupportForm.NONE,
                        message = OperationalMessage("REPORT SENT", "Your report was sent to the supervisor.", MessageTone.SUCCESS))
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) {
                mutable.update {
                    it.copy(busy = false, message = OperationalMessage("REPORT NOT SENT",
                        "The report could not be sent. Check the connection and try again.", MessageTone.ERROR))
                }
            }
        }
    }
}

@Composable
fun WorkerSettingsDialog(
    repository: WorkerRepository?,
    worker: String,
    station: String?,
    connection: String,
    appVersion: String,
    deviceCode: String,
    device: WorkerDevice,
    onClose: () -> Unit,
    onChangeDisplay: (() -> Unit)? = null,
    gloveOn: Boolean = false,
    onToggleGlove: (() -> Unit)? = null,
    glareOn: Boolean = false,
    onToggleGlare: (() -> Unit)? = null,
    /** v1.7.5: wipe operational traces stored on this device (two-tap confirm). */
    onPurgeData: (() -> Unit)? = null,
    /** ORDER 01 follow-up: whether THIS worker serves receiving at all — gates receiving-only sections. */
    receivingVisible: Boolean = true,
    /** PRINTER MANAGER (2026-09-15): local Bluetooth print bridge for the
     *  Admin web on THIS device. Null callbacks hide the section (phone). */
    printerBridgeRunning: Boolean = false,
    /** Why the bridge is NOT listening (port busy, …). Never shown as «RUNNING». */
    printerBridgeError: String? = null,
    printerBridgeState: String? = null,
    onTogglePrinterBridge: (() -> Unit)? = null,
) {
    val vm: WorkerSettingsViewModel? = if (repository != null) viewModel(
        factory = factory {
            WorkerSettingsViewModel(repository, appVersion, deviceCode,
                if (device == WorkerDevice.CT40) "CT40" else "PHONE")
        },
    ) else null
    val fallback = remember { mutableStateOf(WorkerSettingsState()) }
    var confirmPurge by remember { mutableStateOf(false) }
    var purged by remember { mutableStateOf(false) }
    val state by (vm?.state?.collectAsStateWithLifecycle() ?: fallback)
    val model = vm // non-null inside the branch; safe to capture

    AlertDialog(
        onDismissRequest = { if (!state.busy) onClose() },
        title = { Text("SETTINGS") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(TerminalTokens.sm)) {
                state.message?.let { OperationalMessageView(it) }

                SettingsGroup("ACCOUNT") {
                    Text(worker, style = MaterialTheme.typography.titleMedium)
                    station?.let { Text("Station · $it", style = MaterialTheme.typography.bodyMedium) }
                }

                if (onTogglePrinterBridge != null) {
                    SettingsGroup("PRINTER BRIDGE") {
                        Text(
                            if (printerBridgeRunning) "RUNNING · 127.0.0.1:8787" else "OFF",
                            style = MaterialTheme.typography.titleMedium,
                            color = if (printerBridgeRunning) TerminalTokens.success else TerminalTokens.muted,
                        )
                        Text(
                            when {
                                printerBridgeError != null ->
                                    "BRIDGE FAILED: $printerBridgeError — disable and enable it again (another app may hold port 8787)."
                                else -> printerBridgeState ?: "Local print service for the Admin web (labels over Bluetooth)."
                            },
                            style = MaterialTheme.typography.bodySmall,
                            color = if (printerBridgeError != null) TerminalTokens.warning else TerminalTokens.muted,
                        )
                        SecondaryAction(
                            if (printerBridgeRunning) "DISABLE BRIDGE" else "ENABLE BRIDGE",
                            onTogglePrinterBridge,
                            true,
                        )
                    }
                }

                SettingsGroup("OPERATIONS") {
                    // ORDER 01 follow-up: "SWITCH MODE" removed — its only
                    // effect was closing this dialog (a dead control).
                    onChangeDisplay?.let { SecondaryAction("CHANGE DISPLAY", it, !state.busy) }
                    onToggleGlove?.let { SecondaryAction(if (gloveOn) "GLOVE MODE: ON" else "GLOVE MODE: OFF", it, !state.busy) }
                }

                // ORDER 01 follow-up: RAPPORT HISTORY is receiving-session
                // history — a station whose task set has no receiving sees
                // nothing here instead of a permanently empty section.
                if (model != null && receivingVisible) {
                    LaunchedEffect(Unit) { model.loadHistory() }
                    SettingsGroup("RAPPORT HISTORY") {
                        ReportHistoryBody(state)
                    }
                }

                if (model != null) SettingsGroup("SUPPORT") {
                    SecondaryAction("SEND REPORT", { model.openReport() }, !state.busy, Modifier.fillMaxWidth().testTag("SETTINGS_SEND_REPORT"))
                    SecondaryAction("REPORT A PROBLEM", { model.openProblem() }, !state.busy, Modifier.fillMaxWidth().testTag("SETTINGS_REPORT_PROBLEM"))
                }

                SettingsGroup("SYSTEM") {
                    Text("App version · $appVersion", style = MaterialTheme.typography.bodyMedium)
                    Text("Connection · $connection", style = MaterialTheme.typography.bodyMedium)
                    Text("Device · ${if (device == WorkerDevice.CT40) "CT40 rugged terminal" else "Phone / touch terminal"}",
                        style = MaterialTheme.typography.bodyMedium)
                    if (onPurgeData != null) {
                        if (purged) {
                            TerminalNotice("SESSION DATA CLEARED",
                                "Previous receiving operations were removed from this device.",
                                TerminalTone.SUCCESS)
                        }
                        SecondaryAction(
                            if (confirmPurge) "TAP AGAIN TO CONFIRM" else "CLEAR RECEIVING MARKS",
                            {
                                if (confirmPurge) {
                                    onPurgeData(); purged = true; confirmPurge = false
                                } else confirmPurge = true
                            },
                            !state.busy,
                            Modifier.fillMaxWidth().testTag("SETTINGS_PURGE_DATA"),
                        )
                    }
                }

                SettingsGroup("ABOUT") {
                    Text(if (device == WorkerDevice.CT40) "AYROVI CT40" else "AYROVI Warehouse Worker",
                        style = MaterialTheme.typography.bodyMedium)
                }
            }
        },
        confirmButton = { SecondaryAction("CLOSE", onClose, !state.busy) },
    )

    if (model != null && state.form != SupportForm.NONE) {
        SupportFormDialog(
            isProblem = state.form == SupportForm.PROBLEM,
            busy = state.busy,
            device = device,
            hasBatch = receivingVisible || state.history?.isNotEmpty() == true,
            onSubmit = { category, description, reference -> model.submit(state.form, category, description, reference) },
            onDismiss = { if (!state.busy) model.closeForm() },
        )
    }
}

@Composable
private fun ReportHistoryBody(state: WorkerSettingsState) {
    val rows = state.history
    when {
        rows == null || state.historyLoading ->
            Text("Loading past reports…", style = MaterialTheme.typography.bodyMedium, color = TerminalTokens.muted,
                modifier = Modifier.testTag("HISTORY_LOADING"))
        rows.isEmpty() ->
            Text("No submitted reports yet.", style = MaterialTheme.typography.bodyMedium, color = TerminalTokens.muted,
                modifier = Modifier.testTag("HISTORY_EMPTY"))
        else -> Column(verticalArrangement = Arrangement.spacedBy(TerminalTokens.xxs),
            modifier = Modifier.testTag("HISTORY_LIST")) {
            rows.take(20).forEach { row ->
                Column(Modifier.fillMaxWidth()) {
                    Text(row.sessionCode, style = MaterialTheme.typography.titleSmall)
                    Text(
                        listOfNotNull(
                            row.arrivalCode?.let { "Arrival $it" },
                            row.reportStatus?.let { "Report $it" },
                            row.submittedAt?.take(10)?.let { "Sent $it" },
                        ).joinToString(" · ").ifBlank { row.status },
                        style = MaterialTheme.typography.bodySmall, color = TerminalTokens.muted,
                    )
                }
            }
        }
    }
}

@Composable
private fun SettingsGroup(title: String, content: @Composable ColumnScope.() -> Unit) {
    TerminalPanel(title) { Column(verticalArrangement = Arrangement.spacedBy(TerminalTokens.xs), content = content) }
}

@Composable
private fun SupportFormDialog(
    isProblem: Boolean,
    busy: Boolean,
    device: WorkerDevice,
    hasBatch: Boolean,
    onSubmit: (ProblemCategory?, String, String) -> Unit,
    onDismiss: () -> Unit,
) {
    var description by remember { mutableStateOf("") }
    var reference by remember { mutableStateOf("") }
    var category by remember { mutableStateOf(if (isProblem) ProblemCategory.SCANNER else null) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (isProblem) "REPORT A PROBLEM" else "SEND REPORT") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(TerminalTokens.sm)) {
                if (isProblem) {
                    Text("What is the problem?", style = MaterialTheme.typography.labelMedium)
                    ProblemCategory.forDevice(device, hasBatch).forEach { c ->
                        SecondaryAction(c.label, { category = c }, true, Modifier.fillMaxWidth())
                    }
                    Text("Selected · ${category?.label ?: "—"}", style = MaterialTheme.typography.bodyMedium, color = TerminalTokens.muted)
                }
                TerminalTextInput("DESCRIPTION", description, { description = it.take(900) }, enabled = !busy)
                TerminalTextInput("CARD / TASK REFERENCE (OPTIONAL)", reference, { reference = it.take(120) }, enabled = !busy)
            }
        },
        confirmButton = {
            PrimaryAction("SEND", { onSubmit(category, description, reference) },
                !busy && description.trim().length >= 5)
        },
        dismissButton = { SecondaryAction("CANCEL", onDismiss, !busy) },
    )
}
