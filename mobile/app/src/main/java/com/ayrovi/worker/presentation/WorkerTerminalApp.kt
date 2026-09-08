package com.ayrovi.worker.presentation

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.AlertDialog
import com.ayrovi.worker.scanner.WorkerDevice
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.text.input.KeyboardType
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.ayrovi.worker.data.ConnectionState
import com.ayrovi.worker.design.*
import com.ayrovi.worker.di.AppContainer
import com.ayrovi.worker.domain.MessageTone
import com.ayrovi.worker.domain.OperationalMessage

private enum class TerminalRoute { QUEUE, RECEIVING }

internal fun <T : ViewModel> factory(create: () -> T): ViewModelProvider.Factory = object : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST") override fun <V : ViewModel> create(modelClass: Class<V>): V = create() as V
}

/**
 * The new lane contains no repository calls or business rules in Compose.
 * @param openReceivingRequest monotonic signal (see MainActivity): when it is
 *        raised the app opens RECEIVING home once the worker is signed in —
 *        this is the destination of a Receiving card tray notification.
 */
@Composable
fun WorkerTerminalApp(
    container: AppContainer,
    onThemeChanged: (TerminalThemeMode) -> Unit = {},
    openReceivingRequest: Long = 0L,
) {
    val model: WorkerAppViewModel = viewModel(
        factory = factory { WorkerAppViewModel(container.workerSession, container.audio, container.notifier) },
    )
    val appearance: AppearanceViewModel = viewModel(factory = factory { AppearanceViewModel(container.appearance) })
    val theme by appearance.theme.collectAsStateWithLifecycle()
    val themeWarning by appearance.warning.collectAsStateWithLifecycle()
    val androidContext = androidx.compose.ui.platform.LocalContext.current
    LaunchedEffect(themeWarning) { themeWarning?.let { android.widget.Toast.makeText(androidContext, it, android.widget.Toast.LENGTH_LONG).show() } }
    val state by model.state.collectAsStateWithLifecycle()
    LaunchedEffect(theme) { onThemeChanged(theme) }
    val connection by model.connection.collectAsStateWithLifecycle()
    val owner = LocalLifecycleOwner.current
    var showSettings by remember { mutableStateOf(false) }
    var route by rememberSaveable { mutableStateOf(TerminalRoute.QUEUE) }
    // One-shot "a notification asked us to open RECEIVING" latch. Kept pending
    // until the worker is signed in, so a tap never opens a half-signed-in UI.
    var pendingOpenReceiving by remember { mutableStateOf(false) }
    LaunchedEffect(openReceivingRequest) {
        if (openReceivingRequest > 0) pendingOpenReceiving = true
    }
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
    LaunchedEffect(state.signedIn, state.loginGeneration) {
        if (!state.signedIn) { route = TerminalRoute.QUEUE; pendingOpenReceiving = false }
    }
    LaunchedEffect(state.signedIn, pendingOpenReceiving) {
        if (state.signedIn && pendingOpenReceiving) {
            pendingOpenReceiving = false
            route = TerminalRoute.RECEIVING
        }
    }
    LaunchedEffect(state.tasks) {
        if (route == TerminalRoute.RECEIVING && state.me != null && state.tasks.none { it.key == "receiving" }) route = TerminalRoute.QUEUE
    }
    AyroviTerminalTheme(mode = theme, onToggleTheme = appearance::toggleTheme) {
        if (!state.signedIn) {
            SignInScreen(state, model.deviceCode, connection.name, model::login, container.device)
        } else if (route == TerminalRoute.RECEIVING && state.me?.user?.id != null) {
            val workerId = state.me!!.user!!.id!!
            // RECEIVING HOME (card-based rebuild): RECEIVING never opens the
            // scanner directly — it opens the home with PRODUIT / CARTON
            // tiles, live counters and lane-specific scanners.
            val receiving: ReceivingHomeViewModel = viewModel(
                key = "receiving-home-$workerId-${state.loginGeneration}",
                factory = factory { ReceivingHomeViewModel(container.repository, workerId, state.me!!.permissions.toSet(), container.audio) },
            )
            val available = state.verified && connection !in setOf(ConnectionState.OFFLINE, ConnectionState.AUTH_ERROR, ConnectionState.SYNC_ERROR)
            LaunchedEffect(state.me?.permissions, available, connection) {
                receiving.activate(state.me!!.permissions.toSet(), available, connection)
            }
            ReceivingHomeScreen(receiving, workerLabel(state), stationLabel(state), connection.name,
                onBack = { route = TerminalRoute.QUEUE; model.refresh() }, onAuthExpired = model::expireSession,
                device = container.device, onToggleTheme = appearance::toggleTheme,
                appVersion = com.ayrovi.worker.BuildConfig.VERSION_NAME,
                deviceCode = model.deviceCode,
                repository = container.repository)
        } else {
            WorkerWorkQueue(state, container.device, connection.name, workerLabel(state), stationLabel(state),
                model::refresh, model::logout, { showSettings = true }, model::completeAssignment) { route = TerminalRoute.RECEIVING }
        }
        if (showSettings) WorkerSettingsDialog(
            repository = container.repository,
            worker = workerLabel(state),
            station = stationLabel(state),
            connection = connection.name,
            appVersion = com.ayrovi.worker.BuildConfig.VERSION_NAME,
            deviceCode = model.deviceCode,
            device = container.device,
            onSwitchMode = { showSettings = false },
            onClose = { showSettings = false },
            onChangeDisplay = appearance::toggleTheme,
        )
    }
}

