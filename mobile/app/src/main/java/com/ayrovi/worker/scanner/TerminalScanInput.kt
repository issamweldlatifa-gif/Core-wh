package com.ayrovi.worker.scanner

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ayrovi.worker.design.*
import kotlinx.coroutines.delay

/** Shared capture surface: screens provide only a label, context, enablement and a scan intent. */
@Composable
fun TerminalScanInput(label: String, enabled: Boolean, contextKey: String, onScan: (ScanResult) -> Unit) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val latestScan = rememberUpdatedState(onScan)
    val latestEnabled = rememberUpdatedState(enabled)
    var manual by remember { mutableStateOf("") }
    var camera by remember { mutableStateOf(false) }
    var resumed by remember { mutableStateOf(owner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) }
    var triggerSequence by remember { mutableIntStateOf(0) }
    val manager = remember { ScannerManager() }
    val coordinator = remember {
        ScanCoordinator(onAccepted = { _, _, _ -> }, onRejected = {}, manager = manager, onResult = { result ->
            camera = false
            if (latestEnabled.value) { manual = ""; latestScan.value(result) }
        })
    }
    val service = remember { ScannerService(context, coordinator) }
    val scanner by manager.state.collectAsStateWithLifecycle()
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted && latestEnabled.value && resumed) { camera = true; manager.beginScan(); triggerSequence++ }
        else coordinator.unavailable("Camera permission unavailable — use hardware or manual entry")
    }
    fun openCamera() {
        if (!enabled || !resumed) return
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            camera = true; manager.beginScan(); triggerSequence++
        } else permission.launch(Manifest.permission.CAMERA)
    }
    SideEffect { manager.setEnabled(enabled && resumed) }
    LaunchedEffect(enabled, resumed) { if (!enabled || !resumed) camera = false }
    LaunchedEffect(contextKey) { camera = false; manual = ""; manager.rearm() }
    LaunchedEffect(triggerSequence) {
        if (triggerSequence > 0) {
            delay(10_000)
            manager.timeout()
            if (manager.state.value.status == ScannerStatus.TIMEOUT) camera = false
        }
    }
    DisposableEffect(owner, service) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> { resumed = true; service.start() }
                Lifecycle.Event.ON_PAUSE -> { resumed = false; camera = false; manager.setEnabled(false); service.stop() }
                else -> Unit
            }
        }
        owner.lifecycle.addObserver(observer)
        if (resumed) service.start()
        onDispose { owner.lifecycle.removeObserver(observer); manager.setEnabled(false); service.stop() }
    }
    ScanZone(label, enabled && resumed) {
        ScanStatus(scanner.detail, when (scanner.status) {
            ScannerStatus.INVALID, ScannerStatus.UNAVAILABLE, ScannerStatus.TIMEOUT -> TerminalTone.ERROR
            ScannerStatus.DUPLICATE, ScannerStatus.CANCELLED -> TerminalTone.WARNING
            else -> TerminalTone.INSTRUCTION
        })
        Text(if (service.hasHardware) "Use the hardware trigger, or choose a fallback below."
            else "Use the camera, or enter the exact printed code.", style = MaterialTheme.typography.bodyMedium)
        if (camera && enabled && resumed) {
            Box(Modifier.fillMaxWidth().height(TerminalTokens.scanPreview)) {
                CameraScanner(false, coordinator, Modifier.fillMaxWidth().height(TerminalTokens.scanPreview))
            }
            SecondaryAction("CANCEL SCAN", { camera = false; manager.cancel() })
        } else {
            PrimaryAction(if (service.hasHardware) "SOFTWARE SCAN" else "OPEN CAMERA", {
                manager.beginScan()
                if (service.softwareTrigger()) triggerSequence++ else openCamera()
            }, enabled && resumed)
            if (service.hasHardware) SecondaryAction("USE CAMERA", ::openCamera, enabled && resumed)
        }
        val submit: () -> Unit = {
            if (enabled && resumed) coordinator.onScanned(manual, false, ScanSource.MANUAL.name)
        }
        TerminalTextInput("MANUAL CODE", manual, { manual = it }, enabled = enabled && resumed, onSubmit = submit)
        SecondaryAction("SUBMIT CODE", submit, enabled && resumed && manual.isNotBlank())
    }
}
