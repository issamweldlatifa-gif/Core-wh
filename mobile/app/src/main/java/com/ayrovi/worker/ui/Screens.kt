package com.ayrovi.worker.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.ayrovi.worker.data.ArrivalRow
import com.ayrovi.worker.data.AssignmentsResponse
import com.ayrovi.worker.data.MeResponse
import com.ayrovi.worker.data.ReceivingSession
import com.ayrovi.worker.data.SessionStore
import com.ayrovi.worker.data.TerminalAssignment
import com.ayrovi.worker.data.TerminalContext
import com.ayrovi.worker.data.TerminalTask
import com.ayrovi.worker.data.WorkerRepository
import com.ayrovi.worker.scanner.CameraScanner
import com.ayrovi.worker.scanner.HoneywellScanner
import com.ayrovi.worker.scanner.ScanCoordinator
import java.text.SimpleDateFormat
import java.time.Instant
import java.util.Date
import java.util.Locale
import java.util.UUID
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.math.max

private val Dark = darkColorScheme(
    primary = Color(0xFF4CAF8C),
    onPrimary = Color(0xFF06120E),
    secondary = Color(0xFF58A6FF),
    background = Color(0xFF0B1220),
    surface = Color(0xFF111A2E),
    onBackground = Color(0xFFE6EDF3),
    onSurface = Color(0xFFE6EDF3),
    error = Color(0xFFFF6B6B),
)

private val Success = Color(0xFF4CAF8C)
private val Warning = Color(0xFFF0B429)
private val Danger = Color(0xFFFF6B6B)
private val Info = Color(0xFF58A6FF)

private enum class AppScreen { Login, Home, Receiving }
private enum class ScanMode { CARTON, PRODUCT }
private enum class StatusKind { OK, BAD, INFO }
private data class StatusLine(val text: String, val kind: StatusKind = StatusKind.INFO)
private data class ActivityLine(val time: String, val text: String, val kind: StatusKind)

// ---------------------------------------------------------------------------
// Root (with bottom-tab shell)
// ---------------------------------------------------------------------------

