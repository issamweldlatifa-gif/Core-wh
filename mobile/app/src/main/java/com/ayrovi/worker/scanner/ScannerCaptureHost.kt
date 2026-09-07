package com.ayrovi.worker.scanner

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.delay

/** UI capture controls only. One CameraX decoder / one vendor service / one shared ScannerManager. */
class ScannerCapture(
    val cameraOpen: Boolean,
    val manualOpen: Boolean,
    val manualCode: String,
    val hardwareAvailable: Boolean,
    val ocrOpen: Boolean,
    val ocrText: String,
    val ocrSuggestion: DirectedOcrResult?,
    val ocrError: String?,
    val softwareScan: () -> Unit,
    val camera: () -> Unit,
    val manual: () -> Unit,
    val setCode: (String) -> Unit,
    val submit: () -> Unit,
    val ocr: () -> Unit,
    val setOcrText: (String) -> Unit,
    val submitOcr: () -> Unit,
    val cancel: () -> Unit,
    val preview: @Composable (Modifier) -> Unit,
)

@Composable
fun rememberScannerCapture(manager: ScannerManager, enabled: Boolean, contextKey: String, onScan: (ScanResult) -> Unit): ScannerCapture {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current
    val focus = LocalFocusManager.current
    val latestScan = rememberUpdatedState(onScan)
    val latestEnabled = rememberUpdatedState(enabled)
    var camera by remember { mutableStateOf(false) }
    var manual by remember { mutableStateOf(false) }
    var code by remember { mutableStateOf("") }
    var ocrOpen by remember { mutableStateOf(false) }
    var ocrText by remember { mutableStateOf("") }
    var ocrSuggestion by remember { mutableStateOf<DirectedOcrResult?>(null) }
    var ocrError by remember { mutableStateOf<String?>(null) }
    val ocrReader = remember { DirectedOcr() }
    var permissionGranted by remember { mutableStateOf(false) }
    var resumed by remember { mutableStateOf(lifecycle.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) }
    var hardwareAvailable by remember { mutableStateOf(false) }
    var trigger by remember { mutableIntStateOf(0) }
    val coordinator = remember(manager) {
        ScanCoordinator({ _, _, _ -> }, {}, manager, onResult = { result ->
            camera = false; code = ""; ocrOpen = false; ocrText = ""; ocrSuggestion = null; ocrError = null
            if (latestEnabled.value) latestScan.value(result)
        })
    }
    val service = remember(coordinator) { ScannerService(context, coordinator) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) permissionGranted = true else coordinator.unavailable("Camera unavailable. Use manual entry.")
    }
    fun openCamera() {
        if (!enabled || !resumed) return
        manual = false; focus.clearFocus()
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            camera = true; manager.beginScan(); trigger++
        } else permission.launch(Manifest.permission.CAMERA)
    }
    LaunchedEffect(permissionGranted, resumed, enabled) {
        if (permissionGranted && resumed && enabled) { permissionGranted = false; camera = true; manager.beginScan(); trigger++ }
    }
    LaunchedEffect(enabled, resumed) { if (!enabled || !resumed) camera = false }
    LaunchedEffect(contextKey) { camera = false; code = ""; permissionGranted = false; ocrOpen = false; ocrText = ""; ocrSuggestion = null; ocrError = null }
    LaunchedEffect(trigger) {
        if (trigger > 0) { delay(10_000); manager.timeout(); if (manager.state.value.status == ScannerStatus.TIMEOUT) camera = false }
    }
    DisposableEffect(lifecycle, service) {
        service.initialize()
        val observer = LifecycleEventObserver { _, event -> when (event) {
            Lifecycle.Event.ON_RESUME -> { resumed = true; service.start(); hardwareAvailable = service.isAvailable() }
            Lifecycle.Event.ON_PAUSE -> { resumed = false; camera = false; hardwareAvailable = false; manager.setEnabled(false); service.stop() }
            else -> Unit
        } }
        lifecycle.lifecycle.addObserver(observer)
        if (resumed) { service.start(); hardwareAvailable = service.isAvailable() }
        onDispose { lifecycle.lifecycle.removeObserver(observer); manager.setEnabled(false); service.stop() }
    }
    return ScannerCapture(camera, manual, code, hardwareAvailable, ocrOpen, ocrText, ocrSuggestion, ocrError, softwareScan = {
        if (enabled && resumed) {
            if (service.supportsSoftwareTrigger && service.softwareTrigger()) { manager.beginScan(); trigger++ }
            else openCamera() // phone software scan uses the SAME real CameraX/ML Kit adapter
        }
    }, camera = ::openCamera, manual = { camera = false; ocrOpen = false; permissionGranted = false; manual = !manual; if (!manual) focus.clearFocus() },
        setCode = { code = it.take(1025) }, submit = {
            if (enabled && resumed) coordinator.onScanned(code, false, ScanSource.MANUAL.name)
        }, ocr = { camera = false; manual = false; permissionGranted = false; ocrOpen = !ocrOpen; ocrError = null; if (!ocrOpen) focus.clearFocus() },
        // OCR text entry accepts multi-line blocks (pasted label reads): the
        // template extracts the SKU line, so newlines never reach the scan
        // guard — only the extracted single-line token is submitted.
        setOcrText = { ocrText = it.take(2048); ocrError = null; ocrSuggestion = if (ocrText.isBlank()) null else ocrReader.read(ocrText) },
        submitOcr = {
            if (enabled && resumed) {
                val reading = ocrReader.read(ocrText)
                ocrSuggestion = reading
                val confirmed = reading.confirmedByOperator()
                if (confirmed.candidate == null) ocrError = "No SKU found in this text — edit it or re-scan the label"
                else { ocrError = null; coordinator.onOcrConfirmed(confirmed) }
            }
        }, cancel = { camera = false; manual = false; ocrOpen = false; manager.cancel() },
        preview = { modifier -> CameraScanner(false, coordinator, modifier) })
}
