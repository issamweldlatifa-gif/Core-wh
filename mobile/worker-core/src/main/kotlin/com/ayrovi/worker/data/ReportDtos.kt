package com.ayrovi.worker.data

import kotlinx.serialization.Serializable

// ---------------- CONFIRMATION REPORT (ORDER 01 verification report) ----------------
// Mirrors GET /v1/receiving/sessions/{id}/report. Unknown keys are ignored by
// the transport, so the admin-only submit extras (e.g. notifiedAdmins) decode
// into the same view.
@Serializable data class ReportSessionView(
    val id: String,
    val code: String? = null,
    val status: String? = null,
    val startedAt: String? = null,
    val completedAt: String? = null,
    val deviceType: String? = null,
    val deviceName: String? = null,
)
@Serializable data class ReportArrivalView(
    val id: String? = null,
    val code: String? = null,
    val customerName: String? = null,
    val storeName: String? = null,
    val status: String? = null,
)
@Serializable data class ReportTotals(
    val expectedProducts: Int = 0,
    val confirmedProducts: Int = 0,
    val missingProducts: Int = 0,
    val damagedProducts: Int = 0,
    val expectedUnits: Int = 0,
    val scannedUnits: Int = 0,
    val confirmedUnits: Int = 0,
    val missingUnits: Int = 0,
    val damagedUnits: Int = 0,
    val expectedCartons: Int = 0,
    val receivedCartons: Int = 0,
    val missingCartons: Int = 0,
)
@Serializable data class ReportLineView(
    val receivingProductId: String? = null,
    val sku: String? = null,
    val reference: String? = null,
    val productName: String? = null,
    val expectedQuantity: Int = 0,
    val scannedQuantity: Int = 0,
    val confirmedQuantity: Int = 0,
    val missingQuantity: Int = 0,
    val damagedQuantity: Int = 0,
    val result: String? = null,
    val note: String? = null,
)
@Serializable data class ReportManualView(
    val description: String? = null,
    val observation: String? = null,
)
@Serializable data class ReportPhotoView(
    val id: String? = null,
    val lineId: String? = null,
    val dataUrl: String? = null,
    val caption: String? = null,
    val takenBy: String? = null,
    val takenAt: String? = null,
)
@Serializable data class ReportActorView(
    val workerId: String? = null,
    val workerName: String? = null,
    val stationId: String? = null,
    val stationCode: String? = null,
    val deviceType: String? = null,
    val deviceName: String? = null,
)
@Serializable data class ReceivingReportView(
    val session: ReportSessionView,
    val arrival: ReportArrivalView? = null,
    val taskStatus: String? = null,
    val reportStatus: String = "NONE",
    val reportId: String? = null,
    val totals: ReportTotals = ReportTotals(),
    val lines: List<ReportLineView> = emptyList(),
    val manual: ReportManualView? = null,
    val photos: List<ReportPhotoView> = emptyList(),
    val actor: ReportActorView? = null,
    val submittedAt: String? = null,
    val reviewedAt: String? = null,
    val closedAt: String? = null,
    val reviewNote: String? = null,
    val handoffReadyAt: String? = null,
)
@Serializable data class LineVerificationView(
    val scanned: Int = 0,
    val confirmed: Int = 0,
    val missing: Int = 0,
    val damaged: Int = 0,
    val result: String? = null,
)
@Serializable data class DamageResultView(
    val lineId: String? = null,
    val verification: LineVerificationView? = null,
)

/** Photo payload for draft/submit (full-set replace semantics server-side). */
data class ReportPhotoInput(
    val dataUrl: String,
    val caption: String? = null,
    val lineId: String? = null,
)
