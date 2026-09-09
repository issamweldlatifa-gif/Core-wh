package com.ayrovi.worker.presentation

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ayrovi.worker.data.ReportLineView
import com.ayrovi.worker.data.WorkerRepository
import com.ayrovi.worker.design.ConfirmAction
import com.ayrovi.worker.design.DangerAction
import com.ayrovi.worker.design.EmptyState
import com.ayrovi.worker.design.ErrorState
import com.ayrovi.worker.design.LoadingState
import com.ayrovi.worker.design.PrimaryAction
import com.ayrovi.worker.design.QuantityDisplay
import com.ayrovi.worker.design.QuantityStepper
import com.ayrovi.worker.design.SecondaryAction
import com.ayrovi.worker.design.StatusBadge
import com.ayrovi.worker.design.SuccessState
import com.ayrovi.worker.design.TaskInstruction
import com.ayrovi.worker.design.TerminalFooter
import com.ayrovi.worker.design.TerminalHeader
import com.ayrovi.worker.design.TerminalNotice
import com.ayrovi.worker.design.TerminalPanel
import com.ayrovi.worker.design.TerminalShell
import com.ayrovi.worker.design.TerminalTextInput
import com.ayrovi.worker.design.TerminalTokens
import com.ayrovi.worker.design.TerminalTone
import com.ayrovi.worker.scanner.WorkerDevice
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * CONFIRMATION REPORT (ORDER 01) — verification view for the worker.
 *
 * Live auto data (expected/scanned/confirmed/missing/damaged per product),
 * damage declaration, manual description/observation, photo evidence, draft
 * save and CONFIRM & SEND. A locked report is strictly read-only.
 */
