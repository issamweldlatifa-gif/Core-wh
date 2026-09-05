package com.ayrovi.worker.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
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
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import android.content.Context
import android.os.BatteryManager
import android.content.Intent
import android.content.IntentFilter
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.ayrovi.worker.data.ArrivalRow
import com.ayrovi.worker.data.ArticleScanResult
import com.ayrovi.worker.data.AssignmentsResponse
import com.ayrovi.worker.data.BinRef
import com.ayrovi.worker.data.FlashView
import com.ayrovi.worker.data.MeResponse
import com.ayrovi.worker.data.OpContainer
import com.ayrovi.worker.data.OrderRef
import com.ayrovi.worker.data.OrderSortingResult
import com.ayrovi.worker.data.PackResult
import com.ayrovi.worker.data.PackingView
import com.ayrovi.worker.data.ReceivingSession
import com.ayrovi.worker.data.RequiredItem
import com.ayrovi.worker.data.SessionStore
import com.ayrovi.worker.data.ShipResult
import com.ayrovi.worker.data.ShipmentView
import com.ayrovi.worker.data.SortingResult
import com.ayrovi.worker.data.SortingStoreResult
import com.ayrovi.worker.data.TerminalAssignment
import com.ayrovi.worker.data.TerminalContext
import com.ayrovi.worker.data.TerminalTask
import com.ayrovi.worker.data.TraceView
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
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.math.max

// ============================================================
// THEME — professional warehouse-console look
// ============================================================
private val Theme = darkColorScheme(
    primary = Color(0xFF00D084),          // scan green
    onPrimary = Color(0xFF04110B),
    secondary = Color(0xFF4CC2FF),
    tertiary = Color(0xFFFFB020),
    background = Color(0xFF070B11),
    surface = Color(0xFF0F1621),
    surfaceVariant = Color(0xFF162031),
    onBackground = Color(0xFFE8EEF7),
    onSurface = Color(0xFFE8EEF7),
    error = Color(0xFFFF5A5F),
)
private val Green = Color(0xFF00D084)
private val Amber = Color(0xFFFFB020)
private val Red = Color(0xFFFF5A5F)
private val Blue = Color(0xFF4CC2FF)
private val Dim = Color(0xFF7E8AA2)

private enum class Screen { Login, Home }
private enum class StationKey {
    RECEIVING, RECEIVING_CONTAINER, CUSTOMER_SORTING, CUSTOMER_BIN,
    PACKING, SHIPPING, ARCHIVE_TRACE;
    companion object {
        fun fromKey(key: String?): StationKey? = when (key) {
            "receiving" -> RECEIVING
            "customer-sorting", "sorting" -> CUSTOMER_SORTING
            "customer-bin", "order-sorting" -> CUSTOMER_BIN
            "packing" -> PACKING
            "shipping" -> SHIPPING
            "archive-trace" -> ARCHIVE_TRACE
            "receiving-container" -> RECEIVING_CONTAINER
            else -> null
        }
    }
}
internal data class Feedback(val kind: FeedbackKind, val title: String, val sub: String? = null)
internal enum class FeedbackKind { OK, BAD, INFO }

// ============================================================
// ROOT
// ============================================================
@Composable
fun AyroviApp(store: SessionStore) {
    val scope = rememberCoroutineScope()
    val repo = remember { WorkerRepository(store) }
    var me by remember { mutableStateOf<MeResponse?>(null) }
    var ctx by remember { mutableStateOf<TerminalContext?>(null) }
    var loading by remember { mutableStateOf(true) }
    var loggedIn by remember { mutableStateOf(store.hasSession()) }
    var activeStation by remember { mutableStateOf<StationKey?>(null) }
    var activeTask by remember { mutableStateOf<TerminalTask?>(null) }
    var footer by remember { mutableStateOf("READY") }
    var footerKind by remember { mutableStateOf(FeedbackKind.INFO) }
    var lastAction by remember { mutableStateOf<String?>(null) }
    var bootError by remember { mutableStateOf<String?>(null) }
    var online by remember { mutableStateOf(true) }
    var tick by remember { mutableIntStateOf(0) }
    var todayCount by remember { mutableIntStateOf(0) }

    LaunchedEffect(Unit) { while (true) { delay(1_000); tick += 1 } }

    fun setStatus(text: String, kind: FeedbackKind = FeedbackKind.INFO) {
        footer = text; footerKind = kind
    }

    suspend fun boot(): Boolean {
        return try {
            me = repo.me()
            ctx = repo.terminalContext()
            online = true
            bootError = null
            // Auto-open task if server says to resume.
            val resume = ctx?.resume
            if (resume != null) {
                val key = StationKey.fromKey(
                    if (resume.path?.contains("receiving") == true) "receiving" else null
                )
                if (key != null) {
                    activeStation = key
                    activeTask = ctx?.tasks?.firstOrNull { it.key == "receiving" }
                }
            }
            true
        } catch (ex: WorkerRepository.ApiException) {
            online = true
            if (ex.code == 401) { store.clear(); loggedIn = false; false }
            else { bootError = ex.message; false }
        } catch (ex: Exception) {
            online = false
            bootError = ex.message ?: "Connection error."
            false
        }
    }

    LaunchedEffect(loggedIn) {
        if (loggedIn) { loading = true; boot(); loading = false; setStatus("READY") }
    }

    MaterialTheme(colorScheme = Theme) {
        if (!loggedIn) {
            LoginScreen(repo) { loggedIn = true; scope.launch { loading = true; boot(); loading = false } }
            return@MaterialTheme
        }
        Scaffold(
            containerColor = Theme.background,
            bottomBar = {
                StationTabs(
                    tasks = ctx?.tasks?.filter { it.ready != false } ?: emptyList(),
                    active = activeStation,
                    inProgress = ctx?.activeSession != null,
                ) { key, task ->
                    activeStation = key; activeTask = task; setStatus(key?.name?.replace('_',' ') ?: "READY")
                }
            },
        ) { inner ->
            Column(Modifier.fillMaxSize().padding(inner).background(Theme.background)) {
                TopStrip(me, ctx, online, tick) {
                    scope.launch { repo.logout(); loggedIn = false }
                }
                Box(Modifier.weight(1f)) {
                    when {
                        loading -> FullScreenLoading()
                        bootError != null -> FullScreenError(bootError!!) {
                            scope.launch { loading = true; boot(); loading = false }
                        }
                        activeStation == null -> HomeScreen(
                            repo = repo, me = me, ctx = ctx,
                            onOpen = { k, t -> activeStation = k; activeTask = t; setStatus(k.name.replace('_',' ')) },
                            onStatus = ::setStatus, onLastAction = { lastAction = it },
                        )
                        else -> StationRouter(
                            key = activeStation!!, task = activeTask, repo = repo, ctx = ctx,
                            onBack = { activeStation = null; activeTask = null; scope.launch { boot(); setStatus("READY") } },
                            onExpired = { store.clear(); loggedIn = false },
                            onStatus = ::setStatus, onLastAction = { lastAction = it },
                            onAccepted = { todayCount += 1 },
                        )
                    }
                }
                Footer(footer, footerKind, lastAction, ctx?.station?.name, todayCount)
            }
        }
    }
}

// ============================================================
// SHELL: strip, tabs, footer
// ============================================================
@Composable
private fun rememberBatteryPct(): Int {
    val ctx = LocalContext.current
    val read: () -> Int = {
        runCatching {
            val bm = ctx.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
            bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY).takeIf { it > 0 } ?: -1
        }.getOrDefault(-1)
    }
    var pct by remember { mutableIntStateOf(read()) }
    LaunchedEffect(Unit) { while (true) { pct = read(); delay(60_000) } }
    return pct
}

@Composable
private fun TopStrip(me: MeResponse?, ctx: TerminalContext?, online: Boolean, tick: Int, onLogout: () -> Unit) {
    val time = remember(tick) { SimpleDateFormat("HH:mm:ss", Locale.US).format(Date()) }
    val batt = rememberBatteryPct()
    val battColor = when { batt < 0 -> Dim; batt <= 15 -> Red; batt <= 30 -> Amber; else -> Green }
    Surface(color = Theme.surface, tonalElevation = 0.dp) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    me?.user?.employeeCode ?: "WORKER",
                    fontWeight = FontWeight.Black, fontSize = 14.sp, letterSpacing = 1.sp,
                )
                Text(
                    ctx?.station?.let { "${it.code} · ${it.name}" } ?: "NO STATION",
                    fontSize = 11.sp, color = if (ctx?.station == null) Red else Dim,
                    fontFamily = FontFamily.Monospace,
                )
            }
            if (batt >= 0) {
                Text("⚡${batt}%", fontSize = 10.sp, color = battColor, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold)
                Spacer(Modifier.width(8.dp))
            }
            StatusDot(online)
            Spacer(Modifier.width(6.dp))
            Text(if (online) "ONLINE" else "OFFLINE", fontSize = 10.sp, fontWeight = FontWeight.Bold,
                color = if (online) Green else Red, fontFamily = FontFamily.Monospace)
            Spacer(Modifier.width(10.dp))
            Text(time, fontSize = 11.sp, color = Dim, fontFamily = FontFamily.Monospace)
            Spacer(Modifier.width(8.dp))
            OutlinedButton(onClick = onLogout, contentPadding = PaddingValues(horizontal = 10.dp, vertical = 0.dp)) {
                Text("OUT", fontSize = 10.sp)
            }
        }
    }
}

@Composable
private fun StatusDot(online: Boolean) {
    Box(Modifier.size(8.dp).clip(CircleShape).background(if (online) Green else Red))
}

@Composable
private fun StationTabs(
    tasks: List<TerminalTask>, active: StationKey?, inProgress: Boolean,
    onSelect: (StationKey?, TerminalTask?) -> Unit,
) {
    val supported = mapOf(
        StationKey.RECEIVING to "RCV",
        StationKey.RECEIVING_CONTAINER to "TOTE",
        StationKey.CUSTOMER_SORTING to "SORT",
        StationKey.CUSTOMER_BIN to "BIN",
        StationKey.PACKING to "PACK",
        StationKey.SHIPPING to "SHIP",
        StationKey.ARCHIVE_TRACE to "TRACE",
    )
    NavigationBar(containerColor = Theme.surface, tonalElevation = 0.dp) {
        NavigationBarItem(
            selected = active == null,
            onClick = { onSelect(null, null) },
            icon = { Text("⌂", fontSize = 18.sp) },
            label = { Text("HOME", fontSize = 9.sp) },
        )
        // Show only permitted tasks; map key to short label
        for (t in tasks) {
            val key = StationKey.fromKey(t.key) ?: continue
            val label = supported[key] ?: (t.label?.take(4)?.uppercase() ?: "???")
            NavigationBarItem(
                selected = active == key,
                onClick = { onSelect(key, t) },
                icon = {
                    Text(if (key == StationKey.RECEIVING && inProgress) "●" else "▣",
                        fontSize = 14.sp,
                        color = if (key == StationKey.RECEIVING && inProgress) Amber else Color.Unspecified)
                },
                label = { Text(label, fontSize = 9.sp) },
            )
        }
    }
}

