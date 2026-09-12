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
    /** v76 camera-tool UI: torch (flash) state + toggle for the QR/barcode takeover. */
    val torchOn: Boolean,
    val toggleTorch: () -> Unit,
    val preview: @Composable (Modifier) -> Unit,
    val ocrPreview: @Composable (Modifier) -> Unit,
    /** v77 CONTINUOUS SESSION: permanent scan history of the active session. */
    val history: List<ScanHistoryEntry> = emptyList(),
    /** v77 in-camera verdict circle (green ✓ / red ✕) — brief, auto-clearing. */
    val feedback: ScanFeedback? = null,
    /** v77: the WORKFLOW verdict (real backend result) lands here → history
     *  row + in-camera circle. One success mark only, centred in the camera. */
    val reportVerdict: (success: Boolean, warning: Boolean, code: String, detail: String) -> Unit = { _, _, _, _ -> },
)

/** v77: one scan event in the session history (never deleted during a session). */
enum class ScanHistoryTone { PENDING, SUCCESS, WARNING, ERROR }

data class ScanHistoryEntry(
    val id: Long,
    val tone: ScanHistoryTone,
    val code: String,
    val detail: String,
    val atMillis: Long,
)

/** v77: the brief circle shown over the live camera after a judged scan. */
data class ScanFeedback(val id: Long, val success: Boolean)

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
    /**
     * v1.7.5: camera session timeout in ms; 0 = NEVER auto-close. The
     * receiving scan tool is a CONTINUOUS session (the field-reported
     * "camera closes and you reopen it all session" was this 10s timer).
     * Other stations keep the historic 10s watchdog.
     */
    cameraTimeoutMs: Long = 10_000,
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
    var torchOn by remember { mutableStateOf(false) }
    var trigger by remember { mutableIntStateOf(0) }
    // ── v77 CONTINUOUS SCANNING SESSION ─────────────────────────────────────
    // The owner order supersedes the §21 close-on-accept doctrine for the
    // camera tool: the camera opens ONCE and stays open across every scan
    // (success or failure) until the operator exits. Every read becomes a
    // permanent session-history row (PENDING → verdict), and the workflow's
    // real verdict drives the in-camera green ✓ / red ✕ circle.
    var history by remember { mutableStateOf<List<ScanHistoryEntry>>(emptyList()) }
    var feedback by remember { mutableStateOf<ScanFeedback?>(null) }
    val nextEntryId = remember { java.util.concurrent.atomic.AtomicLong(0) }
    val pendingEntries = remember { ArrayDeque<Long>() }
    fun appendEntry(tone: ScanHistoryTone, code: String, detail: String): Long {
        val id = nextEntryId.incrementAndGet()
        history = (history + ScanHistoryEntry(id, tone, code, detail, System.currentTimeMillis())).takeLast(40)
        return id
    }
    fun flash(success: Boolean) { feedback = ScanFeedback(nextEntryId.incrementAndGet(), success) }
    val coordinator = remember(manager) {
        ScanCoordinator({ _, _, _ -> }, {}, manager, onResult = { result ->
            if (latestEnabled.value) {
                // v77: NO surface closes on accept. The read waits in the
                // history as PENDING until the workflow verdict lands. Reads
                // are NEVER gated here: the ONE scan guard (echo/debounce)
                // already swallows the label still in front of the lens —
                // gating after it would silently LOSE genuine new scans.
                pendingEntries.addLast(appendEntry(ScanHistoryTone.PENDING, result.value, "Checking…"))
                latestScan.value(result)
            }
        }, onOcrReview = { block, result ->
            // First useful engine read fills the review field and stops the
            // camera; the operator still reviews and confirms the code.
            ocrText = block.take(2048); ocrSuggestion = result; ocrError = null; ocrCameraOpen = false
        }, ocrTemplate = { latestTemplate.value })
    }
    val service = remember(coordinator) { ScannerService(context, coordinator) }
    // Real-time rejects from the ONE scan guard (INVALID read, several
    // barcodes visible…) → instant red circle + history row with the ACTUAL
    // reason. DEBOUNCE/DUPLICATE echoes stay silent: that is the guard
    // swallowing the label still in front of the lens (house rule), and the
    // real "already scanned" verdict arrives from the backend as WARNING.
    LaunchedEffect(coordinator) {
        manager.events.collect { n ->
            when (n.status) {
                ScannerStatus.INVALID, ScannerStatus.UNAVAILABLE ->
                    appendEntry(ScanHistoryTone.ERROR, n.code ?: "—", n.detail).also { flash(false) }
                else -> Unit
            }
        }
    }
    // The circle clears itself. Detection never stopped (the analyzer kept
    // running and the scan guard kept guarding) — there is nothing to resume.
    LaunchedEffect(feedback?.id) {
        val fb = feedback ?: return@LaunchedEffect
        delay(if (fb.success) 900 else 1_500)
        if (feedback?.id == fb.id) feedback = null
    }
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
    LaunchedEffect(contextKey) { camera = false; code = ""; permissionGranted = false; ocrOpen = false; ocrText = ""; ocrSuggestion = null; ocrError = null; ocrCameraOpen = false; ocrCameraPending = false; torchOn = false; history = emptyList(); feedback = null; pendingEntries.clear(); coordinator.reset() }
    LaunchedEffect(trigger) {
        // v77: the no-read watchdog only reports; it NEVER closes the camera —
        // the tool stops when the OPERATOR exits it, not on a timer (owner
        // order §5: "the camera may stop only when the worker explicitly
        // exits the scanner screen").
        if (trigger > 0 && cameraTimeoutMs > 0) { delay(cameraTimeoutMs); manager.timeout() }
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
    // v77: the workflow verdict (the REAL backend result — never invented)
    // resolves the PENDING history row and flashes the in-camera circle.
    // Green only for a genuine success; warning (already scanned) and error
    // both render the red ✕, per the owner's no-duplicate-mark rule.
    val reportVerdict: (Boolean, Boolean, String, String) -> Unit = { success, warning, code, detail ->
        val tone = when {
            success -> ScanHistoryTone.SUCCESS
            warning -> ScanHistoryTone.WARNING
            else -> ScanHistoryTone.ERROR
        }
        val target = pendingEntries.removeFirstOrNull()
        if (target != null) {
            history = history.map { if (it.id == target) it.copy(tone = tone, detail = detail) else it }
        } else {
            appendEntry(tone, code, detail)
        }
        flash(success)
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
        cancel = { camera = false; manual = false; ocrOpen = false; ocrCameraOpen = false; torchOn = false; feedback = null; manager.cancel() },
        torchOn = torchOn,
        toggleTorch = { torchOn = !torchOn },
        preview = { modifier -> CameraScanner(false, coordinator, modifier, torchOn) },
        ocrPreview = { modifier -> TextOcrScanner(coordinator, modifier) },
        history = history,
        feedback = feedback,
        reportVerdict = reportVerdict)
}
