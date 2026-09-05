package com.ayrovi.worker.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
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
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
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
import com.ayrovi.worker.data.PutawayFlashView
import com.ayrovi.worker.data.PutawayQueueCarton
import com.ayrovi.worker.data.PutawaySession
import com.ayrovi.worker.data.ReceivingSession
import com.ayrovi.worker.data.SessionStore
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
private enum class Screen { Login, Home, Receiving, Putaway }

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

@Composable
fun AyroviApp(store: SessionStore) {
    val scope = rememberCoroutineScope()
    val repo = remember { WorkerRepository(store) }
    var screen by remember { mutableStateOf(if (store.hasSession()) Screen.Home else Screen.Login) }
    var openReceivingCode by remember { mutableStateOf<String?>(null) }

    MaterialTheme(colorScheme = Dark) {
        when (screen) {
            Screen.Login -> LoginScreen(repo = repo, onSuccess = { screen = Screen.Home })
            Screen.Home -> HomeScreen(
                store = store,
                repo = repo,
                onExpired = {
                    store.clear()
                    screen = Screen.Login
                },
                onOpenReceiving = {
                    openReceivingCode = it
                    screen = Screen.Receiving
                },
                onOpenPutaway = { screen = Screen.Putaway },
                onLogout = {
                    scope.launch { repo.logout() }
                    screen = Screen.Login
                },
            )
            Screen.Receiving -> ReceivingFlow(
                repo = repo,
                initialArrivalCode = openReceivingCode,
                onBack = { screen = Screen.Home },
                onExpired = {
                    store.clear()
                    screen = Screen.Login
                },
            )
            Screen.Putaway -> PutawayFlow(
                repo = repo,
                onBack = { screen = Screen.Home },
                onExpired = {
                    store.clear()
                    screen = Screen.Login
                },
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Login
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
                                    repo.login(
                                        identifier = identifier,
                                        secret = secret,
                                        mode = if (usePin) "pin" else "password",
                                        deviceCode = deviceCode.trim(),
                                    )
                                    onSuccess()
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
                        if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                        else Text("Sign in")
                    }
                }
            }
            Spacer(Modifier.height(14.dp))
            Text(
                "Native worker surface · server-enforced device and station access",
                fontSize = 11.sp,
                color = Dark.onBackground.copy(alpha = 0.5f),
                textAlign = TextAlign.Center,
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Home — server-driven workflows
// ---------------------------------------------------------------------------

@Composable
private fun HomeScreen(
    store: SessionStore,
    repo: WorkerRepository,
    onExpired: () -> Unit,
    onOpenReceiving: (String?) -> Unit,
    onOpenPutaway: () -> Unit,
    onLogout: () -> Unit,
) {
    var ctx by remember { mutableStateOf<TerminalContext?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(true) }

    LaunchedEffect(Unit) {
        try {
            ctx = repo.terminalContext()
        } catch (ex: WorkerRepository.ApiException) {
            if (ex.code == 401) onExpired() else error = ex.message
        } catch (ex: Exception) {
            error = ex.message
        } finally {
            busy = false
        }
    }

    Column(
        Modifier.fillMaxSize().background(Dark.background).verticalScroll(rememberScrollState()).padding(16.dp),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                "AYROVI Worker",
                fontWeight = FontWeight.Black,
                fontSize = 20.sp,
                color = Dark.primary,
                modifier = Modifier.weight(1f),
            )
            OutlinedButton(onClick = onLogout) { Text("LOGOUT", fontSize = 12.sp) }
        }
        Text(
            "DEVICE ${store.deviceCode}",
            fontFamily = FontFamily.Monospace,
            fontSize = 11.sp,
            color = Dark.onBackground.copy(alpha = 0.6f),
        )
        Spacer(Modifier.height(14.dp))

        if (busy) {
            CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
        } else if (error != null) {
            ErrorBox(error!!)
        } else {
            val c = ctx
            if (c != null) {
                Card(colors = CardDefaults.cardColors(containerColor = Dark.surface), modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp)) {
                        Text(store.employeeCode ?: "Worker", fontWeight = FontWeight.Bold, fontSize = 18.sp)
                        c.station?.let {
                            Text("${it.code} · ${it.name}", color = Dark.secondary, fontSize = 13.sp)
                        } ?: Text("No station assigned", color = Danger, fontSize = 13.sp)
                    }
                }
                Spacer(Modifier.height(14.dp))
                Text("YOUR WORKFLOWS", fontWeight = FontWeight.Bold, fontSize = 14.sp)
                Spacer(Modifier.height(6.dp))
                val tasks = c.tasks.filter { it.ready != false }
                if (tasks.isEmpty()) {
                    Text("No workflow is assigned. Ask a manager.", color = Dark.onBackground.copy(alpha = 0.7f))
                }
                tasks.forEach { task ->
                    val supported = task.key == "receiving" || task.key == "putaway"
                    TaskCard(task, supported) {
                        when (task.key) {
                            "receiving" -> onOpenReceiving(null)
                            "putaway" -> onOpenPutaway()
                        }
                    }
                }
                c.activeSession?.let { active ->
                    Spacer(Modifier.height(12.dp))
                    ResumeCard("RECEIVING", active.code) {
                        onOpenReceiving(active.expectedArrival?.code)
                    }
                }
                c.activePutaway?.let { active ->
                    Spacer(Modifier.height(8.dp))
                    ResumeCard("PUTAWAY", active.code) { onOpenPutaway() }
                }
            }
        }
    }
}