@Composable
fun ReceivingReportScreen(
    model: ReceivingReportViewModel,
    worker: String,
    station: String?,
    connection: String,
    onBack: () -> Unit,
    onAuthExpired: () -> Unit,
    industrial: Boolean = false,
    repository: WorkerRepository? = null,
    onToggleTheme: (() -> Unit)? = null,
    appVersion: String = "",
    deviceCode: String = "",
    device: WorkerDevice = WorkerDevice.PHONE,
) {
    val state by model.state.collectAsStateWithLifecycle()
    val pending by model.pendingPhotos.collectAsStateWithLifecycle()
    val owner = LocalLifecycleOwner.current
    val context = LocalContext.current

    DisposableEffect(owner, model) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> model.setForeground(true)
                Lifecycle.Event.ON_PAUSE -> model.setForeground(false)
                else -> Unit
            }
        }
        owner.lifecycle.addObserver(observer)
        model.setForeground(owner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED))
        onDispose { owner.lifecycle.removeObserver(observer); model.setForeground(false) }
    }

    LaunchedEffect(state.authExpired) { if (state.authExpired) onAuthExpired() }

    // Manual fields: seeded from the server view, then owned by the worker
    // until the report identity changes (draft created / session changed).
    var description by rememberSaveable(state.report?.reportId) {
        mutableStateOf(state.report?.manual?.description.orEmpty())
    }
    var observation by rememberSaveable(state.report?.reportId) {
        mutableStateOf(state.report?.manual?.observation.orEmpty())
    }
    var damageLine by remember { mutableStateOf<ReportLineView?>(null) }
    var confirmSubmit by remember { mutableStateOf(false) }
    var settings by remember { mutableStateOf(false) }

    val capture = rememberReportPhotoCapture { photo ->
        if (photo == null) {
            android.widget.Toast.makeText(context, "Photo failed — try again.", android.widget.Toast.LENGTH_SHORT).show()
        } else if (!model.canAddPhoto()) {
            android.widget.Toast.makeText(context, "Maximum 10 photos.", android.widget.Toast.LENGTH_SHORT).show()
        } else {
            model.addPending(photo)
        }
    }

    TerminalShell(
        header = {
            // The gear ALWAYS opens Paramètres (never the light/dark toggle:
            // the toggle exists only as the separate "CHANGE DISPLAY" action
            // inside the settings dialog).
            TerminalHeader("CONFIRMATION REPORT", worker, station, connection,
                industrial = industrial, onBack = onBack, onSettings = { settings = true })
        },
        footer = {
            TerminalFooter(if (state.loading) "PLEASE WAIT" else "") {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
                    SecondaryAction("BACK", onBack, !state.loading, Modifier.weight(1f))
                    SecondaryAction("REFRESH", model::refresh, !state.loading, Modifier.weight(1f))
                }
                if (state.report != null && !state.noSession) {
                    SecondaryAction("SAVE DRAFT",
                        { model.saveDraft(description.ifBlank { null }, observation.ifBlank { null }) },
                        state.canMutate, Modifier.testTag("REPORT_SAVE_DRAFT"))
                    if (!state.locked) {
                        PrimaryAction("CONFIRM & SEND", { confirmSubmit = true },
                            state.canMutate, Modifier.testTag("REPORT_SUBMIT"))
                    }
                }
            }
        },
        scrollKey = state.report?.reportStatus,
    ) {
        Column(Modifier.fillMaxWidth().testTag("CONFIRMATION_REPORT"),
            verticalArrangement = Arrangement.spacedBy(TerminalTokens.sm)) {
            when {
                state.loading && state.report == null && !state.noSession ->
                    LoadingState("OPENING REPORT…")
                state.noSession ->
                    EmptyState("NO OPEN SESSION", "There is no open receiving session for this worker. Scan products or cartons first.")
                state.report == null -> {
                    // Error is TERMINAL (never a second endless spinner):
                    // the failure message plus an explicit RETRY that
                    // re-runs the whole open sequence (resolve + load).
                    state.message?.let { OperationalMessageViewHome(it) }
                    ErrorState("REPORT UNAVAILABLE", "The report could not be opened.", null, null)
                    SecondaryAction("RETRY", model::refresh, !state.loading)
                }
                else -> {
                    state.message?.let {
                        OperationalMessageViewHome(it)
                        SecondaryAction("DISMISS", model::dismissMessage)
                    }
                    if (state.justSubmitted) SuccessState("REPORT SENT",
                        "Locked and sent to supervisors. Confirmed products are ready for the next station.")
                    ReportHeader(state.sessionCode, state.arrivalCode, state.reportStatus,
                        state.report?.taskStatus, state.report?.actor?.workerName,
                        state.report?.actor?.stationCode, state.report?.submittedAt)
                    ReportTotals(state)
                    ReportLines(state, onDamage = { damageLine = it })
                    ReportManual(description, observation, state.canMutate && !state.loading,
                        { description = it }, { observation = it })
                    ReportPhotos(state, pending.map { it.dataUrl }, model.canAddPhoto() && state.canMutate && !state.loading,
                        onCamera = capture::camera, onGallery = capture::gallery,
                        onRemovePending = model::removePending)
                }
            }
        }
    }

    if (settings) {
        // Same shared worker Settings as Receiving (Support actions hide when
        // no repository is wired). "Switch Mode" leaves the report.
        WorkerSettingsDialog(
            repository = repository,
            worker = worker,
            station = station,
            connection = connection,
            appVersion = appVersion,
            deviceCode = deviceCode,
            device = device,
            onSwitchMode = { settings = false; onBack() },
            onClose = { settings = false },
            onChangeDisplay = onToggleTheme,
        )
    }

    damageLine?.let { line ->
        val max = (line.scannedQuantity - line.damagedQuantity).coerceAtLeast(0)
        if (max > 0 && state.canMutate) {
            DamageDialog(line, max,
                onConfirm = { qty, note ->
                    model.damage(line.receivingProductId.orEmpty(), qty, note.ifBlank { null })
                    damageLine = null
                },
                onDismiss = { damageLine = null })
        } else {
            // Clear outside composition: writing state while composing can
            // loop the frame on slow devices (settles once, then the dialog
            // branch disappears for good).
            LaunchedEffect(line.receivingProductId) { damageLine = null }
        }
    }

    if (confirmSubmit && state.canMutate) {
        val totals = state.report?.totals
        AlertDialog(
            onDismissRequest = { confirmSubmit = false },
            title = { Text("CONFIRM & SEND") },
            text = {
                Text("Lock this report and send it to supervisors?\n\n" +
                    "Confirmed: ${totals?.confirmedUnits}/${totals?.expectedUnits} · " +
                    "Missing: ${totals?.missingUnits} · Damaged: ${totals?.damagedUnits}\n\n" +
                    "A sent report cannot be changed.")
            },
            confirmButton = {
                ConfirmAction("SEND REPORT", {
                    confirmSubmit = false
                    model.submit(description.ifBlank { null }, observation.ifBlank { null })
                })
            },
            dismissButton = { SecondaryAction("CANCEL", { confirmSubmit = false }) },
        )
    }
}

