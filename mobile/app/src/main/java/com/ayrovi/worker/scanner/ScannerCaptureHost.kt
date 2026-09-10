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
    val ocrCameraOpen: Boolean,
    val softwareScan: () -> Unit,
    val camera: () -> Unit,
    val manual: () -> Unit,
    val setCode: (String) -> Unit,
    val submit: () -> Unit,
    val ocr: () -> Unit,
    val setOcrText: (String) -> Unit,
    val submitOcr: () -> Unit,
    val ocrCamera: () -> Unit,
    val cancel: () -> Unit,
    val preview: @Composable (Modifier) -> Unit,
    val ocrPreview: @Composable (Modifier) -> Unit,
)

@Composable
fun rememberScannerCapture(
    manager: ScannerManager,
    enabled: Boolean,
    contextKey: String,
    onScan: (ScanResult) -> Unit,
    /** Lane template for OCR: strict compact product SKU (PRODUCT lane) or carton/tracking (CARTON lane). */
    ocrTemplate: OcrTemplate = CompactSkuTemplate,
    /**
     * Deterministic hardware override for tests/previews (null = sense the
     * real device). The CI emulator has no imager, so instrumented tests of
     * the CT40 layout pass `true` here; production always passes null.
     */
    hardwareOverride: Boolean? = null,
): ScannerCapture {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current
    val focus = LocalFocusManager.current
    val latestScan = rememberUpdatedState(onScan)
    val latestEnabled = rememberUpdatedState(enabled)
    val latestTemplate = rememberUpdatedState(ocrTemplate)
    var camera by remember { mutableStateOf(false) }
    var manual by remember { mutableStateOf(false) }
    var code by remember { mutableStateOf("") }
    var ocrOpen by remember { mutableStateOf(false) }
    var ocrText by remember { mutableStateOf("") }
    var ocrSuggestion by remember { mutableStateOf<DirectedOcrResult?>(null) }
    var ocrError by remember { mutableStateOf<String?>(null) }
    // Lane-aware paste/text reader: the PRODUCT lane extracts the compact SKU,
    // the CARTON lane extracts a carton / tracking identifier.
    val ocrReader = remember(ocrTemplate) { DirectedOcr(ocrTemplate) }
    var ocrCameraOpen by remember { mutableStateOf(false) }
    var ocrCameraPending by remember { mutableStateOf(false) }
    var permissionGranted by remember { mutableStateOf(false) }
    var resumed by remember { mutableStateOf(lifecycle.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) }
    var hardwareAvailable by remember { mutableStateOf(false) }
    var trigger by remember { mutableIntStateOf(0) }
    val coordinator = remember(manager) {
        ScanCoordinator({ _, _, _ -> }, {}, manager, onResult = { result ->
            // MASTER ORDER §21: a scan tool is TEMPORARY. The moment a read is
            // accepted every tool surface closes (camera, OCR, manual) so the
            // workflow's result state takes over — no camera stays open behind
            // the operator.
            camera = false; code = ""; manual = false; ocrOpen = false; ocrText = ""; ocrSuggestion = null; ocrError = null
            ocrCameraOpen = false
            if (latestEnabled.value) latestScan.value(result)
        }, onOcrReview = { block, result ->
            // First useful engine read fills the review field and stops the
            // camera; the operator still reviews and confirms the code.
            ocrText = block.take(2048); ocrSuggestion = result; ocrError = null; ocrCameraOpen = false
        }, ocrTemplate = { latestTemplate.value })
    }
    val service = remember(coordinator) { ScannerService(context, coordinator) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) permissionGranted = true else coordinator.unavailable("Camera unavailable. Use manual entry.")
    }
    fun openCamera() {
        if (!enabled || !resumed) return
        manual = false; ocrOpen = false; focus.clearFocus()
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            camera = true; manager.beginScan(); trigger++
        } else permission.launch(Manifest.permission.CAMERA)
    }
    fun openOcrCamera() {
        if (!enabled || !resumed) return
        camera = false; manual = false; focus.clearFocus()
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            ocrCameraOpen = true; manager.beginScan(); trigger++
        } else { ocrCameraPending = true; permission.launch(Manifest.permission.CAMERA) }
    }
    LaunchedEffect(permissionGranted, resumed, enabled) {
        if (permissionGranted && resumed && enabled) {
            permissionGranted = false
            if (ocrCameraPending) { ocrCameraPending = false; ocrCameraOpen = true } else { camera = true }
            manager.beginScan(); trigger++
        }
    }
    LaunchedEffect(enabled, resumed) { if (!enabled || !resumed) { camera = false; ocrCameraOpen = false } }
    LaunchedEffect(contextKey) { camera = false; code = ""; permissionGranted = false; ocrOpen = false; ocrText = ""; ocrSuggestion = null; ocrError = null; ocrCameraOpen = false; ocrCameraPending = false; coordinator.reset() }
    LaunchedEffect(trigger) {
        if (trigger > 0) { delay(10_000); manager.timeout(); if (manager.state.value.status == ScannerStatus.TIMEOUT) { camera = false; ocrCameraOpen = false } }
    }
    DisposableEffect(lifecycle, service) {
        service.initialize()
        fun sense() { hardwareAvailable = hardwareOverride ?: service.isAvailable() }
        val observer = LifecycleEventObserver { _, event -> when (event) {
            Lifecycle.Event.ON_RESUME -> { resumed = true; service.start(); sense() }
            Lifecycle.Event.ON_PAUSE -> { resumed = false; camera = false; hardwareAvailable = hardwareOverride ?: false; manager.setEnabled(false); service.stop() }
            else -> Unit
        } }
        lifecycle.lifecycle.addObserver(observer)
        if (resumed) { service.start(); sense() }
        onDispose { lifecycle.lifecycle.removeObserver(observer); manager.setEnabled(false); service.stop() }
    }
    return ScannerCapture(camera, manual, code, hardwareAvailable, ocrOpen, ocrText, ocrSuggestion, ocrError, ocrCameraOpen, softwareScan = {
        if (enabled && resumed) {
            if (service.supportsSoftwareTrigger && service.softwareTrigger()) { manager.beginScan(); trigger++ }
            else openCamera() // phone software scan uses the SAME real CameraX/ML Kit adapter
        }
    }, camera = ::openCamera, manual = { camera = false; ocrOpen = false; permissionGranted = false; manual = !manual; if (!manual) focus.clearFocus() },
        setCode = { code = it.take(1025) }, submit = {
            if (enabled && resumed) coordinator.onScanned(code, false, ScanSource.MANUAL.name)
        }, ocr = { camera = false; manual = false; permissionGranted = false; ocrCameraOpen = false; ocrOpen = !ocrOpen; ocrError = null; if (!ocrOpen) focus.clearFocus() },
        // OCR text entry accepts multi-line blocks (pasted label reads): the
        // LANE template extracts the identifier line (compact SKU in the
        // product lane, carton/tracking id in the carton lane), so newlines
        // never reach the scan guard — only the extracted token is submitted.
        setOcrText = { ocrText = it.take(2048); ocrError = null; ocrSuggestion = if (ocrText.isBlank()) null else coordinator.onOcrText(ocrText) },
        submitOcr = {
            if (enabled && resumed) {
                val reading = coordinator.onOcrText(ocrText)
                ocrSuggestion = reading
                val confirmed = reading.confirmedByOperator()
                val isCarton = latestTemplate.value.id == CartonTemplate.id
                if (confirmed.candidate == null) ocrError = if (isCarton)
                    "No carton or tracking code found in this text — edit it or re-scan the label"
                else "No SKU found in this text — edit it or re-scan the label"
                else { ocrError = null; coordinator.onOcrConfirmed(confirmed) }
            }
        }, ocrCamera = { if (ocrCameraOpen) { ocrCameraOpen = false; manager.cancel() } else openOcrCamera() },
        cancel = { camera = false; manual = false; ocrOpen = false; ocrCameraOpen = false; manager.cancel() },
        preview = { modifier -> CameraScanner(false, coordinator, modifier) },
        ocrPreview = { modifier -> TextOcrScanner(coordinator, modifier) })
}
