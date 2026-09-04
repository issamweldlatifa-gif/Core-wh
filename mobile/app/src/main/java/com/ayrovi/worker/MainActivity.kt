package com.ayrovi.worker

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val store = WorkerSessionStore(this)
        val api = WorkerApi(BuildConfig.API_BASE_URL, store)
        setContent { WorkerApp(api, store) }
    }
}

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

    MaterialTheme {
        Surface(modifier = Modifier.fillMaxSize()) {
            if (context == null) {
                LoginScreen(
                    loading = loading,
                    error = error,
                    onLogin = { identifier, secret ->
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
                    },
                )
            } else {
                WorkerHome(context!!, onRefresh = ::loadContext, onLogout = {
                    api.logout()
                    context = null
                }, api = api)
            }
        }
    }
}

@Composable
private fun LoginScreen(
    loading: Boolean,
    error: String?,
    onLogin: (String, String) -> Unit,
) {
    var identifier by remember { mutableStateOf("") }
    var secret by remember { mutableStateOf("") }
    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text("AYROVI", style = MaterialTheme.typography.headlineLarge)
        Text("Worker App", style = MaterialTheme.typography.titleLarge)
        Spacer(Modifier.height(24.dp))
        OutlinedTextField(identifier, { identifier = it }, label = { Text("Employee code") }, singleLine = true)
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            secret, { secret = it }, label = { Text("Password or PIN") },
            visualTransformation = PasswordVisualTransformation(), singleLine = true,
        )
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(12.dp)) }
        Spacer(Modifier.height(12.dp))
        Button(
            onClick = { onLogin(identifier.trim(), secret) },
            enabled = !loading && identifier.isNotBlank() && secret.isNotBlank(),
        ) { if (loading) CircularProgressIndicator() else Text("Sign in") }
    }
}

@Composable
private fun WorkerHome(context: WorkerContext, onRefresh: () -> Unit, onLogout: () -> Unit, api: WorkerApi) {
    var receiving by remember { mutableStateOf(false) }
    if (receiving) {
        ReceivingScreen(api, onBack = { receiving = false })
        return
    }
    Column(Modifier.fillMaxSize().padding(20.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Column {
                Text("WORKER TERMINAL", style = MaterialTheme.typography.titleLarge)
                Text(context.station?.let { "${it.name} · ${it.code}" } ?: "No station assigned")
            }
            Button(onClick = onLogout) { Text("Logout") }
        }
        Spacer(Modifier.height(24.dp))
        Text("Allowed workflows", style = MaterialTheme.typography.titleMedium)
        LazyColumn(Modifier.padding(top = 8.dp)) {
            items(context.tasks) { task ->
                Button(onClick = { if (task.key.contains("receiv", true)) receiving = true }) {
                    Text("${task.label.ifBlank { task.key }}${if (task.ready) " · READY" else ""}")
                }
            }
        }
        Button(onClick = onRefresh, modifier = Modifier.fillMaxWidth()) { Text("Refresh assignment") }
    }
}

@Composable
private fun ReceivingScreen(api: WorkerApi, onBack: () -> Unit) {
    var arrivals by remember { mutableStateOf<List<ReceivingArrival>>(emptyList()) }
    var session by remember { mutableStateOf<ReceivingSession?>(null) }
    var code by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    fun run(block: () -> Unit) {
        busy = true
        scope.launch {
            try { withContext(Dispatchers.IO) { block() } }
            catch (e: Exception) { message = e.message ?: "Receiving request failed" }
            finally { busy = false }
        }
    }

    androidx.compose.runtime.LaunchedEffect(Unit) {
        run { arrivals = api.arrivals() }
    }

    Column(Modifier.fillMaxSize().padding(20.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("RECEIVING", style = MaterialTheme.typography.headlineMedium)
            Button(onClick = onBack) { Text("Back") }
        }
        message?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(vertical = 8.dp)) }
        if (session == null) {
            Text("Select expected arrival", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(vertical = 16.dp))
            LazyColumn {
                items(arrivals) { arrival ->
                    Button(
                        onClick = { run { session = api.startReceiving(arrival.code) } },
                        enabled = !busy,
                        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                    ) { Text("${arrival.code} · ${arrival.customerName}") }
                }
            }
        } else {
            val active = session!!
            Text("Session ${active.code} · ${active.receivedCartons}/${active.expectedCartons} cartons")
            Spacer(Modifier.height(20.dp))
            OutlinedTextField(
                code, { code = it }, label = { Text("Carton barcode / QR") },
                singleLine = true, modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(12.dp))
            Button(
                onClick = {
                    val value = code.trim()
                    if (value.isNotEmpty()) run { session = api.scanCarton(active.id, value); code = "" }
                },
                enabled = !busy && code.isNotBlank(), modifier = Modifier.fillMaxWidth(),
            ) { Text(if (busy) "Sending…" else "Scan carton") }
            active.flashMessage?.let { Text(it, modifier = Modifier.padding(top = 16.dp)) }
        }
    }
}
