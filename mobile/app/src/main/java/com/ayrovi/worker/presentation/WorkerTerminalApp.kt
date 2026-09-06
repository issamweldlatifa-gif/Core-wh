package com.ayrovi.worker.presentation

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.ayrovi.worker.BuildConfig
import com.ayrovi.worker.data.ConnectionState
import com.ayrovi.worker.design.*
import com.ayrovi.worker.di.AppContainer
import com.ayrovi.worker.domain.MessageTone
import com.ayrovi.worker.domain.OperationalMessage

private enum class TerminalRoute { QUEUE, RECEIVING }

internal fun <T : ViewModel> factory(create: () -> T): ViewModelProvider.Factory = object : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST") override fun <V : ViewModel> create(modelClass: Class<V>): V = create() as V
}

/** The new lane contains no repository calls or business rules in Compose. */
@Composable
fun WorkerTerminalApp(container: AppContainer) {
    val model: WorkerAppViewModel = viewModel(factory = factory { WorkerAppViewModel(container.workerSession) })
    val state by model.state.collectAsStateWithLifecycle()
    val connection by model.connection.collectAsStateWithLifecycle()
    val owner = LocalLifecycleOwner.current
    var route by rememberSaveable { mutableStateOf(TerminalRoute.QUEUE) }
    DisposableEffect(owner, model) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> model.onForeground()
                Lifecycle.Event.ON_PAUSE -> model.onBackground()
                else -> Unit
            }
        }
        owner.lifecycle.addObserver(observer)
        if (owner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) model.onForeground()
        onDispose { owner.lifecycle.removeObserver(observer); model.onBackground() }
    }
    LaunchedEffect(state.signedIn, state.loginGeneration) { if (!state.signedIn) route = TerminalRoute.QUEUE }
    LaunchedEffect(state.tasks) {
        if (route == TerminalRoute.RECEIVING && state.me != null && state.tasks.none { it.key == "receiving" }) route = TerminalRoute.QUEUE
    }
    AyroviTerminalTheme {
        if (!state.signedIn) {
            SignInScreen(state, model.deviceCode, connection.name, model::login)
        } else if (route == TerminalRoute.RECEIVING && state.me?.user?.id != null) {
            val workerId = state.me!!.user!!.id!!
            val receiving: ReceivingViewModel = viewModel(
                key = "receiving-$workerId-${state.loginGeneration}",
                factory = factory { ReceivingViewModel(container.repository, container.sessions, workerId, state.me!!.permissions.toSet()) },
            )
            val available = state.verified && connection !in setOf(ConnectionState.OFFLINE, ConnectionState.AUTH_ERROR, ConnectionState.SYNC_ERROR)
            LaunchedEffect(state.me?.permissions, available) {
                receiving.activate(state.me!!.permissions.toSet(), available, state.context?.activeSession?.id)
            }
            ReceivingScreen(receiving, workerLabel(state), stationLabel(state), connection.name,
                onBack = { route = TerminalRoute.QUEUE; model.refresh() }, onVerifyConnection = model::refresh, onAuthExpired = model::expireSession)
        } else {
            WorkQueueScreen(state, connection.name, model::refresh, model::logout, model::completeAssignment) {
                route = TerminalRoute.RECEIVING
            }
        }
    }
}

@Composable
private fun SignInScreen(state: WorkerAppState, deviceCode: String, connection: String, onSignIn: (String, String, Boolean) -> Unit) {
    var employee by rememberSaveable { mutableStateOf("") }
    // Deliberately NOT saveable: never persist passwords/PINs in saved state or local storage.
    var secret by remember { mutableStateOf("") }
    var pin by rememberSaveable { mutableStateOf(false) }
    TerminalShell(
        header = { TerminalHeader("WAREHOUSE TERMINAL", "SIGN-IN REQUIRED", null, connection) },
        footer = { TerminalFooter("AUTHORIZED WORKERS ONLY") {
            PrimaryAction("SIGN IN", { val value = secret; secret = ""; onSignIn(employee, value, pin) }, !state.busy && employee.isNotBlank() && secret.isNotBlank())
        } },
    ) {
        TaskInstruction("READY FOR YOUR SHIFT", "Sign in with your AYROVI employee code.")
        state.message?.let { OperationalMessageView(it) }
        if (state.busy) LoadingState("Verifying worker and device…")
        TerminalTextInput("EMPLOYEE CODE", employee, { employee = it }, enabled = !state.busy)
        TerminalTextInput(if (pin) "PIN" else "PASSWORD", secret, { secret = it }, enabled = !state.busy,
            secret = true, keyboardType = if (pin) KeyboardType.NumberPassword else KeyboardType.Password)
        SecondaryAction(if (pin) "USE PASSWORD" else "USE PIN", { pin = !pin; secret = "" }, !state.busy)
        TerminalPanel("REGISTERED DEVICE") {
            BarcodeDisplay(deviceCode)
            Text("Give this device code to your administrator for registration. Device codes are not passwords.", style = MaterialTheme.typography.bodyMedium, color = TerminalTokens.muted)
        }
        TerminalPanel("ENVIRONMENT / MIGRATION PILOT") {
            Text(BuildConfig.API_BASE_URL, style = MaterialTheme.typography.bodyMedium)
            Text("Receiving-first pilot. No offline stock operations. Production approval is still required.", style = MaterialTheme.typography.bodyMedium, color = TerminalTokens.warning)
        }
    }
}