@Composable
private fun Footer(status: String, kind: FeedbackKind, lastAction: String?, stationName: String?, todayCount: Int = 0) {
    val color = when (kind) {
        FeedbackKind.OK -> Green; FeedbackKind.BAD -> Red; FeedbackKind.INFO -> Blue
    }
    Surface(color = Theme.surface) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically) {
            Text(status.uppercase(), fontWeight = FontWeight.Black, fontSize = 11.sp, color = color,
                letterSpacing = 1.sp, modifier = Modifier.weight(1f))
            Text(lastAction ?: "—", fontSize = 10.sp, color = Dim,
                fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f), textAlign = TextAlign.Center)
            if (todayCount > 0) {
                Surface(color = Green.copy(alpha = 0.15f), shape = RoundedCornerShape(6.dp)) {
                    Text(" $todayCount ", fontWeight = FontWeight.Black, fontSize = 10.sp, color = Green,
                        fontFamily = FontFamily.Monospace)
                }
                Spacer(Modifier.width(6.dp))
            }
            Text(stationName ?: "unassigned", fontSize = 10.sp, color = Dim, fontFamily = FontFamily.Monospace)
        }
    }
}

// ============================================================
// Shared components
// ============================================================
@Composable private fun FullScreenLoading() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            CircularProgressIndicator(color = Theme.primary, strokeWidth = 3.dp)
            Spacer(Modifier.height(12.dp))
            Text("Loading…", color = Dim, fontSize = 12.sp, letterSpacing = 2.sp)
        }
    }
}
@Composable private fun FullScreenError(msg: String, onRetry: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally) {
        Text("⚠", fontSize = 32.sp, color = Red)
        Spacer(Modifier.height(8.dp))
        Text(msg, color = Red, textAlign = TextAlign.Center, fontSize = 13.sp)
        Spacer(Modifier.height(16.dp))
        Button(onClick = onRetry) { Text("RETRY") }
    }
}

@Composable
internal fun FlashBar(fb: Feedback?, onDismiss: () -> Unit = {}, onCount: () -> Unit = {}, ctaText: String = "SCAN NEXT ▸") {
    val ctx = LocalContext.current
    LaunchedEffect(fb) {
        if (fb != null) {
            when (fb.kind) {
                FeedbackKind.OK -> { FeedbackSounds.ok(ctx); onCount() }
                FeedbackKind.BAD -> FeedbackSounds.bad(ctx)
                FeedbackKind.INFO -> FeedbackSounds.warn(ctx)
            }
            if (fb.kind == FeedbackKind.OK) { delay(1800); onDismiss() }
        }
    }
    AnimatedVisibility(visible = fb != null) {
        fb ?: return@AnimatedVisibility
        val bg = when (fb.kind) {
            FeedbackKind.OK -> Green
            FeedbackKind.BAD -> Red
            FeedbackKind.INFO -> Blue
        }
        Column {
            Card(colors = CardDefaults.cardColors(containerColor = bg.copy(alpha = 0.14f)),
                border = androidx.compose.foundation.BorderStroke(1.dp, bg.copy(alpha = 0.5f)),
                modifier = Modifier.fillMaxWidth().padding(bottom = if (fb.kind == FeedbackKind.OK) 6.dp else 10.dp)) {
                Row(Modifier.padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(when (fb.kind) {
                        FeedbackKind.OK -> "✓"; FeedbackKind.BAD -> "✕"; FeedbackKind.INFO -> "ℹ"
                    }, color = bg, fontWeight = FontWeight.Black, fontSize = 22.sp)
                    Spacer(Modifier.width(10.dp))
                    Column(Modifier.weight(1f)) {
                        Text(fb.title, color = bg, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                        if (fb.sub != null) Text(fb.sub, color = Theme.onBackground, fontSize = 11.sp)
                    }
                    TextButton(onClick = onDismiss) { Text("×", color = Dim, fontSize = 18.sp) }
                }
            }
            if (fb.kind == FeedbackKind.OK) ScanNextCta(ctaText)
        }
    }
}

@Composable
internal fun ScanNextCta(text: String = "SCAN NEXT ▸") {
    Surface(color = Green.copy(alpha = 0.10f), shape = RoundedCornerShape(10.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, Green.copy(alpha = 0.5f))) {
        Text(text,
            modifier = Modifier.fillMaxWidth().padding(vertical = 14.dp),
            textAlign = TextAlign.Center, color = Green, fontWeight = FontWeight.Black,
            fontSize = 18.sp, letterSpacing = 4.sp)
    }
    Spacer(Modifier.height(8.dp))
}

@Composable
internal fun BigScanHero(
    title: String, subtitle: String? = null,
    hint: String = "SCAN WITH CT40 TRIGGER",
    statusLabel: String? = null, statusColor: Color = Blue,
    cameraOn: Boolean = false,
) {
    Card(colors = CardDefaults.cardColors(containerColor = Theme.surfaceVariant),
        modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            if (statusLabel != null) {
                Surface(color = statusColor.copy(alpha = 0.18f), shape = RoundedCornerShape(999.dp)) {
                    Text(statusLabel, color = statusColor, fontSize = 10.sp, fontWeight = FontWeight.Bold,
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 3.dp), letterSpacing = 1.sp)
                }
                Spacer(Modifier.height(10.dp))
            }
            Text(title, fontWeight = FontWeight.Black, fontSize = 26.sp, textAlign = TextAlign.Center, lineHeight = 28.sp)
            if (subtitle != null) {
                Spacer(Modifier.height(4.dp))
                Text(subtitle, color = Dim, fontSize = 13.sp, textAlign = TextAlign.Center)
            }
            Spacer(Modifier.height(18.dp))
            // Scan target reticle
            Box(Modifier.size(140.dp), contentAlignment = Alignment.Center) {
                Box(Modifier.size(140.dp).border(2.dp, Theme.primary.copy(alpha = 0.35f), RoundedCornerShape(16.dp)))
                Box(Modifier.size(100.dp).border(2.dp, Theme.primary.copy(alpha = 0.7f), RoundedCornerShape(12.dp)))
                Text("◉", fontSize = 30.sp, color = Theme.primary)
            }
            Spacer(Modifier.height(14.dp))
            Text(hint, color = Dim, fontSize = 11.sp, letterSpacing = 2.sp, fontFamily = FontFamily.Monospace)
        }
    }
}

@Composable
internal fun ManualEntry(
    label: String,
    value: String,
    onValue: (String) -> Unit,
    onSubmit: (String) -> Unit,
    enabled: Boolean = true,
    placeholder: String = "",
    extraButton: @Composable (() -> Unit)? = null,
    focus: Boolean = true,
) {
    val fr = remember { FocusRequester() }
    val kb = LocalSoftwareKeyboardController.current
    OutlinedTextField(
        value = value, onValueChange = onValue, singleLine = true,
        textStyle = androidx.compose.ui.text.TextStyle(fontSize = 18.sp, fontFamily = FontFamily.Monospace),
        enabled = enabled, label = { Text(label, fontSize = 11.sp, letterSpacing = 1.sp) },
        placeholder = { Text(placeholder, color = Dim.copy(alpha = 0.6f), fontSize = 14.sp) },
        keyboardOptions = KeyboardOptions(
            capitalization = KeyboardCapitalization.Characters,
            autoCorrectEnabled = false,
            imeAction = ImeAction.Done,
        ),
        keyboardActions = KeyboardActions(onDone = {
            val v = value; if (v.isNotBlank()) { onValue(""); onSubmit(v.trim()) }
            kb?.hide()
        }),
        modifier = Modifier.fillMaxWidth().then(if (focus) Modifier.focusRequester(fr) else Modifier),
    )
    LaunchedEffect(Unit) { if (focus) runCatching { fr.requestFocus() } }
    Spacer(Modifier.height(10.dp))
    Row(verticalAlignment = Alignment.CenterVertically) {
        Button(
            onClick = { val v = value.trim(); if (v.isNotBlank()) { onValue(""); onSubmit(v) } },
            enabled = enabled && value.isNotBlank(),
            modifier = Modifier.weight(1f).height(52.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Green, contentColor = Theme.onPrimary),
        ) { Text("ENTER", letterSpacing = 4.sp, fontSize = 16.sp, fontWeight = FontWeight.Black) }
        if (extraButton != null) { Spacer(Modifier.width(8.dp)); extraButton() }
    }
}

@Composable
internal fun Metric(label: String, value: String, color: Color = Theme.primary, modifier: Modifier = Modifier) {
    Card(colors = CardDefaults.cardColors(containerColor = color.copy(alpha = 0.10f)),
        border = androidx.compose.foundation.BorderStroke(1.dp, color.copy(alpha = 0.25f)),
        modifier = modifier) {
        Column(Modifier.fillMaxWidth().padding(10.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(value, fontSize = 22.sp, fontWeight = FontWeight.Black, color = color)
            Text(label, fontSize = 9.sp, color = Dim, letterSpacing = 1.sp)
        }
    }
}

@Composable
internal fun ContextCard(title: String, value: String? = null, sub: String? = null, accent: Color = Blue) {
    Card(colors = CardDefaults.cardColors(containerColor = Theme.surface),
        modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(4.dp).background(accent, CircleShape))
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(title, fontSize = 10.sp, color = Dim, letterSpacing = 1.sp)
                if (value != null) Text(value, fontSize = 18.sp, fontWeight = FontWeight.Black, lineHeight = 20.sp)
                if (sub != null) Text(sub, fontSize = 11.sp, color = Dim)
            }
        }
    }
}

@Composable
internal fun Section(label: String) {
    Text(label, fontSize = 10.sp, color = Theme.primary, fontWeight = FontWeight.Bold,
        letterSpacing = 2.sp, modifier = Modifier.padding(top = 14.dp, bottom = 6.dp))
}

@Composable
internal fun BackBar(title: String, onBack: () -> Unit, trailing: @Composable () -> Unit = {}) {
    Row(Modifier.fillMaxWidth().padding(bottom = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        OutlinedButton(onClick = onBack, contentPadding = PaddingValues(horizontal = 10.dp)) { Text("‹") }
        Spacer(Modifier.width(10.dp))
        Text(title, fontWeight = FontWeight.Black, fontSize = 20.sp, letterSpacing = 1.sp,
            modifier = Modifier.weight(1f))
        trailing()
    }
}

@Composable
internal fun CameraToggle(
    cameraOn: Boolean, onToggle: (Boolean) -> Unit,
    coordinator: ScanCoordinator, enabled: Boolean = true,
) {
    val ctx = LocalContext.current
    var granted by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(ctx, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
    }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted = it }
    LaunchedEffect(cameraOn) { if (cameraOn && !granted) launcher.launch(Manifest.permission.CAMERA) }
    Card(colors = CardDefaults.cardColors(containerColor = Theme.surface),
        modifier = Modifier.fillMaxWidth().padding(top = 10.dp)) {
        Column(Modifier.padding(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("CAMERA SCANNER", fontSize = 10.sp, color = Dim, letterSpacing = 1.sp)
                    Text(if (HoneywellScanner.isHoneywellDevice()) "CT40 side-trigger is primary"
                        else "Tap switch to enable camera", fontSize = 11.sp, color = Dim)
                }
                Switch(checked = cameraOn, onCheckedChange = onToggle, enabled = enabled)
            }
            if (cameraOn && granted && enabled) {
                Spacer(Modifier.height(8.dp))
                Box(Modifier.fillMaxWidth().height(220.dp).clip(RoundedCornerShape(8.dp)).background(Color.Black)) {
                    CameraScanner(ocrEnabled = false, coordinator = coordinator, modifier = Modifier.fillMaxSize())
                }
            }
        }
    }
}

