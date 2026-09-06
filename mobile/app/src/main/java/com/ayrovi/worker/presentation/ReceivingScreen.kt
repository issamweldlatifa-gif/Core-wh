package com.ayrovi.worker.presentation

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ayrovi.worker.design.*
import com.ayrovi.worker.domain.ReceivingMode
import com.ayrovi.worker.domain.ReceivingState
import com.ayrovi.worker.domain.ReceivingStep
import com.ayrovi.worker.scanner.TerminalScanInput
import com.ayrovi.worker.ui.FeedbackSounds

/** Rendering + intents only. Modes, prerequisites, permissions and all writes live in worker-core. */
@Composable
fun ReceivingScreen(
    model: ReceivingViewModel,
    worker: String,
    station: String,
    connection: String,
    onBack: () -> Unit,
    onVerifyConnection: () -> Unit,
    onAuthExpired: () -> Unit,
) {
    val state by model.state.collectAsStateWithLifecycle()
    val workflow = model.workflow
    var taskActions by remember { mutableStateOf(false) }
    var exceptionDialog by remember { mutableStateOf(false) }
    var resolveId by remember { mutableStateOf<String?>(null) }
    var reason by remember { mutableStateOf("") }
    val captureEnabled = state.canScan && !taskActions && !exceptionDialog && resolveId == null
    val androidContext = LocalContext.current
    val refresh: () -> Unit = { if (state.serverAvailable) workflow.refresh() else onVerifyConnection() }
    BackHandler {
        when {
            taskActions -> taskActions = false
            exceptionDialog || resolveId != null -> { exceptionDialog = false; resolveId = null }
            !state.busy -> onBack()
        }
    }
    LaunchedEffect(state.authExpired) { if (state.authExpired) onAuthExpired() }
    LaunchedEffect(state.authorized) { if (state.loaded && !state.authorized && !state.authExpired) onVerifyConnection() }
    LaunchedEffect(state.receipt?.articleCode) { if (state.receipt != null && !state.restoredReceipt) FeedbackSounds.ok(androidContext) }
    LaunchedEffect(state.message?.title) {
        if (state.message?.title in setOf("EXCEPTION REPORTED", "EXCEPTION RESOLVED")) {
            exceptionDialog = false; resolveId = null; reason = ""
        }
    }

    TerminalShell(
        header = { TerminalHeader("RECEIVING", worker, station,
            if (!state.serverAvailable && connection == "ONLINE") "CHECKING" else connection,
            onBack = onBack, backEnabled = !state.busy) },
        toolbar = {
            TerminalModeSelector("CARTON", "PRODUIT", state.mode == ReceivingMode.CARTONS, state.canSelectMode,
                onFirst = { workflow.selectMode(ReceivingMode.CARTONS) },
                onSecond = { workflow.selectMode(ReceivingMode.PRODUCTS) })
        },
        footer = { TerminalFooter(footerInstruction(state)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
                val primary = Modifier.weight(1f)
                when {
                    !state.serverAvailable -> PrimaryAction("VERIFY CONNECTION", onVerifyConnection, !state.busy, primary)
                    state.step == ReceivingStep.CONFIRM_CARTON -> PrimaryAction(
                        if (state.carton?.alreadyReceived == true) "USE RECEIVED CARTON" else "CONFIRM CARTON", workflow::confirmCarton, state.canMutate, primary)
                    state.step == ReceivingStep.REVIEW_PRODUCT -> PrimaryAction("CONFIRM 1 ARTICLE", workflow::confirmProduct, state.canMutate, primary)
                    state.step == ReceivingStep.RESULT -> PrimaryAction("ACKNOWLEDGE · NEXT", workflow::nextProduct, state.canAcknowledgeReceipt, primary)
                    state.step == ReceivingStep.REVIEW_COMPLETE -> PrimaryAction("COMPLETE ARRIVAL", workflow::complete, state.canComplete, primary)
                    state.step == ReceivingStep.PAUSED -> PrimaryAction("RESUME RECEIVING", workflow::resume, state.canMutate, primary)
                    state.step == ReceivingStep.COMPLETE -> PrimaryAction("NEXT ARRIVAL", workflow::nextArrival, state.canMutate, primary)
                    state.step == ReceivingStep.RECONCILE -> PrimaryAction("CHECK SERVER STATE", refresh, !state.busy, primary)
                    state.step == ReceivingStep.ARRIVAL -> PrimaryAction("REFRESH QUEUE", refresh, !state.busy, primary)
                    else -> PrimaryAction("TASK ACTIONS", { taskActions = true }, state.canManageTask, primary)
                }
                if (state.canManageTask && state.step in setOf(ReceivingStep.CONFIRM_CARTON, ReceivingStep.REVIEW_PRODUCT, ReceivingStep.REVIEW_COMPLETE)) {
                    SecondaryAction("•••", { taskActions = true }, !state.busy, Modifier.width(TerminalTokens.touch).semantics { contentDescription = "Open task actions" })
                }
            }
        } },
        scrollKey = "${state.mode}:${state.step}",
    ) {
        state.session?.let { session ->
            TaskHeader(session.code, session.status.replace('_', ' '),
                "${session.arrival.code} · ${session.arrival.customerName ?: "Customer not supplied"}")
        }
        TaskInstruction(instruction(state), detail(state))
        if (state.busy) LoadingState("Checking warehouse server…")
        state.message?.let { OperationalMessageView(it) }
        if (!state.serverAvailable) {
            if (connection == "OFFLINE") OfflineStatus()
            else WarningState("SERVER VERIFICATION REQUIRED", "Work is stopped until the connection and permissions are verified.")
        }

        when (state.step) {
            ReceivingStep.ARRIVAL -> {
                if (state.loaded && state.arrivals.isEmpty()) EmptyState("NO ARRIVALS WAITING", "The server returned an empty Receiving queue. Refresh to check again.")
            }
            ReceivingStep.CARTON -> Unit
            ReceivingStep.CONFIRM_CARTON -> state.carton?.let { LocationBlock(it.code, label = "IDENTIFIED · NOT YET CONFIRMED") }
            ReceivingStep.TOTE -> {
                state.sourceCarton?.let { LocationBlock(it.code, label = "CONFIRMED SOURCE CARTON") }
                Text("Use an existing ACTIVE receiving tote. Ask a supervisor if none is provisioned.", style = MaterialTheme.typography.bodyMedium, color = TerminalTokens.muted)
            }
            ReceivingStep.PRODUCT -> {
                state.tote?.let { LocationBlock(it.code, label = "DESTINATION TOTE") }
                state.sourceCarton?.let { Text("SOURCE · ${it.code}", style = MaterialTheme.typography.bodyMedium, color = TerminalTokens.muted) }
            }
            ReceivingStep.REVIEW_PRODUCT -> state.product?.let { review ->
                ProductBlock(review.product?.productName, review.scan.value)
                TerminalPanel("VERIFY QUANTITY") {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.sm)) {
                        QuantityDisplay("EXPECTED", review.product?.expected?.toString() ?: "—", Modifier.weight(1f))
                        QuantityDisplay("REMAINING", review.product?.remaining?.toString() ?: "—", Modifier.weight(1f))
                    }
                    QuantityInput(review.quantity, workflow::setQuantity, state.canMutate)
                    Text("One physical article per confirmation. Bulk receipt is not supported by this API.", style = MaterialTheme.typography.bodyMedium, color = TerminalTokens.muted)
                    Text("SOURCE · ${review.scan.source.name.replace('_', ' ')}", style = MaterialTheme.typography.labelMedium)
                }
                state.tote?.let { LocationBlock(it.code, label = "DESTINATION TOTE") }
                WarningState("CONDITION PROBLEM?", "Report an exception for supervisor review. Formal rejection or disposition is not supported by this backend.")
                SecondaryAction("SCAN ANOTHER PRODUCT", workflow::nextProduct, state.canMutate)
            }
            ReceivingStep.RESULT -> state.receipt?.let { receipt ->
                ProductBlock(null, receipt.sku)
                TerminalPanel("SERVER-CONFIRMED ARTICLE") {
                    BarcodeDisplay(receipt.articleCode)
                    Text("Recorded in ${receipt.toteCode}", style = MaterialTheme.typography.bodyLarge)
                    TaskStatus(if (receipt.withException) "RECEIVED WITH EXCEPTION" else "RECEIVED",
                        if (receipt.withException) TerminalTone.WARNING else TerminalTone.SUCCESS)
                }
            }
            ReceivingStep.PAUSED -> WarningState("SESSION PAUSED", "Scanner and receipt actions are stopped. Resume online to continue.")
            ReceivingStep.REVIEW_COMPLETE -> {
                if (state.hasVariance && !state.canResolve) WarningState("SUPERVISOR REQUIRED", "Missing cartons, variance or open exceptions require an authorized supervisor.")
                else Text("Confirm the physical work is finished. The backend validates quantities, cartons and exceptions again.", style = MaterialTheme.typography.bodyLarge)
                SecondaryAction("CONTINUE SCANNING", workflow::nextProduct, state.canMutate)
            }
            ReceivingStep.COMPLETE -> {
                when (state.session?.status) {
                    "CANCELLED" -> WarningState("SESSION CANCELLED", "The server closed this session. No further receipt can be entered here.")
                    "COMPLETED_WITH_DISCREPANCY" -> WarningState("CLOSED WITH DISCREPANCY", "Review the recorded discrepancies with a supervisor.")
                    else -> SuccessState("ARRIVAL COMPLETE", "Completion is confirmed by the backend. Continue to the next arrival.")
                }
            }
            ReceivingStep.RECONCILE -> WarningState("DO NOT REPEAT THE OPERATION", "No replay will occur. Reload the server record and reconcile unresolved work with a supervisor.")
        }
        // One scanner host remains mounted across steps; only capture surfaces are visible.
        TerminalScanInput(scanLabel(state), captureEnabled,
            "${state.session?.id}:${state.mode}:${state.step}:${state.scanEpoch}", workflow::scan,
            visible = state.step in setOf(ReceivingStep.ARRIVAL, ReceivingStep.CARTON, ReceivingStep.TOTE, ReceivingStep.PRODUCT))
                if (state.step == ReceivingStep.ARRIVAL && state.arrivals.isNotEmpty()) TerminalPanel("OR SELECT A SERVER ARRIVAL") {
                    state.arrivals.forEach { arrival ->
                        SecondaryAction("${arrival.code ?: arrival.id}\n${arrival.customerName ?: arrival.storeName.orEmpty()}",
                            { workflow.openArrival(arrival.code ?: arrival.id.orEmpty()) }, state.canMutate)
                        Text("${arrival.cartons?.toString() ?: "—"} cartons · ${arrival.units?.toString() ?: "—"} expected units", style = MaterialTheme.typography.bodyMedium, color = TerminalTokens.muted)
                    }
                }

        state.session?.let { session ->
            TerminalPanel("SERVER PROGRESS") {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.md)) {
                    Column(Modifier.weight(1f)) { ProgressIndicator(session.tally.receivedCartons, session.tally.expectedCartons, "CARTONS") }
                    Column(Modifier.weight(1f)) { ProgressIndicator(session.tally.receivedUnits, session.tally.expectedUnits, "UNITS") }
                }
                TaskStatus("${session.tally.openDiscrepancies} OPEN EXCEPTIONS", if (session.tally.openDiscrepancies > 0) TerminalTone.WARNING else TerminalTone.NEUTRAL)
            }
            session.discrepancies.filter { it.status == "OPEN" }.forEach { discrepancy ->
                TerminalPanel("EXCEPTION · ${discrepancy.type?.replace('_', ' ')}") {
                    Text(discrepancy.reason ?: "No reason was supplied by the backend.", style = MaterialTheme.typography.bodyLarge)
                    if (state.canResolve && discrepancy.id != null) SecondaryAction("RESOLVE WITH REASON", {
                        resolveId = discrepancy.id; reason = ""
                    }, state.canMutate)
                }
            }
        }
    }
    if (taskActions) AlertDialog(onDismissRequest = { taskActions = false },
        title = { Text("TASK ACTIONS") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
                if (state.mode == ReceivingMode.PRODUCTS) {
                    SecondaryAction("CHANGE SOURCE CARTON", { taskActions = false; workflow.changeCarton() }, state.canManageTask)
                    SecondaryAction("CHANGE TOTE", { taskActions = false; workflow.changeTote() }, state.canManageTask)
                }
                SecondaryAction("REPORT EXCEPTION", { taskActions = false; reason = ""; exceptionDialog = true }, state.canManageTask)
                PauseAction({ taskActions = false; workflow.pause() }, state.canManageTask)
                SecondaryAction("REVIEW COMPLETION", { taskActions = false; workflow.reviewCompletion() }, state.canManageTask)
                RetryAction({ taskActions = false; refresh() }, !state.busy, "REFRESH SERVER STATE")
            }
        }, confirmButton = { SecondaryAction("BACK TO SCAN", { taskActions = false }) },
        containerColor = TerminalTokens.surface, shape = MaterialTheme.shapes.medium)
    if (exceptionDialog || resolveId != null) ModalException(
        title = if (resolveId != null) "RESOLVE EXCEPTION" else "REPORT EXCEPTION",
        reason = reason, onReason = { reason = it },
        onDismiss = { exceptionDialog = false; resolveId = null },
        onConfirm = { val id = resolveId; if (id != null) workflow.resolveException(id, reason) else workflow.reportException(reason) },
        enabled = state.canMutate, confirmLabel = if (resolveId != null) "RESOLVE" else "REPORT",
        message = state.message?.takeIf { it.tone == com.ayrovi.worker.domain.MessageTone.ERROR }?.detail,
    )
}

