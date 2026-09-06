package com.ayrovi.worker.scanner

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ayrovi.worker.design.*
import kotlinx.coroutines.delay

/** One foreground capture host across Receiving steps. No warehouse policy or API lives here. */
@Composable
fun TerminalScanInput(
    label: String, enabled: Boolean, contextKey: String, onScan: (ScanResult) -> Unit,
    visible: Boolean = true,
) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val latestScan = rememberUpdatedState(onScan)
    val latestEnabled = rememberUpdatedState(enabled)
    val focus = remember { FocusRequester() }
    val focusManager = LocalFocusManager.current
    var manual by remember { mutableStateOf("") }
    var manualExpanded by remember { mutableStateOf(false) }
    var camera by remember { mutableStateOf(false) }
    var cameraPermissionGranted by remember { mutableStateOf(false) }
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
        if (granted) cameraPermissionGranted = true
        else coordinator.unavailable("Camera permission unavailable — use hardware or manual entry")
    }
    fun openCamera() {
        if (!enabled || !resumed) return
        manualExpanded = false
        focusManager.clearFocus()
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            camera = true; manager.beginScan(); triggerSequence++
        } else permission.launch(Manifest.permission.CAMERA)
    }
    SideEffect { manager.setEnabled(enabled && resumed) }
    LaunchedEffect(cameraPermissionGranted, resumed, enabled) {
        // Permission delivery may precede ON_RESUME. Wait instead of reporting a false denial.
        if (cameraPermissionGranted && resumed && enabled) {
            cameraPermissionGranted = false
            manager.setEnabled(true); manager.beginScan(); camera = true; triggerSequence++
        }
    }
    LaunchedEffect(enabled, resumed) { if (!enabled || !resumed) camera = false }
    LaunchedEffect(contextKey) { camera = false; cameraPermissionGranted = false; manual = ""; manager.rearm() }
    LaunchedEffect(manualExpanded, enabled, visible) {
        if (manualExpanded && enabled && visible) focus.requestFocus()
    }
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
    if (visible) ScanZone(label, enabled && resumed) {
        ScanStatus(scanner.detail, when (scanner.status) {
            ScannerStatus.INVALID, ScannerStatus.UNAVAILABLE, ScannerStatus.TIMEOUT -> TerminalTone.ERROR
            ScannerStatus.DUPLICATE, ScannerStatus.CANCELLED -> TerminalTone.WARNING
            else -> TerminalTone.INSTRUCTION
        })
        if (service.hasHardware) Text("Use the hardware trigger. Camera and manual entry are fallbacks.",
            style = MaterialTheme.typography.bodyMedium, color = TerminalTokens.muted)
        if (camera && enabled && resumed) {
            CameraScanner(false, coordinator, Modifier.fillMaxWidth().height(TerminalTokens.scanPreview))
            SecondaryAction("CANCEL SCAN", { camera = false; manager.cancel() })
        } else Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
            SecondaryAction("CAMERA", ::openCamera, enabled && resumed, Modifier.weight(1f))
            SecondaryAction(if (manualExpanded) "HIDE KEYPAD" else "MANUAL", {
                cameraPermissionGranted = false
                manualExpanded = !manualExpanded
                if (!manualExpanded) focusManager.clearFocus()
            }, enabled && resumed, Modifier.weight(1f))
        }
        if (service.supportsSoftwareTrigger) SecondaryAction("SOFTWARE TRIGGER", {
            manager.beginScan()
            if (service.softwareTrigger()) triggerSequence++
            else coordinator.unavailable("Software trigger unavailable — use camera or manual entry")
        }, enabled && resumed)
        if (manualExpanded) {
            val submit: () -> Unit = {
                if (enabled && resumed) coordinator.onScanned(manual, false, ScanSource.MANUAL.name)
            }
            TerminalTextInput("MANUAL CODE", manual, { manual = it }, enabled = enabled && resumed,
                onSubmit = submit, modifier = Modifier.fillMaxWidth().focusRequester(focus))
            PrimaryAction("SUBMIT CODE", submit, enabled && resumed && manual.isNotBlank())
        }
    }
}