// Reusable scanner binding — same pattern across every station.
// --- Feedback helpers (sound + vibe + footer updates) -----------------
@Composable
internal fun rememberFeedback(): (Feedback) -> Unit {
    val ctx = LocalContext.current
    return { fb: Feedback ->
        when (fb.kind) {
            FeedbackKind.OK -> FeedbackSounds.ok(ctx)
            FeedbackKind.BAD -> FeedbackSounds.bad(ctx)
            FeedbackKind.INFO -> FeedbackSounds.warn(ctx)
        }
    }
}

@Composable
internal fun StationScanner(
    onScan: suspend (String) -> Unit,
    busy: Boolean,
    enabled: Boolean = true,
): Triple<ScanCoordinator, Boolean, (Boolean) -> Unit> {
    val scope = rememberCoroutineScope()
    var cameraOn by remember { mutableStateOf(false) }
    val onScanRef = rememberUpdatedState(onScan)
    val busyRef = rememberUpdatedState(busy)
    val enabledRef = rememberUpdatedState(enabled)
    val coordinator = remember {
        ScanCoordinator(
            onAccepted = { v, _, _ ->
                if (!busyRef.value && enabledRef.value) scope.launch { onScanRef.value(v) }
            },
            onRejected = { },
        )
    }
    val ctx = LocalContext.current
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner) {
        val hw = HoneywellScanner(ctx) { v ->
            if (!busyRef.value && enabledRef.value) coordinator.onScanned(v, fromOcr = false, source = HoneywellScanner.SOURCE)
        }
        val obs = LifecycleEventObserver { _, e ->
            when (e) {
                Lifecycle.Event.ON_START -> hw.start()
                Lifecycle.Event.ON_PAUSE -> hw.stop()
                else -> Unit
            }
        }
        owner.lifecycle.addObserver(obs)
        if (owner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) hw.start()
        onDispose { owner.lifecycle.removeObserver(obs); hw.stop() }
    }
    return Triple(coordinator, cameraOn, { cameraOn = it })
}

internal fun jsonString(el: JsonElement?, key: String): String? = runCatching {
    el?.jsonObject?.get(key)?.jsonPrimitive?.content
}.getOrNull()

internal fun timeNow(): String = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())
internal fun formatIso(v: String?): String {
    if (v == null) return "--:--:--"
    return runCatching { SimpleDateFormat("HH:mm:ss", Locale.US).format(Date.from(Instant.parse(v))) }
        .getOrElse { "--:--:--" }
}
internal fun elapsed(startedAt: String, tick: Int): String {
    val start = runCatching { Instant.parse(startedAt).toEpochMilli() }.getOrElse { System.currentTimeMillis() }
    val s = max(0L, (System.currentTimeMillis() - start) / 1000)
    val h = s / 3600; val m = (s % 3600) / 60; val sec = s % 60
    return String.format(Locale.US, "%02d:%02d:%02d", h, m, sec)
}

// ---- include Login + Home + each Station screen (kept in separate composables below) ----

// ============================================================
// LOGIN (kept as v1.1.0)
// ============================================================
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
    Box(Modifier.fillMaxSize().background(Theme.background).verticalScroll(rememberScrollState()), contentAlignment = Alignment.Center) {
        Column(Modifier.padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text("AYROVI", fontSize = 36.sp, fontWeight = FontWeight.Black, color = Theme.primary, letterSpacing = 4.sp)
            Text("WAREHOUSE TERMINAL", fontSize = 12.sp, color = Dim, letterSpacing = 4.sp)
            Spacer(Modifier.height(28.dp))
            Card(colors = CardDefaults.cardColors(containerColor = Theme.surface), modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(18.dp)) {
                    Text("Worker sign-in", fontWeight = FontWeight.Bold, fontSize = 16.sp)
                    Spacer(Modifier.height(14.dp))
                    OutlinedTextField(identifier, { identifier = it }, singleLine = true,
                        label = { Text("Employee code / Worker key") }, modifier = Modifier.fillMaxWidth())
                    Spacer(Modifier.height(10.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("Use PIN", fontSize = 14.sp, modifier = Modifier.weight(1f))
                        Switch(checked = usePin, onCheckedChange = { usePin = it })
                    }
                    OutlinedTextField(secret, { secret = it }, singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(
                            keyboardType = if (usePin) KeyboardType.NumberPassword else KeyboardType.Password),
                        label = { Text(if (usePin) "PIN" else "Password") }, modifier = Modifier.fillMaxWidth())
                    Spacer(Modifier.height(10.dp))
                    OutlinedTextField(deviceCode, { deviceCode = it }, singleLine = true,
                        label = { Text("Device code") },
                        supportingText = { Text("Register this code in Admin Web → Devices", fontSize = 11.sp) },
                        modifier = Modifier.fillMaxWidth())
                    if (error != null) { Spacer(Modifier.height(10.dp)); Text(error!!, color = Red, fontSize = 12.sp) }
                    Spacer(Modifier.height(16.dp))
                    Button(onClick = {
                        if (identifier.isBlank() || secret.isBlank()) { error = "Enter your employee code and secret."; return@Button }
                        busy = true; error = null
                        scope.launch {
                            try { repo.login(identifier, secret, if (usePin) "pin" else "password", deviceCode); onSuccess() }
                            catch (ex: WorkerRepository.ApiException) { error = ex.message }
                            catch (ex: Exception) { error = ex.message ?: "Sign-in failed." }
                            finally { busy = false }
                        }
                    }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                        if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = Theme.onPrimary)
                        else Text("Sign in")
                    }
                }
            }
        }
    }
}

// ============================================================
// HOME
// ============================================================
@Composable
private fun HomeScreen(
    repo: WorkerRepository, me: MeResponse?, ctx: TerminalContext?,
    onOpen: (StationKey, TerminalTask?) -> Unit,
    onStatus: (String, FeedbackKind) -> Unit, onLastAction: (String) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var assignments by remember { mutableStateOf<AssignmentsResponse?>(null) }
    var busyBtn by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(ctx) {
        try { assignments = repo.assignments() } catch (_: Exception) { assignments = AssignmentsResponse(emptyList(), emptyList()) }
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(14.dp)) {
        Card(colors = CardDefaults.cardColors(containerColor = Theme.surface), modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                Text(me?.user?.name?.takeIf { it.isNotBlank() } ?: me?.user?.employeeCode ?: "WORKER",
                    fontWeight = FontWeight.Black, fontSize = 20.sp)
                Spacer(Modifier.height(2.dp))
                Text(
                    if (ctx?.station != null) "${ctx.station!!.code} · ${ctx.station!!.name} · ${ctx.station!!.department ?: ""}"
                    else "No station assigned",
                    color = if (ctx?.station == null) Red else Blue, fontSize = 12.sp,
                    fontFamily = FontFamily.Monospace)
            }
        }
        Spacer(Modifier.height(12.dp))
        val open = assignments?.open ?: emptyList()
        if (open.isNotEmpty()) {
            Section("ASSIGNED TASKS")
            for (a in open) {
                Card(colors = CardDefaults.cardColors(containerColor = Theme.surface), modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                    Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(a.title, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                            if (!a.relatedCode.isNullOrBlank())
                                Text(a.relatedCode, color = Amber, fontSize = 10.sp, fontFamily = FontFamily.Monospace)
                            if (!a.description.isNullOrBlank())
                                Text(a.description, fontSize = 11.sp, color = Dim)
                        }
                        Button(onClick = {
                            scope.launch {
                                busyBtn = a.id
                                try { repo.completeAssignment(a.id); assignments = repo.assignments()
                                    onStatus("DONE", FeedbackKind.OK); onLastAction("${a.title} marked done") }
                                catch (_: Exception) { onStatus("could not complete", FeedbackKind.BAD) }
                                finally { busyBtn = null }
                            }
                        }, enabled = busyBtn != a.id,
                            contentPadding = PaddingValues(horizontal = 14.dp, vertical = 4.dp)) {
                            Text(if (busyBtn == a.id) "…" else "DONE", fontSize = 12.sp)
                        }
                    }
                }
            }
        }
        Section("MY STATIONS")
        val ready = ctx?.tasks?.filter { it.ready != false } ?: emptyList()
        if (ready.isEmpty()) {
            Card(colors = CardDefaults.cardColors(containerColor = Theme.surface)) {
                Column(Modifier.padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("NO STATION ASSIGNED", fontWeight = FontWeight.Bold, fontSize = 14.sp, letterSpacing = 2.sp)
                    Spacer(Modifier.height(6.dp))
                    Text("Ask a supervisor to assign a role or station.", color = Dim, fontSize = 12.sp,
                        textAlign = TextAlign.Center)
                }
            }
        } else {
            for (t in ready) {
                val key = StationKey.fromKey(t.key) ?: continue
                StationTile(key, t, ctx?.activeSession != null) { onOpen(key, t) }
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun StationTile(key: StationKey, task: TerminalTask, active: Boolean, onClick: () -> Unit) {
    val (icon, question, color) = when (key) {
        StationKey.RECEIVING -> Triple("📦", "What am I receiving?", Green)
        StationKey.RECEIVING_CONTAINER -> Triple("🗑", "Which tote am I filling?", Blue)
        StationKey.CUSTOMER_SORTING -> Triple("↗", "Where does this article go?", Amber)
        StationKey.CUSTOMER_BIN -> Triple("🗂", "Is this the correct bin?", Amber)
        StationKey.PACKING -> Triple("📮", "Which items are still missing?", Blue)
        StationKey.SHIPPING -> Triple("🚚", "Which shipment am I confirming?", Green)
        StationKey.ARCHIVE_TRACE -> Triple("🔍", "What happened to this item?", Dim)
    }
    Card(colors = CardDefaults.cardColors(containerColor = Theme.surface),
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp), onClick = onClick) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(44.dp).background(color.copy(alpha = 0.12f), CircleShape),
                contentAlignment = Alignment.Center) { Text(icon, fontSize = 22.sp) }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text((task.label ?: key.name).uppercase(), fontWeight = FontWeight.Bold, fontSize = 14.sp,
                        letterSpacing = 1.sp)
                    if (active && key == StationKey.RECEIVING) {
                        Spacer(Modifier.width(8.dp))
                        Text("IN PROGRESS", color = Amber, fontSize = 9.sp, fontWeight = FontWeight.Bold,
                            modifier = Modifier.background(Amber.copy(alpha = 0.2f), RoundedCornerShape(4.dp)).padding(horizontal = 6.dp, vertical = 1.dp))
                    }
                }
                Text(question, color = Dim, fontSize = 11.sp)
            }
            Text("›", fontSize = 22.sp, color = Dim)
        }
    }
}