@Composable
private fun ReportHeader(
    session: String?, arrival: String?, status: String, task: String?,
    workerName: String?, stationCode: String?, submittedAt: String?,
) {
    TerminalPanel("REPORT") {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs),
            verticalAlignment = Alignment.CenterVertically) {
            StatusBadge(status, reportTone(status))
            if (task != null) StatusBadge(task, TerminalTone.NEUTRAL)
        }
        Text("Session ${session ?: "—"} · Arrival ${arrival ?: "—"}",
            style = MaterialTheme.typography.bodyMedium)
        Text("Worker ${workerName ?: "—"} · Station ${stationCode ?: "—"}",
            style = MaterialTheme.typography.bodyMedium, color = TerminalTokens.muted)
        if (submittedAt != null) Text("Sent $submittedAt",
            style = MaterialTheme.typography.bodySmall, color = TerminalTokens.muted)
    }
}

@Composable
private fun ReportTotals(state: com.ayrovi.worker.domain.ReceivingReportState) {
    val t = state.report?.totals ?: return
    TerminalPanel("TOTALS") {
        TotalsRow(
            Triple("EXPECTED", t.expectedUnits.toString(), Modifier.weight(1f)),
            Triple("SCANNED", t.scannedUnits.toString(), Modifier.weight(1f)),
            Triple("CONFIRMED", t.confirmedUnits.toString(), Modifier.weight(1f)),
        )
        TotalsRow(
            Triple("MISSING", t.missingUnits.toString(), Modifier.weight(1f)),
            Triple("DAMAGED", t.damagedUnits.toString(), Modifier.weight(1f)),
            Triple("CARTONS", "${t.receivedCartons}/${t.expectedCartons}", Modifier.weight(1f)),
        )
        Text("Products — confirmed ${t.confirmedProducts} · missing ${t.missingProducts} · " +
            "damaged ${t.damagedProducts} · expected ${t.expectedProducts}",
            style = MaterialTheme.typography.bodySmall, color = TerminalTokens.muted)
        if (t.missingCartons > 0) TerminalNotice("CARTONS MISSING",
            "${t.missingCartons} carton(s) not yet received.", TerminalTone.WARNING)
    }
}

@Composable
private fun TotalsRow(vararg cells: Triple<String, String, Modifier>) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.sm)) {
        cells.forEach { (label, value, modifier) -> QuantityDisplay(label, value, modifier) }
    }
}

@Composable
private fun ReportLines(
    state: com.ayrovi.worker.domain.ReceivingReportState,
    onDamage: (ReportLineView) -> Unit,
) {
    val lines = state.report?.lines.orEmpty()
    TaskInstruction("PRODUCTS", "${lines.size} expected product(s)")
    if (lines.isEmpty()) {
        TerminalPanel(null) {
            Text("No products on this session.", style = MaterialTheme.typography.bodyMedium,
                color = TerminalTokens.muted)
        }
        return
    }
    lines.forEach { line ->
        TerminalPanel(line.sku ?: line.reference ?: "PRODUCT") {
            Text(line.productName ?: "—", style = MaterialTheme.typography.titleMedium)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs),
                verticalAlignment = Alignment.CenterVertically) {
                StatusBadge(line.result ?: "PENDING", resultTone(line.result))
                if (!line.note.isNullOrBlank()) Text(line.note!!,
                    style = MaterialTheme.typography.bodySmall, color = TerminalTokens.muted,
                    modifier = Modifier.weight(1f))
            }
            TotalsRow(
                Triple("EXPECTED", line.expectedQuantity.toString(), Modifier.weight(1f)),
                Triple("SCANNED", line.scannedQuantity.toString(), Modifier.weight(1f)),
                Triple("CONFIRMED", line.confirmedQuantity.toString(), Modifier.weight(1f)),
            )
            TotalsRow(
                Triple("MISSING", line.missingQuantity.toString(), Modifier.weight(1f)),
                Triple("DAMAGED", line.damagedQuantity.toString(), Modifier.weight(1f)),
                Triple("REF", (line.reference ?: "—").take(12), Modifier.weight(1f)),
            )
            val max = (line.scannedQuantity - line.damagedQuantity).coerceAtLeast(0)
            if (state.canMutate && !line.receivingProductId.isNullOrBlank() && max > 0) {
                SecondaryAction("DECLARE DAMAGE", { onDamage(line) }, !state.loading)
            }
        }
    }
}

@Composable
private fun ReportManual(
    description: String, observation: String, editable: Boolean,
    onDescription: (String) -> Unit, onObservation: (String) -> Unit,
) {
    TerminalPanel("WORKER NOTES") {
        TerminalTextInput("DESCRIPTION", description, onDescription, enabled = editable)
        TerminalTextInput("OBSERVATION", observation, onObservation, enabled = editable)
        if (!editable) Text("Locked — notes cannot be changed.",
            style = MaterialTheme.typography.bodySmall, color = TerminalTokens.muted)
    }
}