@Composable
fun AyroviApp(store: SessionStore) {
    val scope = rememberCoroutineScope()
    val repo = remember { WorkerRepository(store) }
    var me by remember { mutableStateOf<MeResponse?>(null) }
    var ctx by remember { mutableStateOf<TerminalContext?>(null) }
    var bootLoading by remember { mutableStateOf(true) }
    var appScreen by remember { mutableStateOf(AppScreen.Home) }
    var openReceivingCode by remember { mutableStateOf<String?>(null) }
    var statusLine by remember { mutableStateOf(StatusLine("READY", StatusKind.INFO)) }
    var lastAction by remember { mutableStateOf<String?>(null) }
    var bootError by remember { mutableStateOf<String?>(null) }
    var online by remember { mutableStateOf(true) }
    var nowTick by remember { mutableIntStateOf(0) }

    // Tick the clock every second for the strip/elapsed counters.
    LaunchedEffect(Unit) {
        while (true) {
            delay(1_000)
            nowTick += 1
        }
    }

    // Online/offline listener (best effort: we can't really detect it without
    // pinging but ConnectivityManager would add permission weight — just track
    // failure state by clearing on successful requests).
    fun setStatus(text: String, kind: StatusKind) {
        statusLine = StatusLine(text, kind)
    }

    suspend fun reloadContext(): Boolean {
        return try {
            me = repo.me()
            ctx = repo.terminalContext()
            online = true
            // Auto-route to in-flight work if any.
            val resume = ctx?.resume
            when {
                resume?.path?.contains("/receiving") == true -> {
                    openReceivingCode = resume.code
                    appScreen = AppScreen.Receiving
                }
            }
            bootError = null
            true
        } catch (ex: WorkerRepository.ApiException) {
            online = true
            if (ex.code == 401) {
                store.clear()
                appScreen = AppScreen.Login
                false
            } else {
                bootError = ex.message
                false
            }
        } catch (ex: Exception) {
            online = false
            bootError = ex.message ?: "Connection error."
            false
        }
    }

    LaunchedEffect(store.hasSession()) {
        bootLoading = true
        if (store.hasSession()) {
            if (reloadContext()) setStatus("READY", StatusKind.OK)
        } else {
            appScreen = AppScreen.Login
        }
        bootLoading = false
    }

    MaterialTheme(colorScheme = Dark) {
        if (appScreen == AppScreen.Login) {
            LoginScreen(
                repo = repo,
                onSuccess = {
                    scope.launch {
                        bootLoading = true
                        if (reloadContext()) {
                            appScreen = AppScreen.Home
                            setStatus("READY", StatusKind.OK)
                        }
                        bootLoading = false
                    }
                },
            )
            return@MaterialTheme
        }

        val readyTasks = ctx?.tasks?.filter { it.ready != false } ?: emptyList()
        val receivingTask = readyTasks.firstOrNull { it.key == "receiving" }

        Scaffold(
            containerColor = Dark.background,
            bottomBar = {
                TerminalTabBar(
                    current = appScreen,
                    hasReceiving = receivingTask != null,
                    receivingLabel = receivingTask?.label ?: "RECEIVING",
                    receivingInProgress = ctx?.activeSession != null,
                    onSelect = { s ->
                        if (s == AppScreen.Home) {
                            openReceivingCode = null
                            appScreen = AppScreen.Home
                            scope.launch { reloadContext() }
                        } else {
                            appScreen = AppScreen.Receiving
                        }
                    },
                )
            },
        ) { inner ->
            Column(Modifier.fillMaxSize().padding(inner).background(Dark.background)) {
                // Top strip — task / station / online / clock
                TopStrip(
                    screen = appScreen,
                    ctx = ctx,
                    me = me,
                    store = store,
                    online = online,
                    nowTick = nowTick,
                    onLogout = {
                        scope.launch { repo.logout() }
                        appScreen = AppScreen.Login
                    },
                )

                // Body
                Box(Modifier.weight(1f)) {
                    when (appScreen) {
                        AppScreen.Home -> HomeScreen(
                            repo = repo,
                            me = me,
                            ctx = ctx,
                            bootLoading = bootLoading,
                            bootError = bootError,
                            onReload = {
                                scope.launch {
                                    bootLoading = true
                                    reloadContext()
                                    bootLoading = false
                                }
                            },
                            onOpenReceiving = { code ->
                                openReceivingCode = code
                                appScreen = AppScreen.Receiving
                            },
                            onSetStatus = ::setStatus,
                            onLastAction = { lastAction = it },
                        )
                        AppScreen.Receiving -> ReceivingFlow(
                            repo = repo,
                            initialArrivalCode = openReceivingCode,
                            onBack = {
                                openReceivingCode = null
                                appScreen = AppScreen.Home
                                scope.launch {
                                    reloadContext()
                                    setStatus("READY", StatusKind.INFO)
                                }
                            },
                            onExpired = {
                                store.clear()
                                appScreen = AppScreen.Login
                            },
                            onSetStatus = ::setStatus,
                            onLastAction = { lastAction = it },
                        )
                        else -> Unit
                    }
                }

                // Footer — state / last action / station
                FooterStrip(statusLine = statusLine, lastAction = lastAction, stationName = ctx?.station?.name)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Shell: top strip, tab bar, footer
// ---------------------------------------------------------------------------

@Composable
private fun TopStrip(
    screen: AppScreen,
    ctx: TerminalContext?,
    me: MeResponse?,
    store: SessionStore,
    online: Boolean,
    nowTick: Int,
    onLogout: () -> Unit,
) {
    val taskLabel = when (screen) {
        AppScreen.Home -> "TERMINAL"
        AppScreen.Receiving -> "RECEIVING"
        else -> ""
    }
    val time = remember(nowTick) {
        SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())
    }
    Row(
        Modifier.fillMaxWidth().background(Dark.surface).padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(taskLabel, fontWeight = FontWeight.Bold, fontSize = 13.sp, color = Dark.primary, modifier = Modifier.weight(1f))
        Text(me?.user?.employeeCode ?: store.employeeCode ?: "", fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = Dark.onBackground.copy(alpha = 0.7f))
        Spacer(Modifier.width(8.dp))
        Text(
            ctx?.station?.code ?: "NO STATION",
            fontSize = 10.sp,
            fontFamily = FontFamily.Monospace,
            color = if (ctx?.station == null) Danger else Dark.onBackground.copy(alpha = 0.6f),
        )
        Spacer(Modifier.width(8.dp))
        Text(
            if (online) "ONLINE" else "OFFLINE",
            fontSize = 10.sp,
            fontWeight = FontWeight.Bold,
            color = if (online) Success else Danger,
        )
        Spacer(Modifier.width(8.dp))
        Text(time, fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = Dark.onBackground.copy(alpha = 0.5f))
        Spacer(Modifier.width(8.dp))
        OutlinedButton(onClick = onLogout, contentPadding = PaddingValues(horizontal = 10.dp, vertical = 2.dp)) {
            Text("OUT", fontSize = 10.sp)
        }
    }
}

@Composable
private fun TerminalTabBar(
    current: AppScreen,
    hasReceiving: Boolean,
    receivingLabel: String,
    receivingInProgress: Boolean,
    onSelect: (AppScreen) -> Unit,
) {
    NavigationBar(containerColor = Dark.surface, tonalElevation = 0.dp) {
        NavigationBarItem(
            selected = current == AppScreen.Home,
            onClick = { onSelect(AppScreen.Home) },
            icon = { Text("⌂", fontSize = 18.sp) },
            label = { Text("HOME", fontSize = 10.sp) },
        )
        NavigationBarItem(
            selected = current == AppScreen.Receiving,
            enabled = hasReceiving,
            onClick = { onSelect(AppScreen.Receiving) },
            icon = {
                Text(
                    if (receivingInProgress) "●" else "▣",
                    fontSize = 16.sp,
                    color = if (receivingInProgress) Warning else Color.Unspecified,
                )
            },
            label = { Text(receivingLabel.uppercase(), fontSize = 10.sp) },
        )
    }
}

@Composable
private fun FooterStrip(
    statusLine: StatusLine,
    lastAction: String?,
    stationName: String?,
) {
    val color = when (statusLine.kind) {
        StatusKind.OK -> Success
        StatusKind.BAD -> Danger
        StatusKind.INFO -> Info
    }
    Row(
        Modifier.fillMaxWidth().background(Dark.surface).padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            statusLine.text.uppercase(),
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            color = color,
            modifier = Modifier.weight(1f),
        )
        Text(
            lastAction ?: "—",
            fontSize = 10.sp,
            fontFamily = FontFamily.Monospace,
            color = Dark.onBackground.copy(alpha = 0.6f),
            modifier = Modifier.weight(1f),
            textAlign = TextAlign.Center,
            maxLines = 1,
        )
        Text(
            stationName ?: "unassigned",
            fontSize = 10.sp,
            color = Dark.onBackground.copy(alpha = 0.5f),
            fontFamily = FontFamily.Monospace,
        )
    }
}

// ---------------------------------------------------------------------------
// Login (kept as v1.1.0 — unchanged)
// ---------------------------------------------------------------------------

@Composable
private fun LoginScreen(repo: WorkerRepository, onSuccess: () -> Unit) {
    val store = SessionStore(LocalContext.current)
    var identifier by remember { mutableStateOf("") }
    var secret by remember { mutableStateOf("") }
    var deviceCode by remember { mutableStateOf(store.deviceCode) }
    var usePin by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    Box(
        Modifier.fillMaxSize().background(Dark.background).verticalScroll(rememberScrollState()),
        contentAlignment = Alignment.Center,
    ) {
        Column(Modifier.padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text("AYROVI", fontSize = 30.sp, fontWeight = FontWeight.Black, color = Dark.primary)
            Text("Worker Terminal", fontSize = 14.sp, color = Dark.onBackground.copy(alpha = 0.7f))
            Spacer(Modifier.height(28.dp))
            Card(colors = CardDefaults.cardColors(containerColor = Dark.surface), modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(18.dp)) {
                    Text("Worker sign-in", fontWeight = FontWeight.Bold, fontSize = 16.sp)
                    Spacer(Modifier.height(14.dp))
                    OutlinedTextField(
                        value = identifier,
                        onValueChange = { identifier = it },
                        label = { Text("Employee code / Worker key") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(10.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("Use PIN", fontSize = 14.sp, modifier = Modifier.weight(1f))
                        Switch(checked = usePin, onCheckedChange = { usePin = it })
                    }
                    OutlinedTextField(
                        value = secret,
                        onValueChange = { secret = it },
                        label = { Text(if (usePin) "PIN" else "Password") },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(
                            keyboardType = if (usePin) KeyboardType.NumberPassword else KeyboardType.Password,
                        ),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(10.dp))
                    OutlinedTextField(
                        value = deviceCode,
                        onValueChange = { deviceCode = it },
                        label = { Text("Device code") },
                        supportingText = { Text("Register this code in Admin Web → Devices", fontSize = 11.sp) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    if (error != null) {
                        Spacer(Modifier.height(10.dp))
                        ErrorBox(error!!)
                    }
                    Spacer(Modifier.height(16.dp))
                    Button(
                        onClick = {
                            if (identifier.isBlank() || secret.isBlank()) {
                                error = "Enter your employee code and secret."
                                return@Button
                            }
                            busy = true
                            error = null
                            scope.launch {
                                try {
                                    repo.login(identifier, secret, if (usePin) "pin" else "password", deviceCode)
                                    onSuccess()
                                } catch (ex: WorkerRepository.ApiException) {
                                    error = ex.message
                                } catch (ex: Exception) {
                                    error = ex.message ?: "Sign-in failed."
                                } finally {
                                    busy = false
                                }
                            }
                        },
                        enabled = !busy,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = Dark.onPrimary)
                        else Text("Sign in")
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Home — server-driven task picker (matches web worker terminal home)
// ---------------------------------------------------------------------------

@Composable
private fun HomeScreen(
    repo: WorkerRepository,
    me: MeResponse?,
    ctx: TerminalContext?,
    bootLoading: Boolean,
    bootError: String?,
    onReload: () -> Unit,
    onOpenReceiving: (String?) -> Unit,
    onSetStatus: (String, StatusKind) -> Unit,
    onLastAction: (String) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var assignments by remember { mutableStateOf<AssignmentsResponse?>(null) }
    var busyBtn by remember { mutableStateOf<String?>(null) }
    var tab by remember { mutableStateOf(0) } // 0 ASSIGNED / 1 TASKS

    LaunchedEffect(ctx) {
        try {
            assignments = repo.assignments()
        } catch (_: Exception) {
            assignments = AssignmentsResponse(emptyList(), emptyList())
        }
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp),
    ) {
        // Identity card
        Card(colors = CardDefaults.cardColors(containerColor = Dark.surface), modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(14.dp)) {
                val displayName = me?.user?.name?.takeIf { it.isNotBlank() }
                    ?: me?.user?.employeeCode?.takeIf { it.isNotBlank() }
                    ?: "Worker"
                Text(displayName, fontWeight = FontWeight.Bold, fontSize = 18.sp)
                ctx?.station?.let {
                    Text("${it.code} · ${it.name}", color = Dark.secondary, fontSize = 13.sp)
                } ?: Text("No station assigned", color = Danger, fontSize = 13.sp)
            }
        }
        Spacer(Modifier.height(10.dp))

        if (bootLoading) {
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        } else if (bootError != null) {
            ErrorBox(bootError)
            Spacer(Modifier.height(6.dp))
            OutlinedButton(onClick = onReload, modifier = Modifier.fillMaxWidth()) { Text("↻ RETRY") }
        } else {
            val openAssign = assignments?.open ?: emptyList()
            val readyTasks = ctx?.tasks?.filter { it.ready != false } ?: emptyList()
            val hasAny = readyTasks.isNotEmpty() || openAssign.isNotEmpty()

            if (openAssign.isNotEmpty()) {
                SectionTitle("ASSIGNED TASKS")
                openAssign.forEach { a ->
                    AssignedTaskCard(a, busy = busyBtn == a.id) {
                        scope.launch {
                            busyBtn = a.id
                            try {
                                repo.completeAssignment(a.id)
                                assignments = repo.assignments()
                                onSetStatus("DONE — ${a.title}", StatusKind.OK)
                                onLastAction("${a.title} marked done")
                            } catch (ex: Exception) {
                                onSetStatus("could not complete assigned task", StatusKind.BAD)
                            } finally { busyBtn = null }
                        }
                    }
                }
                Spacer(Modifier.height(10.dp))
            }

            if (readyTasks.isEmpty() && openAssign.isEmpty()) {
                Card(colors = CardDefaults.cardColors(containerColor = Dark.surface)) {
                    Column(Modifier.padding(18.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("NO TASK ASSIGNED", fontWeight = FontWeight.Bold, fontSize = 16.sp)
                        Spacer(Modifier.height(6.dp))
                        Text(
                            "Your account has no operational task permissions yet. Ask a supervisor to assign a role or station.",
                            fontSize = 12.sp,
                            color = Dark.onBackground.copy(alpha = 0.7f),
                            textAlign = TextAlign.Center,
                        )
                    }
                }
            } else {
                SectionTitle("MY TASKS")
                readyTasks.forEach { task ->
                    val openCode = if (task.key == "receiving") ctx?.activeSession?.code else null
                    TaskCard(
                        task = task,
                        openCode = openCode,
                    ) {
                        when (task.key) {
                            "receiving" -> onOpenReceiving(null)
                        }
                    }
                }
            }
        }
        Spacer(Modifier.height(20.dp))
    }
}

@Composable
private fun AssignedTaskCard(a: TerminalAssignment, busy: Boolean, onDone: () -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = Dark.surface), modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(a.title, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                    if (!a.relatedCode.isNullOrBlank()) {
                        Spacer(Modifier.width(6.dp))
                        Text(a.relatedCode, color = Warning, fontSize = 10.sp, fontFamily = FontFamily.Monospace)
                    }
                }
                if (!a.description.isNullOrBlank())
                    Text(a.description, fontSize = 11.sp, color = Dark.onBackground.copy(alpha = 0.6f))
            }
            Button(onClick = onDone, enabled = !busy, contentPadding = PaddingValues(horizontal = 14.dp, vertical = 4.dp)) {
                Text(if (busy) "…" else "DONE", fontSize = 12.sp)
            }
        }
    }
}

@Composable
private fun TaskCard(task: TerminalTask, openCode: String?, onOpen: () -> Unit) {
    val supported = task.key == "receiving"
    Card(colors = CardDefaults.cardColors(containerColor = Dark.surface), modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text((task.label ?: task.key ?: "Task").uppercase(), fontWeight = FontWeight.Bold, fontSize = 14.sp)
                Text(
                    if (!task.department.isNullOrBlank()) task.department else (task.description ?: task.key ?: ""),
                    fontSize = 12.sp,
                    color = Dark.onBackground.copy(alpha = 0.6f),
                )
                openCode?.let {
                    Spacer(Modifier.height(4.dp))
                    Text("IN PROGRESS · $it", color = Warning, fontSize = 10.sp, fontWeight = FontWeight.Bold)
                }
            }
            Button(onClick = onOpen, enabled = supported) { Text(if (supported) { if (openCode != null) "RESUME" else "OPEN" } else "WEB") }
        }
    }
}

// ---------------------------------------------------------------------------
// Receiving — full feature workspace
// ---------------------------------------------------------------------------

@Composable
private fun ReceivingFlow(
    repo: WorkerRepository,
    initialArrivalCode: String?,
    onBack: () -> Unit,
    onExpired: () -> Unit,
    onSetStatus: (String, StatusKind) -> Unit,
    onLastAction: (String) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var arrivals by remember { mutableStateOf<List<ArrivalRow>>(emptyList()) }
    var session by remember { mutableStateOf<ReceivingSession?>(null) }
    var loading by remember { mutableStateOf(true) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var mode by remember { mutableStateOf(ScanMode.CARTON) }
    var manual by remember { mutableStateOf("") }
    var qty by remember { mutableStateOf("1") }
    var activity by remember { mutableStateOf<List<ActivityLine>>(emptyList()) }
    var resetSignal by remember { mutableIntStateOf(0) }
    var nowTick by remember { mutableIntStateOf(0) }
    var banner by remember { mutableStateOf<Pair<String, Color>?>(null) }
    var cameraOn by remember { mutableStateOf(false) }

    fun log(text: String, kind: StatusKind) {
        activity = listOf(ActivityLine(timeNow(), text, kind)) + activity
        onLastAction(text)
    }

    suspend fun loadArrivals() { arrivals = repo.arrivals() }

    suspend fun openArrival(row: ArrivalRow) {
        val identity = row.code ?: row.id ?: return
        busy = true; error = null
        try {
            session = repo.activeSession(identity) ?: repo.startReceiving(identity)
            banner = "SESSION ACTIVE" to Info
            log("session ${session?.code} started", StatusKind.INFO)
            onSetStatus("SESSION ACTIVE", StatusKind.INFO)
        } catch (ex: WorkerRepository.ApiException) {
            if (ex.code == 401) onExpired() else error = ex.message
        } catch (ex: Exception) {
            error = ex.message
        } finally { busy = false }
    }

    LaunchedEffect(initialArrivalCode) {
        loading = true
        try {
            loadArrivals()
            initialArrivalCode?.let { code ->
                arrivals.firstOrNull { it.code == code }?.let { openArrival(it) }
            }
        } catch (ex: WorkerRepository.ApiException) {
            if (ex.code == 401) onExpired() else error = ex.message
        } catch (ex: Exception) {
            error = ex.message
        } finally { loading = false }
    }

    LaunchedEffect(session?.status) {
        if (session?.status == "COMPLETED" || session?.status == "COMPLETED_WITH_DISCREPANCY") {
            delay(2000); onBack()
        }
    }

    LaunchedEffect(Unit) {
        while (true) { delay(1_000); nowTick += 1 }
    }

    if (session == null) {
        Column(Modifier.fillMaxSize().background(Dark.background).padding(12.dp)) {
            StationHeader("RECEIVING ARRIVALS", onBack, busy || loading)
            if (error != null) { ErrorBox(error!!); Spacer(Modifier.height(6.dp)) }
            when {
                loading -> CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
                arrivals.isEmpty() -> Text("No arrivals awaiting receiving.", color = Dark.onBackground.copy(alpha = 0.65f))
                else -> ArrivalList(arrivals) { scope.launch { openArrival(it) } }
            }
        }
        return
    }

    ReceivingWorkspace(
        s = session!!,
        repo = repo,
        mode = mode,
        onModeChange = { mode = it },
        manual = manual,
        onManualChange = { manual = it },
        qty = qty,
        onQtyChange = { qty = it },
        busy = busy,
        error = error,
        banner = banner,
        resetSignal = resetSignal,
        nowTick = nowTick,
        cameraOn = cameraOn,
        onCameraChange = { cameraOn = it },
        onBack = onBack,
        onExpired = onExpired,
        onSessionChange = { session = it },
        onBusyChange = { busy = it },
        onError = { error = it },
        onBanner = { banner = it },
        onLog = ::log,
        onReset = { resetSignal += 1 },
        onSetStatus = onSetStatus,
    )
}

@Composable
private fun ArrivalList(arrivals: List<ArrivalRow>, onOpen: (ArrivalRow) -> Unit) {
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(vertical = 6.dp)) {
        items(arrivals, key = { it.id ?: it.code ?: ("ARRIVAL-" + it.hashCode()) }) { a ->
            Card(colors = CardDefaults.cardColors(containerColor = Dark.surface), modifier = Modifier.fillMaxWidth().padding(vertical = 5.dp)) {
                Row(Modifier.padding(13.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(a.code ?: "—", fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
                        Text(a.customerName ?: a.storeName ?: "—", fontSize = 13.sp)
                        Text(
                            "${a.cartons ?: 0} cartons · ${a.units ?: 0} units · ${a.products ?: 0} products",
                            fontSize = 11.sp,
                            color = Dark.onBackground.copy(alpha = 0.6f),
                        )
                    }
                    Button(onClick = { onOpen(a) }) {
                        Text(if (a.status == "EXPECTED") "START" else "RESUME")
                    }
                }
            }
        }
    }
}

@Composable
private fun ReceivingWorkspace(
    s: ReceivingSession,
    repo: WorkerRepository,
    mode: ScanMode,
    onModeChange: (ScanMode) -> Unit,
    manual: String,
    onManualChange: (String) -> Unit,
    qty: String,
    onQtyChange: (String) -> Unit,
    busy: Boolean,
    error: String?,
    banner: Pair<String, Color>?,
    resetSignal: Int,
    nowTick: Int,
    cameraOn: Boolean,
    onCameraChange: (Boolean) -> Unit,
    onBack: () -> Unit,
    onExpired: () -> Unit,
    onSessionChange: (ReceivingSession) -> Unit,
    onBusyChange: (Boolean) -> Unit,
    onError: (String?) -> Unit,
    onBanner: (Pair<String, Color>?) -> Unit,
    onLog: (String, StatusKind) -> Unit,
    onReset: () -> Unit,
    onSetStatus: (String, StatusKind) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val paused = s.status == "PAUSED"
    val done = s.status == "COMPLETED" || s.status == "COMPLETED_WITH_DISCREPANCY"
    val openDisc = s.discrepancies.filter { it.status == "OPEN" }
    val context = LocalContext.current
    var cameraGranted by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
    }
    val permLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { cameraGranted = it }

    LaunchedEffect(cameraOn) {
        if (cameraOn && !cameraGranted) permLauncher.launch(Manifest.permission.CAMERA)
    }

    // Honeywell side-trigger scanner (same as v1.1.0, attached to this screen).
    val coordinatorHolder = remember { arrayOfNulls<ScanCoordinator>(1) }
    val onAcceptedState = rememberUpdatedState<(String, Boolean, String) -> Unit> { value, fromOcr, source ->
        scope.launch { submitScan(repo, s, mode, value, if (mode == ScanMode.PRODUCT) (qty.toIntOrNull() ?: 1) else 1, fromOcr, source, onSessionChange, onBusyChange, onError, onBanner, onLog, onSetStatus, onReset) }
    }
    val onRejectedState = rememberUpdatedState<(String) -> Unit> { reason -> onBanner(reason.replace('_', ' ') to Warning) }
    val coordinator = remember {
        ScanCoordinator(
            onAccepted = { v, o, src -> onAcceptedState.value(v, o, src) },
            onRejected = { r -> onRejectedState.value(r) },
        ).also { coordinatorHolder[0] = it }
    }
    LaunchedEffect(resetSignal) { if (resetSignal > 0) coordinatorHolder[0]?.reset() }

    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val scanner = HoneywellScanner(context) { value ->
            if (!busy && !paused && !done) coordinatorHolder[0]?.onScanned(value, fromOcr = false, source = HoneywellScanner.SOURCE)
        }
        val obs = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> scanner.start()
                Lifecycle.Event.ON_PAUSE -> scanner.stop()
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(obs)
        onDispose { lifecycleOwner.lifecycle.removeObserver(obs); scanner.stop() }
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp).background(Dark.background)) {
        // Session bar
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            OutlinedButton(onClick = onBack, contentPadding = PaddingValues(horizontal = 10.dp)) { Text("‹") }
            Spacer(Modifier.width(8.dp))
            Column(Modifier.weight(1f)) {
                Text(s.code, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
                Text(
                    "${s.arrival.customerName ?: "—"} · ${s.arrival.code ?: "—"}",
                    fontSize = 12.sp,
                    color = Dark.onBackground.copy(alpha = 0.7f),
                )
            }
            Text(elapsedSince(s.startedAt, nowTick), fontFamily = FontFamily.Monospace, color = Dark.secondary)
        }
        Spacer(Modifier.height(6.dp))

        banner?.let { Banner(it.first, it.second) }
        if (error != null) { ErrorBox(error!!); Spacer(Modifier.height(4.dp)) }

        // Tally (3 metric cards)
        val t = s.tally
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            MetricCell("CARTONS", "${t.receivedCartons}/${t.expectedCartons}", Modifier.weight(1f), (t.receivedCartons >= t.expectedCartons && t.expectedCartons > 0))
            MetricCell("UNITS", "${t.receivedUnits}/${t.expectedUnits}", Modifier.weight(1f), (t.receivedUnits >= t.expectedUnits && t.expectedUnits > 0))
            MetricCell("EXCEPTIONS", "${t.openDiscrepancies}", Modifier.weight(1f), bad = t.openDiscrepancies > 0)
        }
        Spacer(Modifier.height(6.dp))

        // Controls: pause/resume, complete
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            OutlinedButton(
                onClick = {
                    scope.launch {
                        onBusyChange(true); onError(null)
                        try {
                            onSessionChange(if (paused) repo.resumeSession(s.id) else repo.pauseSession(s.id))
                            onBanner((if (!paused) "SESSION PAUSED" else "SESSION RESUMED") to Dark.secondary)
                            onLog(if (paused) "session resumed" else "session paused", StatusKind.INFO)
                        } catch (ex: Exception) { onError(ex.message) }
                        finally { onBusyChange(false) }
                    }
                },
                enabled = !busy && !done,
                modifier = Modifier.weight(1f),
            ) { Text(if (paused) "RESUME" else "PAUSE") }
            Button(
                onClick = {
                    scope.launch {
                        onBusyChange(true); onError(null)
                        try {
                            val r = repo.completeSession(s.id)
                            onSessionChange(r)
                            onBanner("RECEIVING COMPLETE" to Success)
                            onLog("receiving completed", StatusKind.OK)
                            onSetStatus("COMPLETE", StatusKind.OK)
                        } catch (ex: Exception) { onError(ex.message) }
                        finally { onBusyChange(false) }
                    }
                },
                enabled = !busy && !paused && !done,
                modifier = Modifier.weight(1f),
            ) { Text("COMPLETE") }
        }
        if (paused) { Spacer(Modifier.height(6.dp)); Banner("SESSION PAUSED", Warning) }
        Spacer(Modifier.height(10.dp))

        // Mode toggle
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            ModeButton("CARTON", mode == ScanMode.CARTON, Modifier.weight(1f)) { onModeChange(ScanMode.CARTON); onBanner(null); onReset() }
            ModeButton("PRODUCT", mode == ScanMode.PRODUCT, Modifier.weight(1f)) { onModeChange(ScanMode.PRODUCT); onBanner(null); onReset() }
        }
        Spacer(Modifier.height(6.dp))

        // Camera scanner surface
        Card(colors = CardDefaults.cardColors(containerColor = Dark.surface), modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(if (mode == ScanMode.CARTON) "SCAN CARTON" else "SCAN PRODUCT", color = Dark.secondary, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                    if (HoneywellScanner.isHoneywellDevice()) Text("SIDE TRIGGER", color = Success, fontSize = 10.sp)
                }
                if (cameraOn && cameraGranted && !busy && !paused && !done) {
                    Spacer(Modifier.height(6.dp))
                    Box(Modifier.fillMaxWidth().height(240.dp).background(Color.Black)) {
                        CameraScanner(ocrEnabled = false, coordinator = coordinator, modifier = Modifier.fillMaxSize())
                    }
                } else if (cameraOn && !cameraGranted) {
                    OutlinedButton(onClick = { permLauncher.launch(Manifest.permission.CAMERA) }, modifier = Modifier.fillMaxWidth()) { Text("GRANT CAMERA") }
                }
                Row(Modifier.fillMaxWidth().padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Camera", fontSize = 12.sp, modifier = Modifier.weight(1f))
                    Switch(checked = cameraOn, onCheckedChange = onCameraChange, enabled = !busy && !paused && !done)
                }
            }
        }
        Spacer(Modifier.height(8.dp))

        // Manual entry — same path, mode-aware label
        Text(if (mode == ScanMode.CARTON) "SCAN OR TYPE CARTON" else "SCAN OR TYPE PRODUCT", fontSize = 11.sp, fontWeight = FontWeight.Bold)
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = manual,
                onValueChange = onManualChange,
                singleLine = true,
                enabled = !busy && !paused && !done,
                label = { Text(if (mode == ScanMode.CARTON) "Carton code" else "SKU / reference") },
                modifier = Modifier.weight(1f),
            )
            if (mode == ScanMode.PRODUCT) {
                Spacer(Modifier.width(6.dp))
                OutlinedTextField(
                    value = qty,
                    onValueChange = { onQtyChange(it.filter(Char::isDigit).take(4)) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    label = { Text("Qty") },
                    modifier = Modifier.width(72.dp),
                    enabled = !busy && !paused && !done,
                )
            }
            Spacer(Modifier.width(6.dp))
            Button(
                onClick = {
                    val value = manual; val q = qty.toIntOrNull()?.coerceAtLeast(1) ?: 1
                    onManualChange(""); onQtyChange("1")
                    scope.launch { submitScan(repo, s, mode, value, q, false, "MANUAL", onSessionChange, onBusyChange, onError, onBanner, onLog, onSetStatus, onReset) }
                },
                enabled = manual.isNotBlank() && !busy && !paused && !done,
            ) { Text("ENTER") }
        }
        Spacer(Modifier.height(10.dp))

        // Cartons list
        SectionTitle("CARTONS · ${s.cartons.count { it.status == "RECEIVED" }}/${s.cartons.size}")
        if (s.cartons.isEmpty()) Text("No cartons declared.", color = Dark.onBackground.copy(alpha = 0.6f), fontSize = 12.sp)
        s.cartons.forEach { c ->
            val received = c.status == "RECEIVED"
            Row(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
                Text(if (received) "✓" else "○", color = if (received) Success else Dark.onBackground)
                Spacer(Modifier.width(8.dp))
                Text(c.externalCartonId ?: c.reference ?: "—", fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f))
                Text(c.status ?: "—", fontSize = 11.sp, color = if (received) Success else Dark.onBackground.copy(alpha = 0.65f))
            }
            HorizontalDivider(color = Dark.onBackground.copy(alpha = 0.08f))
        }

        Spacer(Modifier.height(10.dp))
        // Products table (key columns only for mobile)
        if (s.products.isNotEmpty()) {
            SectionTitle("PRODUCTS · ${s.products.size} lines")
            s.products.forEach { p ->
                val sku = p.sku ?: p.reference
                Card(colors = CardDefaults.cardColors(containerColor = Dark.surface), modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
                    Row(Modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(sku ?: "—", fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, fontSize = 12.sp)
                            Text(p.productName ?: "", fontSize = 11.sp, color = Dark.onBackground.copy(alpha = 0.7f), maxLines = 1)
                            Text(
                                "exp ${p.expected} · rec ${p.received} · rem ${p.remaining}",
                                fontSize = 10.sp,
                                color = if (p.remaining == 0) Success else Dark.onBackground.copy(alpha = 0.6f),
                            )
                        }
                        Button(
                            onClick = {
                                if (sku == null) return@Button
                                scope.launch { submitScan(repo, s, ScanMode.PRODUCT, sku, 1, false, "MANUAL", onSessionChange, onBusyChange, onError, onBanner, onLog, onSetStatus, onReset) }
                            },
                            enabled = !busy && !paused && !done && !sku.isNullOrBlank(),
                            contentPadding = PaddingValues(horizontal = 10.dp, vertical = 2.dp),
                        ) { Text("+1", fontSize = 11.sp) }
                    }
                }
            }
        }

        // Exceptions
        if (openDisc.isNotEmpty()) {
            Spacer(Modifier.height(10.dp))
            SectionTitle("EXCEPTIONS · ${openDisc.size} open")
            openDisc.forEach { d ->
                Text("${d.type?.replace("_", " ") ?: "EXCEPTION"} · ${d.reason ?: "—"}", color = Danger, fontSize = 12.sp, modifier = Modifier.padding(vertical = 2.dp))
            }
        }

        // Activity log
        Spacer(Modifier.height(10.dp))
        SectionTitle("ACTIVITY")
        if (activity.isEmpty() && s.receivedCartonEvents.isEmpty()) Text("No activity yet.", color = Dark.onBackground.copy(alpha = 0.6f), fontSize = 12.sp)
        activity.take(25).forEach {
            Text("${it.time}  ${it.text}", color = when (it.kind) { StatusKind.OK -> Dark.onBackground; StatusKind.BAD -> Danger; StatusKind.INFO -> Dark.secondary }, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
        }
        s.receivedCartonEvents.take(10).forEach {
            Text(
                "${formatIsoTime(it.receivedAt)}  ${it.status ?: "SCAN"}  ${it.cartonId ?: it.code ?: "—"}",
                color = Dark.onBackground.copy(alpha = 0.6f),
                fontFamily = FontFamily.Monospace,
                fontSize = 11.sp,
            )
        }
        Spacer(Modifier.height(16.dp))
    }
}

