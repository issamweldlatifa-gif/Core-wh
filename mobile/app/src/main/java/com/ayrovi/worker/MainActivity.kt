package com.ayrovi.worker

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.jsonObject

private val Green = Color(0xFF00FF66)
private val Screen = Color(0xFF0B0D0C)
private val Panel = Color(0xFF111413)
private val Line = Color(0xFF303633)
private val Muted = Color(0xFF9EA7A1)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val store = WorkerSessionStore(this)
        val api = WorkerApi(BuildConfig.API_BASE_URL, store)
        setContent { WorkerApp(api, store) }
    }
}

private enum class WorkerPage { DASHBOARD, RECEIVING, EXPECTED, PUTAWAY, SORTING, PACKING, ORDER_SORTING, SHIPPING }

private fun WorkerContext.allowed(permission: String): Boolean =
    tasks.any { it.permission == permission && it.ready }

@Composable
private fun WorkerApp(api: WorkerApi, store: WorkerSessionStore) {
    var context by remember { mutableStateOf<WorkerContext?>(null) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    fun loadContext() {
        loading = true
        error = null
        scope.launch {
            try { context = withContext(Dispatchers.IO) { api.context() } }
            catch (e: Exception) { error = e.message ?: "Unable to load worker context" }
            finally { loading = false }
        }
    }

    LaunchedEffect(Unit) {
        if (store.accessToken() != null) loadContext()
    }

    MaterialTheme(colorScheme = darkColorScheme(primary = Green, secondary = Green, background = Screen, surface = Panel, onPrimary = Color.Black, onBackground = Color.White, onSurface = Color.White)) {
        Surface(modifier = Modifier.fillMaxSize(), color = Screen) {
            if (context == null) {
                LoginScreen(loading, error) { identifier, secret ->
                    loading = true
                    error = null
                    scope.launch {
                        try {
                            withContext(Dispatchers.IO) { api.login(identifier, secret) }
                            context = withContext(Dispatchers.IO) { api.context() }
                        } catch (e: Exception) {
                            error = e.message ?: "Login failed"
                            store.clear()
                        } finally { loading = false }
                    }
                }
            } else {
                WorkerShell(
                    context = context!!,
                    api = api,
                    onRefresh = ::loadContext,
                    onLogout = { api.logout(); context = null },
                )
            }
        }
    }
}

@Composable
private fun LoginScreen(loading: Boolean, error: String?, onLogin: (String, String) -> Unit) {
    var identifier by remember { mutableStateOf("") }
    var secret by remember { mutableStateOf("") }
    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text("AYROVI", color = Green, fontSize = 36.sp, fontWeight = FontWeight.Bold, letterSpacing = 5.sp)
        Text("WAREHOUSE · WORKER TERMINAL", color = Color.White, fontSize = 13.sp, letterSpacing = 3.sp)
        Spacer(Modifier.height(36.dp))
        OutlinedTextField(identifier, { identifier = it }, label = { Text("Employee code") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(secret, { secret = it }, label = { Text("Password or PIN") }, visualTransformation = PasswordVisualTransformation(), singleLine = true, modifier = Modifier.fillMaxWidth())
        error?.let { Text(it, color = Color(0xFFFF7167), modifier = Modifier.padding(12.dp)) }
        Spacer(Modifier.height(16.dp))
        Button(onClick = { onLogin(identifier.trim(), secret) }, enabled = !loading && identifier.isNotBlank() && secret.isNotBlank(), colors = ButtonDefaults.buttonColors(containerColor = Green, contentColor = Color.Black)) {
            if (loading) CircularProgressIndicator(modifier = Modifier.width(20.dp).height(20.dp), color = Color.Black) else Text("SIGN IN", fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun WorkerShell(context: WorkerContext, api: WorkerApi, onRefresh: () -> Unit, onLogout: () -> Unit) {
    var page by remember { mutableStateOf(WorkerPage.DASHBOARD) }
    Column(Modifier.fillMaxSize().background(Screen)) {
        WorkerHeader(context, onLogout)
        WorkerNav(context, page) { page = it }
        when (page) {
            WorkerPage.DASHBOARD -> DashboardPage(context, api, onOpenReceiving = { page = WorkerPage.RECEIVING })
            WorkerPage.RECEIVING -> ReceivingPage(api, onBack = { page = WorkerPage.DASHBOARD })
            WorkerPage.EXPECTED -> ExpectedPage(api, onBack = { page = WorkerPage.DASHBOARD })
            WorkerPage.PUTAWAY -> PutawayPage(api, onBack = { page = WorkerPage.DASHBOARD })
            WorkerPage.SORTING -> SortingPage(api, onBack = { page = WorkerPage.DASHBOARD })
            WorkerPage.PACKING -> PackingPage(api, onBack = { page = WorkerPage.DASHBOARD })
            WorkerPage.ORDER_SORTING -> OrderSortingPage(api, onBack = { page = WorkerPage.DASHBOARD })
            WorkerPage.SHIPPING -> ShippingPage(api, onBack = { page = WorkerPage.DASHBOARD })
        }
    }
}

@Composable
private fun WorkerHeader(context: WorkerContext, onLogout: () -> Unit) {
    Row(Modifier.fillMaxWidth().background(Color.Black).padding(horizontal = 18.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("AYROVI", color = Green, fontWeight = FontWeight.Bold, letterSpacing = 3.sp, fontSize = 18.sp)
        Spacer(Modifier.weight(1f))
        Text(context.station?.code ?: "WORKER", color = Green, fontSize = 12.sp)
        Spacer(Modifier.width(10.dp))
        TextButton(onClick = onLogout) { Text("LOGOUT", color = Muted, fontSize = 11.sp) }
    }
}

@Composable
private fun WorkerNav(context: WorkerContext, page: WorkerPage, onPage: (WorkerPage) -> Unit) {
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).background(Color.Black).padding(horizontal = 8.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
        NavItem("DASHBOARD", page == WorkerPage.DASHBOARD) { onPage(WorkerPage.DASHBOARD) }
        if (context.allowed("receiving.execute")) NavItem("RECEIVING", page == WorkerPage.RECEIVING) { onPage(WorkerPage.RECEIVING) }
        if (context.allowed("expected_arrivals.view")) NavItem("EXPECTED", page == WorkerPage.EXPECTED) { onPage(WorkerPage.EXPECTED) }
        if (context.allowed("stowing.execute")) {
            NavItem("PUTAWAY", page == WorkerPage.PUTAWAY) { onPage(WorkerPage.PUTAWAY) }
            NavItem("SORTING", page == WorkerPage.SORTING) { onPage(WorkerPage.SORTING) }
        }
        if (context.allowed("packing.execute")) NavItem("PACKING", page == WorkerPage.PACKING) { onPage(WorkerPage.PACKING) }
        if (context.allowed("picking.execute")) NavItem("ORDER SORT", page == WorkerPage.ORDER_SORTING) { onPage(WorkerPage.ORDER_SORTING) }
        if (context.allowed("shipping.execute")) NavItem("SHIPPING", page == WorkerPage.SHIPPING) { onPage(WorkerPage.SHIPPING) }
    }
}

@Composable
private fun NavItem(label: String, active: Boolean, onClick: () -> Unit) {
    TextButton(onClick = onClick) { Text(label, color = if (active) Green else Muted, fontSize = 12.sp, letterSpacing = 1.sp, fontWeight = if (active) FontWeight.Bold else FontWeight.Normal) }
}

@Composable
private fun DashboardPage(context: WorkerContext, api: WorkerApi, onOpenReceiving: () -> Unit) {
    var arrivals by remember { mutableStateOf<List<ReceivingArrival>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    val scope = rememberCoroutineScope()
    fun refresh() { loading = true; scope.launch { try { arrivals = withContext(Dispatchers.IO) { api.arrivals() } } catch (e: Exception) { error = e.message } finally { loading = false } } }
    LaunchedEffect(Unit) { refresh() }
    val receivingAllowed = context.tasks.any { it.key.contains("receiv", true) && it.ready }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(22.dp)) {
        Text("Dashboard", color = Color.White, fontSize = 30.sp, fontWeight = FontWeight.Light)
        Text("Operational overview · ${context.station?.code ?: "no station assigned"}", color = Muted, modifier = Modifier.padding(top = 4.dp))
        Spacer(Modifier.height(20.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            MetricCard("${context.tasks.count { it.ready }}", "READY TASKS", Modifier.weight(1f))
            MetricCard(context.station?.code ?: "—", "STATION", Modifier.weight(1f))
        }
        Spacer(Modifier.height(12.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            MetricCard("${arrivals.size}", "EXPECTED ARRIVALS", Modifier.weight(1f))
            MetricCard("${arrivals.sumOf { it.cartons }}", "EXPECTED CARTONS", Modifier.weight(1f))
        }
        Spacer(Modifier.height(24.dp))
        Text("EXPECTED WORK", color = Green, fontSize = 13.sp, letterSpacing = 2.sp)
        Spacer(Modifier.height(10.dp))
        if (receivingAllowed) {
            WorkCard("RECEIVING", "Physically receive expected arrivals: scan cartons, count units, raise exceptions.", "OPEN RECEIVING", onOpenReceiving)
        }
        WorkCard("EXPECTED ARRIVALS", "Customer arrival cards received from Arrival CRM. This is expected work, not physical receiving.", "VIEW EXPECTED", { /* navigation is available from top tab */ })
        Spacer(Modifier.height(22.dp))
        Text("LIVE EXPECTED ARRIVALS", color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.Medium)
        error?.let { Text(it, color = Color(0xFFFF7167), modifier = Modifier.padding(vertical = 8.dp)) }
        if (loading) CircularProgressIndicator(color = Green, modifier = Modifier.padding(20.dp))
        else if (arrivals.isEmpty()) Text("No expected arrivals yet.", color = Muted, modifier = Modifier.padding(vertical = 16.dp))
        else arrivals.take(6).forEach { ArrivalRow(it) }
    }
}

@Composable
private fun MetricCard(value: String, label: String, modifier: Modifier = Modifier) {
    Column(modifier.border(1.dp, Line).padding(16.dp)) {
        Text(value, color = Green, fontSize = 28.sp)
        Text(label, color = Muted, fontSize = 11.sp, letterSpacing = 1.sp)
    }
}

@Composable
private fun WorkCard(title: String, note: String, action: String, onClick: () -> Unit) {
    Column(Modifier.fillMaxWidth().border(1.dp, Line).padding(16.dp)) {
        Text(title, color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.Bold)
        Text(note, color = Muted, fontSize = 13.sp, modifier = Modifier.padding(vertical = 8.dp))
        Button(onClick = onClick, colors = ButtonDefaults.buttonColors(containerColor = Green, contentColor = Color.Black)) { Text(action, fontWeight = FontWeight.Bold) }
    }
    Spacer(Modifier.height(10.dp))
}

@Composable
private fun ArrivalRow(arrival: ReceivingArrival) {
    Row(Modifier.fillMaxWidth().border(1.dp, Line).padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(arrival.code, color = Color.White, fontWeight = FontWeight.Bold)
            Text(arrival.customerName, color = Muted, fontSize = 13.sp)
        }
        Text(arrival.status, color = Color(0xFFFFC247), fontSize = 12.sp)
        Spacer(Modifier.width(10.dp))
        Text("${arrival.cartons} cartons", color = Muted, fontSize = 12.sp)
    }
    Spacer(Modifier.height(6.dp))
}

@Composable
private fun ExpectedPage(api: WorkerApi, onBack: () -> Unit) {
    var arrivals by remember { mutableStateOf<List<ReceivingArrival>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { try { arrivals = withContext(Dispatchers.IO) { api.arrivals() } } catch (e: Exception) { error = e.message } }
    Column(Modifier.fillMaxSize().padding(22.dp)) {
        PageTitle("Expected Arrivals", onBack)
        Text("Customer Arrival Cards received from Arrival CRM via the integration API. Goods are expected to arrive — this is not physical receiving.", color = Muted, fontSize = 14.sp, modifier = Modifier.padding(vertical = 10.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            MetricCard("${arrivals.size}", "EXPECTED ARRIVALS", Modifier.weight(1f))
            MetricCard("${arrivals.sumOf { it.cartons }}", "EXPECTED CARTONS", Modifier.weight(1f))
        }
        error?.let { Text(it, color = Color(0xFFFF7167), modifier = Modifier.padding(vertical = 10.dp)) }
        LazyColumn(Modifier.padding(top = 16.dp)) { items(arrivals) { ArrivalRow(it) } }
    }
}

@Composable
private fun ReceivingPage(api: WorkerApi, onBack: () -> Unit) {
    var arrivals by remember { mutableStateOf<List<ReceivingArrival>>(emptyList()) }
    var session by remember { mutableStateOf<ReceivingSession?>(null) }
    var code by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var scannerOpen by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    fun request(block: suspend () -> Unit) {
        busy = true
        error = null
        scope.launch {
            try { block() }
            catch (e: Exception) { error = e.message ?: "Request failed" }
            finally { busy = false }
        }
    }
    LaunchedEffect(Unit) { request { arrivals = withContext(Dispatchers.IO) { api.arrivals() } } }
    if (scannerOpen) {
        NativeBarcodeScanner(
            onDetected = { value -> scannerOpen = false; request { val activeSession = session; if (activeSession != null) session = withContext(Dispatchers.IO) { api.scanCarton(activeSession.id, value, "CAMERA") } } },
            onClose = { scannerOpen = false },
        )
        return
    }
    Column(Modifier.fillMaxSize().padding(22.dp)) {
        PageTitle("Receiving", onBack)
        Text("Physical receiving workspace · scan cartons, count products and raise exceptions.", color = Muted, fontSize = 14.sp, modifier = Modifier.padding(vertical = 8.dp))
        error?.let { Text(it, color = Color(0xFFFF7167), modifier = Modifier.padding(vertical = 8.dp)) }
        if (session == null) {
            Text("EXPECTED ARRIVALS", color = Green, fontSize = 13.sp, letterSpacing = 2.sp, modifier = Modifier.padding(vertical = 12.dp))
            if (arrivals.isEmpty() && !busy) Text("No expected arrivals available.", color = Muted)
            LazyColumn { items(arrivals) { arrival ->
                Button(onClick = { request { session = withContext(Dispatchers.IO) { api.startReceiving(arrival.code) } } }, enabled = !busy, modifier = Modifier.fillMaxWidth().padding(vertical = 5.dp), colors = ButtonDefaults.buttonColors(containerColor = Panel, contentColor = Color.White)) {
                    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.Start) { Text(arrival.code, fontWeight = FontWeight.Bold); Text("${arrival.customerName} · ${arrival.cartons} cartons", color = Muted, fontSize = 12.sp) }
                }
            } }
        } else {
            val active = session!!
            Text("SESSION ${active.code}", color = Green, fontSize = 14.sp, letterSpacing = 2.sp)
            Text("${active.receivedCartons} / ${active.expectedCartons} cartons received", color = Color.White, fontSize = 20.sp, modifier = Modifier.padding(vertical = 12.dp))
            OutlinedTextField(code, { code = it }, label = { Text("Carton barcode / QR") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(12.dp))
            OutlinedButton(onClick = { scannerOpen = true }, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("OPEN CAMERA SCANNER") }
            Spacer(Modifier.height(8.dp))
            Button(onClick = { val value = code.trim(); if (value.isNotEmpty()) request { session = withContext(Dispatchers.IO) { api.scanCarton(active.id, value) }; code = "" } }, enabled = !busy && code.isNotBlank(), modifier = Modifier.fillMaxWidth(), colors = ButtonDefaults.buttonColors(containerColor = Green, contentColor = Color.Black)) { Text(if (busy) "SENDING…" else "SCAN CARTON", fontWeight = FontWeight.Bold) }
            active.flashMessage?.let { Text(it, color = if (active.flashKind == "CARTON_IDENTIFIED") Green else Color(0xFFFFC247), modifier = Modifier.padding(top = 16.dp)) }
            OutlinedButton(onClick = { session = null }, modifier = Modifier.fillMaxWidth().padding(top = 18.dp)) { Text("BACK TO ARRIVALS") }
        }
    }
}

@Composable
private fun PageTitle(title: String, onBack: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
        Text(title, color = Color.White, fontSize = 30.sp, fontWeight = FontWeight.Light)
        TextButton(onClick = onBack) { Text("BACK", color = Green) }
    }
}

@Composable
private fun NativeWorkPage(title: String, subtitle: String, steps: List<String>, onBack: () -> Unit) {
    var step by remember { mutableStateOf(0) }
    var value by remember { mutableStateOf("") }
    var scanner by remember { mutableStateOf(false) }
    if (scanner) {
        NativeBarcodeScanner(onDetected = { value = it; scanner = false }, onClose = { scanner = false })
        return
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(22.dp)) {
        PageTitle(title, onBack)
        Text(subtitle, color = Muted, fontSize = 14.sp, modifier = Modifier.padding(vertical = 8.dp))
        Text("STEP ${step + 1} / ${steps.size}", color = Green, letterSpacing = 2.sp, modifier = Modifier.padding(top = 18.dp))
        Text(steps[step], color = Color.White, fontSize = 24.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(vertical = 12.dp))
        OutlinedTextField(value, { value = it }, label = { Text("Scan or type code") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Button(onClick = { scanner = true }, modifier = Modifier.fillMaxWidth().padding(top = 12.dp), colors = ButtonDefaults.buttonColors(containerColor = Green, contentColor = Color.Black)) { Text("OPEN CAMERA SCANNER") }
        Button(onClick = { if (step < steps.lastIndex) { step++; value = "" } }, enabled = value.isNotBlank(), modifier = Modifier.fillMaxWidth().padding(top = 8.dp), colors = ButtonDefaults.buttonColors(containerColor = Panel, contentColor = Color.White)) { Text(if (step == steps.lastIndex) "CONFIRM" else "CONTINUE") }
        if (value.isNotBlank()) Text("Captured: $value", color = Green, modifier = Modifier.padding(top = 18.dp))
    }
}

@Composable
private fun PutawayPage(api: WorkerApi, onBack: () -> Unit) {
    var sessionId by remember { mutableStateOf<String?>(null) }
    var carton by remember { mutableStateOf<String?>(null) }
    var input by remember { mutableStateOf("") }
    var camera by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    fun submit(value: String, mode: String) {
        if (value.isBlank() || busy) return
        busy = true
        scope.launch {
            try {
                withContext(Dispatchers.IO) {
                    if (sessionId == null) {
                        val result = api.putawayStart()
                        sessionId = result["id"]?.toString()?.trim('"')
                    }
                    if (carton == null) {
                        val result = api.putawayScanCarton(value)
                        val flash = result["flash"]?.jsonObject
                        val kind = flash?.get("kind")?.toString()?.trim('"')
                        if (kind != "CARTON_READY") error(kind ?: "CARTON_NOT_ACCEPTED")
                        carton = flash["carton"]?.jsonObject?.get("externalCartonId")?.toString()?.trim('"') ?: value
                        message = "$carton ready — scan location"
                    } else {
                        val result = api.putawayPlace(sessionId!!, carton!!, value)
                        val flash = result["flash"]?.jsonObject
                        val kind = flash?.get("kind")?.toString()?.trim('"')
                        if (kind != "STORED") error(kind ?: "LOCATION_NOT_ACCEPTED")
                        message = "$carton stored at $value"
                        carton = null
                    }
                }
                input = ""
            } catch (e: Exception) { message = e.message ?: "Putaway failed" }
            finally { busy = false }
        }
    }
    if (camera) {
        NativeBarcodeScanner(onDetected = { camera = false; submit(it, "CAMERA") }, onClose = { camera = false })
        return
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(22.dp)) {
        PageTitle("Putaway", onBack)
        Text("Move received cartons to their assigned warehouse locations.", color = Muted, modifier = Modifier.padding(vertical = 8.dp))
        Text(if (carton == null) "STEP 1 · SCAN CARTON" else "STEP 2 · SCAN LOCATION", color = Green, fontSize = 14.sp, letterSpacing = 2.sp, modifier = Modifier.padding(top = 18.dp))
        Text(carton ?: "No carton staged", color = Color.White, fontSize = 22.sp, modifier = Modifier.padding(vertical = 12.dp))
        message?.let { Text(it, color = if (it.contains("stored")) Green else Color(0xFFFFC247), modifier = Modifier.padding(bottom = 10.dp)) }
        OutlinedTextField(input, { input = it }, label = { Text(if (carton == null) "Carton code" else "Location code") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedButton(onClick = { camera = true }, enabled = !busy, modifier = Modifier.fillMaxWidth().padding(top = 12.dp)) { Text("OPEN CAMERA SCANNER") }
        Button(onClick = { submit(input, "MANUAL") }, enabled = !busy && input.isNotBlank(), modifier = Modifier.fillMaxWidth().padding(top = 8.dp), colors = ButtonDefaults.buttonColors(containerColor = Green, contentColor = Color.Black)) { Text(if (busy) "PROCESSING…" else "CONFIRM", fontWeight = FontWeight.Bold) }
    }
}

@Composable
private fun SortingPage(api: WorkerApi, onBack: () -> Unit) {
    var article by remember { mutableStateOf<String?>(null) }
    var input by remember { mutableStateOf("") }
    var destination by remember { mutableStateOf("") }
    var camera by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    fun submit(value: String) {
        if (value.isBlank() || busy) return
        busy = true
        scope.launch {
            try {
                withContext(Dispatchers.IO) {
                    if (article == null) {
                        val result = api.sortingScan(value)
                        val kind = result["kind"]?.toString()?.trim('"')
                        if (kind != "DESTINATION") error(kind ?: "ARTICLE_REJECTED")
                        article = result["article"]?.jsonObject?.get("code")?.toString()?.trim('"') ?: value
                        destination = result["zone"]?.jsonObject?.get("code")?.toString()?.trim('"').orEmpty()
                        message = "$article → zone $destination — scan location"
                    } else {
                        val result = api.sortingStore(article!!, value)
                        val flash = result["flash"]?.jsonObject
                        message = "${flash?.get("article")?.toString()?.trim('"') ?: article} stored at ${flash?.get("location")?.toString()?.trim('"') ?: value}"
                        article = null; destination = ""
                    }
                }
                input = ""
            } catch (e: Exception) { message = e.message ?: "Sorting failed" }
            finally { busy = false }
        }
    }
    if (camera) { NativeBarcodeScanner(onDetected = { camera = false; submit(it) }, onClose = { camera = false }); return }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(22.dp)) {
        PageTitle("Sorting", onBack)
        Text("Article → configured destination → storage location.", color = Muted, modifier = Modifier.padding(vertical = 8.dp))
        Text(if (article == null) "STEP 1 · SCAN ARTICLE" else "STEP 2 · SCAN LOCATION", color = Green, letterSpacing = 2.sp, modifier = Modifier.padding(top = 18.dp))
        Text(article ?: "No article staged", color = Color.White, fontSize = 22.sp, modifier = Modifier.padding(vertical = 12.dp))
        if (destination.isNotBlank()) Text("DESTINATION ZONE: $destination", color = Color(0xFFFFC247))
        message?.let { Text(it, color = Green, modifier = Modifier.padding(vertical = 10.dp)) }
        OutlinedTextField(input, { input = it }, label = { Text(if (article == null) "Article code" else "Location code") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedButton(onClick = { camera = true }, enabled = !busy, modifier = Modifier.fillMaxWidth().padding(top = 12.dp)) { Text("OPEN CAMERA SCANNER") }
        Button(onClick = { submit(input) }, enabled = !busy && input.isNotBlank(), modifier = Modifier.fillMaxWidth().padding(top = 8.dp), colors = ButtonDefaults.buttonColors(containerColor = Green, contentColor = Color.Black)) { Text(if (busy) "PROCESSING…" else "CONFIRM", fontWeight = FontWeight.Bold) }
    }
}

@Composable
private fun PackingPage(api: WorkerApi, onBack: () -> Unit) {
    var bin by remember { mutableStateOf("") }
    var view by remember { mutableStateOf<kotlinx.serialization.json.JsonObject?>(null) }
    var camera by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    fun scan(value: String) {
        if (value.isBlank() || busy) return
        busy = true
        scope.launch { try { view = withContext(Dispatchers.IO) { api.packingScan(value) }; message = "Bin loaded — verify contents" } catch (e: Exception) { message = e.message ?: "Packing scan failed" } finally { busy = false } }
    }
    fun pack() {
        val code = view?.get("bin")?.jsonObject?.get("code")?.toString()?.trim('"') ?: bin
        if (code.isBlank() || busy) return
        busy = true
        scope.launch { try { withContext(Dispatchers.IO) { api.packingPack(code) }; message = "PACKED $code"; view = null; bin = "" } catch (e: Exception) { message = e.message ?: "Pack failed" } finally { busy = false } }
    }
    if (camera) { NativeBarcodeScanner(onDetected = { camera = false; bin = it; scan(it) }, onClose = { camera = false }); return }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(22.dp)) {
        PageTitle("Packing", onBack)
        Text("Scan a customer bin → verify contents → pack into a shipping carton.", color = Muted, modifier = Modifier.padding(vertical = 8.dp))
        message?.let { Text(it, color = if (it.startsWith("PACKED")) Green else Color(0xFFFFC247), modifier = Modifier.padding(vertical = 10.dp)) }
        OutlinedTextField(bin, { bin = it }, label = { Text("Customer bin QR") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedButton(onClick = { camera = true }, enabled = !busy, modifier = Modifier.fillMaxWidth().padding(top = 12.dp)) { Text("OPEN CAMERA SCANNER") }
        Button(onClick = { scan(bin) }, enabled = !busy && bin.isNotBlank() && view == null, modifier = Modifier.fillMaxWidth().padding(top = 8.dp), colors = ButtonDefaults.buttonColors(containerColor = Panel, contentColor = Color.White)) { Text("LOAD BIN") }
        view?.let { data ->
            Text("BIN CONTENTS", color = Green, letterSpacing = 2.sp, modifier = Modifier.padding(top = 24.dp))
            Text(data.toString(), color = Muted, fontSize = 12.sp, modifier = Modifier.padding(vertical = 8.dp))
            Button(onClick = ::pack, enabled = !busy, modifier = Modifier.fillMaxWidth(), colors = ButtonDefaults.buttonColors(containerColor = Green, contentColor = Color.Black)) { Text(if (busy) "PACKING…" else "PACK BIN", fontWeight = FontWeight.Bold) }
        }
    }
}

@Composable
private fun OrderSortingPage(api: WorkerApi, onBack: () -> Unit) {
    var article by remember { mutableStateOf("") }
    var bin by remember { mutableStateOf("") }
    var decision by remember { mutableStateOf<kotlinx.serialization.json.JsonObject?>(null) }
    var camera by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    fun submit(value: String) {
        if (value.isBlank() || busy) return
        busy = true
        scope.launch { try { withContext(Dispatchers.IO) { if (decision == null) { decision = api.orderSortingScan(value); article = value; message = "Article resolved — scan customer bin" } else { api.orderSortingAssign(article, value); decision = null; article = ""; message = "Article assigned to $value" } } } catch (e: Exception) { message = e.message ?: "Order sorting failed" } finally { busy = false } }
    }
    if (camera) { NativeBarcodeScanner(onDetected = { camera = false; if (decision == null) article = it else bin = it; submit(it) }, onClose = { camera = false }); return }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(22.dp)) {
        PageTitle("Order Sorting", onBack)
        Text("Scan an article, then assign it to the customer order bin.", color = Muted, modifier = Modifier.padding(vertical = 8.dp))
        Text(if (decision == null) "STEP 1 · SCAN ARTICLE" else "STEP 2 · SCAN BIN", color = Green, letterSpacing = 2.sp, modifier = Modifier.padding(top = 18.dp))
        message?.let { Text(it, color = Green, modifier = Modifier.padding(vertical = 10.dp)) }
        OutlinedTextField(if (decision == null) article else bin, { if (decision == null) article = it else bin = it }, label = { Text(if (decision == null) "Article code" else "Customer bin") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedButton(onClick = { camera = true }, enabled = !busy, modifier = Modifier.fillMaxWidth().padding(top = 12.dp)) { Text("OPEN CAMERA SCANNER") }
        Button(onClick = { submit(if (decision == null) article else bin) }, enabled = !busy && (if (decision == null) article else bin).isNotBlank(), modifier = Modifier.fillMaxWidth().padding(top = 8.dp), colors = ButtonDefaults.buttonColors(containerColor = Green, contentColor = Color.Black)) { Text("CONFIRM", fontWeight = FontWeight.Bold) }
    }
}

@Composable
private fun ShippingPage(api: WorkerApi, onBack: () -> Unit) {
    var code by remember { mutableStateOf("") }
    var shipment by remember { mutableStateOf<kotlinx.serialization.json.JsonObject?>(null) }
    var camera by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    fun load(value: String) { if (value.isBlank() || busy) return; busy = true; scope.launch { try { shipment = withContext(Dispatchers.IO) { api.shippingScan(value) }; message = "Shipment loaded — verify and ship" } catch (e: Exception) { message = e.message ?: "Shipping scan failed" } finally { busy = false } } }
    fun ship() { if (code.isBlank() || busy) return; busy = true; scope.launch { try { withContext(Dispatchers.IO) { api.shippingShip(code) }; message = "SHIPPED $code"; shipment = null; code = "" } catch (e: Exception) { message = e.message ?: "Shipping failed" } finally { busy = false } } }
    if (camera) { NativeBarcodeScanner(onDetected = { camera = false; code = it; load(it) }, onClose = { camera = false }); return }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(22.dp)) {
        PageTitle("Shipping", onBack)
        Text("Scan a shipment, verify its details, then confirm dispatch.", color = Muted, modifier = Modifier.padding(vertical = 8.dp))
        message?.let { Text(it, color = if (it.startsWith("SHIPPED")) Green else Color(0xFFFFC247), modifier = Modifier.padding(vertical = 10.dp)) }
        OutlinedTextField(code, { code = it }, label = { Text("Shipment code") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedButton(onClick = { camera = true }, enabled = !busy, modifier = Modifier.fillMaxWidth().padding(top = 12.dp)) { Text("OPEN CAMERA SCANNER") }
        Button(onClick = { load(code) }, enabled = !busy && code.isNotBlank() && shipment == null, modifier = Modifier.fillMaxWidth().padding(top = 8.dp), colors = ButtonDefaults.buttonColors(containerColor = Panel, contentColor = Color.White)) { Text("LOAD SHIPMENT") }
        shipment?.let { Text(it.toString(), color = Muted, fontSize = 12.sp, modifier = Modifier.padding(top = 18.dp)) }
        if (shipment != null) Button(onClick = ::ship, enabled = !busy, modifier = Modifier.fillMaxWidth().padding(top = 8.dp), colors = ButtonDefaults.buttonColors(containerColor = Green, contentColor = Color.Black)) { Text("CONFIRM SHIPMENT", fontWeight = FontWeight.Bold) }
    }
}
