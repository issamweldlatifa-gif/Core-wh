package com.ayrovi.worker.presentation

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ayrovi.worker.design.*
import com.ayrovi.worker.domain.ReceivingState
import com.ayrovi.worker.domain.ReceivingStep
import com.ayrovi.worker.scanner.TerminalScanInput
import com.ayrovi.worker.ui.FeedbackSounds

/** Rendering only. All commands go through the ViewModel-owned ReceivingWorkflow. */
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
    var exceptionDialog by remember { mutableStateOf(false) }
    var resolveId by remember { mutableStateOf<String?>(null) }
    var reason by remember { mutableStateOf("") }
    val captureEnabled = state.canScan && !exceptionDialog && resolveId == null
    val androidContext = LocalContext.current
    BackHandler { if (!state.busy) onBack() }
    LaunchedEffect(state.authExpired) { if (state.authExpired) onAuthExpired() }
    LaunchedEffect(state.authorized) { if (state.loaded && !state.authorized && !state.authExpired) onVerifyConnection() }
    LaunchedEffect(state.receipt?.articleCode) { if (state.receipt != null) FeedbackSounds.ok(androidContext) }
    LaunchedEffect(state.message?.title) {
        if (state.message?.title in setOf("EXCEPTION REPORTED", "EXCEPTION RESOLVED")) {
            exceptionDialog = false; resolveId = null; reason = ""
        }
    }

    TerminalShell(
        header = { TerminalHeader("RECEIVING", worker, station, if (!state.serverAvailable && connection == "ONLINE") "CHECKING" else connection) },
        footer = { TerminalFooter(footerInstruction(state)) {
            when {
                !state.serverAvailable -> RetryAction(onVerifyConnection, !state.busy, "VERIFY SERVER CONNECTION")
                state.step == ReceivingStep.CONFIRM_CARTON -> ConfirmAction(
                    if (state.carton?.alreadyReceived == true) "USE RECEIVED CARTON" else "CONFIRM CARTON RECEIVED", workflow::confirmCarton, state.canMutate)
                state.step == ReceivingStep.REVIEW_PRODUCT -> ConfirmAction("CONFIRM 1 ARTICLE", workflow::confirmProduct, state.canMutate)
                state.step == ReceivingStep.RESULT -> PrimaryAction("NEXT PRODUCT", workflow::nextProduct, state.canMutate)
                state.step == ReceivingStep.REVIEW_COMPLETE -> ConfirmAction("COMPLETE ARRIVAL", workflow::complete, state.canComplete)
                state.step == ReceivingStep.PAUSED -> PrimaryAction("RESUME RECEIVING", workflow::resume, state.canMutate)
                state.step == ReceivingStep.COMPLETE -> PrimaryAction("NEXT ARRIVAL", workflow::nextArrival, state.canMutate)
                state.step == ReceivingStep.RECONCILE -> RetryAction(workflow::refresh, !state.busy, "CHECK SERVER STATE · NO REPLAY")
                else -> Text("Use the scanner or enter the printed code.", style = MaterialTheme.typography.bodyMedium)
            }
            SecondaryAction("WORK QUEUE", onBack, !state.busy)
        } },
        scrollKey = state.step,
    ) {
        state.session?.let { session ->
            TaskHeader(session.code, session.status.replace('_', ' '))
            Text("${session.arrival.code} · ${session.arrival.customerName ?: "Customer not supplied"}", style = MaterialTheme.typography.bodyLarge)
        }
        StepIndicator(stepNumber(state.step), 7, state.step.name.replace('_', ' '))
        TaskInstruction(instruction(state.step), detail(state))
        if (state.busy) LoadingState("Waiting for warehouse server…")
        state.message?.let { OperationalMessageView(it) }
        if (!state.serverAvailable) {
            if (connection == "OFFLINE") OfflineStatus()
            else WarningState("SERVER VERIFICATION REQUIRED", "Work is stopped until the connection and permissions are verified.")
        }

        when (state.step) {
            ReceivingStep.ARRIVAL -> {
                TerminalScanInput("AYROVI ARRIVAL CODE", captureEnabled, "arrival:${state.scanEpoch}", workflow::scan)
                if (state.loaded && state.arrivals.isEmpty()) EmptyState("NO ARRIVALS WAITING", "The server returned an empty Receiving queue. Refresh to check for new arrivals.")
                if (state.arrivals.isNotEmpty()) TerminalPanel("OR SELECT A SERVER ARRIVAL") {
                    state.arrivals.forEach { arrival ->
                        SecondaryAction("${arrival.code ?: arrival.id}\n${arrival.customerName ?: arrival.storeName.orEmpty()}",
                            { workflow.openArrival(arrival.code ?: arrival.id.orEmpty()) }, state.canMutate)
                        Text("${arrival.cartons?.toString() ?: "—"} cartons · ${arrival.units?.toString() ?: "—"} expected units", style = MaterialTheme.typography.bodyMedium, color = TerminalTokens.muted)
                    }
                }
            }
            ReceivingStep.CARTON -> TerminalScanInput("SOURCE CARTON", captureEnabled, "${state.session?.id}:carton:${state.scanEpoch}", workflow::scan)
            ReceivingStep.CONFIRM_CARTON -> state.carton?.let { LocationBlock(it.code, label = "IDENTIFIED SOURCE CARTON") }
            ReceivingStep.TOTE -> {
                state.carton?.let { LocationBlock(it.code, label = "SOURCE CARTON") }
                TerminalScanInput("RECEIVING TOTE QR / CODE", captureEnabled, "${state.session?.id}:tote:${state.scanEpoch}", workflow::scan)
                Text("Use an existing ACTIVE receiving tote. Ask a supervisor if no tote has been provisioned.", style = MaterialTheme.typography.bodyMedium, color = TerminalTokens.muted)
            }
            ReceivingStep.PRODUCT -> {
                state.tote?.let { LocationBlock(it.code, label = "PLACE CONFIRMED ARTICLES INTO") }
                TerminalScanInput("PRODUCT SKU", captureEnabled, "${state.session?.id}:product:${state.scanEpoch}", workflow::scan)
            }
            ReceivingStep.REVIEW_PRODUCT -> state.product?.let { review ->
                ProductBlock(review.product?.productName, review.scan.value)
                TerminalPanel("SERVER QUANTITY CONTEXT") {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.md)) {
                        QuantityDisplay("EXPECTED", review.product?.expected?.toString() ?: "—", Modifier.weight(1f))
                        QuantityDisplay("REMAINING", review.product?.remaining?.toString() ?: "—", Modifier.weight(1f))
                    }
                    QuantityInput(review.quantity, workflow::setQuantity, state.canMutate)
                    Text("This API supports one physical article per confirmation. Bulk quantities require a backend contract change.", style = MaterialTheme.typography.bodyMedium, color = TerminalTokens.muted)
                    Text("INPUT SOURCE · ${review.scan.source.name.replace('_', ' ')}", style = MaterialTheme.typography.labelMedium)
                }
                state.tote?.let { LocationBlock(it.code, label = "DESTINATION TOTE") }
                WarningState("CONDITION / REJECTION", "For a condition problem, report an exception for supervisor review. This backend has no formal rejection or disposition action; none will be implied.")
                SecondaryAction("SCAN ANOTHER PRODUCT", workflow::nextProduct, state.canMutate)
            }
            ReceivingStep.RESULT -> state.receipt?.let { receipt ->
                ProductBlock(null, receipt.sku)
                TerminalPanel("SERVER-CONFIRMED ARTICLE") {
                    BarcodeDisplay(receipt.articleCode)
                    Text("Recorded in ${receipt.toteCode}", style = MaterialTheme.typography.bodyLarge)
                    if (receipt.withException) TaskStatus("RECEIVED WITH EXCEPTION", TerminalTone.WARNING)
                    else TaskStatus("RECEIVED", TerminalTone.SUCCESS)
                }
            }
            ReceivingStep.PAUSED -> WarningState("SESSION PAUSED", "Scanner and receipt actions are stopped. Resume online to continue.")
            ReceivingStep.REVIEW_COMPLETE -> {
                if (state.hasVariance && !state.canResolve) WarningState("SUPERVISOR REQUIRED", "Missing cartons, quantity variance or open exceptions must be reviewed by an authorized supervisor.")
                else Text("Confirm the physical work is finished. The backend will validate quantities, cartons and exceptions again.", style = MaterialTheme.typography.bodyLarge)
                SecondaryAction("CONTINUE SCANNING", workflow::nextProduct, state.canMutate)
            }
            ReceivingStep.COMPLETE -> {
                if (state.session?.status == "CANCELLED") WarningState("SESSION CANCELLED", "The server closed this session. No further receipt can be entered here.")
                else if (state.session?.status == "COMPLETED_WITH_DISCREPANCY") WarningState("ARRIVAL CLOSED WITH DISCREPANCY", "The server recorded completion with discrepancies. Review the operational record with a supervisor.")
                else SuccessState("ARRIVAL COMPLETE", "Completion is confirmed by the AYROVI backend. Continue to the next arrival.")
            }
            ReceivingStep.RECONCILE -> WarningState("DO NOT REPEAT THIS OPERATION", "No automatic retry or offline replay will occur. Reload the server record and ask a supervisor to reconcile the unresolved work.")
        }
        state.session?.let { session ->
            TerminalPanel("SERVER PROGRESS") {
                ProgressIndicator(session.tally.receivedCartons, session.tally.expectedCartons, "CARTONS")
                ProgressIndicator(session.tally.receivedUnits, session.tally.expectedUnits, "UNITS")
                TaskStatus("${session.tally.openDiscrepancies} OPEN EXCEPTIONS", if (session.tally.openDiscrepancies > 0) TerminalTone.WARNING else TerminalTone.NEUTRAL)
            }
            if (session.status == "RECEIVING" && state.pending == null) {
                TerminalPanel("TASK ACTIONS") {
                    if (state.step in setOf(ReceivingStep.PRODUCT, ReceivingStep.REVIEW_PRODUCT, ReceivingStep.RESULT)) {
                        SecondaryAction("CHANGE SOURCE CARTON", workflow::changeCarton, state.canMutate)
                        SecondaryAction("CHANGE TOTE", workflow::changeTote, state.canMutate)
                    }
                    SecondaryAction("REPORT EXCEPTION", { reason = ""; exceptionDialog = true }, state.canMutate)
                    PauseAction(workflow::pause, state.canMutate)
                    if (state.step != ReceivingStep.REVIEW_COMPLETE) SecondaryAction("REVIEW ARRIVAL COMPLETION", workflow::reviewCompletion, state.canMutate)
                }
            }
            session.discrepancies.filter { it.status == "OPEN" }.forEach { discrepancy ->
                TerminalPanel("OPEN EXCEPTION · ${discrepancy.type?.replace('_', ' ')}") {
                    Text(discrepancy.reason ?: "The backend did not provide a reason.", style = MaterialTheme.typography.bodyLarge)
                    if (state.canResolve && discrepancy.id != null) SecondaryAction("RESOLVE WITH REASON", {
                        resolveId = discrepancy.id; reason = ""
                    }, state.canMutate)
                }
            }
        }
        if (state.step != ReceivingStep.RECONCILE) RetryAction(
            onClick = { if (state.serverAvailable) workflow.refresh() else onVerifyConnection() },
            enabled = !state.busy, label = "REFRESH SERVER STATE")
    }
    if (exceptionDialog || resolveId != null) ModalException(
        title = if (resolveId != null) "RESOLVE EXCEPTION" else "REPORT EXCEPTION",
        reason = reason, onReason = { reason = it },
        onDismiss = { exceptionDialog = false; resolveId = null },
        onConfirm = { val id = resolveId; if (id != null) workflow.resolveException(id, reason) else workflow.reportException(reason) },
        enabled = state.canMutate,
        confirmLabel = if (resolveId != null) "RESOLVE" else "REPORT",
    )
}