private suspend fun submitScan(
    repo: WorkerRepository,
    s: ReceivingSession,
    mode: ScanMode,
    rawValue: String,
    qty: Int,
    fromOcr: Boolean,
    source: String,
    onSessionChange: (ReceivingSession) -> Unit,
    onBusyChange: (Boolean) -> Unit,
    onError: (String?) -> Unit,
    onBanner: (Pair<String, Color>?) -> Unit,
    onLog: (String, StatusKind) -> Unit,
    onSetStatus: (String, StatusKind) -> Unit,
    onReset: () -> Unit,
) {
    val value = rawValue.trim()
    if (value.isEmpty()) return
    onBusyChange(true); onError(null)
    try {
        if (mode == ScanMode.CARTON) {
            val identified = repo.scanCarton(s.id, value, scanTypeFor(fromOcr, source), UUID.randomUUID().toString(), source)
            when (identified.flash?.kind) {
                "CARTON_IDENTIFIED" -> {
                    val cartonId = jsonStringField(identified.flash?.carton, "externalCartonId")
                        ?: jsonStringField(identified.flash?.carton, "id")
                        ?: throw IllegalStateException("Identified carton missing id/externalCartonId.")
                    val committed = repo.receiveCarton(s.id, cartonId, UUID.randomUUID().toString(), source)
                    onSessionChange(committed)
                    onBanner("$cartonId RECEIVED · ${committed.tally.receivedCartons}/${committed.tally.expectedCartons}" to Success)
                    onLog("carton $cartonId received", StatusKind.OK)
                    onSetStatus("ACCEPTED", StatusKind.OK)
                }
                "UNKNOWN_CARTON" -> { onBanner("$value · UNKNOWN CARTON" to Danger); onLog("$value unknown carton", StatusKind.BAD); onSessionChange(identified) }
                "WRONG_SHIPMENT" -> { onBanner("$value · WRONG SHIPMENT" to Danger); onLog("$value wrong shipment", StatusKind.BAD); onSessionChange(identified) }
                "DUPLICATE_CARTON" -> { onBanner("$value · ALREADY RECEIVED" to Warning); onLog("$value duplicate", StatusKind.BAD); onSessionChange(identified) }
                else -> { onBanner("$value · NOT ACCEPTED" to Danger); onLog("$value rejected", StatusKind.BAD); onSessionChange(identified) }
            }
        } else {
            val updated = repo.receiveProduct(s.id, value, qty.coerceAtLeast(1), UUID.randomUUID().toString(), source)
            onSessionChange(updated)
            if (updated.flash?.kind == "UNEXPECTED_PRODUCT") {
                onBanner("$value · UNEXPECTED PRODUCT" to Danger)
                onLog("product $value unexpected", StatusKind.BAD)
            } else {
                onBanner("$value +$qty · ${updated.tally.receivedUnits}/${updated.tally.expectedUnits} UNITS" to Success)
                onLog("product $value +$qty received", StatusKind.OK)
                onSetStatus("ACCEPTED", StatusKind.OK)
                onReset() // allow immediate repeat scan
            }
        }
    } catch (ex: WorkerRepository.ApiException) {
        if (ex.code == 401) { onError(null); return }
        onError(ex.message); onBanner(ex.message to Danger); onLog("server rejected $value", StatusKind.BAD)
    } catch (ex: Exception) {
        onError(ex.message); onBanner((ex.message ?: "error") to Danger); onLog("error on $value", StatusKind.BAD)
    } finally { onBusyChange(false) }
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

@Composable
private fun StationHeader(title: String, onBack: () -> Unit, busy: Boolean) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        OutlinedButton(onClick = onBack, contentPadding = PaddingValues(horizontal = 10.dp)) { Text("‹") }
        Spacer(Modifier.width(8.dp))
        Text(title, fontWeight = FontWeight.Black, fontSize = 18.sp, modifier = Modifier.weight(1f))
        if (busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
    }
    Spacer(Modifier.height(8.dp))
}