private fun instruction(state: ReceivingState) = when (state.step) {
    ReceivingStep.ARRIVAL -> "SCAN ARRIVAL"
    ReceivingStep.CARTON -> if (state.mode == ReceivingMode.CARTONS) "SCAN CARTON" else "VERIFY SOURCE CARTON"
    ReceivingStep.CONFIRM_CARTON -> "VERIFY CARTON"
    ReceivingStep.TOTE -> "SCAN RECEIVING TOTE"
    ReceivingStep.PRODUCT -> "SCAN PRODUCT"
    ReceivingStep.REVIEW_PRODUCT -> "VERIFY RECEIVED UNIT"
    ReceivingStep.RESULT -> "UNIT RECORDED"
    ReceivingStep.REVIEW_COMPLETE -> "REVIEW ARRIVAL"
    ReceivingStep.PAUSED -> "RESUME WHEN READY"
    ReceivingStep.COMPLETE -> "NEXT ARRIVAL"
    ReceivingStep.RECONCILE -> "RECONCILE FIRST"
}
private fun detail(state: ReceivingState) = when (state.step) {
    ReceivingStep.ARRIVAL -> "Identify the arrival you are physically receiving."
    ReceivingStep.CARTON -> if (state.mode == ReceivingMode.CARTONS) "Scan → verify → confirm. Cartons are not product units." else "Product receipt requires a verified source carton."
    ReceivingStep.CONFIRM_CARTON -> "Identification is not receipt. Confirm the physical carton."
    ReceivingStep.TOTE -> "Every received article must go into a real receiving tote."
    ReceivingStep.PRODUCT -> "Read the exact SKU on one physical unit."
    ReceivingStep.REVIEW_PRODUCT -> "Verify product, quantity and destination before acceptance."
    ReceivingStep.RESULT -> "Verify physical placement in the tote, then acknowledge. Do not receive the same unit again."
    else -> null
}
private fun footerInstruction(state: ReceivingState) = when {
    state.busy -> "WAIT FOR SERVER CONFIRMATION"
    state.pending?.confirmedReceipt != null -> "ACKNOWLEDGE THE RECORDED UNIT"
    state.pending != null -> "RECONCILIATION REQUIRED · NO REPLAY"
    !state.serverAvailable -> "SERVER CONNECTION REQUIRED"
    state.canScan -> "${if (state.mode == ReceivingMode.CARTONS) "CARTON" else "PRODUIT"} · READY FOR SCAN"
    else -> "NEXT ACTION"
}

private fun scanLabel(state: ReceivingState) = when (state.step) {
    ReceivingStep.ARRIVAL -> "ARRIVAL CODE"
    ReceivingStep.CARTON -> if (state.mode == ReceivingMode.CARTONS) "CARTON CODE" else "SOURCE CARTON"
    ReceivingStep.TOTE -> "RECEIVING TOTE"
    else -> "PRODUCT SKU"
}