// ============================================================
// ROUTER
// ============================================================
@Composable
private fun StationRouter(
    key: StationKey, task: TerminalTask?, repo: WorkerRepository, ctx: TerminalContext?,
    onBack: () -> Unit, onExpired: () -> Unit,
    onStatus: (String, FeedbackKind) -> Unit, onLastAction: (String) -> Unit,
    onAccepted: () -> Unit = {},
) {
    val onAcceptWrap: () -> Unit = onAccepted
    when (key) {
        StationKey.RECEIVING -> ReceivingStation(repo, onBack, onExpired, onStatus, onLastAction, onAcceptWrap)
        StationKey.RECEIVING_CONTAINER -> ToteStation(repo, onBack, onExpired, onStatus, onLastAction, onAcceptWrap)
        StationKey.CUSTOMER_SORTING -> SortingStation(repo, onBack, onExpired, onStatus, onLastAction, onAcceptWrap)
        StationKey.CUSTOMER_BIN -> CustomerBinStation(repo, onBack, onExpired, onStatus, onLastAction, onAcceptWrap)
        StationKey.PACKING -> PackingStation(repo, onBack, onExpired, onStatus, onLastAction, onAcceptWrap)
        StationKey.SHIPPING -> ShippingStation(repo, onBack, onExpired, onStatus, onLastAction, onAcceptWrap)
        StationKey.ARCHIVE_TRACE -> TraceStation(repo, onBack, onExpired, onStatus, onLastAction, onAcceptWrap)
    }
}

// ============================================================
// STATION 1: RECEIVING (PRODUCT-CENTRIC, FAST & MOBILE-FIRST)
// Supports scanning both CARTONS and PRODUCTS.
// ============================================================
@Composable
private fun ReceivingStation(
    repo: WorkerRepository, onBack: () -> Unit, onExpired: () -> Unit,
    onStatus: (String, FeedbackKind) -> Unit, onLastAction: (String) -> Unit,
    onAccepted: () -> Unit = {},
) {
    val scope = rememberCoroutineScope()
    var arrivals by remember { mutableStateOf<List<ArrivalRow>>(emptyList()) }
    var session by remember { mutableStateOf<ReceivingSession?>(null) }
    var loading by remember { mutableStateOf(true) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var fb by remember { mutableStateOf<Feedback?>(null) }
    var tick by remember { mutableIntStateOf(0) }
    
    // Scan modes
    var scanMode by remember { mutableStateOf("PRODUCT") } // "PRODUCT" or "CARTON"
    var viewMode by remember { mutableStateOf("HOME") }
    var scannedProduct by remember { mutableStateOf<ProductRow?>(null) }
    var scannedCode by remember { mutableStateOf("") }
    var manualCode by remember { mutableStateOf("") }
    var quantity by remember { mutableIntStateOf(1) }

    LaunchedEffect(Unit) { while (true) { delay(1000); tick += 1 } }

    suspend fun loadArrivals() { arrivals = repo.arrivals() }
    suspend fun open(a: ArrivalRow) {
        val id = a.code ?: a.id ?: return
        busy = true; error = null
        try {
            session = repo.activeSession(id) ?: repo.startReceiving(id)
            fb = Feedback(FeedbackKind.INFO, "SESSION ACTIVE", session!!.code); onStatus("SESSION ACTIVE", FeedbackKind.INFO)
            onLastAction("session ${session!!.code} started")
        } catch (ex: WorkerRepository.ApiException) { if (ex.code == 401) onExpired() else error = ex.message }
        catch (ex: Exception) { error = ex.message } finally { busy = false }
    }
    LaunchedEffect(Unit) { loading = true; try { loadArrivals() } catch (e: Exception) { error = e.message }; loading = false }

    val cleanCode = { c: String -> c.trim().uppercase(Locale.ROOT) }

    val processScan: suspend (String) -> Unit = onScan@{ value ->
        val s = session
        if (s == null || busy) return@onScan
        
        val clean = cleanCode(value)
        if (clean.isEmpty()) return@onScan

        busy = true
        error = null

        if (scanMode == "CARTON") {
            try {
                val updated = repo.scanCarton(s.id, clean, "BARCODE", UUID.randomUUID().toString(), "EXTERNAL_SCANNER")
                session = updated
                when (updated.flash?.kind) {
                    "CARTON_RECEIVED", "CARTON_IDENTIFIED", "CARTON_CONFIRMED" -> {
                        val cid = jsonString(updated.flash!!.carton, "externalCartonId")
                            ?: jsonString(updated.flash!!.carton, "code")
                            ?: jsonString(updated.flash!!.carton, "qrCodeValue")
                            ?: clean
                        fb = Feedback(FeedbackKind.OK, "CARTON RECEIVED",
                            "$cid  ·  ${updated.tally.receivedCartons}/${updated.tally.expectedCartons} cartons")
                        onStatus("ACCEPTED", FeedbackKind.OK); onLastAction("carton $cid received")
                        // Reset to product mode after scanning carton to keep product-centric flow
                        scanMode = "PRODUCT"
                    }
                    "UNKNOWN_CARTON" -> { fb = Feedback(FeedbackKind.BAD, "UNKNOWN CARTON", clean); onStatus("REJECTED", FeedbackKind.BAD) }
                    "WRONG_SHIPMENT" -> { fb = Feedback(FeedbackKind.BAD, "WRONG SHIPMENT", clean); onStatus("REJECTED", FeedbackKind.BAD) }
                    "DUPLICATE_CARTON" -> { fb = Feedback(FeedbackKind.BAD, "ALREADY RECEIVED", clean); onStatus("REJECTED", FeedbackKind.BAD) }
                    else -> {
                        val t = updated.tally
                        if (t.receivedCartons > s.tally.receivedCartons) {
                            fb = Feedback(FeedbackKind.OK, "CARTON RECEIVED",
                                "$clean  ·  ${t.receivedCartons}/${t.expectedCartons} cartons")
                            onStatus("ACCEPTED", FeedbackKind.OK); onLastAction("carton $clean received")
                            scanMode = "PRODUCT"
                        } else {
                            fb = Feedback(FeedbackKind.BAD, "NOT ACCEPTED", clean); onStatus("REJECTED", FeedbackKind.BAD)
                        }
                    }
                }
            } catch (ex: WorkerRepository.ApiException) {
                if (ex.code != 401) { error = ex.message; fb = Feedback(FeedbackKind.BAD, "ERROR", ex.message) } else onExpired()
            } catch (ex: Exception) { error = ex.message; fb = Feedback(FeedbackKind.BAD, "ERROR", ex.message) }
            finally { busy = false }
        } else {
            // PRODUCT MODE
            // Local evaluation first (speed priority)
            val p = s.products.find { cleanCode(it.sku ?: "") == clean || cleanCode(it.reference ?: "") == clean }
            
            scannedCode = clean
            scannedProduct = p
            quantity = 1
            viewMode = "PRODUCT_RESULT"
            fb = null
            onLastAction("scanned product $clean")
            busy = false
        }
    }
    
    val confirmProductReceiving = {
        scope.launch {
            if (session == null || scannedCode.isEmpty() || busy) return@launch
            busy = true
            onStatus("SUBMITTING", FeedbackKind.INFO)
            try {
                val updated = repo.receiveProduct(session!!.id, scannedCode, quantity, UUID.randomUUID().toString(), "CAMERA")
                session = updated
                val f = updated.flash
                
                if (f?.kind == "UNEXPECTED_PRODUCT") {
                    fb = Feedback(FeedbackKind.BAD, "UNEXPECTED PRODUCT", "$scannedCode was not on the expected list.")
                    onStatus("EXCEPTION", FeedbackKind.BAD)
                } else {
                    fb = Feedback(FeedbackKind.OK, "RECEIVED ✓", "$scannedCode x$quantity")
                    onStatus("ACCEPTED", FeedbackKind.OK)
                }
                
                onLastAction("received $scannedCode x$quantity")
                
                // Return to home automatically to keep the process flowing fast!
                viewMode = "HOME"
                scannedCode = ""
                scannedProduct = null
            } catch (ex: WorkerRepository.ApiException) {
                if (ex.code != 401) { error = ex.message; fb = Feedback(FeedbackKind.BAD, "ERROR", ex.message) } else onExpired()
                onStatus("ERROR", FeedbackKind.BAD)
            } catch (ex: Exception) {
                error = ex.message; fb = Feedback(FeedbackKind.BAD, "ERROR", ex.message)
                onStatus("ERROR", FeedbackKind.BAD)
            } finally {
                busy = false
            }
        }
    }

    val (coord, camOn, setCam) = StationScanner(onScan = processScan, busy = busy, enabled = session != null && viewMode != "PRODUCT_RESULT")

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(14.dp)) {
        if (session == null) {
            BackBar("RECEIVING", onBack)
            if (error != null) { FlashBar(Feedback(FeedbackKind.BAD, "ERROR", error)); Spacer(Modifier.height(6.dp)) }
            when {
                loading -> CircularProgressIndicator(modifier = Modifier.align(Alignment.CenterHorizontally))
                arrivals.isEmpty() -> Text("No arrivals awaiting receiving.", color = Dim)
                else -> for (a in arrivals) {
                    Card(colors = CardDefaults.cardColors(containerColor = Theme.surface),
                        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp), onClick = { scope.launch { open(a) } }) {
                        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(a.code ?: "—", fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
                                Text(a.customerName ?: a.storeName ?: "—", fontSize = 12.sp, color = Dim)
                                Text("${a.products ?: 0} products · ${a.cartons ?: 0} cartons", fontSize = 11.sp, color = Dim)
                            }
                            Button(onClick = { scope.launch { open(a) } }) {
                                Text(if (a.status == "EXPECTED") "START" else "RESUME")
                            }
                        }
                    }
                }
            }
            return@Column
        }
        val s = session!!
        val t = s.tally
        
        BackBar("RECEIVING", onBack) {
            Text(elapsed(s.startedAt, tick), fontFamily = FontFamily.Monospace, color = Blue, fontWeight = FontWeight.Bold)
        }
        
        if (viewMode == "HOME") {
            ContextCard("SESSION", s.code, s.arrival.customerName ?: s.arrival.storeName, Green)
            Spacer(Modifier.height(10.dp))
            FlashBar(fb, { fb = null }, onAccepted)
            
            // TABS (CARTON vs PRODUCT)
            Row(modifier = Modifier.fillMaxWidth().padding(bottom = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = { scanMode = "PRODUCT" },
                    modifier = Modifier.weight(1f),
                    colors = ButtonDefaults.buttonColors(containerColor = if (scanMode == "PRODUCT") Theme.primary else Theme.surfaceVariant, contentColor = if (scanMode == "PRODUCT") Theme.onPrimary else Theme.onSurface)
                ) { Text("SCAN PRODUCT", fontWeight = FontWeight.Bold) }
                Button(
                    onClick = { scanMode = "CARTON" },
                    modifier = Modifier.weight(1f),
                    colors = ButtonDefaults.buttonColors(containerColor = if (scanMode == "CARTON") Theme.primary else Theme.surfaceVariant, contentColor = if (scanMode == "CARTON") Theme.onPrimary else Theme.onSurface)
                ) { Text("SCAN CARTON", fontWeight = FontWeight.Bold) }
            }

            // METRICS ROW based on mode
            if (scanMode == "PRODUCT") {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Metric("EXPECTED", "${t.expectedProducts}", Theme.primary, Modifier.weight(1f))
                    Metric("RECEIVED", "${t.receivedProducts}", Green, Modifier.weight(1f))
                    Metric("EXCEPTIONS", "${t.openDiscrepancies}", if (t.openDiscrepancies > 0) Red else Dim, Modifier.weight(1f))
                }
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Metric("CARTONS", "${t.receivedCartons}/${t.expectedCartons}", if (t.receivedCartons >= t.expectedCartons && t.expectedCartons > 0) Green else Theme.primary, Modifier.weight(1f))
                    Metric("UNITS", "${t.receivedUnits}/${t.expectedUnits}", Theme.primary, Modifier.weight(1f))
                }
            }
            Spacer(Modifier.height(10.dp))
            
            // PRIMARY ACTION: SCAN
            val titleText = if (scanMode == "PRODUCT") "SCAN PRODUCT" else "SCAN CARTON"
            val heroHint = if (scanMode == "PRODUCT") "Point the CT40 trigger or use the camera to scan product." else "Point the CT40 trigger or use the camera to scan carton."
            BigScanHero(titleText, heroHint,
                statusLabel = if (camOn) "CAMERA ON" else "CT40 READY", statusColor = Green,
                cameraOn = camOn)
            CameraToggle(camOn, setCam, coord, enabled = !busy)
            
            Spacer(Modifier.height(10.dp))
            Section("MANUAL ENTRY")
            val manualLabel = if (scanMode == "PRODUCT") "PRODUCT CODE" else "CARTON CODE"
            ManualEntry(manualLabel, manualCode, { manualCode = it }, { v -> scope.launch { processScan(v) } }, enabled = !busy)
            
            Spacer(Modifier.height(10.dp))
            val openEx = s.discrepancies.filter { it.status == "OPEN" }
            if (openEx.isNotEmpty()) {
                Section("OPEN EXCEPTIONS")
                for (d in openEx) Text("• ${d.type?.replace("_"," ")} · ${d.reason ?: d.sku ?: d.cartonCode ?: "—"}", color = Red, fontSize = 12.sp)
                Spacer(Modifier.height(10.dp))
            }
            
            val recent = s.products.filter { it.received > 0 }.take(3)
            if (scanMode == "PRODUCT" && recent.isNotEmpty()) {
                Section("RECENT PRODUCTS")
                Card(colors = CardDefaults.cardColors(containerColor = Theme.surface), modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(10.dp)) {
                        for (p in recent) {
                            Row(Modifier.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                                Box(Modifier.size(40.dp).background(Theme.surfaceVariant), contentAlignment = Alignment.Center) { Text("IMG", color = Dim, fontSize = 9.sp) }
                                Spacer(Modifier.width(10.dp))
                                Column(Modifier.weight(1f)) {
                                    Text(p.productName ?: "Unknown", fontWeight = FontWeight.Bold, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    Text("SKU: ${p.sku ?: p.reference}", color = Dim, fontSize = 11.sp)
                                }
                                Text("${p.received}/${p.expected}", color = Green, fontWeight = FontWeight.Bold)
                            }
                            HorizontalDivider(color = Theme.onBackground.copy(alpha = 0.06f))
                        }
                    }
                }
                Spacer(Modifier.height(10.dp))
            }
            
            Section("SESSION CONTROLS")
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (s.status == "ACTIVE") {
                    OutlinedButton(onClick = {
                        scope.launch { busy = true; try { session = repo.pauseSession(s.id) } catch (e: Exception) { fb = Feedback(FeedbackKind.BAD, "ERROR", e.message) } finally { busy = false } }
                    }, modifier = Modifier.weight(1f), enabled = !busy) { Text("PAUSE") }
                } else if (s.status == "PAUSED") {
                    OutlinedButton(onClick = {
                        scope.launch { busy = true; try { session = repo.resumeSession(s.id); fb = Feedback(FeedbackKind.OK, "RESUMED", s.code) } catch (e: Exception) { fb = Feedback(FeedbackKind.BAD, "ERROR", e.message) } finally { busy = false } }
                    }, modifier = Modifier.weight(1f), enabled = !busy) { Text("RESUME") }
                }
                OutlinedButton(onClick = {
                    scope.launch {
                        busy = true; try {
                            val done = repo.completeSession(s.id); session = done
                            fb = Feedback(FeedbackKind.OK, "SESSION COMPLETE", done.code)
                            onStatus("DONE", FeedbackKind.OK); onLastAction("session ${done.code} complete")
                        } catch (e: Exception) { fb = Feedback(FeedbackKind.BAD, "CANNOT COMPLETE", e.message) } finally { busy = false }
                    }
                }, modifier = Modifier.weight(1f), enabled = !busy) { Text("COMPLETE", color = Green) }
            }
        } else if (viewMode == "PRODUCT_RESULT") {
            // PRODUCT RESULT SCREEN
            Text(if (scannedProduct != null) "✓ PRODUCT FOUND" else "✕ UNEXPECTED PRODUCT", 
                color = if (scannedProduct != null) Green else Red, 
                fontWeight = FontWeight.Black, fontSize = 18.sp, modifier = Modifier.padding(bottom = 12.dp))
            
            Card(colors = CardDefaults.cardColors(containerColor = Theme.surface), modifier = Modifier.fillMaxWidth()) {
                Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(80.dp).background(Theme.surfaceVariant), contentAlignment = Alignment.Center) { Text("IMAGE", color = Dim, fontSize = 12.sp) }
                    Spacer(Modifier.width(14.dp))
                    Column(Modifier.weight(1f)) {
                        Text(scannedProduct?.productName ?: "Unknown Product", fontWeight = FontWeight.Bold, fontSize = 18.sp, maxLines = 2)
                        Spacer(Modifier.height(4.dp))
                        Text("SKU: $scannedCode", color = Dim, fontFamily = FontFamily.Monospace, fontSize = 14.sp)
                    }
                }
                HorizontalDivider(color = Theme.onBackground.copy(alpha = 0.06f))
                Row(Modifier.padding(14.dp).fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) { Text("EXPECTED", color = Dim, fontSize = 10.sp); Text("${scannedProduct?.expected ?: 0}", fontWeight = FontWeight.Bold, fontSize = 20.sp) }
                    Column(horizontalAlignment = Alignment.CenterHorizontally) { Text("RECEIVED", color = Dim, fontSize = 10.sp); Text("${scannedProduct?.received ?: 0}", fontWeight = FontWeight.Bold, fontSize = 20.sp, color = Green) }
                    Column(horizontalAlignment = Alignment.CenterHorizontally) { Text("REMAINING", color = Dim, fontSize = 10.sp); Text("${scannedProduct?.remaining ?: 0}", fontWeight = FontWeight.Bold, fontSize = 20.sp) }
                }
            }
            
            Spacer(Modifier.height(24.dp))
            Section("QUANTITY")
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                Button(onClick = { quantity = max(1, quantity - 1) }, modifier = Modifier.size(64.dp), colors = ButtonDefaults.buttonColors(containerColor = Theme.surfaceVariant, contentColor = Theme.onSurface)) { Text("-", fontSize = 24.sp) }
                Text("$quantity", fontSize = 48.sp, fontWeight = FontWeight.Black, modifier = Modifier.padding(horizontal = 32.dp))
                Button(onClick = { quantity += 1 }, modifier = Modifier.size(64.dp), colors = ButtonDefaults.buttonColors(containerColor = Theme.surfaceVariant, contentColor = Theme.onSurface)) { Text("+", fontSize = 24.sp) }
            }
            
            Spacer(Modifier.height(32.dp))
            Button(
                onClick = { confirmProductReceiving() },
                enabled = !busy,
                colors = ButtonDefaults.buttonColors(containerColor = Green, contentColor = Theme.onPrimary),
                modifier = Modifier.fillMaxWidth().height(60.dp)
            ) { Text("CONFIRM RECEIVING", fontSize = 16.sp, fontWeight = FontWeight.Bold, letterSpacing = 2.sp) }
            
            Spacer(Modifier.height(10.dp))
            OutlinedButton(onClick = { viewMode = "HOME"; scannedCode = ""; fb = null }, modifier = Modifier.fillMaxWidth().height(50.dp), enabled = !busy) { Text("CANCEL", color = Dim) }
        }
    }
}