@Composable
private fun SignInScreen(state: WorkerAppState, deviceCode: String, connection: String, onSignIn: (String, String, Boolean) -> Unit, device: WorkerDevice) {
    var setup by remember { mutableStateOf(false) }
    var employee by rememberSaveable { mutableStateOf("") }
    // Deliberately NOT saveable: never persist passwords/PINs in saved state or local storage.
    var secret by remember { mutableStateOf("") }
    var pin by rememberSaveable { mutableStateOf(false) }
    TerminalShell(
        header = { TerminalHeader("SIGN IN", "SIGN-IN REQUIRED", null, connection, industrial = device == WorkerDevice.CT40, onSettings = { setup = true }) },
        footer = { TerminalFooter("AUTHORIZED WORKERS ONLY") {
            PrimaryAction("SIGN IN", { val value = secret; secret = ""; onSignIn(employee, value, pin) }, !state.busy && !state.storageLocked && employee.isNotBlank() && secret.isNotBlank())
        } },
    ) {
        TaskInstruction("SIGN IN", "Enter your employee code.")
        state.message?.let { OperationalMessageView(it) }
        if (state.busy) LoadingState("Signing in…")
        TerminalTextInput("EMPLOYEE CODE", employee, { employee = it }, enabled = !state.busy)
        TerminalTextInput(if (pin) "PIN" else "PASSWORD", secret, { secret = it }, enabled = !state.busy,
            secret = true, keyboardType = if (pin) KeyboardType.NumberPassword else KeyboardType.Password)
        SecondaryAction(if (pin) "USE PASSWORD" else "USE PIN", { pin = !pin; secret = "" }, !state.busy)
        if (setup) AlertDialog(onDismissRequest = { setup = false }, title = { Text("DEVICE SETUP") },
            text = { Column { BarcodeDisplay(deviceCode); Text("Give this code to your supervisor to register the device.") } },
            confirmButton = { SecondaryAction("CLOSE", { setup = false }) })
    }
}

@Composable
internal fun OperationalMessageView(message: OperationalMessage) {
    when (message.tone) {
        MessageTone.ERROR -> ErrorState(message.title, message.detail, message.expected, message.scanned)
        MessageTone.WARNING -> WarningState(message.title, message.detail + (message.scanned?.let { "\nScanned: $it" } ?: ""))
        MessageTone.SUCCESS -> TerminalNotice(message.title, message.detail, TerminalTone.SUCCESS)
        MessageTone.INFO -> TerminalNotice(message.title, message.detail, TerminalTone.INSTRUCTION)
    }
}

private fun workerLabel(state: WorkerAppState): String = state.me?.user?.let {
    listOfNotNull(it.name, it.employeeCode).joinToString(" · ")
} ?: "VERIFYING WORKER"
private fun stationLabel(state: WorkerAppState): String? = state.context?.station?.code