@Composable
private fun TaskCard(task: TerminalTask, enabled: Boolean, onOpen: () -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = Dark.surface), modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text((task.label ?: task.key ?: "Task").uppercase(), fontWeight = FontWeight.Bold, fontSize = 14.sp)
                Text(task.description ?: task.key ?: "", fontSize = 12.sp, color = Dark.onBackground.copy(alpha = 0.6f))
            }
            Button(onClick = onOpen, enabled = enabled) { Text(if (enabled) "OPEN" else "WEB") }
        }
    }
}

@Composable
private fun ResumeCard(label: String, code: String?, onOpen: () -> Unit) {
    Card(
        colors = CardDefaults.cardColors(containerColor = Dark.secondary.copy(alpha = 0.12f)),
        border = BorderStroke(1.dp, Dark.secondary),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("IN PROGRESS · $label", color = Dark.secondary, fontWeight = FontWeight.Bold, fontSize = 12.sp)
                Text(code ?: "OPEN SESSION", fontFamily = FontFamily.Monospace)
            }
            Button(onClick = onOpen) { Text("RESUME") }
        }
    }
}

// ---------------------------------------------------------------------------
// Receiving — arrivals → full station session
// ---------------------------------------------------------------------------

@Composable
private fun ReceivingFlow(
    repo: WorkerRepository,
    initialArrivalCode: String?,
    onBack: () -> Unit,
    onExpired: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var arrivals by remember { mutableStateOf<List<ArrivalRow>>(emptyList()) }
    var session by remember { mutableStateOf<ReceivingSession?>(null) }
    var loading by remember { mutableStateOf(true) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    suspend fun loadArrivals() {
        arrivals = repo.arrivals()
    }

    suspend fun openArrival(row: ArrivalRow) {
        val identity = row.code ?: row.id ?: return
        busy = true
        error = null
        try {
            session = repo.activeSession(identity) ?: repo.startReceiving(identity)
        } catch (ex: WorkerRepository.ApiException) {
            if (ex.code == 401) onExpired() else error = ex.message
        } catch (ex: Exception) {
            error = ex.message
        } finally {
            busy = false
        }
    }

    LaunchedEffect(initialArrivalCode) {
        loading = true
        try {
            loadArrivals()
            if (initialArrivalCode != null) {
                arrivals.firstOrNull { it.code == initialArrivalCode }?.let { openArrival(it) }
            }
        } catch (ex: WorkerRepository.ApiException) {
            if (ex.code == 401) onExpired() else error = ex.message
        } catch (ex: Exception) {
            error = ex.message
        } finally {
            loading = false
        }
    }

    if (session != null) {
        ReceivingWorkspace(
            initial = session!!,
            repo = repo,
            onExpired = onExpired,
            onClose = {
                session = null
                scope.launch {
                    try { loadArrivals() } catch (_: Exception) { /* retain last list */ }
                }
            },
        )
        return
    }

    Column(Modifier.fillMaxSize().background(Dark.background).padding(12.dp)) {
        StationHeader(title = "RECEIVING ARRIVALS", onBack = onBack, busy = busy || loading)
        if (error != null) {
            ErrorBox(error!!)
            Spacer(Modifier.height(8.dp))
        }
        when {
            loading -> CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
            arrivals.isEmpty() -> Text("No arrivals awaiting receiving.", color = Dark.onBackground.copy(alpha = 0.65f))
            else -> ArrivalList(arrivals) { scope.launch { openArrival(it) } }
        }
    }
}

@Composable
private fun ArrivalList(arrivals: List<ArrivalRow>, onOpen: (ArrivalRow) -> Unit) {
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(vertical = 6.dp)) {
        items(arrivals, key = { it.id ?: it.code ?: it.customerName ?: UUID.randomUUID().toString() }) { a ->
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

private enum class ReceivingMode { CARTON, PRODUCT }
private data class ActivityLine(val time: String, val text: String, val ok: Boolean)

@Composable
private fun ReceivingWorkspace(
    initial: ReceivingSession,
    repo: WorkerRepository,
    onExpired: () -> Unit,
    onClose: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var session by remember(initial.id) { mutableStateOf(initial) }
    var mode by remember { mutableStateOf(ReceivingMode.CARTON) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var banner by remember { mutableStateOf<Pair<String, Color>?>(null) }
    var manual by remember { mutableStateOf("") }
    var quantity by remember { mutableStateOf("1") }
    var activity by remember { mutableStateOf<List<ActivityLine>>(emptyList()) }
    var resetSignal by remember { mutableStateOf(0) }
    var now by remember { mutableStateOf(System.currentTimeMillis()) }

    val paused = session.status == "PAUSED"
    val done = session.status == "COMPLETED" || session.status == "COMPLETED_WITH_DISCREPANCY"

    LaunchedEffect(session.status) {
        while (!done) {
            now = System.currentTimeMillis()
            delay(1_000)
        }
    }
    LaunchedEffect(done) {
        if (done) {
            delay(2_000)
            onClose()
        }
    }

    fun log(text: String, ok: Boolean = true) {
        activity = (listOf(ActivityLine(timeNow(), text, ok)) + activity).take(30)
    }

    suspend fun submit(valueRaw: String, fromOcr: Boolean, source: String, requestedQuantity: Int = 1) {
        val value = valueRaw.trim()
        if (value.isEmpty() || busy || paused || done) return
        busy = true
        error = null
        try {
            if (mode == ReceivingMode.CARTON) {
                val identified = repo.scanCarton(
                    sessionId = session.id,
                    code = value,
                    scanType = scanTypeFor(fromOcr, source),
                    operationId = UUID.randomUUID().toString(),
                    source = source,
                )
                session = identified
                when (identified.flash?.kind) {
                    "CARTON_IDENTIFIED" -> {
                        // The commit must use the server-resolved carton identity,
                        // never the untrusted raw scan value.
                        val cartonId = jsonStringField(identified.flash.carton, "externalCartonId")
                        if (cartonId.isNullOrBlank()) {
                            throw IllegalStateException("Identified carton has no externalCartonId.")
                        }
                        session = repo.receiveCarton(
                            sessionId = session.id,
                            cartonId = cartonId,
                            operationId = UUID.randomUUID().toString(),
                            source = source,
                        )
                        banner = "$cartonId RECEIVED · ${session.tally.receivedCartons}/${session.tally.expectedCartons}" to Success
                        log("carton $cartonId received")
                    }
                    "UNKNOWN_CARTON" -> {
                        banner = "$value · UNKNOWN CARTON" to Danger
                        log("$value rejected: unknown carton", false)
                    }
                    "WRONG_SHIPMENT" -> {
                        banner = "$value · WRONG SHIPMENT" to Danger
                        log("$value rejected: wrong shipment", false)
                    }
                    "DUPLICATE_CARTON" -> {
                        banner = "$value · ALREADY RECEIVED" to Warning
                        log("$value duplicate", false)
                    }
                    else -> {
                        banner = "$value · NOT ACCEPTED" to Danger
                        log("$value rejected", false)
                    }
                }
            } else {
                val qty = if (source == "MANUAL") requestedQuantity.coerceAtLeast(1) else 1
                val updated = repo.receiveProduct(
                    sessionId = session.id,
                    sku = value,
                    quantity = qty,
                    operationId = UUID.randomUUID().toString(),
                    source = source,
                )
                session = updated
                if (updated.flash?.kind == "UNEXPECTED_PRODUCT") {
                    banner = "$value · UNEXPECTED PRODUCT" to Danger
                    log("product $value not on expected list", false)
                } else {
                    banner = "$value +$qty · ${updated.tally.receivedUnits}/${updated.tally.expectedUnits} UNITS" to Success
                    log("product $value +$qty received")
                    // Product receiving is piece-by-piece. The same expected SKU
                    // must be accepted again immediately on the next trigger.
                    resetSignal += 1
                }
            }
        } catch (ex: WorkerRepository.ApiException) {
            if (ex.code == 401) onExpired()
            else {
                error = ex.message
                banner = ex.message to Danger
                log("server rejected $value", false)
            }
        } catch (ex: Exception) {
            error = ex.message ?: "Server error"
            banner = (ex.message ?: "Server error") to Danger
            log("error on $value", false)
        } finally {
            busy = false
        }
    }

    suspend fun togglePause() {
        busy = true
        error = null
        try {
            session = if (paused) repo.resumeSession(session.id) else repo.pauseSession(session.id)
            banner = (if (session.status == "PAUSED") "SESSION PAUSED" else "SESSION RESUMED") to Dark.secondary
            log(if (session.status == "PAUSED") "session paused" else "session resumed")
        } catch (ex: WorkerRepository.ApiException) {
            if (ex.code == 401) onExpired() else error = ex.message
        } catch (ex: Exception) {
            error = ex.message
        } finally {
            busy = false
        }
    }

    suspend fun complete() {
        busy = true
        error = null
        try {
            session = repo.completeSession(session.id)
            banner = "RECEIVING COMPLETE" to Success
            log("receiving completed")
        } catch (ex: WorkerRepository.ApiException) {
            if (ex.code == 401) onExpired() else error = ex.message
        } catch (ex: Exception) {
            error = ex.message
        } finally {
            busy = false
        }
    }

    if (done) {
        CompletionCard(
            title = "RECEIVING COMPLETE",
            code = session.code,
            detail = "${session.tally.receivedCartons}/${session.tally.expectedCartons} cartons · " +
                "${session.tally.receivedUnits}/${session.tally.expectedUnits} units",
        )
        return
    }

    Column(
        Modifier.fillMaxSize().background(Dark.background).verticalScroll(rememberScrollState()).padding(12.dp),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            OutlinedButton(onClick = onClose) { Text("‹") }
            Spacer(Modifier.width(8.dp))
            Column(Modifier.weight(1f)) {
                Text(session.code, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
                Text(
                    "${session.arrival.customerName ?: "—"} · ${session.arrival.code ?: "—"}",
                    fontSize = 12.sp,
                    color = Dark.onBackground.copy(alpha = 0.7f),
                )
            }
            Text(elapsedSince(session.startedAt, now), fontFamily = FontFamily.Monospace, color = Dark.secondary)
        }
        Spacer(Modifier.height(8.dp))

        banner?.let { Banner(it.first, it.second) }
        if (error != null) ErrorBox(error!!)

        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            MetricCell("CARTONS", "${session.tally.receivedCartons}/${session.tally.expectedCartons}", Modifier.weight(1f))
            MetricCell("UNITS", "${session.tally.receivedUnits}/${session.tally.expectedUnits}", Modifier.weight(1f))
            MetricCell("EXC", session.tally.openDiscrepancies.toString(), Modifier.weight(1f), session.tally.openDiscrepancies > 0)
        }
        Spacer(Modifier.height(8.dp))

        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { scope.launch { togglePause() } }, enabled = !busy, modifier = Modifier.weight(1f)) {
                Text(if (paused) "RESUME" else "PAUSE")
            }
            Button(onClick = { scope.launch { complete() } }, enabled = !busy && !paused, modifier = Modifier.weight(1f)) {
                Text("COMPLETE")
            }
        }
        if (paused) {
            Spacer(Modifier.height(8.dp))
            Banner("SESSION PAUSED", Warning)
        }

        Spacer(Modifier.height(12.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ModeButton("CARTON", mode == ReceivingMode.CARTON, Modifier.weight(1f)) { mode = ReceivingMode.CARTON }
            ModeButton("PRODUCT", mode == ReceivingMode.PRODUCT, Modifier.weight(1f)) { mode = ReceivingMode.PRODUCT }
        }
        Spacer(Modifier.height(8.dp))

        StationScanner(
            enabled = !busy && !paused,
            prompt = if (mode == ReceivingMode.CARTON) "SCAN CARTON" else "SCAN PRODUCT",
            resetSignal = resetSignal,
            onAccepted = { value, fromOcr, source -> scope.launch { submit(value, fromOcr, source) } },
            onRejected = { reason -> banner = reason.replace('_', ' ') to Warning },
        )

        Spacer(Modifier.height(8.dp))
        Text(if (mode == ReceivingMode.CARTON) "SCAN OR TYPE CARTON" else "SCAN OR TYPE PRODUCT", fontSize = 11.sp, fontWeight = FontWeight.Bold)
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = manual,
                onValueChange = { manual = it },
                singleLine = true,
                enabled = !busy && !paused,
                label = { Text(if (mode == ReceivingMode.CARTON) "Carton code" else "SKU / reference") },
                modifier = Modifier.weight(1f),
            )
            if (mode == ReceivingMode.PRODUCT) {
                Spacer(Modifier.width(6.dp))
                OutlinedTextField(
                    value = quantity,
                    onValueChange = { quantity = it.filter(Char::isDigit).take(4) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    label = { Text("Qty") },
                    modifier = Modifier.width(84.dp),
                )
            }
            Spacer(Modifier.width(6.dp))
            Button(
                onClick = {
                    val value = manual
                    val qty = quantity.toIntOrNull()?.coerceAtLeast(1) ?: 1
                    manual = ""
                    quantity = "1"
                    scope.launch { submit(value, false, "MANUAL", qty) }
                },
                enabled = manual.isNotBlank() && !busy && !paused,
            ) { Text("ENTER") }
        }

        Spacer(Modifier.height(12.dp))
        if (mode == ReceivingMode.CARTON) {
            SectionTitle("CARTONS")
            if (session.cartons.isEmpty()) Text("No cartons declared.", color = Dark.onBackground.copy(alpha = 0.6f))
            session.cartons.forEach { carton ->
                val received = carton.status == "RECEIVED"
                Row(Modifier.fillMaxWidth().padding(vertical = 5.dp)) {
                    Text(if (received) "✓" else "○", color = if (received) Success else Dark.onBackground)
                    Spacer(Modifier.width(8.dp))
                    Text(carton.externalCartonId ?: carton.reference ?: "—", fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f))
                    Text(carton.status ?: "—", fontSize = 11.sp, color = if (received) Success else Dark.onBackground.copy(alpha = 0.65f))
                }
                HorizontalDivider(color = Dark.onBackground.copy(alpha = 0.08f))
            }
        } else {
            SectionTitle("EXPECTED PRODUCTS")
            if (session.products.isEmpty()) Text("No product lines declared.", color = Dark.onBackground.copy(alpha = 0.6f))
            session.products.forEach { product ->
                val sku = product.sku ?: product.reference
                Card(colors = CardDefaults.cardColors(containerColor = Dark.surface), modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                    Row(Modifier.padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(sku ?: "—", fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold)
                            Text(product.productName ?: "", fontSize = 12.sp)
                            Text(
                                "received ${product.received} · remaining ${product.remaining} · expected ${product.expected}",
                                color = if (product.remaining == 0) Success else Dark.onBackground.copy(alpha = 0.65f),
                                fontSize = 11.sp,
                            )
                        }
                        Button(
                            onClick = { if (sku != null) scope.launch { submit(sku, false, "MANUAL", 1) } },
                            enabled = sku != null && !busy && !paused,
                        ) { Text("+1") }
                    }
                }
            }
        }

        val openDiscrepancies = session.discrepancies.filter { it.status == "OPEN" }
        if (openDiscrepancies.isNotEmpty()) {
            Spacer(Modifier.height(12.dp))
            SectionTitle("EXCEPTIONS · ${openDiscrepancies.size}")
            openDiscrepancies.forEach {
                Text("${it.type ?: "EXCEPTION"} · ${it.reason ?: "—"}", color = Danger, fontSize = 12.sp, modifier = Modifier.padding(vertical = 3.dp))
            }
        }

        Spacer(Modifier.height(12.dp))
        SectionTitle("ACTIVITY")
        if (activity.isEmpty() && session.receivedCartonEvents.isEmpty()) {
            Text("No activity yet.", color = Dark.onBackground.copy(alpha = 0.6f))
        }
        activity.forEach {
            Text("${it.time}  ${it.text}", color = if (it.ok) Dark.onBackground else Danger, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
        }
        session.receivedCartonEvents.take(15).forEach {
            Text(
                "${formatIsoTime(it.receivedAt)}  ${it.status ?: "SCAN"}  ${it.cartonId ?: it.code ?: "—"}",
                color = Dark.onBackground.copy(alpha = 0.65f),
                fontFamily = FontFamily.Monospace,
                fontSize = 11.sp,
            )
        }
        Spacer(Modifier.height(24.dp))
    }
}

