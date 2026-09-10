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

private enum class TerminalRoute { QUEUE, RECEIVING, REPORT, TEMPORARY }

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
        factory = factory { WorkerAppViewModel(container.workerSession, container.audio, container.notifier, container.cardReads, container.pushRegistration) },
    )
    val appearance: AppearanceViewModel = viewModel(factory = factory { AppearanceViewModel(container.appearance) })
    val theme by appearance.theme.collectAsStateWithLifecycle()
    val glove by appearance.glove.collectAsStateWithLifecycle()
    val themeWarning by appearance.warning.collectAsStateWithLifecycle()
    val androidContext = androidx.compose.ui.platform.LocalContext.current
    LaunchedEffect(themeWarning) { themeWarning?.let { android.widget.Toast.makeText(androidContext, it, android.widget.Toast.LENGTH_LONG).show() } }
    val state by model.state.collectAsStateWithLifecycle()
    LaunchedEffect(theme) { onThemeChanged(theme) }
    val connection by model.connection.collectAsStateWithLifecycle()
    val owner = LocalLifecycleOwner.current
    var showSettings by remember { mutableStateOf(false) }
    var route by rememberSaveable { mutableStateOf(TerminalRoute.QUEUE) }
    // Where the report was opened FROM (QUEUE tile or RECEIVING home): BACK
    // from the report always returns there — never to a wrong screen.
    var reportFrom by rememberSaveable { mutableStateOf(TerminalRoute.QUEUE) }
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
            // Same "read" event as tapping the RECEIVING tile: arriving from
            // the tray notification means the worker has seen these cards.
            model.markReceivingRead()
            route = TerminalRoute.RECEIVING
        }
    }
    LaunchedEffect(state.tasks) {
        if ((route == TerminalRoute.RECEIVING || route == TerminalRoute.REPORT) && state.me != null && state.tasks.none { it.key == "receiving" }) route = TerminalRoute.QUEUE
        // Temporary Storage is STAGING-station work: if the backend no longer
        // exposes the task (station changed / permission removed), never keep
        // the worker on a screen they can no longer operate.
        if (route == TerminalRoute.TEMPORARY && state.me != null && state.tasks.none { it.key == "temporary-storage" }) route = TerminalRoute.QUEUE
    }
    AyroviTerminalTheme(mode = theme, onToggleTheme = appearance::toggleTheme, gloveMode = glove) {
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
                repository = container.repository,
                onOpenReport = { reportFrom = TerminalRoute.RECEIVING; route = TerminalRoute.REPORT },
                gloveOn = glove, onToggleGlove = appearance::toggleGlove)
        } else if (route == TerminalRoute.TEMPORARY && state.me?.user?.id != null) {
            // TEMPORARY STORAGE (native, CT40-first): scan product -> the
            // target container lights up -> scan that container.
            val workerId = state.me!!.user!!.id!!
            val temp: TempStorageViewModel = viewModel(
                key = "temp-storage-$workerId-${state.loginGeneration}",
                factory = factory { TempStorageViewModel(container.repository, state.me!!.permissions.toSet(), container.audio) },
            )
            val tempAvailable = state.verified && connection !in setOf(ConnectionState.OFFLINE, ConnectionState.AUTH_ERROR, ConnectionState.SYNC_ERROR)
            LaunchedEffect(state.me?.permissions, tempAvailable, connection) {
                temp.activate(state.me!!.permissions.toSet(), tempAvailable, connection)
            }
            TempStorageScreen(temp, workerLabel(state), stationLabel(state), connection.name,
                onBack = { route = TerminalRoute.QUEUE; model.refresh() }, onAuthExpired = model::expireSession,
                industrial = container.device == WorkerDevice.CT40,
                repository = container.repository, onToggleTheme = appearance::toggleTheme,
                appVersion = com.ayrovi.worker.BuildConfig.VERSION_NAME,
                deviceCode = model.deviceCode, device = container.device,
                gloveOn = glove, onToggleGlove = appearance::toggleGlove)
        } else if (route == TerminalRoute.REPORT && state.me?.user?.id != null) {
            // CONFIRMATION REPORT (ORDER 01): verification view for this
            // worker's open receiving session. Back returns to RECEIVING.
            val report: ReceivingReportViewModel = viewModel(
                key = "receiving-report-${state.loginGeneration}",
                factory = factory { ReceivingReportViewModel(container.repository, state.me!!.permissions.toSet(), container.audio) },
            )
            val reportAvailable = state.verified && connection !in setOf(ConnectionState.OFFLINE, ConnectionState.AUTH_ERROR, ConnectionState.SYNC_ERROR)
            LaunchedEffect(state.me?.permissions, reportAvailable) {
                report.activate(state.me!!.permissions.toSet(), reportAvailable)
            }
            // End-of-work cleanup on EVERY leave path (BACK, mode switch,
            // forced redirect): a finished report is auto-cleared from the
            // device, so no trace of the old transaction resurfaces. An
            // open report is kept (resume). Never fires while viewing.
            DisposableEffect(report) { onDispose { report.releaseFinished() } }
            ReceivingReportScreen(report, workerLabel(state), stationLabel(state), connection.name,
                onBack = { route = reportFrom; model.refresh() }, onAuthExpired = model::expireSession,
                industrial = container.device == WorkerDevice.CT40,
                repository = container.repository, onToggleTheme = appearance::toggleTheme,
                appVersion = com.ayrovi.worker.BuildConfig.VERSION_NAME,
                deviceCode = model.deviceCode, device = container.device,
                gloveOn = glove, onToggleGlove = appearance::toggleGlove)
        } else {
            WorkerWorkQueue(state, container.device, connection.name, workerLabel(state), stationLabel(state),
                model::refresh, model::logout, { showSettings = true }, model::completeAssignment,
                receiving = {
                    // Entering RECEIVING is the "read" event for the dispatched
                    // cards: the worker has now seen them, so the badge clears
                    // immediately while the cards themselves stay in the feed.
                    model.markReceivingRead()
                    route = TerminalRoute.RECEIVING
                },
                report = { reportFrom = TerminalRoute.QUEUE; route = TerminalRoute.REPORT },
                showReport = state.tasks.any { it.key == "receiving" },
                temporaryStorage = {
                    if (state.tasks.any { it.key == "temporary-storage" }) route = TerminalRoute.TEMPORARY
                    else model.noticeTask("Temporary Storage")
                },
                otherTask = model::noticeTask)
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
            gloveOn = glove,
            onToggleGlove = appearance::toggleGlove,
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
