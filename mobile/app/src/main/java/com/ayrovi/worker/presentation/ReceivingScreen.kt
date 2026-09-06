package com.ayrovi.worker.presentation

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ayrovi.worker.design.*
import com.ayrovi.worker.domain.*
import com.ayrovi.worker.presentation.ct40.CT40Receiving
import com.ayrovi.worker.presentation.phone.PhoneReceiving
import com.ayrovi.worker.scanner.WorkerDevice
import com.ayrovi.worker.scanner.rememberScannerCapture

/** The ONLY Receiving route. Shared VM/scanner/dialogs; two intentionally different renderers. */
@Composable
fun ReceivingScreen(
    model: ReceivingViewModel, worker: String, station: String?, connection: String,
    onBack: () -> Unit, onVerifyConnection: () -> Unit, onAuthExpired: () -> Unit,
    device: WorkerDevice = WorkerDevice.PHONE, onToggleTheme: (() -> Unit)? = null,
) {
    val view by model.ui.collectAsStateWithLifecycle()
    val state = view.workflow
    val owner = LocalLifecycleOwner.current
    var menu by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf(false) }
    var details by remember { mutableStateOf(false) }
    var resolve by remember { mutableStateOf<String?>(null) }
    var cameraRequested by remember { mutableStateOf(false) }
    var reason by remember { mutableStateOf("") }
    fun overlay(menuOpen: Boolean = menu, problemOpen: Boolean = problem, detailOpen: Boolean = details, resolution: String? = resolve) {
        model.setOverlay(menuOpen || problemOpen || detailOpen || resolution != null)
    }
    val openMenu = { overlay(menuOpen = true); menu = true }
    val refresh: () -> Unit = { if (state.serverAvailable) model.send(ReceivingIntent.Refresh) else onVerifyConnection() }
    val capture = rememberScannerCapture(model.scanner, model.captureAllowed,
        "${state.session?.id}:${state.mode}:${state.step}:${state.scanEpoch}", model::onScan)
    DisposableEffect(owner, model) {
        val listener = LifecycleEventObserver { _, event -> when (event) {
            Lifecycle.Event.ON_RESUME -> model.setForeground(true)
            Lifecycle.Event.ON_PAUSE -> model.setForeground(false)
            else -> Unit
        } }
        owner.lifecycle.addObserver(listener)
        model.setForeground(owner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED))
        onDispose { owner.lifecycle.removeObserver(listener); model.setForeground(false); model.setOverlay(false) }
    }
    LaunchedEffect(state.authExpired) { if (state.authExpired) onAuthExpired() }
    LaunchedEffect(state.authorized) { if (state.loaded && !state.authorized && !state.authExpired) onVerifyConnection() }
    LaunchedEffect(state.message?.title) {
        if (state.message?.title in setOf("EXCEPTION REPORTED", "EXCEPTION RESOLVED")) {
            problem = false; resolve = null; reason = ""; overlay(problemOpen = false, resolution = null)
        }
    }
    BackHandler {
        when {
            menu || problem || details || resolve != null -> { menu = false; problem = false; details = false; resolve = null; model.setOverlay(false) }
            !state.busy -> onBack()
        }
    }
    val settings = { overlay(detailOpen = true); details = true }
    LaunchedEffect(cameraRequested) {
        if (cameraRequested && model.captureAllowed) { capture.camera(); cameraRequested = false }
    }
    when (device) {
        WorkerDevice.CT40 -> CT40Receiving(view, capture, model.captureAllowed, worker, station, connection,
            model::send, onBack, openMenu, settings, refresh)
        WorkerDevice.PHONE -> PhoneReceiving(view, capture, model.captureAllowed, worker, station, connection,
            model::send, onBack, openMenu, settings, refresh)
    }
    if (menu) AlertDialog(onDismissRequest = { menu = false; overlay(menuOpen = false) },
        title = { Text("TASK ACTIONS") }, text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
                if (state.mode == ReceivingMode.PRODUCTS) {
                    SecondaryAction("CHANGE SOURCE CARTON", { menu = false; overlay(menuOpen = false); model.send(ReceivingIntent.ChangeSource) }, state.canManageTask)
                    SecondaryAction("CHANGE TOTE", { menu = false; overlay(menuOpen = false); model.send(ReceivingIntent.ChangeTote) }, state.canManageTask)
                }
                SecondaryAction("REPORT A PROBLEM", { menu = false; problem = true; reason = ""; overlay(menuOpen = false, problemOpen = true) }, state.canManageTask)
                SecondaryAction("TASK DETAILS", { menu = false; details = true; overlay(menuOpen = false, detailOpen = true) }, state.session != null)
                PauseAction({ menu = false; overlay(menuOpen = false); model.send(ReceivingIntent.Pause) }, state.canManageTask)
                SecondaryAction("REVIEW COMPLETION", { menu = false; overlay(menuOpen = false); model.send(ReceivingIntent.ReviewCompletion) }, state.canManageTask)
                RetryAction({ menu = false; overlay(menuOpen = false); refresh() }, !state.busy, "REFRESH TASK")
                if (device == WorkerDevice.CT40) SecondaryAction("CAMERA FALLBACK", {
                    menu = false; overlay(menuOpen = false); cameraRequested = true
                }, state.canScan)
            }
        }, confirmButton = { SecondaryAction("BACK", { menu = false; overlay(menuOpen = false) }) },
        containerColor = TerminalTokens.surface, shape = MaterialTheme.shapes.medium)
    if (details) AlertDialog(onDismissRequest = { details = false; overlay(detailOpen = false) }, title = { Text("TASK DETAILS") },
        text = { Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(TerminalTokens.sm)) {
            Text(worker, style = MaterialTheme.typography.titleMedium)
            Text(station ?: "No station assigned")
            onToggleTheme?.let { toggle -> SecondaryAction("CHANGE DISPLAY", toggle) }
            state.session?.let { task ->
                TaskNumber(task.code)
                Text(task.arrival.customerName ?: task.arrival.code.orEmpty())
                ProgressIndicator(task.tally.receivedCartons, task.tally.expectedCartons, "CARTONS")
                ProgressIndicator(task.tally.receivedUnits, task.tally.expectedUnits, "UNITS")
                task.discrepancies.filter { it.status == "OPEN" }.forEach { discrepancy ->
                    Text(WorkerMessages.reason(discrepancy.reason, "Ask your supervisor to check this problem."))
                    if (state.canResolve && discrepancy.id != null) SecondaryAction("RESOLVE PROBLEM", {
                        details = false; resolve = discrepancy.id; reason = ""; overlay(detailOpen = false, resolution = discrepancy.id)
                    }, state.canMutate)
                }
            }
        } }, confirmButton = { SecondaryAction("CLOSE", { details = false; overlay(detailOpen = false) }) })
    if (problem || resolve != null) ModalException(
        if (resolve != null) "RESOLVE PROBLEM" else "REPORT A PROBLEM", reason, { reason = it },
        onDismiss = { problem = false; resolve = null; overlay(problemOpen = false, resolution = null) },
        onConfirm = { val id = resolve; model.send(if (id != null) ReceivingIntent.ResolveProblem(id, reason) else ReceivingIntent.ReportProblem(reason)) },
        enabled = state.canMutate, confirmLabel = if (resolve != null) "RESOLVE" else "REPORT",
        message = state.message?.takeIf { it.tone == MessageTone.ERROR }?.detail,
    )
}
