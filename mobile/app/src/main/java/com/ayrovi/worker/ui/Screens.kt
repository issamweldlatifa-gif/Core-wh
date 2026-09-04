package com.ayrovi.worker.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
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
import com.ayrovi.worker.data.ArrivalRow
import com.ayrovi.worker.data.SessionHeader
import com.ayrovi.worker.data.SessionStore
import com.ayrovi.worker.data.TerminalContext
import com.ayrovi.worker.data.TerminalTask
import com.ayrovi.worker.data.WorkerRepository
import com.ayrovi.worker.scanner.CameraScanner
import com.ayrovi.worker.scanner.ScanCoordinator
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID
import kotlinx.coroutines.launch

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

private enum class Screen { Login, Home, Receiving }

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
            Screen.Login -> LoginScreen(
                repo = repo,
                onSuccess = { screen = Screen.Home },
            )
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
        }
    }
}

// ---------------------------------------------------------------------------
// Login (worker identity → WORKER_NATIVE session on the backend)
// ---------------------------------------------------------------------------

@Composable
private fun LoginScreen(
    repo: WorkerRepository,
    onSuccess: () -> Unit,
) {
    val store = SessionStore(LocalContext.current)
    var identifier by remember { mutableStateOf("") }
    var secret by remember { mutableStateOf("") }
    var deviceCode by remember { mutableStateOf(store.deviceCode) }
    var usePin by remember { mutableStateOf(true) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    Box(Modifier.fillMaxSize().background(Dark.background).verticalScroll(rememberScrollState()), contentAlignment = Alignment.Center) {
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
                        keyboardOptions = KeyboardOptions(keyboardType = if (usePin) KeyboardType.NumberPassword else KeyboardType.Password),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(10.dp))
                    OutlinedTextField(
                        value = deviceCode,
                        onValueChange = { deviceCode = it },
                        label = { Text("Device code") },
                        supportingText = { Text("As registered under Admin Web → Devices", fontSize = 11.sp) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(16.dp))
                    if (error != null) {
                        Text(error!!, color = Dark.error, fontSize = 13.sp)
                        Spacer(Modifier.height(10.dp))
                    }
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
                                        mode = if (usePin) "PIN" else "PASSWORD",
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
                "Backend refuses Admin identities and unregistered devices.\nThis surface only opens a WORKER_NATIVE session.",
                fontSize = 11.sp,
                color = Dark.onBackground.copy(alpha = 0.5f),
                textAlign = TextAlign.Center,
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Home — worker profile + station + permitted workflows (server-driven)
// ---------------------------------------------------------------------------

@Composable
private fun HomeScreen(
    store: SessionStore,
    repo: WorkerRepository,
    onExpired: () -> Unit,
    onOpenReceiving: (arrivalCode: String?) -> Unit,
    onLogout: () -> Unit,
) {
    var ctx by remember { mutableStateOf<TerminalContext?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(true) }

    LaunchedEffect(Unit) {
        try {
            ctx = repo.terminalContext()
        } catch (ex: WorkerRepository.ApiException) {
            if (ex.code == 401) onExpired()
            else error = ex.message
        } catch (ex: Exception) {
            error = ex.message
        } finally {
            busy = false
        }
    }

    Box(Modifier.fillMaxSize().background(Dark.background)) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("AYROVI Worker", fontWeight = FontWeight.Black, fontSize = 20.sp, color = Dark.primary, modifier = Modifier.weight(1f))
                OutlinedButton(onClick = onLogout) { Text("Logout", fontSize = 12.sp) }
            }
            Spacer(Modifier.height(6.dp))
            Text("Device: ${store.deviceCode}", fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = Dark.onBackground.copy(alpha = 0.6f))

            if (busy) {
                Spacer(Modifier.height(60.dp))
                CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
            } else if (error != null) {
                ErrorBox(error!!)
            } else {
                val c = ctx
                if (c != null) {
                    // Identity card
                    Card(colors = CardDefaults.cardColors(containerColor = Dark.surface), modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(16.dp)) {
                            Text(store.employeeCode ?: "Worker", fontWeight = FontWeight.Bold, fontSize = 18.sp)
                            c.station?.let { st ->
                                Text("Station: ${st.code} — ${st.name}", color = Dark.secondary, fontSize = 13.sp)
                            } ?: Text("No station assigned", color = Dark.error, fontSize = 13.sp)
                        }
                    }
                    Spacer(Modifier.height(14.dp))
                    Text("Your workflows", fontWeight = FontWeight.Bold, fontSize = 15.sp)
                    Spacer(Modifier.height(8.dp))
                    val tasks = c.tasks.filter { it.ready != false }
                    if (tasks.isEmpty()) {
                        Text("No workflow is assigned to you. Ask a manager.", color = Dark.onBackground.copy(alpha = 0.7f), fontSize = 13.sp)
                    } else {
                        tasks.forEach { task -> TaskCard(task, enabled = task.key == "receiving") { onOpenReceiving(null) } }
                    }
                    c.activeSession?.let { s ->
                        Spacer(Modifier.height(12.dp))
                        Text("Resume open session", fontWeight = FontWeight.Bold, fontSize = 14.sp, color = Dark.secondary)
                        Spacer(Modifier.height(6.dp))
                        val arrival = s.expectedArrival
                        Button(onClick = { onOpenReceiving(arrival?.code) }, colors = ButtonDefaults.buttonColors(containerColor = Dark.secondary)) {
                            Text("${s.code} — ${arrival?.customerName ?: arrival?.code ?: "session"}")
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun TaskCard(task: TerminalTask, enabled: Boolean, onOpen: () -> Unit) {
    Card(
        colors = CardDefaults.cardColors(containerColor = Dark.surface),
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
    ) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text((task.label ?: task.key ?: "Task").uppercase(), fontWeight = FontWeight.Bold, fontSize = 14.sp)
                Text(task.description ?: task.key ?: "", fontSize = 12.sp, color = Dark.onBackground.copy(alpha = 0.6f))
            }
            Button(
                onClick = onOpen,
                enabled = enabled,
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (enabled) Dark.primary else Dark.onBackground.copy(alpha = 0.15f),
                ),
            ) {
                Text(if (enabled) "OPEN" else "SOON")
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Receiving flow — arrivals → session → scanner (identify + receive carton)
// ---------------------------------------------------------------------------

private enum class RcvView { List, Session }

@Composable
private fun ReceivingFlow(
    repo: WorkerRepository,
    initialArrivalCode: String?,
    onBack: () -> Unit,
    onExpired: () -> Unit,
) {
    var view by remember { mutableStateOf(if (initialArrivalCode != null) RcvView.Session else RcvView.List) }
    var arrivals by remember { mutableStateOf<List<ArrivalRow>>(emptyList()) }
    var arrival by remember { mutableStateOf<ArrivalRow?>(null) }
    var sessionCode by remember { mutableStateOf<String?>(null) }
    var sessionId by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }

    val scope = rememberCoroutineScope()

    suspend fun openSessionFor(arr: ArrivalRow) {
        busy = true
        error = null
        try {
            var hdr: SessionHeader? = try {
                repo.startReceiving(arr.id ?: arr.code ?: "")
            } catch (ex: WorkerRepository.ApiException) {
                if (ex.code == 409 || ex.code == 400) repo.activeSession(arr.code ?: arr.id ?: "")
                else throw ex
            }
            if (hdr?.id == null) hdr = repo.activeSession(arr.code ?: arr.id ?: "")
            val session = requireNotNull(hdr) { "لا توجد جلسة استلام نشطة لهذه الشحنة" }
            sessionId = session.id
            sessionCode = session.code
            arrival = arr
            view = RcvView.Session
        } catch (ex: WorkerRepository.ApiException) {
            if (ex.code == 401) onExpired() else error = ex.message
        } catch (ex: Exception) {
            error = ex.message
        } finally {
            busy = false
        }
    }

    LaunchedEffect(Unit) {
        try {
            if (initialArrivalCode != null) {
                arrivals = repo.arrivals()
                val arr = arrivals.firstOrNull { it.code == initialArrivalCode }
                if (arr != null) openSessionFor(arr)
                else view = RcvView.List
            } else {
                arrivals = repo.arrivals()
            }
        } catch (ex: WorkerRepository.ApiException) {
            if (ex.code == 401) onExpired() else error = ex.message
        } catch (ex: Exception) {
            error = ex.message
        } finally {
            busy = false
        }
    }

    Column(Modifier.fillMaxSize().background(Dark.background).padding(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            OutlinedButton(onClick = {
                if (view == RcvView.Session) {
                    view = RcvView.List
                    arrival = null
                    sessionId = null
                } else onBack()
            }) { Text("‹") }
            Spacer(Modifier.width(8.dp))
            Text(
                if (view == RcvView.Session) "Receiving — ${arrival?.code ?: ""}" else "Receiving arrivals",
                fontWeight = FontWeight.Bold,
                fontSize = 16.sp,
                modifier = Modifier.weight(1f),
            )
            if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
        }
        Spacer(Modifier.height(6.dp))
        if (error != null) {
            ErrorBox(error!!)
            Spacer(Modifier.height(6.dp))
        }

        if (view == RcvView.List && !busy) {
            ArrivalList(arrivals) { scope.launch { openSessionFor(it) } }
        }
        if (view == RcvView.Session) {
            sessionId?.let { sid ->
                SessionScanner(
                    repo = repo,
                    sessionId = sid,
                    sessionCode = sessionCode,
                    onExpired = onExpired,
                )
            }
        }
    }
}

@Composable
private fun ArrivalList(arrivals: List<ArrivalRow>, onOpen: (ArrivalRow) -> Unit) {
    if (arrivals.isEmpty()) {
        Text("No arrivals awaiting receiving.", color = Dark.onBackground.copy(alpha = 0.6f), fontSize = 13.sp)
        return
    }
    LazyColumn(Modifier.fillMaxSize()) {
        items(arrivals, key = { it.id ?: it.code ?: it.customerName ?: "" }) { a ->
            Card(colors = CardDefaults.cardColors(containerColor = Dark.surface), modifier = Modifier.fillMaxWidth().padding(vertical = 5.dp)) {
                Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(a.code ?: "", fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
                        Text(a.customerName ?: a.storeName ?: "", fontSize = 13.sp)
                        Text(
                            "${a.status ?: ""} · ${a.products ?: 0} products · ${a.units ?: 0} units · ${a.cartons ?: 0} cartons",
                            fontSize = 11.sp,
                            color = Dark.onBackground.copy(alpha = 0.6f),
                        )
                    }
                    Button(onClick = { onOpen(a) }, colors = ButtonDefaults.buttonColors(containerColor = Dark.primary)) {
                        Text(if (a.status == "RECEIVING" || a.status == "PAUSED") "RESUME" else "START")
                    }
                }
            }
        }
    }
}

@Composable
private fun SessionScanner(
    repo: WorkerRepository,
    sessionId: String,
    sessionCode: String?,
    onExpired: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var ocrEnabled by remember { mutableStateOf(false) }
    var manualCode by remember { mutableStateOf("") }
    var cameraGranted by remember { mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) }
    var flash by remember { mutableStateOf<Pair<String, Color>?>(null) }
    var stats by remember { mutableStateOf(Triple(0, 0, 0)) } // ok / issue / total
    var history by remember { mutableStateOf<List<String>>(emptyList()) }

    val cameraPermissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        cameraGranted = granted
    }
    LaunchedEffect(Unit) {
        if (!cameraGranted) cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
    }

    val handleAccepted: suspend (String, Boolean) -> Unit = { value, fromOcr ->
        val scanType = if (fromOcr) "MANUAL" else "BARCODE"
        try {
            val identified = repo.scanCarton(
                sessionId = sessionId,
                code = value,
                scanType = scanType,
                operationId = UUID.randomUUID().toString(),
                source = "CAMERA",
            )
            val kind = identified.flash?.kind
            when (kind) {
                "CARTON_IDENTIFIED" -> {
                    flash = Pair("Carton identified — receiving…", Color(0xFF4CAF8C))
                    val received = repo.receiveCarton(sessionId, value, UUID.randomUUID().toString())
                    val k2 = received.flash?.kind
                    if (k2 == "DUPLICATE_CARTON" || k2 == "ALREADY_RECEIVED") {
                        flash = Pair("Carton already received", Color(0xFFF0B429))
                        stats = Triple(stats.first, stats.second + 1, stats.third + 1)
                    } else {
                        flash = Pair("Received ✓", Color(0xFF4CAF8C))
                        stats = Triple(stats.first + 1, stats.second, stats.third + 1)
                    }
                }
                "UNKNOWN_CARTON" -> {
                    flash = Pair("Unknown carton: $value", Color(0xFFFF6B6B))
                    stats = Triple(stats.first, stats.second + 1, stats.third + 1)
                }
                "WRONG_SHIPMENT" -> {
                    flash = Pair("Carton belongs to another shipment", Color(0xFFFF6B6B))
                    stats = Triple(stats.first, stats.second + 1, stats.third + 1)
                }
                "DUPLICATE_CARTON" -> {
                    flash = Pair("Duplicate — already received", Color(0xFFF0B429))
                    stats = Triple(stats.first, stats.second + 1, stats.third + 1)
                }
                else -> {
                    flash = Pair(kind ?: "Scanned", Color(0xFF4CAF8C))
                    stats = Triple(stats.first + 1, stats.second, stats.third + 1)
                }
            }
            history = listOf("${timeNow()} ${kind ?: "OK"} $value") + history
        } catch (ex: WorkerRepository.ApiException) {
            if (ex.code == 401) onExpired()
            else flash = Pair(ex.message ?: "Scan rejected", Color(0xFFFF6B6B))
        } catch (ex: Exception) {
            flash = Pair(ex.message ?: "Offline or server error — retry", Color(0xFFFF6B6B))
        }
    }

    val coordinator = remember {
        ScanCoordinator(
            onAccepted = { value, fromOcr ->
                scope.launch { handleAccepted(value, fromOcr) }
            },
            onRejected = { reason ->
                flash = Pair(reason.lowercase().replace('_', ' '), Color(0xFFF0B429))
            },
        )
    }

    Column(Modifier.fillMaxSize().padding(bottom = 8.dp)) {
        // Flash banner
        val f = flash
        if (f != null) {
            Box(
                Modifier.fillMaxWidth().background(f.second).padding(12.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(f.first, color = Color.Black, fontWeight = FontWeight.Bold)
            }
        }

        Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Session ${sessionCode ?: sessionId}", fontWeight = FontWeight.Bold, fontSize = 12.sp, modifier = Modifier.weight(1f))
            Text("✓${stats.first} ⚠${stats.second}", fontSize = 12.sp, color = Dark.onBackground.copy(alpha = 0.7f))
        }

        if (cameraGranted) {
            Box(Modifier.fillMaxWidth().height(320.dp).background(Color.Black)) {
                CameraScanner(ocrEnabled = ocrEnabled, coordinator = coordinator, modifier = Modifier.fillMaxSize())
            }
            Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("OCR fallback", fontSize = 13.sp, modifier = Modifier.weight(1f))
                Switch(checked = ocrEnabled, onCheckedChange = { ocrEnabled = it })
            }
        } else {
            OutlinedButton(onClick = { cameraPermissionLauncher.launch(Manifest.permission.CAMERA) }, modifier = Modifier.fillMaxWidth()) {
                Text("Grant camera access")
            }
        }

        // Manual entry fallback
        Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = manualCode,
                onValueChange = { manualCode = it },
                label = { Text("Manual code") },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(8.dp))
            Button(
                onClick = {
                    val code = manualCode.trim()
                    if (code.isNotEmpty()) {
                        scope.launch { handleAccepted(code, false) }
                        manualCode = ""
                    }
                },
                colors = ButtonDefaults.buttonColors(containerColor = Dark.primary),
            ) { Text("Send") }
        }

        if (history.isNotEmpty()) {
            Text("Recent scans", fontWeight = FontWeight.Bold, fontSize = 12.sp)
            history.take(12).forEach { h ->
                Text(h, fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = Dark.onBackground.copy(alpha = 0.75f))
            }
        }
    }
}

@Composable
private fun ErrorBox(message: String) {
    Box(Modifier.fillMaxWidth().background(Dark.error.copy(alpha = 0.15f)).padding(10.dp)) {
        Text(message, color = Dark.error, fontSize = 13.sp)
    }
}

private fun timeNow(): String =
    SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())