@Composable
private fun ReportPhotos(
    state: com.ayrovi.worker.domain.ReceivingReportState,
    pendingUrls: List<String>, editable: Boolean,
    onCamera: () -> Unit, onGallery: () -> Unit, onRemovePending: (Int) -> Unit,
) {
    val persisted = state.report?.photos.orEmpty().mapNotNull { it.dataUrl?.takeIf { url -> url.isNotBlank() } }
    TerminalPanel("PHOTOS (${persisted.size + pendingUrls.size}/10)") {
        if (persisted.isEmpty() && pendingUrls.isEmpty()) {
            Text("No photos yet.", style = MaterialTheme.typography.bodyMedium, color = TerminalTokens.muted)
        } else {
            (persisted.map { it to null } + pendingUrls.mapIndexed { index, url -> url to index })
                .chunked(4).forEach { row ->
                    Row(horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
                        row.forEach { (url, pendingIndex) ->
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                PhotoThumb(url)
                                if (pendingIndex != null && editable) {
                                    SecondaryAction("REMOVE", { onRemovePending(pendingIndex) }, true,
                                        Modifier.width(72.dp))
                                }
                            }
                        }
                    }
                }
            if (pendingUrls.isNotEmpty()) Text(
                "${pendingUrls.size} waiting to send — SAVE DRAFT or CONFIRM & SEND keeps them.",
                style = MaterialTheme.typography.bodySmall, color = TerminalTokens.muted)
        }
        if (editable) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
                SecondaryAction("TAKE PHOTO", onCamera, true, Modifier.weight(1f).testTag("REPORT_PHOTO_CAMERA"))
                SecondaryAction("GALLERY", onGallery, true, Modifier.weight(1f).testTag("REPORT_PHOTO_GALLERY"))
            }
        }
    }
}

@Composable
private fun PhotoThumb(dataUrl: String) {
    val bitmap by produceState<Bitmap?>(initialValue = null, dataUrl) {
        value = withContext(Dispatchers.Default) { decodeThumb(dataUrl) }
    }
    Box(Modifier.size(72.dp).background(TerminalTokens.surface, MaterialTheme.shapes.small),
        contentAlignment = Alignment.Center) {
        val ready = bitmap
        if (ready != null) {
            Image(ready.asImageBitmap(), contentDescription = "Report photo",
                contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        } else {
            Text("…", color = TerminalTokens.muted)
        }
    }
}

private fun decodeThumb(dataUrl: String): Bitmap? = runCatching {
    val raw = dataUrl.substringAfter(",", "")
    if (raw.isEmpty()) return null
    val bytes = Base64.decode(raw, Base64.DEFAULT)
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= 144 && sample < 16) sample *= 2
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
}.getOrNull()

@Composable
private fun DamageDialog(line: ReportLineView, max: Int, onConfirm: (Int, String) -> Unit, onDismiss: () -> Unit) {
    var qty by remember(line.receivingProductId) { mutableIntStateOf(1) }
    var note by remember(line.receivingProductId) { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("DECLARE DAMAGE") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
                Text("${line.productName ?: line.sku} — at most $max of ${line.scannedQuantity} scanned.",
                    style = MaterialTheme.typography.bodyMedium)
                QuantityStepper(qty.toString(),
                    onMinus = { qty = (qty - 1).coerceAtLeast(1) },
                    onPlus = { qty = (qty + 1).coerceAtMost(max) },
                    minusEnabled = qty > 1, plusEnabled = qty < max)
                TerminalTextInput("NOTE (OPTIONAL)", note, { note = it })
            }
        },
        confirmButton = { DangerAction("RECORD $qty DAMAGED", { onConfirm(qty, note) }) },
        dismissButton = { SecondaryAction("CANCEL", onDismiss) },
    )
}

private fun reportTone(status: String): TerminalTone = when (status) {
    "SUBMITTED", "REVIEWED", "CLOSED" -> TerminalTone.SUCCESS
    "DRAFT" -> TerminalTone.INSTRUCTION
    else -> TerminalTone.NEUTRAL
}

private fun resultTone(result: String?): TerminalTone = when (result) {
    "CONFIRMED" -> TerminalTone.SUCCESS
    "MISSING" -> TerminalTone.WARNING
    "DAMAGED" -> TerminalTone.ERROR
    else -> TerminalTone.NEUTRAL
}