// ============================================================
// STATION 2: RECEIVING CONTAINER / TOTE
// Q: Which container am I processing?  -> scan tote, then scan articles into it
// ============================================================
@Composable
private fun ToteStation(
    repo: WorkerRepository, onBack: () -> Unit, onExpired: () -> Unit,
    onStatus: (String, FeedbackKind) -> Unit, onLastAction: (String) -> Unit,
    onAccepted: () -> Unit = {},
) {
    val scope = rememberCoroutineScope()
    // Find open receiving session (auto-resume from active)
    var session by remember { mutableStateOf<ReceivingSession?>(null) }
    var tote by remember { mutableStateOf<String?>(null) }   // active tote code
    var totes by remember { mutableStateOf<List<OpContainer>>(emptyList()) }
    var newLabel by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var fb by remember { mutableStateOf<Feedback?>(null) }
    var manualSku by remember { mutableStateOf("") }
    var articlesCount by remember { mutableStateOf(0) }
    var tick by remember { mutableIntStateOf(0) }
    var cameraOn by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(true) }

    LaunchedEffect(Unit) { while(true){delay(1000); tick++} }
    suspend fun refresh() {
        totes = repo.containers("RECEIVING", "ACTIVE")
        val actives = repo.arrivals()
        for (a in actives) {
            val key = a.code ?: a.id
            if (key != null) {
                val s = repo.activeSession(key)
                if (s != null) { session = s; break }
            }
        }
        loading = false
    }
    LaunchedEffect(Unit) { try { refresh() } catch (e: Exception) { error = e.message; loading = false } }

    val onScan: suspend (String) -> Unit = onScan@{ value ->
        val s = session
        if (s == null) { fb = Feedback(FeedbackKind.BAD, "NO ACTIVE RECEIVING SESSION"); onStatus("ERROR", FeedbackKind.BAD); return@onScan }
        if (tote == null) {
            busy = true
            try {
                val c = repo.container(value)
                if (c.type != "RECEIVING") { fb = Feedback(FeedbackKind.BAD, "NOT A RECEIVING TOTE", c.code); return@onScan }
                tote = c.code; articlesCount = c.articles.size
                fb = Feedback(FeedbackKind.INFO, "TOTE SELECTED", "${c.code} · ${c.label ?: ""}")
                onStatus("SCAN ARTICLE", FeedbackKind.OK); onLastAction("tote ${c.code} selected")
            } catch (ex: Exception) { fb = Feedback(FeedbackKind.BAD, "CONTAINER NOT FOUND", value); onStatus("ERROR", FeedbackKind.BAD) }
            finally { busy = false }
            return@onScan
        }
        // Scan article into tote
        busy = true
        try {
            val r = repo.scanArticleAtReceiving(s.id, value, tote!!)
            articlesCount += 1
            if (r.matched) {
                val sku = r.flash?.sku ?: value
                fb = Feedback(FeedbackKind.OK, "ARTICLE PLACED IN ${tote}",
                    "$sku  ·  articles $articlesCount")
                onStatus("ACCEPTED", FeedbackKind.OK); onLastAction("article $value → $tote")
            } else {
                fb = Feedback(FeedbackKind.BAD, "UNEXPECTED ARTICLE — EXCEPTION RECORDED", value)
                onStatus("EXCEPTION", FeedbackKind.BAD); onLastAction("UNEXPECTED $value in $tote")
            }
        } catch (ex: WorkerRepository.ApiException) {
            if (ex.code != 401) { error = ex.message; fb = Feedback(FeedbackKind.BAD, "ERROR", ex.message) }
            else onExpired()
        } catch (ex: Exception) { error = ex.message; fb = Feedback(FeedbackKind.BAD, "ERROR", ex.message) }
        finally { busy = false }
    }
    val (coord, camOn, setCam) = StationScanner(onScan, busy)

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(14.dp)) {
        BackBar("RECEIVING CONTAINER / TOTE", onBack)
        if (loading) { CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally)); return@Column }
        if (session == null) {
            Card(colors = CardDefaults.cardColors(containerColor = Theme.surface)) {
                Column(Modifier.padding(18.dp)) {
                    Text("NO ACTIVE RECEIVING SESSION", fontWeight = FontWeight.Bold, color = Red)
                    Spacer(Modifier.height(4.dp))
                    Text("Open a Receiving session first (RECEIVING tab) to scan articles into a tote.", fontSize = 12.sp, color = Dim)
                }
            }
            return@Column
        }
        FlashBar(fb, { fb = null }, onAccepted)
        ContextCard("SESSION", session!!.code, session!!.arrival.customerName, Green)
        Spacer(Modifier.height(10.dp))
        if (tote == null) {
            BigScanHero("SCAN CONTAINER", "Scan the tote QR or pick one below.",
                hint = "SCAN TOTE WITH CT40 TRIGGER", statusLabel = "READY", statusColor = Blue)
            Spacer(Modifier.height(8.dp))
            Section("OR CREATE NEW TOTE")
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(newLabel, { newLabel = it }, singleLine = true,
                    label = { Text("Label (optional)", fontSize = 10.sp) },
                    modifier = Modifier.weight(1f))
                Spacer(Modifier.width(8.dp))
                Button(onClick = {
                    scope.launch {
                        busy = true; try {
                            val c = repo.createContainer("RECEIVING", label = newLabel.ifBlank { null })
                            totes = listOf(c) + totes; newLabel = ""
                            fb = Feedback(FeedbackKind.OK, "NEW TOTE CREATED", c.code); onLastAction("tote ${c.code} created")
                        } catch (e: Exception) { fb = Feedback(FeedbackKind.BAD, "COULD NOT CREATE TOTE", e.message) }
                        finally { busy = false }
                    }
                }, enabled = !busy) { Text("+ NEW TOTE") }
            }
            Spacer(Modifier.height(8.dp))
            Section("ACTIVE TOTES")
            if (totes.isEmpty()) Text("No active totes.", color = Dim, fontSize = 12.sp)
            for (t in totes) {
                Card(colors = CardDefaults.cardColors(containerColor = Theme.surface),
                    modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp), onClick = {
                        tote = t.code; articlesCount = t.articleCount
                        fb = Feedback(FeedbackKind.INFO, "TOTE SELECTED", "${t.code} · ${t.articleCount} articles")
                        onStatus("SCAN ARTICLE", FeedbackKind.OK); onLastAction("tote ${t.code}")
                    }) {
                    Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(t.code, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
                            Text(t.label ?: "receiving tote", fontSize = 11.sp, color = Dim)
                        }
                        Text("${t.articleCount}", fontWeight = FontWeight.Black, fontSize = 18.sp, color = Blue)
                        Spacer(Modifier.width(4.dp)); Text("items", fontSize = 10.sp, color = Dim)
                    }
                }
            }
        } else {
            ContextCard("CURRENT CONTAINER", tote, "$articlesCount items · Ready", Green)
            Spacer(Modifier.height(10.dp))
            BigScanHero("SCAN ARTICLE", "Scan each unit out of the carton → place into $tote.",
                hint = "SCAN ARTICLE INTO $tote", statusLabel = "ACTIVE", statusColor = Green,
                cameraOn = camOn)
            CameraToggle(camOn, setCam, coord, !busy)
            Spacer(Modifier.height(10.dp))
            Section("MANUAL SKU")
            ManualEntry("SKU / REFERENCE", manualSku, { manualSku = it }, { v -> scope.launch { onScan(v) } },
                enabled = !busy)
            Spacer(Modifier.height(8.dp))
            OutlinedButton(onClick = { tote = null; articlesCount = 0 }, modifier = Modifier.fillMaxWidth()) {
                Text("CHANGE TOTE")
            }
        }
    }
}