private fun instruction(step: ReceivingStep) = when (step) {
    ReceivingStep.ARRIVAL -> "SCAN ARRIVAL"
    ReceivingStep.CARTON -> "SCAN THIS CARTON"
    ReceivingStep.CONFIRM_CARTON -> "VERIFY CARTON"
    ReceivingStep.TOTE -> "SCAN RECEIVING TOTE"
    ReceivingStep.PRODUCT -> "SCAN PRODUCT"
    ReceivingStep.REVIEW_PRODUCT -> "VERIFY RECEIVED UNIT"
    ReceivingStep.RESULT -> "TAKE NEXT ACTION"
    ReceivingStep.REVIEW_COMPLETE -> "REVIEW ARRIVAL"
    ReceivingStep.PAUSED -> "RESUME WHEN READY"
    ReceivingStep.COMPLETE -> "NEXT ARRIVAL"
    ReceivingStep.RECONCILE -> "RECONCILE BEFORE CONTINUING"
}
private fun detail(state: ReceivingState) = when (state.step) {
    ReceivingStep.ARRIVAL -> "Identify the arrival you are physically receiving."
    ReceivingStep.CARTON -> "The backend will identify the carton before you confirm receipt."
    ReceivingStep.CONFIRM_CARTON -> "Identification is not acceptance. Confirm the physical carton below."
    ReceivingStep.TOTE -> "Every received article goes into a real receiving tote."
    ReceivingStep.PRODUCT -> "Read the exact SKU on one physical unit."
    ReceivingStep.REVIEW_PRODUCT -> "Verify the product, quantity and destination before acceptance."
    ReceivingStep.RESULT -> "Do not receive the same physical unit again."
    else -> null
}
private fun stepNumber(step: ReceivingStep) = when (step) {
    ReceivingStep.ARRIVAL -> 1
    ReceivingStep.CARTON, ReceivingStep.CONFIRM_CARTON -> 2
    ReceivingStep.TOTE -> 3
    ReceivingStep.PRODUCT, ReceivingStep.REVIEW_PRODUCT -> 4
    ReceivingStep.RESULT -> 5
    ReceivingStep.REVIEW_COMPLETE, ReceivingStep.PAUSED, ReceivingStep.RECONCILE -> 6
    ReceivingStep.COMPLETE -> 7
}
private fun footerInstruction(state: ReceivingState) = when {
    state.busy -> "WAIT FOR SERVER CONFIRMATION"
    state.pending != null -> "RECONCILIATION REQUIRED"
    !state.serverAvailable -> "SERVER CONNECTION REQUIRED"
    else -> "NEXT ACTION"
}