// ---------------------------------------------------------------------------
// Putaway — queue → CARTON → LOCATION → placement
// ---------------------------------------------------------------------------

private enum class PutawayStep { CARTON, LOCATION }
private data class StagedCarton(val code: String, val source: String, val customer: String?, val currentLocation: String?)

@Composable
private fun PutawayFlow(repo: WorkerRepository, onBack: () -> Unit, onExpired: () -> Unit) {
    val scope = rememberCoroutineScope()
    var session by remember { mutableStateOf<PutawaySession?>(null) }
    var queue by remember { mutableStateOf<List<PutawayQueueCarton>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var banner by remember { mutableStateOf<Pair<String, Color>?>(null) }
    var manual by remember { mutableStateOf("") }
    var step by remember { mutableStateOf(PutawayStep.CARTON) }
    var staged by remember { mutableStateOf<StagedCarton?>(null) }
    var activity by remember { mutableStateOf<List<ActivityLine>>(emptyList()) }
    var resetSignal by remember { mutableStateOf(0) }

    suspend fun refreshQueue() {
        queue = repo.putawayQueue()
    }

    LaunchedEffect(Unit) {
        try {
            session = repo.activePutaway()
            refreshQueue()
        } catch (ex: WorkerRepository.ApiException) {
            if (ex.code == 401) onExpired() else error = ex.message
        } catch (ex: Exception) {
            error = ex.message
        } finally {
            loading = false
        }
    }

    fun log(text: String, ok: Boolean = true) {
        activity = (listOf(ActivityLine(timeNow(), text, ok)) + activity).take(30)
    }

    suspend fun start() {
        busy = true
        error = null
        try {
            session = repo.startPutaway()
            banner = "PUTAWAY SESSION ACTIVE" to Dark.secondary
            log("session ${session?.code} started")
        } catch (ex: WorkerRepository.ApiException) {
            if (ex.code == 401) onExpired() else error = ex.message
        } catch (ex: Exception) {
            error = ex.message
        } finally {
            busy = false
        }
    }

    fun rejectText(flash: PutawayFlashView, value: String): String = when (flash.kind) {
        "UNKNOWN_CARTON" -> "$value · UNKNOWN CARTON"
        "CARTON_NOT_RECEIVED" -> "$value · NOT RECEIVED (${flash.status ?: "UNKNOWN"})"
        "UNKNOWN_LOCATION" -> "$value · UNKNOWN LOCATION"
        "LOCATION_UNAVAILABLE" -> "$value · LOCATION ${flash.status ?: "UNAVAILABLE"}"
        else -> "$value · NOT ACCEPTED"
    }

    suspend fun submit(raw: String, source: String) {
        val value = raw.trim()
        val active = session ?: return
        if (value.isEmpty() || busy || active.status == "PAUSED" || active.status == "COMPLETED") return
        busy = true
        error = null
        try {
            if (step == PutawayStep.CARTON) {
                val flash = repo.scanPutawayCarton(value)
                if (flash.kind != "CARTON_READY") {
                    val text = rejectText(flash, value)
                    banner = text to Danger
                    log(text, false)
                } else {
                    val cartonCode = jsonStringField(flash.carton, "externalCartonId")
                        ?: throw IllegalStateException("Carton response has no externalCartonId.")
                    staged = StagedCarton(
                        code = cartonCode,
                        source = source,
                        customer = jsonStringField(flash.carton, "customerName"),
                        currentLocation = jsonStringField(flash.carton, "currentLocation"),
                    )
                    step = PutawayStep.LOCATION
                    banner = "$cartonCode READY · SCAN LOCATION" to Dark.secondary
                    log("carton $cartonCode staged")
                }
            } else {
                val carton = staged ?: run {
                    step = PutawayStep.CARTON
                    return
                }
                val locationFlash = repo.scanPutawayLocation(value)
                if (locationFlash.kind != "LOCATION_READY") {
                    val text = rejectText(locationFlash, value)
                    banner = text to Danger
                    log(text, false)
                } else {
                    val locationCode = jsonStringField(locationFlash.location, "locationCode")
                        ?: throw IllegalStateException("Location response has no locationCode.")
                    val placed = repo.placePutaway(
                        sessionId = active.id,
                        cartonCode = carton.code,
                        locationCode = locationCode,
                        cartonSource = carton.source,
                        locationSource = source,
                    )
                    if (placed.flash.kind != "STORED") {
                        val text = rejectText(placed.flash, value)
                        banner = text to Danger
                        log(text, false)
                    } else {
                        session = placed.session ?: repo.putawayDetail(active.id)
                        val verb = if (placed.flash.moved == true) "MOVED TO" else "STORED AT"
                        banner = "${carton.code} $verb $locationCode" to Success
                        log("${carton.code} → $locationCode")
                        staged = null
                        step = PutawayStep.CARTON
                        resetSignal += 1
                        refreshQueue()
                    }
                }
            }
        } catch (ex: WorkerRepository.ApiException) {
            if (ex.code == 401) onExpired()
            else {
                error = ex.message
                banner = ex.message to Danger
                log("server rejected $value", false)
            }
        } catch (ex: Exception) {
            error = ex.message ?: "Server error"
            banner = (ex.message ?: "Server error") to Danger
            log("error on $value", false)
        } finally {
            busy = false
        }
    }

    suspend fun togglePause() {
        val active = session ?: return
        busy = true
        try {
            session = if (active.status == "PAUSED") repo.resumePutaway(active.id) else repo.pausePutaway(active.id)
            banner = (if (session?.status == "PAUSED") "SESSION PAUSED" else "SESSION RESUMED") to Dark.secondary
        } catch (ex: WorkerRepository.ApiException) {
            if (ex.code == 401) onExpired() else error = ex.message
        } catch (ex: Exception) {
            error = ex.message
        } finally {
            busy = false
        }
    }

    suspend fun complete() {
        val active = session ?: return
        busy = true
        try {
            session = repo.completePutaway(active.id)
            banner = "PUTAWAY COMPLETE" to Success
        } catch (ex: WorkerRepository.ApiException) {
            if (ex.code == 401) onExpired() else error = ex.message
        } catch (ex: Exception) {
            error = ex.message
        } finally {
            busy = false
        }
    }

    val active = session
    val done = active?.status == "COMPLETED"
    LaunchedEffect(done) {
        if (done) {
            delay(2_000)
            onBack()
        }
    }

    if (done && active != null) {
        CompletionCard(
            title = "PUTAWAY COMPLETE",
            code = active.code,
            detail = "${active.tally.storedThisSession} cartons stored · ${active.tally.totalPlacements} placements",
        )
        return
    }

    if (active == null) {
        Column(
            Modifier.fillMaxSize().background(Dark.background).verticalScroll(rememberScrollState()).padding(12.dp),
        ) {
            StationHeader("PUTAWAY", onBack, loading || busy)
            if (error != null) ErrorBox(error!!)
            Spacer(Modifier.height(24.dp))
            Card(colors = CardDefaults.cardColors(containerColor = Dark.surface), modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(if (loading) "—" else queue.size.toString(), fontSize = 40.sp, fontWeight = FontWeight.Black, color = Dark.primary)
                    Text("CARTONS WAITING", fontSize = 12.sp)
                    Spacer(Modifier.height(18.dp))
                    Button(onClick = { scope.launch { start() } }, enabled = !loading && !busy && error == null, modifier = Modifier.fillMaxWidth()) {
                        Text("START PUTAWAY")
                    }
                }
            }
            queue.take(12).forEach {
                Text(
                    "${it.externalCartonId ?: "—"} · ${it.customerName ?: it.arrivalCode ?: ""}",
                    modifier = Modifier.padding(top = 8.dp),
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                )
            }
        }
        return
    }

    val paused = active.status == "PAUSED"
    Column(
        Modifier.fillMaxSize().background(Dark.background).verticalScroll(rememberScrollState()).padding(12.dp),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            OutlinedButton(onClick = onBack) { Text("‹") }
            Spacer(Modifier.width(8.dp))
            Column(Modifier.weight(1f)) {
                Text(active.code, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold)
                Text(active.station?.code ?: "PUTAWAY", color = Dark.secondary, fontSize = 12.sp)
            }
            if (busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
        }
        Spacer(Modifier.height(8.dp))
        banner?.let { Banner(it.first, it.second) }
        if (error != null) ErrorBox(error!!)

        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            MetricCell("STORED", active.tally.storedThisSession.toString(), Modifier.weight(1f))
            MetricCell("WAITING", active.tally.pendingCartons.toString(), Modifier.weight(1f))
            MetricCell("MOVES", active.tally.totalPlacements.toString(), Modifier.weight(1f))
        }
        Spacer(Modifier.height(8.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { scope.launch { togglePause() } }, enabled = !busy, modifier = Modifier.weight(1f)) {
                Text(if (paused) "RESUME" else "PAUSE")
            }
            Button(onClick = { scope.launch { complete() } }, enabled = !busy && !paused, modifier = Modifier.weight(1f)) {
                Text("COMPLETE")
            }
        }

        Spacer(Modifier.height(12.dp))
        Card(colors = CardDefaults.cardColors(containerColor = Dark.surface), modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(14.dp)) {
                Text("1  CARTON", color = if (step == PutawayStep.CARTON) Dark.primary else Success, fontWeight = FontWeight.Bold)
                Text(staged?.code ?: "Scan a received carton", fontFamily = FontFamily.Monospace)
                staged?.customer?.let { Text(it, fontSize = 12.sp, color = Dark.onBackground.copy(alpha = 0.65f)) }
                staged?.currentLocation?.let { Text("Currently at $it · this will move it", fontSize = 11.sp, color = Warning) }
                Spacer(Modifier.height(12.dp))
                Text("2  LOCATION", color = if (step == PutawayStep.LOCATION) Dark.primary else Dark.onBackground.copy(alpha = 0.45f), fontWeight = FontWeight.Bold)
                Text(if (step == PutawayStep.LOCATION) "Scan the destination shelf" else "Waiting for carton", fontSize = 12.sp)
            }
        }

        if (paused) {
            Spacer(Modifier.height(8.dp))
            Banner("SESSION PAUSED", Warning)
        }
        Spacer(Modifier.height(8.dp))
        StationScanner(
            enabled = !busy && !paused,
            prompt = if (step == PutawayStep.CARTON) "SCAN CARTON" else "SCAN LOCATION",
            resetSignal = resetSignal,
            onAccepted = { value, _, source -> scope.launch { submit(value, source) } },
            onRejected = { reason -> banner = reason.replace('_', ' ') to Warning },
        )

        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = manual,
                onValueChange = { manual = it },
                label = { Text(if (step == PutawayStep.CARTON) "Carton code" else "Location code") },
                singleLine = true,
                enabled = !busy && !paused,
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(6.dp))
            Button(
                onClick = {
                    val value = manual
                    manual = ""
                    scope.launch { submit(value, "MANUAL") }
                },
                enabled = manual.isNotBlank() && !busy && !paused,
            ) { Text("ENTER") }
        }
        if (staged != null) {
            OutlinedButton(
                onClick = {
                    staged = null
                    step = PutawayStep.CARTON
                    banner = "CARTON CLEARED" to Warning
                },
                enabled = !busy,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("CANCEL CARTON") }
        }

        Spacer(Modifier.height(12.dp))
        SectionTitle("WAITING CARTONS · ${queue.size}")
        queue.take(20).forEach { carton ->
            val code = carton.externalCartonId
            Row(Modifier.fillMaxWidth().padding(vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(code ?: "—", fontFamily = FontFamily.Monospace)
                    Text(carton.customerName ?: carton.arrivalCode ?: "", fontSize = 11.sp, color = Dark.onBackground.copy(alpha = 0.6f))
                }
                OutlinedButton(
                    onClick = { if (code != null) scope.launch { submit(code, "MANUAL") } },
                    enabled = code != null && step == PutawayStep.CARTON && !busy && !paused,
                ) { Text("SELECT") }
            }
            HorizontalDivider(color = Dark.onBackground.copy(alpha = 0.08f))
        }

        Spacer(Modifier.height(12.dp))
        SectionTitle("THIS SESSION")
        if (active.placements.isEmpty()) Text("No placements yet.", color = Dark.onBackground.copy(alpha = 0.6f))
        active.placements.forEach {
            Text(
                "${formatIsoTime(it.placedAt)}  ${it.cartonCode ?: "—"} → ${it.locationCode ?: "—"}${if (it.releasedAt != null) " · MOVED" else ""}",
                fontFamily = FontFamily.Monospace,
                fontSize = 11.sp,
                color = if (it.releasedAt == null) Dark.onBackground else Dark.onBackground.copy(alpha = 0.5f),
                modifier = Modifier.padding(vertical = 3.dp),
            )
        }
        if (activity.isNotEmpty()) {
            Spacer(Modifier.height(12.dp))
            SectionTitle("ACTIVITY")
            activity.forEach {
                Text("${it.time}  ${it.text}", color = if (it.ok) Dark.onBackground else Danger, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

// ---------------------------------------------------------------------------
// Shared native scanner surface
// ---------------------------------------------------------------------------

@Composable
private fun StationScanner(
    enabled: Boolean,
    prompt: String,
    resetSignal: Int,
    onAccepted: (String, Boolean, String) -> Unit,
    onRejected: (String) -> Unit,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val honeywell = remember { HoneywellScanner.isHoneywellDevice() }
    var cameraOn by remember { mutableStateOf(!honeywell) }
    var ocrEnabled by remember { mutableStateOf(false) }
    var cameraGranted by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
    }
    val acceptedState = rememberUpdatedState(onAccepted)
    val rejectedState = rememberUpdatedState(onRejected)

    // Holder avoids a forward reference from scanner callbacks while keeping
    // one coordinator instance alive for camera and Honeywell input.
    val coordinatorHolder = remember { arrayOfNulls<ScanCoordinator>(1) }
    val coordinator = remember {
        ScanCoordinator(
            onAccepted = { value, fromOcr, source -> acceptedState.value(value, fromOcr, source) },
            onRejected = { reason -> rejectedState.value(reason) },
        ).also { coordinatorHolder[0] = it }
    }
    LaunchedEffect(resetSignal) {
        if (resetSignal > 0) coordinatorHolder[0]?.reset()
    }

    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        cameraGranted = it
    }
    LaunchedEffect(cameraOn, enabled) {
        if (enabled && cameraOn && !cameraGranted) permissionLauncher.launch(Manifest.permission.CAMERA)
    }

    DisposableEffect(lifecycleOwner, enabled) {
        val scanner = HoneywellScanner(context) { value ->
            if (enabled) coordinatorHolder[0]?.onScanned(value, fromOcr = false, source = HoneywellScanner.SOURCE)
        }
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> if (enabled) scanner.start()
                Lifecycle.Event.ON_PAUSE -> scanner.stop()
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        if (enabled && lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) scanner.start()
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
            scanner.stop()
        }
    }

    Card(colors = CardDefaults.cardColors(containerColor = Dark.surface), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(prompt, color = Dark.secondary, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                if (honeywell) Text("SIDE TRIGGER ACTIVE", color = Success, fontSize = 10.sp)
            }
            if (cameraOn && cameraGranted && enabled) {
                Spacer(Modifier.height(8.dp))
                Box(Modifier.fillMaxWidth().height(250.dp).background(Color.Black)) {
                    CameraScanner(ocrEnabled = ocrEnabled, coordinator = coordinator, modifier = Modifier.fillMaxSize())
                }
            } else if (cameraOn && !cameraGranted) {
                OutlinedButton(onClick = { permissionLauncher.launch(Manifest.permission.CAMERA) }, modifier = Modifier.fillMaxWidth()) {
                    Text("GRANT CAMERA ACCESS")
                }
            }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("Camera", fontSize = 12.sp, modifier = Modifier.weight(1f))
                Switch(checked = cameraOn, onCheckedChange = { cameraOn = it }, enabled = enabled)
                Spacer(Modifier.width(10.dp))
                Text("OCR", fontSize = 12.sp)
                Switch(checked = ocrEnabled, onCheckedChange = { ocrEnabled = it }, enabled = enabled && cameraOn)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Shared UI/helpers
// ---------------------------------------------------------------------------

@Composable
private fun StationHeader(title: String, onBack: () -> Unit, busy: Boolean) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        OutlinedButton(onClick = onBack) { Text("‹") }
        Spacer(Modifier.width(8.dp))
        Text(title, fontWeight = FontWeight.Black, fontSize = 18.sp, modifier = Modifier.weight(1f))
        if (busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
    }
    Spacer(Modifier.height(10.dp))
}

@Composable
private fun MetricCell(label: String, value: String, modifier: Modifier = Modifier, bad: Boolean = false) {
    Card(
        colors = CardDefaults.cardColors(containerColor = if (bad) Danger.copy(alpha = 0.16f) else Dark.surface),
        modifier = modifier,
    ) {
        Column(Modifier.fillMaxWidth().padding(10.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(value, fontSize = 20.sp, fontWeight = FontWeight.Black, color = if (bad) Danger else Dark.primary)
            Text(label, fontSize = 9.sp, color = Dark.onBackground.copy(alpha = 0.6f))
        }
    }
}

@Composable
private fun ModeButton(label: String, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    if (selected) {
        Button(onClick = onClick, modifier = modifier) { Text(label) }
    } else {
        OutlinedButton(onClick = onClick, modifier = modifier) { Text(label) }
    }
}

@Composable
private fun SectionTitle(title: String) {
    Text(title, fontWeight = FontWeight.Bold, fontSize = 12.sp, color = Dark.secondary, modifier = Modifier.padding(vertical = 6.dp))
}

@Composable
private fun Banner(message: String, color: Color) {
    Box(
        Modifier.fillMaxWidth().padding(bottom = 8.dp).background(color, RoundedCornerShape(4.dp)).padding(11.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(message, color = Color.Black, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
    }
}

@Composable
private fun ErrorBox(message: String) {
    Box(Modifier.fillMaxWidth().background(Danger.copy(alpha = 0.15f)).padding(10.dp)) {
        Text(message, color = Danger, fontSize = 13.sp)
    }
}

@Composable
private fun CompletionCard(title: String, code: String, detail: String) {
    Box(Modifier.fillMaxSize().background(Dark.background).padding(24.dp), contentAlignment = Alignment.Center) {
        Card(
            colors = CardDefaults.cardColors(containerColor = Success.copy(alpha = 0.12f)),
            border = BorderStroke(1.dp, Success),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(Modifier.padding(28.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Text("✓", color = Success, fontSize = 52.sp, fontWeight = FontWeight.Black)
                Text(title, color = Success, fontWeight = FontWeight.Black, fontSize = 20.sp, textAlign = TextAlign.Center)
                Spacer(Modifier.height(8.dp))
                Text(code, fontFamily = FontFamily.Monospace)
                Text(detail, color = Dark.onBackground.copy(alpha = 0.7f), textAlign = TextAlign.Center, fontSize = 12.sp)
                Spacer(Modifier.height(10.dp))
                Text("Returning to task list…", fontSize = 11.sp, color = Dark.onBackground.copy(alpha = 0.5f))
            }
        }
    }
}

private fun scanTypeFor(fromOcr: Boolean, source: String): String =
    if (fromOcr || source == "MANUAL") "MANUAL" else "BARCODE"

/** Safe dynamic flash reader: malformed/missing objects never crash the station. */
private fun jsonStringField(element: JsonElement?, key: String): String? = runCatching {
    element?.jsonObject?.get(key)?.jsonPrimitive?.contentOrNull
}.getOrNull()

private fun elapsedSince(startedAt: String, now: Long): String {
    val start = runCatching { Instant.parse(startedAt).toEpochMilli() }.getOrElse { now }
    val seconds = max(0L, (now - start) / 1_000L)
    val hours = seconds / 3_600
    val minutes = (seconds % 3_600) / 60
    val secs = seconds % 60
    return String.format(Locale.US, "%02d:%02d:%02d", hours, minutes, secs)
}

private fun formatIsoTime(value: String?): String {
    if (value == null) return "--:--:--"
    return runCatching {
        SimpleDateFormat("HH:mm:ss", Locale.US).format(Date.from(Instant.parse(value)))
    }.getOrElse { "--:--:--" }
}

private fun timeNow(): String = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())