@Composable
private fun MetricCell(label: String, value: String, modifier: Modifier = Modifier, ok: Boolean = false, bad: Boolean = false) {
    Card(colors = CardDefaults.cardColors(containerColor = when { bad -> Danger.copy(alpha = 0.16f); ok -> Success.copy(alpha = 0.12f); else -> Dark.surface }), modifier = modifier) {
        Column(Modifier.fillMaxWidth().padding(10.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(value, fontSize = 20.sp, fontWeight = FontWeight.Black, color = when { bad -> Danger; ok -> Success; else -> Dark.primary })
            Text(label, fontSize = 9.sp, color = Dark.onBackground.copy(alpha = 0.6f))
        }
    }
}

@Composable
private fun ModeButton(label: String, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    if (selected) Button(onClick = onClick, modifier = modifier) { Text(label) }
    else OutlinedButton(onClick = onClick, modifier = modifier) { Text(label) }
}

@Composable
private fun SectionTitle(title: String) {
    Text(title, fontWeight = FontWeight.Bold, fontSize = 12.sp, color = Dark.secondary, modifier = Modifier.padding(vertical = 6.dp))
}

@Composable
private fun Banner(message: String, color: Color) {
    Box(Modifier.fillMaxWidth().padding(bottom = 6.dp).background(color, RoundedCornerShape(4.dp)).padding(10.dp), contentAlignment = Alignment.Center) {
        Text(message, color = Color.Black, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center, fontSize = 12.sp)
    }
}

@Composable
private fun ErrorBox(message: String) {
    Box(Modifier.fillMaxWidth().background(Danger.copy(alpha = 0.15f)).padding(10.dp)) { Text(message, color = Danger, fontSize = 12.sp) }
}

private fun scanTypeFor(fromOcr: Boolean, source: String): String =
    if (fromOcr || source == "MANUAL") "MANUAL" else "BARCODE"

private fun jsonStringField(element: JsonElement?, key: String): String? = runCatching {
    element?.jsonObject?.get(key)?.jsonPrimitive?.contentOrNull
}.getOrNull()

private fun elapsedSince(startedAt: String, tick: Int): String {
    val start = runCatching { Instant.parse(startedAt).toEpochMilli() }.getOrElse { System.currentTimeMillis() }
    val seconds = max(0L, (System.currentTimeMillis() - start) / 1000L)
    val h = seconds / 3600; val m = (seconds % 3600) / 60; val s = seconds % 60
    return String.format(Locale.US, "%02d:%02d:%02d", h, m, s)
}

private fun formatIsoTime(value: String?): String {
    if (value == null) return "--:--:--"
    return runCatching { SimpleDateFormat("HH:mm:ss", Locale.US).format(Date.from(Instant.parse(value))) }.getOrElse { "--:--:--" }
}

private fun timeNow(): String = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())
