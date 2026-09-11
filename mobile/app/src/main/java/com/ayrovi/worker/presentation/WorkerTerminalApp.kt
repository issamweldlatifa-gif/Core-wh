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

private enum class TerminalRoute { QUEUE, RECEIVING, REPORT, TEMPORARY, SORTING, PACKING, SCAN, SHIPPING, TRACE }

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
    val glare by appearance.glare.collectAsStateWithLifecycle()
    val coachPending by appearance.coachPending.collectAsStateWithLifecycle()
    val themeWarning by appearance.warning.collectAsStateWithLifecycle()
    val androidContext = androidx.compose.ui.platform.LocalContext.current
    LaunchedEffect(themeWarning) { themeWarning?.let { android.widget.Toast.makeText(androidContext, it, android.widget.Toast.LENGTH_LONG).show() } }
    val state by model.state.collectAsStateWithLifecycle()
    LaunchedEffect(theme) { onThemeChanged(theme) }
    val connection by model.connection.collectAsStateWithLifecycle()
    val owner = LocalLifecycleOwner.current
    var showSettings by remember { mutableStateOf(false) }
    var route by rememberSaveable { mutableStateOf(TerminalRoute.QUEUE) }
    // HOME scan tools (§9/§14): whether the OCR flow opens on top of the AUTO
    // scanner (OCR tile) or the scanner stands alone (QR CODE tile).
    var scanOcrFirst by rememberSaveable { mutableStateOf(false) }
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
        // STABILITY: only a REAL task removal redirects. An empty/partial list
        // (refresh in flight, weak network, low battery) must never yank the
        // worker out of RECEIVING / the scan tool mid-work.
        if (state.tasks.isNotEmpty() && (route == TerminalRoute.RECEIVING || route == TerminalRoute.SCAN || route == TerminalRoute.REPORT) && state.me != null && state.tasks.none { it.key == "receiving" }) route = TerminalRoute.QUEUE
        // Temporary Storage is STAGING-station work: if the backend no longer
        // exposes the task (station changed / permission removed), never keep
        // the worker on a screen they can no longer operate.
        if (route == TerminalRoute.TEMPORARY && state.me != null && state.tasks.none { it.key == "temporary-storage" }) route = TerminalRoute.QUEUE
        if (route == TerminalRoute.SORTING && state.me != null && state.tasks.none { it.key == "customer-sorting" }) route = TerminalRoute.QUEUE
        if (route == TerminalRoute.PACKING && state.me != null && state.tasks.none { it.key == "packing" }) route = TerminalRoute.QUEUE
        if (route == TerminalRoute.SHIPPING && state.me != null && state.tasks.none { it.key == "shipping" }) route = TerminalRoute.QUEUE
        if (route == TerminalRoute.TRACE && state.me != null && state.tasks.none { it.key == "archive-trace" }) route = TerminalRoute.QUEUE
    }
    AyroviTerminalTheme(mode = theme, onToggleTheme = appearance::toggleTheme, gloveMode = glove, glareBoost = glare) {
        if (!state.signedIn) {
            SignInScreen(state, model.deviceCode, connection.name, model::login, container.device)
        } else if (route == TerminalRoute.RECEIVING && state.me?.user?.id != null) {
            // RECEIVING WORK CENTER (UX RESTRUCTURE §5): opens DIRECTLY on the
            // live receiving content — TO DO / ISSUES / DONE cards + the
            // existing PRODUCT / CARTON lane scanners. No intermediate picker.
            ReceivingHomeRoute(container, state, connection, model,
                onExitSession = { route = TerminalRoute.QUEUE; model.refresh() },
                vmKey = "receiving-home", openWith = null, ocrFirst = false,
                glove = glove, glare = glare,
                onToggleTheme = appearance::toggleTheme,
                onToggleGlove = appearance::toggleGlove, onToggleGlare = appearance::toggleGlare,
                coachPending = coachPending, onCoachDone = appearance::markCoachDone,
                onBack = { route = TerminalRoute.QUEUE; model.refresh() })
        } else if (route == TerminalRoute.SCAN && state.me?.user?.id != null) {
            // §9/§14 HOME TOOLS — QR CODE / OCR: the scanner opens DIRECTLY
            // (no Receiving → Product → Carton steps). Scans run through the
            // EXISTING matching/verify/error logic; only the entry changed.
            ReceivingHomeRoute(container, state, connection, model,
                // v1.7.5: every exit of the QR CODE tool (camera BACK, red
                // verdict BACK) lands on the MAIN home — no intermediate page.
                onExitSession = { route = TerminalRoute.QUEUE; model.refresh() },
                vmKey = "scan-tool", openWith = ReceivingHomeIntent.OpenAutoScan, ocrFirst = scanOcrFirst,
                glove = glove, glare = glare,
                onToggleTheme = appearance::toggleTheme,
                onToggleGlove = appearance::toggleGlove, onToggleGlare = appearance::toggleGlare,
                coachPending = false, onCoachDone = {},
                onBack = { route = TerminalRoute.QUEUE; model.refresh() })
        } else if (route == TerminalRoute.SORTING && state.me?.user?.id != null) {
            // v1.7.6 FIX FOUND BY THE DEAD-CODE SWEEP: the SORTING route was
            // reachable from Home but had NO composition branch — the tile
            // silently re-rendered Home. The station screen + VM + gateway
            // always existed (and are test-covered); only this wiring was
            // lost. Pure navigation wiring, zero business changes.
            val sort: SortingViewModel = viewModel(
                key = "sorting-${state.loginGeneration}",
                factory = factory { SortingViewModel(RepoSortingGateway(container.repository), container.audio) },
            )
            SortingScreen(sort, workerLabel(state), stationLabel(state), connection.name,
                onBack = { route = TerminalRoute.QUEUE; model.refresh() }, onAuthExpired = model::expireSession,
                industrial = container.device == WorkerDevice.CT40,
                repository = container.repository,
                appVersion = com.ayrovi.worker.BuildConfig.VERSION_NAME,
                deviceCode = model.deviceCode, device = container.device,
                onToggleTheme = appearance::toggleTheme,
                gloveOn = glove, onToggleGlove = appearance::toggleGlove,
                glareOn = glare, onToggleGlare = appearance::toggleGlare)
        } else if (route == TerminalRoute.SHIPPING && state.me?.user?.id != null) {
            // SHIPPING (native, CT40-first): scan the label -> cards -> the
            // ONE deliberate confirm (dispatch is irreversible) -> green flash.
            val ship: ShippingViewModel = viewModel(
                key = "shipping-${state.loginGeneration}",
                factory = factory { ShippingViewModel(RepoShippingGateway(container.repository), container.audio) },
            )
            val shipAvailable = state.verified && connection !in setOf(ConnectionState.OFFLINE, ConnectionState.AUTH_ERROR, ConnectionState.SYNC_ERROR)
            LaunchedEffect(shipAvailable) { ship.setAvailable(shipAvailable) }
            ShippingScreen(ship, workerLabel(state), stationLabel(state), connection.name,
                onBack = { route = TerminalRoute.QUEUE; model.refresh() }, onAuthExpired = model::expireSession,
                industrial = container.device == WorkerDevice.CT40,
                repository = container.repository,
                appVersion = com.ayrovi.worker.BuildConfig.VERSION_NAME,
                deviceCode = model.deviceCode, device = container.device,
                onToggleTheme = appearance::toggleTheme,
                gloveOn = glove, onToggleGlove = appearance::toggleGlove,
                glareOn = glare, onToggleGlare = appearance::toggleGlare)
        } else if (route == TerminalRoute.TRACE && state.me?.user?.id != null) {
            // ARCHIVE / TRACE (native, read-only): scan an article -> full chain.
            val trace: TraceViewModel = viewModel(
                key = "trace-${state.loginGeneration}",
                factory = factory { TraceViewModel(RepoTraceGateway(container.repository), container.audio) },
            )
            val traceAvailable = state.verified && connection !in setOf(ConnectionState.OFFLINE, ConnectionState.AUTH_ERROR, ConnectionState.SYNC_ERROR)
            LaunchedEffect(traceAvailable) { trace.setAvailable(traceAvailable) }
            TraceScreen(trace, workerLabel(state), stationLabel(state), connection.name,
                onBack = { route = TerminalRoute.QUEUE; model.refresh() }, onAuthExpired = model::expireSession,
                industrial = container.device == WorkerDevice.CT40,
                repository = container.repository,
                appVersion = com.ayrovi.worker.BuildConfig.VERSION_NAME,
                deviceCode = model.deviceCode, device = container.device,
                onToggleTheme = appearance::toggleTheme,
                gloveOn = glove, onToggleGlove = appearance::toggleGlove,
                glareOn = glare, onToggleGlare = appearance::toggleGlare)
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
                gloveOn = glove, onToggleGlove = appearance::toggleGlove,
                glareOn = glare, onToggleGlare = appearance::toggleGlare)
        } else if (route == TerminalRoute.PACKING && state.me?.user?.id != null) {
            // PACKING (native, CT40-first): scan a customer bin — a COMPLETE
            // bin packs immediately (zero-touch), an INCOMPLETE one is a
            // persistent amber verdict listing the missing items.
            val pack: PackingViewModel = viewModel(
                key = "packing-${state.loginGeneration}",
                factory = factory { PackingViewModel(RepoPackingGateway(container.repository), container.audio) },
            )
            val packAvailable = state.verified && connection !in setOf(ConnectionState.OFFLINE, ConnectionState.AUTH_ERROR, ConnectionState.SYNC_ERROR)
            LaunchedEffect(packAvailable) { pack.setAvailable(packAvailable) }
            PackingScreen(pack, workerLabel(state), stationLabel(state), connection.name,
                onBack = { route = TerminalRoute.QUEUE; model.refresh() }, onAuthExpired = model::expireSession,
                industrial = container.device == WorkerDevice.CT40,
                repository = container.repository,
                appVersion = com.ayrovi.worker.BuildConfig.VERSION_NAME,
                deviceCode = model.deviceCode, device = container.device,
                onToggleTheme = appearance::toggleTheme,
                gloveOn = glove, onToggleGlove = appearance::toggleGlove,
                glareOn = glare, onToggleGlare = appearance::toggleGlare)
        } else if (route == TerminalRoute.REPORT && state.me?.user?.id != null) {
            // CONFIRMATION REPORT (ORDER 01): verification view for this
            // worker's open receiving session. Back returns to RECEIVING.
            val report: ReceivingReportViewModel = viewModel(
                key = "receiving-report-${state.loginGeneration}",
                factory = factory {
                    ReceivingReportViewModel(container.repository, state.me!!.permissions.toSet(), container.audio,
                        // v1.7.5: a finished rapport wipes every operational
                        // trace of previous receiving work from the device.
                        operationalWipe = { container.cardReads.clearAll() })
                },
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
            // HOME (UX RESTRUCTURE §3): RECEIVING / OCR / QR CODE / RAPPORT /
            // SETTINGS — one clear terminal. The worker's other assigned
            // stations keep their own tiles (§17) and every action keeps its
            // existing handler.
            WorkerHomeScreen(state, container.device, connection.name, workerLabel(state), stationLabel(state),
                model::refresh, model::logout, { showSettings = true }, model::completeAssignment,
                receiving = {
                    // Entering RECEIVING is the "read" event for the dispatched
                    // cards: the worker has now seen them, so the badge clears
                    // immediately while the cards themselves stay in the feed.
                    model.markReceivingRead()
                    route = TerminalRoute.RECEIVING
                },
                report = { reportFrom = TerminalRoute.QUEUE; route = TerminalRoute.REPORT },
                // §9/§14: the tools open their scanner DIRECTLY (no lane
                // picker) — QR CODE lands in the AUTO scanner, OCR opens the
                // existing OCR flow on top of it.
                openOcr = { scanOcrFirst = true; route = TerminalRoute.SCAN },
                openQr = { scanOcrFirst = false; route = TerminalRoute.SCAN },
                temporaryStorage = {
                    if (state.tasks.any { it.key == "temporary-storage" }) route = TerminalRoute.TEMPORARY
                    else model.noticeTask("Temporary Storage")
                },
                otherTask = { key ->
                    when (key) {
                        "customer-sorting" -> route = TerminalRoute.SORTING
                        "packing" -> route = TerminalRoute.PACKING
                        "shipping" -> route = TerminalRoute.SHIPPING
                        "archive-trace" -> route = TerminalRoute.TRACE
                        else -> model.noticeTask(key)
                    }
                })
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
            onPurgeData = { model.purgeOperationalData() },
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

/**
 * RECEIVING route — SHARED by the RECEIVING work center and the HOME scan
 * tools (§20: one route, no duplicated screens). One workflow, one scanner
 * stack, one set of existing success/error flows; the only differences are
 * the view-model instance key and the one-shot entry intent (AUTO scanner /
 * OCR chooser) plus where BACK and the report return to.
 */
@Composable
private fun ReceivingHomeRoute(
    container: AppContainer,
    state: WorkerAppState,
    connection: ConnectionState,
    model: WorkerAppViewModel,
    vmKey: String,
    openWith: ReceivingHomeIntent?,
    ocrFirst: Boolean,
    glove: Boolean,
    glare: Boolean,
    onToggleTheme: () -> Unit,
    onToggleGlove: () -> Unit,
    onToggleGlare: () -> Unit,
    coachPending: Boolean,
    onCoachDone: () -> Unit,
    onBack: () -> Unit,
    onExitSession: (() -> Unit)? = null,
) {
    val workerId = state.me!!.user!!.id!!
    val receiving: ReceivingHomeViewModel = viewModel(
        key = "$vmKey-$workerId-${state.loginGeneration}",
        factory = factory { ReceivingHomeViewModel(container.repository, workerId, state.me!!.permissions.toSet(), container.audio) },
    )
    val available = state.verified && connection !in setOf(ConnectionState.OFFLINE, ConnectionState.AUTH_ERROR, ConnectionState.SYNC_ERROR)
    LaunchedEffect(state.me?.permissions, available, connection) {
        receiving.activate(state.me!!.permissions.toSet(), available, connection)
    }
    ReceivingHomeScreen(receiving, workerLabel(state), stationLabel(state), connection.name,
        onBack = onBack, onAuthExpired = model::expireSession,
        device = container.device, onToggleTheme = onToggleTheme,
        openWith = openWith, ocrFirst = ocrFirst,
        onExitSession = onExitSession,
        gloveOn = glove, onToggleGlove = onToggleGlove,
        glareOn = glare, onToggleGlare = onToggleGlare,
        coachPending = coachPending, onCoachDone = onCoachDone)
}

private fun workerLabel(state: WorkerAppState): String = state.me?.user?.let {
    listOfNotNull(it.name, it.employeeCode).joinToString(" · ")
} ?: "VERIFYING WORKER"
private fun stationLabel(state: WorkerAppState): String? = state.context?.station?.code
