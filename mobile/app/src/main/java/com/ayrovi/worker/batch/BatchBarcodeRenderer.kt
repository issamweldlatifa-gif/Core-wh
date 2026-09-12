package com.ayrovi.worker.batch

import com.google.zxing.BarcodeFormat
import com.google.zxing.oned.Code128Writer

/**
 * BATCH/UNIT LABEL ENCODER — v1.8-batch.7 (74), OWNER DECISION 2026-09-12:
 *
 * The label is a LINEAR BARCODE (CODE 128) of the AYROVI identity with the
 * identity itself printed beneath it as the human-readable number — NOTHING
 * else: no customer, no original-product info, no time, no address, no QR.
 * Every scanned unit already owns its unique serial identity (AYP-000000001,
 * AYP-000000002, …) so every printed barcode is different by construction.
 *
 * PURE encoding only (no android.*): the print stage consumes the matrix;
 * JVM tests verify a real ENCODE->DECODE roundtrip. The camera scanner is
 * ML Kit (reads CODE_128 natively) and the CT40 hardware scanner reads 1-D
 * symbologies natively — BATCH IN keeps scanning the printed labels.
 */
object BatchBarcodeRenderer {

    /** One row of [width] modules: true = dark bar (CODE 128 is 1-D). */
    data class Label(
        val value: String,
        val matrix: List<BooleanArray>,
        val width: Int,
        val height: Int,
    )

    /** Per-unit label: the unique AYROVI unit code (AYP-…). */
    fun unitLabel(unitCode: String): Label {
        require(unitCode.startsWith("AYP")) { "unit label needs an AYROVI unit code (AYP-…): $unitCode" }
        return encode(unitCode)
    }

    /** Parcel label: the batch code (AYB-…). */
    fun batchLabel(batchCode: String): Label {
        require(batchCode.startsWith("AYB")) { "batch label needs an AYROVI batch code (AYB-…): $batchCode" }
        return encode(batchCode)
    }

    private fun encode(value: String): Label {
        val m = Code128Writer().encode(value, BarcodeFormat.CODE_128, 0, 0)
        val row = BooleanArray(m.width) { x -> m.get(x, 0) }
        return Label(value, listOf(row), m.width, 1)
    }
}