@Composable
private fun WorkQueueScreen(
    state: WorkerAppState, connection: String, onRefresh: () -> Unit, onLogout: () -> Unit,
    onCompleteAssignment: (String) -> Unit, onReceiving: () -> Unit,
) {
    TerminalShell(
        header = { TerminalHeader("WORK QUEUE", workerLabel(state), stationLabel(state), if (!state.verified && connection == "ONLINE") "CHECKING" else connection) },
        footer = { TerminalFooter("SERVER-ASSIGNED WORK") {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
                SecondaryAction("REFRESH", onRefresh, !state.busy, Modifier.weight(1f))
                DangerAction("SIGN OUT", onLogout, !state.busy, Modifier.weight(1f))
            }
        } },
    ) {
        if (state.busy) LoadingState("Checking assignments and permissions…")
        state.message?.let { OperationalMessageView(it) }
        if (!state.verified && !state.busy) WarningState("WORK NOT VERIFIED", "Refresh the server connection before starting an operation. No offline work is queued.")
        if (state.me != null && state.tasks.isEmpty() && !state.busy) EmptyState("NO AUTHORIZED WORKFLOWS", "Ask a supervisor to check your roles and station assignment.")
        state.tasks.forEach { task ->
            TerminalPanel(task.department ?: "WORKFLOW") {
                Text(task.label ?: task.key.orEmpty(), style = MaterialTheme.typography.titleLarge)
                if (task.key == "receiving") {
                    QuantityDisplay("ARRIVALS IN SERVER QUEUE", state.receivingArrivals?.toString() ?: "—")
                    state.context?.activeSession?.let { TaskStatus("OPEN SESSION · ${it.code}", TerminalTone.WARNING) }
                    PrimaryAction(if (state.context?.activeSession != null) "CURRENT RECEIVING TASK" else "OPEN RECEIVING", onReceiving, state.verified && !state.busy)
                } else {
                    TaskStatus("LEGACY WORKFLOW · NOT MIGRATED", TerminalTone.WARNING)
                    Text("Use the approved legacy terminal during the Receiving pilot. This build does not simulate this workflow.", style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
        state.assignments?.open?.forEach { assignment ->
            TerminalPanel("ASSIGNED INSTRUCTION") {
                Text(assignment.title, style = MaterialTheme.typography.titleMedium)
                assignment.relatedCode?.let { BarcodeDisplay(it) }
                assignment.description?.let { Text(it, style = MaterialTheme.typography.bodyLarge) }
                SecondaryAction("MARK INSTRUCTION DONE", { onCompleteAssignment(assignment.id) }, state.verified && !state.busy)
            }
        }
        Text("MIGRATION PILOT · Receiving first. Other workflows remain frozen until hardware acceptance.", style = MaterialTheme.typography.bodyMedium, color = TerminalTokens.muted)
    }
}

@Composable
internal fun OperationalMessageView(message: OperationalMessage) {
    when (message.tone) {
        MessageTone.ERROR -> ErrorState(message.title, message.detail, message.expected, message.scanned)
        MessageTone.WARNING -> WarningState(message.title, message.detail + (message.scanned?.let { "\nScanned: $it" } ?: ""))
        MessageTone.SUCCESS -> SuccessState(message.title, message.detail)
        MessageTone.INFO -> ScanResult(message.title, message.detail, TerminalTone.INSTRUCTION)
    }
}

private fun workerLabel(state: WorkerAppState): String = state.me?.user?.let {
    listOfNotNull(it.employeeCode, it.name).joinToString(" · ")
} ?: "VERIFYING WORKER"
private fun stationLabel(state: WorkerAppState): String = state.context?.station?.let {
    listOfNotNull(it.code, it.name).joinToString(" · ")
} ?: "No station assigned by backend"