// ============================================================
// STATION 3: CUSTOMER SORTING (stowing)
// Q: Where does this article go?  -> ZONE + LOCATION
// ============================================================
private const val STEP_SORT_ARTICLE = 0
private const val STEP_SORT_LOCATION = 1
private const val STEP_BIN_ARTICLE = 0
private const val STEP_BIN_BIN = 1

@Composable
private fun SortingStation(
    repo: WorkerRepository, onBack: () -> Unit, onExpired: () -> Unit,
    onStatus: (String, FeedbackKind) -> Unit, onLastAction: (String) -> Unit,
    onAccepted: () -> Unit = {},
) {
    val scope = rememberCoroutineScope()
    var step by remember { mutableIntStateOf(STEP_SORT_ARTICLE) }
    var decision by remember { mutableStateOf<SortingResult?>(null) }
    var busy by remember { mutableStateOf(false) }
    var fb by remember { mutableStateOf<Feedback?>(null) }
    var manual by remember { mutableStateOf("") }
    var cameraOn by remember { mutableStateOf(false) }
    var stored by remember { mutableIntStateOf(0) }

    val onScan: suspend (String) -> Unit = onScan@{ value ->
        busy = true; fb = null
        try {
            if (step == STEP_SORT_ARTICLE) {
                val r = repo.sortingScan(value)
                decision = r
                when (r.kind) {
                    "DESTINATION" -> {
                        step = STEP_SORT_LOCATION
                        fb = Feedback(FeedbackKind.INFO,
                            "${r.article?.sku ?: value}  →  ZONE ${r.zone?.code}",
                            "Scan location: ${r.suggestedLocations.joinToString(" · ")}")
                        onStatus("SCAN LOCATION", FeedbackKind.INFO); onLastAction("${r.article?.sku} → ${r.zone?.code}")
                    }
                    "NEEDS_REVIEW" -> { fb = Feedback(FeedbackKind.BAD, "MANUAL REVIEW REQUIRED", r.article?.sku ?: value); onStatus("REVIEW", FeedbackKind.BAD) }
                    "REJECTED" -> { fb = Feedback(FeedbackKind.BAD, r.reason ?: "REJECTED", r.article?.sku ?: value); onStatus("REJECTED", FeedbackKind.BAD) }
                    else -> { fb = Feedback(FeedbackKind.BAD, if (r.kind=="UNMAPPED") "NO DESTINATION CONFIGURED" else "AMBIGUOUS DESTINATION", r.article?.sku); onStatus("REJECTED", FeedbackKind.BAD) }
                }
            } else {
                val d = decision; if (d?.kind != "DESTINATION") { step = STEP_SORT_ARTICLE; return@onScan }
                val res = repo.sortingStore(d.article!!.code!!, value)
                val artLabel = res.flash?.sku ?: d.article?.sku ?: d.article?.code
                fb = Feedback(FeedbackKind.OK, "STORED", "$artLabel → ${res.flash?.location ?: value}")
                onStatus("STORED", FeedbackKind.OK); onLastAction("$artLabel → ${res.flash?.location ?: value}")
                stored += 1; decision = null; step = STEP_SORT_ARTICLE
            }
        } catch (ex: WorkerRepository.ApiException) { if (ex.code != 401) fb = Feedback(FeedbackKind.BAD, "ERROR", ex.message) else onExpired() }
        catch (ex: Exception) { fb = Feedback(FeedbackKind.BAD, "ERROR", ex.message) }
        finally { busy = false }
    }
    val (coord, camOn, setCam) = StationScanner(onScan, busy)

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(14.dp)) {
        BackBar("CUSTOMER SORTING", onBack) { Text("$stored", fontWeight = FontWeight.Black, fontSize = 20.sp, color = Green) }
        val d = decision
        // Context: what question are we answering right now?
        if (step == STEP_SORT_ARTICLE) {
            FlashBar(fb, { fb = null }, onAccepted)
            BigScanHero("SCAN ARTICLE", "The system will tell you WHERE it goes.",
                hint = "SCAN WITH CT40 TRIGGER", statusLabel = "STEP 1/2 · ARTICLE", statusColor = Blue,
                cameraOn = camOn)
            CameraToggle(camOn, setCam, coord, !busy)
        } else if (d != null) {
            // Destination prominently displayed
            FlashBar(fb, { fb = null }, onAccepted)
            ContextCard("CUSTOMER", d.article?.productName ?: "", d.article?.sku, Amber)
            Spacer(Modifier.height(8.dp))
            ContextCard("DESTINATION", d.zone?.code ?: "—", d.zone?.name ?: "", Green)
            Spacer(Modifier.height(8.dp))
            BigScanHero("SCAN LOCATION", d.suggestedLocations.joinToString(" · ").ifBlank { "Scan the location barcode." },
                hint = "CONFIRM STORAGE LOCATION", statusLabel = "STEP 2/2 · LOCATION", statusColor = Green,
                cameraOn = camOn)
            CameraToggle(camOn, setCam, coord, !busy)
        }
        Spacer(Modifier.height(10.dp))
        Section(if (step == STEP_SORT_ARTICLE) "MANUAL ARTICLE" else "MANUAL LOCATION")
        ManualEntry(if (step == STEP_SORT_ARTICLE) "ARTICLE CODE" else "LOCATION CODE", manual,
            { manual = it }, { v -> scope.launch { onScan(v) } }, enabled = !busy,
            placeholder = if (step == STEP_SORT_ARTICLE) "ART-…" else "")
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Metric("STORED", "$stored", Green, Modifier.weight(1f))
            Metric("STEP", if (step == STEP_SORT_ARTICLE) "1/2" else "2/2", Blue, Modifier.weight(1f))
        }
    }
}

// ============================================================
// STATION 4: CUSTOMER BIN (order-sorting verify)
// Q: Is this the correct bin?  -> Article -> Customer -> Bin + WRONG BIN rejection
// ============================================================
@Composable
private fun CustomerBinStation(
    repo: WorkerRepository, onBack: () -> Unit, onExpired: () -> Unit,
    onStatus: (String, FeedbackKind) -> Unit, onLastAction: (String) -> Unit,
    onAccepted: () -> Unit = {},
) {
    val scope = rememberCoroutineScope()
    var step by remember { mutableIntStateOf(STEP_BIN_ARTICLE) }
    var decision by remember { mutableStateOf<OrderSortingResult?>(null) }
    var busy by remember { mutableStateOf(false) }
    var fb by remember { mutableStateOf<Feedback?>(null) }
    var manual by remember { mutableStateOf("") }
    var cameraOn by remember { mutableStateOf(false) }
    var bins by remember { mutableStateOf<List<OpContainer>>(emptyList()) }
    var assigned by remember { mutableIntStateOf(0) }
    var newOrderRef by remember { mutableStateOf("") }

    LaunchedEffect(Unit) { try { bins = repo.containers("CUSTOMER", "ACTIVE") } catch (_: Exception) { } }

    val onScan: suspend (String) -> Unit = onScan@{ value ->
        busy = true; fb = null
        try {
            if (step == STEP_BIN_ARTICLE) {
                val r = repo.orderSortingScan(value)
                decision = r
                when (r.kind) {
                    "ASSIGNMENT" -> {
                        step = STEP_BIN_BIN
                        val binCode = r.bin?.code ?: "NO BIN"
                        fb = Feedback(FeedbackKind.INFO,
                            "${r.article?.sku ?: value} → ${r.order?.customer ?: ""}",
                            "Scan customer bin $binCode${if (r.binMissing) " (or +NEW BIN below)" else ""}")
                        onStatus("SCAN BIN", FeedbackKind.INFO); onLastAction("${r.article?.sku} → ${r.order?.customer}")
                    }
                    "NO_ORDER" -> { fb = Feedback(FeedbackKind.BAD, "NO OPEN ORDER", r.reason); onStatus("REJECTED", FeedbackKind.BAD) }
                    else -> { fb = Feedback(FeedbackKind.BAD, r.reason ?: "REJECTED", r.article?.sku); onStatus("REJECTED", FeedbackKind.BAD) }
                }
            } else {
                val d = decision; if (d?.kind != "ASSIGNMENT") { step = STEP_BIN_ARTICLE; return@onScan }
                val res = repo.orderSortingAssign(d.article!!.code!!, value)
                val isReady = res.flash?.kind == "BIN_READY_FOR_PACKING"
                val artLabel = res.flash?.sku ?: d.article?.sku ?: d.article?.code
                val binCode = res.flash?.bin ?: value
                val cust = res.flash?.customer ?: d.order?.customer
                fb = if (isReady)
                    Feedback(FeedbackKind.OK, "BIN COMPLETE — READY FOR PACKING", binCode)
                else Feedback(FeedbackKind.OK, "ARTICLE IN BIN", "$artLabel → $binCode ($cust)")
                onStatus(if (isReady) "READY FOR PACKING" else "ACCEPTED", FeedbackKind.OK)
                onLastAction("$artLabel → $binCode")
                assigned += 1; decision = null; step = STEP_BIN_ARTICLE
                try { bins = repo.containers("CUSTOMER", "ACTIVE") } catch (_: Exception) { }
            }
        } catch (ex: WorkerRepository.ApiException) {
            if (ex.code != 401) {
                fb = Feedback(FeedbackKind.BAD, "WRONG BIN / ERROR", ex.message)
                onStatus("WRONG DESTINATION", FeedbackKind.BAD); onLastAction("wrong bin: $value")
            } else onExpired()
        } catch (ex: Exception) { fb = Feedback(FeedbackKind.BAD, "ERROR", ex.message) }
        finally { busy = false }
    }
    val (coord, camOn, setCam) = StationScanner(onScan, busy)

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(14.dp)) {
        BackBar("CUSTOMER BIN", onBack) { Text("$assigned", fontWeight = FontWeight.Black, fontSize = 20.sp, color = Green) }
        val d = decision
        if (step == STEP_BIN_ARTICLE) {
            FlashBar(fb, { fb = null }, onAccepted)
            BigScanHero("SCAN ARTICLE", "Find the customer & bin for this article.",
                statusLabel = "STEP 1/2 · ARTICLE", statusColor = Amber, cameraOn = camOn)
            CameraToggle(camOn, setCam, coord, !busy)
        } else if (d != null) {
            FlashBar(fb, { fb = null }, onAccepted)
            ContextCard("CUSTOMER", d.order?.customer ?: "—", "Order ${d.order?.reference ?: ""}", Green)
            Spacer(Modifier.height(8.dp))
            ContextCard("TARGET BIN", d.bin?.code ?: "—", d.bin?.label ?: "",
                if (d.binMissing) Amber else Green)
            if (d.binMissing) {
                Spacer(Modifier.height(8.dp))
                Section("CREATE NEW BIN FOR THIS ORDER")
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(newOrderRef, { newOrderRef = it }, singleLine = true,
                        label = { Text("Order ref", fontSize = 10.sp) },
                        modifier = Modifier.weight(1f))
                    Spacer(Modifier.width(8.dp))
                    Button(onClick = {
                        scope.launch {
                            busy = true; try {
                                val bin = repo.createContainer("CUSTOMER", orderReference = d.order?.reference)
                                bins = listOf(bin) + bins; newOrderRef = ""
                                fb = Feedback(FeedbackKind.OK, "NEW BIN CREATED", "${bin.code} → ${bin.label}")
                                // auto-assign to new bin
                                val res = repo.orderSortingAssign(d.article!!.code!!, bin.code)
                                assigned += 1; decision = null; step = STEP_BIN_ARTICLE
                                val artLabel = res.flash?.sku ?: d.article?.sku ?: d.article?.code
                                fb = Feedback(FeedbackKind.OK, "ARTICLE IN BIN", "$artLabel → ${res.flash?.bin ?: bin.code}")
                                onLastAction("bin ${bin.code} created")
                            } catch (e: Exception) { fb = Feedback(FeedbackKind.BAD, "COULD NOT CREATE BIN", e.message) }
                            finally { busy = false }
                        }
                    }, enabled = !busy) { Text("+ CREATE BIN") }
                }
            }
            Spacer(Modifier.height(8.dp))
            BigScanHero("SCAN BIN", "Scan the customer bin to confirm placement.",
                statusLabel = "STEP 2/2 · BIN", statusColor = Green, cameraOn = camOn)
            CameraToggle(camOn, setCam, coord, !busy)
        }
        Spacer(Modifier.height(10.dp))
        Section(if (step == STEP_BIN_ARTICLE) "MANUAL ARTICLE" else "MANUAL BIN")
        ManualEntry(if (step == STEP_BIN_ARTICLE) "ARTICLE CODE" else "BIN CODE", manual,
            { manual = it }, { v -> scope.launch { onScan(v) } }, enabled = !busy)
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Metric("ASSIGNED", "$assigned", Green, Modifier.weight(1f))
            Metric("ACTIVE BINS", "${bins.size}", Blue, Modifier.weight(1f))
        }
    }
}

// ============================================================
// STATION 5: PACKING
// Q: Which items are still missing? -> Order + Items checklist
// ============================================================
@Composable
private fun PackingStation(
    repo: WorkerRepository, onBack: () -> Unit, onExpired: () -> Unit,
    onStatus: (String, FeedbackKind) -> Unit, onLastAction: (String) -> Unit,
    onAccepted: () -> Unit = {},
) {
    val scope = rememberCoroutineScope()
    var view by remember { mutableStateOf<PackingView?>(null) }
    var packedShipment by remember { mutableStateOf<PackResult?>(null) }
    var busy by remember { mutableStateOf(false) }
    var fb by remember { mutableStateOf<Feedback?>(null) }
    var manual by remember { mutableStateOf("") }
    var cameraOn by remember { mutableStateOf(false) }
    var packedToday by remember { mutableIntStateOf(0) }

    val onScan: suspend (String) -> Unit = onScan@{ value ->
        busy = true; packedShipment = null
        try {
            val v = repo.packingScan(value)
            view = v
            fb = if (v.complete) Feedback(FeedbackKind.OK, "BIN COMPLETE", "${v.bin.code} · ${v.order.customer} · VERIFY & PACK")
                else Feedback(FeedbackKind.BAD, "ORDER INCOMPLETE", "Missing items in ${v.bin.code}")
            onStatus(if (v.complete) "VERIFY & PACK" else "BIN INCOMPLETE",
                if (v.complete) FeedbackKind.OK else FeedbackKind.BAD)
            onLastAction("scanned bin ${v.bin.code}")
        } catch (ex: WorkerRepository.ApiException) {
            if (ex.code != 401) { fb = Feedback(FeedbackKind.BAD, "ERROR", ex.message); onStatus("ERROR", FeedbackKind.BAD) } else onExpired()
        } catch (ex: Exception) { fb = Feedback(FeedbackKind.BAD, "ERROR", ex.message) }
        finally { busy = false }
    }
    val (coord, camOn, setCam) = StationScanner(onScan, busy)

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(14.dp)) {
        BackBar("PACKING", onBack) { Text("$packedToday", fontWeight = FontWeight.Black, fontSize = 20.sp, color = Green) }
        FlashBar(fb, { fb = null }, onAccepted)
        val v = view
        if (v == null && packedShipment == null) {
            BigScanHero("SCAN CUSTOMER BIN", "The system will show the order and missing items.",
                statusLabel = "READY", statusColor = Blue, cameraOn = camOn)
            CameraToggle(camOn, setCam, coord, !busy)
            Spacer(Modifier.height(10.dp))
            Section("MANUAL BIN")
            ManualEntry("BIN CODE", manual, { manual = it }, { v -> scope.launch { onScan(v) } }, enabled = !busy, placeholder = "BIN-…")
        } else if (packedShipment != null) {
            val ps = packedShipment!!
            ContextCard("PACKED", ps.shipment?.code ?: "—", ps.shipment?.labelValue ?: "shipment created", Green)
            Spacer(Modifier.height(10.dp))
            BigScanHero("SHIPMENT CREATED", ps.shipment?.code ?: "",
                hint = "PLACE SHIPMENT LABEL ON THE CARTON", statusLabel = "SHIPPED LABEL READY", statusColor = Green)
            Spacer(Modifier.height(10.dp))
            Button(onClick = { packedShipment = null; view = null; fb = null; onStatus("SCAN NEXT BIN", FeedbackKind.INFO) },
                modifier = Modifier.fillMaxWidth()) { Text("SCAN NEXT BIN") }
        } else if (v != null) {
            ContextCard("ORDER", "#${v.order.reference}", v.order.customer, Blue)
            Spacer(Modifier.height(6.dp))
            ContextCard("BIN", v.bin.code, v.bin.label ?: "", if (v.complete) Green else Red)
            Spacer(Modifier.height(10.dp))
            Section("ITEMS")
            val itemsDone = v.required.count { it.inBin >= it.requested }
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Metric("ITEMS", "$itemsDone/${v.required.size}", if (v.complete) Green else Amber, Modifier.weight(1f))
                Metric("ARTICLES IN BIN", "${v.articles.size}", Blue, Modifier.weight(1f))
            }
            Spacer(Modifier.height(6.dp))
            Card(colors = CardDefaults.cardColors(containerColor = Theme.surface), modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(10.dp)) {
                    for (it in v.required) {
                        val ok = it.inBin >= it.requested
                        Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(if (ok) "✓" else "○", color = if (ok) Green else Red, fontWeight = FontWeight.Bold)
                            Spacer(Modifier.width(10.dp))
                            Column(Modifier.weight(1f)) {
                                Text(it.sku ?: "—", fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, fontSize = 12.sp)
                                Text(it.productName ?: "", fontSize = 11.sp, color = Dim, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                            Text("${it.inBin}/${it.requested}",
                                color = if (ok) Green else Red,
                                fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
                        }
                        HorizontalDivider(color = Theme.onBackground.copy(alpha = 0.08f))
                    }
                }
            }
            Spacer(Modifier.height(12.dp))
            Button(
                onClick = {
                    scope.launch {
                        busy = true; try {
                            val r = repo.pack(v.bin.code); packedShipment = r
                            fb = Feedback(FeedbackKind.OK, "PACKED → SHIPMENT ${r.shipment?.code}", v.order.customer)
                            onStatus("PACKED", FeedbackKind.OK); onLastAction("packed ${v.bin.code} → ${r.shipment?.code}")
                            packedToday += 1; view = null
                        } catch (ex: Exception) { fb = Feedback(FeedbackKind.BAD, "COULD NOT PACK", ex.message) }
                        finally { busy = false }
                    }
                },
                enabled = !busy && v.complete,
                colors = ButtonDefaults.buttonColors(containerColor = Green, contentColor = Theme.onPrimary),
                modifier = Modifier.fillMaxWidth(),
            ) { Text("PACK & PRINT LABEL", fontSize = 14.sp, letterSpacing = 2.sp) }
            if (!v.complete) {
                Spacer(Modifier.height(6.dp))
                Text("Order incomplete — cannot pack until all items are present.", color = Red, fontSize = 11.sp)
            }
            Spacer(Modifier.height(8.dp))
            OutlinedButton(onClick = { view = null; fb = null }, modifier = Modifier.fillMaxWidth()) { Text("SCAN ANOTHER BIN") }
        }
    }
}

// ============================================================
// STATION 6: SHIPPING
// Q: Which shipment am I confirming? -> Shipment -> Destination -> CONFIRM DISPATCH
// ============================================================
@Composable
private fun ShippingStation(
    repo: WorkerRepository, onBack: () -> Unit, onExpired: () -> Unit,
    onStatus: (String, FeedbackKind) -> Unit, onLastAction: (String) -> Unit,
    onAccepted: () -> Unit = {},
) {
    val scope = rememberCoroutineScope()
    var shipment by remember { mutableStateOf<ShipmentView?>(null) }
    var busy by remember { mutableStateOf(false) }
    var fb by remember { mutableStateOf<Feedback?>(null) }
    var manual by remember { mutableStateOf("") }
    var cameraOn by remember { mutableStateOf(false) }
    var shipped by remember { mutableIntStateOf(0) }

    val onScan: suspend (String) -> Unit = onScan@{ value ->
        busy = true
        try {
            val s = repo.shippingScan(value)
            shipment = s
            if (s.status == "SHIPPED") {
                fb = Feedback(FeedbackKind.BAD, "ALREADY SHIPPED", s.code)
                onStatus("ALREADY SHIPPED", FeedbackKind.BAD)
            } else {
                fb = Feedback(FeedbackKind.INFO, "SHIPMENT FOUND", "${s.code} · ${s.order?.externalCustomerReference ?: ""}")
                onStatus("CONFIRM DISPATCH", FeedbackKind.OK); onLastAction("scanned shipment ${s.code}")
            }
        } catch (ex: WorkerRepository.ApiException) {
            if (ex.code != 401) { fb = Feedback(FeedbackKind.BAD, "ERROR", ex.message); shipment = null } else onExpired()
        } catch (ex: Exception) { fb = Feedback(FeedbackKind.BAD, "ERROR", ex.message); shipment = null }
        finally { busy = false }
    }
    val (coord, camOn, setCam) = StationScanner(onScan, busy)

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(14.dp)) {
        BackBar("SHIPPING", onBack) { Text("$shipped", fontWeight = FontWeight.Black, fontSize = 20.sp, color = Green) }
        FlashBar(fb, { fb = null }, onAccepted)
        val s = shipment
        if (s == null) {
            BigScanHero("SCAN SHIPMENT", "Confirm dispatch for a ready-to-ship carton.",
                statusLabel = "READY", statusColor = Blue, cameraOn = camOn)
            CameraToggle(camOn, setCam, coord, !busy)
            Spacer(Modifier.height(10.dp))
            Section("MANUAL SHIPMENT")
            ManualEntry("SHIPMENT LABEL", manual, { manual = it }, { v -> scope.launch { onScan(v) } },
                enabled = !busy, placeholder = "OUT-…")
        } else {
            ContextCard("SHIPMENT", s.code, "Carrier: ${s.carrier ?: "internal"} · Tracking: ${s.trackingNumber ?: "—"}", Green)
            Spacer(Modifier.height(6.dp))
            ContextCard("DESTINATION", s.order?.externalCustomerReference ?: "—", "Order #${s.order?.externalOrderReference ?: ""}", Blue)
            Spacer(Modifier.height(6.dp))
            ContextCard("CONTENTS", "${s.articles.size} articles", s.container?.code?.let { "bin $it" } ?: "", Dim)
            Spacer(Modifier.height(10.dp))
            Section("ARTICLES")
            Card(colors = CardDefaults.cardColors(containerColor = Theme.surface), modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(10.dp)) {
                    for (a in s.articles) {
                        Row(Modifier.padding(vertical = 3.dp)) {
                            Text(a.sku ?: a.code ?: "—", fontFamily = FontFamily.Monospace, fontSize = 12.sp,
                                modifier = Modifier.weight(1f))
                            Text(a.productName?.take(28) ?: "", color = Dim, fontSize = 11.sp, maxLines = 1)
                        }
                        HorizontalDivider(color = Theme.onBackground.copy(alpha = 0.06f))
                    }
                }
            }
            Spacer(Modifier.height(14.dp))
            Button(
                onClick = {
                    scope.launch {
                        busy = true; try {
                            repo.ship(s.code); shipped += 1
                            fb = Feedback(FeedbackKind.OK, "DISPATCHED ✓", s.code)
                            onStatus("SHIPPED", FeedbackKind.OK); onLastAction("shipped ${s.code}")
                            shipment = null
                        } catch (ex: Exception) { fb = Feedback(FeedbackKind.BAD, "COULD NOT SHIP", ex.message) }
                        finally { busy = false }
                    }
                },
                enabled = !busy && s.status != "SHIPPED",
                colors = ButtonDefaults.buttonColors(containerColor = Green, contentColor = Theme.onPrimary),
                modifier = Modifier.fillMaxWidth(),
            ) { Text("CONFIRM DISPATCH", fontSize = 14.sp, letterSpacing = 2.sp) }
            Spacer(Modifier.height(6.dp))
            OutlinedButton(onClick = { shipment = null; fb = null }, modifier = Modifier.fillMaxWidth()) {
                Text("SCAN ANOTHER SHIPMENT")
            }
        }
    }
}

// ============================================================
// STATION 7: ARCHIVE / TRACE
// Q: What happened to this item? -> Timeline
// ============================================================
@Composable
private fun TraceStation(
    repo: WorkerRepository, onBack: () -> Unit, onExpired: () -> Unit,
    onStatus: (String, FeedbackKind) -> Unit, onLastAction: (String) -> Unit,
    onAccepted: () -> Unit = {},
) {
    val scope = rememberCoroutineScope()
    var view by remember { mutableStateOf<TraceView?>(null) }
    var busy by remember { mutableStateOf(false) }
    var fb by remember { mutableStateOf<Feedback?>(null) }
    var manual by remember { mutableStateOf("") }
    var cameraOn by remember { mutableStateOf(false) }

    fun stages(t: com.ayrovi.worker.data.TraceChain?): List<Pair<String, String?>> {
        if (t == null) return emptyList()
        return listOf(
            "ARRIVAL" to t.expectedArrival,
            "INBOUND SHIPMENT" to t.inboundShipment,
            "SOURCE CARTON" to t.sourceCarton,
            "RECEIVING" to t.receivingSession,
            "CONTAINER" to t.container?.let { c -> "${c.label ?: ""} (${c.code})".trim() },
            "STORAGE LOCATION" to t.storageLocation?.let { loc -> "${loc.code} (zone ${loc.zone})" },
            "CUSTOMER ORDER" to t.customerOrder,
            "CUSTOMER" to t.customer,
            "OUTBOUND SHIPMENT" to t.outboundShipment,
            "TRACKING" to t.tracking,
        )
    }

    val onScan: suspend (String) -> Unit = onScan@{ value ->
        busy = true
        try {
            view = repo.trace(value)
            fb = Feedback(FeedbackKind.INFO, "TRACE FOUND", value)
            onStatus("TRACE", FeedbackKind.INFO); onLastAction("traced $value")
        } catch (ex: WorkerRepository.ApiException) {
            if (ex.code != 401) { fb = Feedback(FeedbackKind.BAD, "NOT FOUND", ex.message) } else onExpired()
        } catch (ex: Exception) { fb = Feedback(FeedbackKind.BAD, "ERROR", ex.message) }
        finally { busy = false }
    }
    val (coord, camOn, setCam) = StationScanner(onScan, busy)

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(14.dp)) {
        BackBar("ARCHIVE / TRACE", onBack)
        FlashBar(fb, { fb = null }, onAccepted)
        val v = view
        if (v == null) {
            BigScanHero("SCAN ARTICLE", "See the full history of this item.",
                hint = "SCAN ARTICLE QR", statusLabel = "TRACE", statusColor = Dim, cameraOn = camOn)
            CameraToggle(camOn, setCam, coord, !busy)
            Spacer(Modifier.height(10.dp))
            Section("MANUAL CODE")
            ManualEntry("ARTICLE CODE", manual, { manual = it }, { v -> scope.launch { onScan(v) } }, enabled = !busy)
        } else {
            ContextCard("ARTICLE", v.article?.sku ?: v.article?.code ?: "—",
                v.article?.productName, Blue)
            Spacer(Modifier.height(6.dp))
            if (v.article?.status != null) {
                val c = when (v.article!!.status) {
                    "SHIPPED" -> Green; "PACKED", "IN_CUSTOMER_BIN" -> Amber; "IN_CONTAINER" -> Blue else -> Dim
                }
                ContextCard("CURRENT STATUS", v.article!!.status!!, "", c)
                Spacer(Modifier.height(10.dp))
            }
            Section("TIMELINE")
            Card(colors = CardDefaults.cardColors(containerColor = Theme.surface), modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp)) {
                    for ((stage, val_) in stages(v.trace)) {
                        val done = val_ != null
                        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 4.dp)) {
                            Box(Modifier.size(12.dp).clip(CircleShape)
                                .background(if (done) Green else Dim.copy(alpha = 0.25f)))
                            Spacer(Modifier.width(10.dp))
                            Column(Modifier.weight(1f)) {
                                Text(stage, fontSize = 9.sp, color = Dim, letterSpacing = 1.sp)
                                Text(val_ ?: "—", fontWeight = if (done) FontWeight.Bold else FontWeight.Normal,
                                    color = if (done) Theme.onBackground else Dim, fontSize = 12.sp,
                                    fontFamily = FontFamily.Monospace)
                            }
                        }
                    }
                }
            }
            Spacer(Modifier.height(10.dp))
            OutlinedButton(onClick = { view = null; fb = null }, modifier = Modifier.fillMaxWidth()) {
                Text("TRACE ANOTHER")
            }
        }
    }
}
