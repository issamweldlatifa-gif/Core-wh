package com.ayrovi.worker.batch

import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter

/**
 * BATCH/UNIT LABEL ENCODER — v1.8 Phase 2 (feature/ayrovi-batch).
 *
 * PURE encoding only: a value in -> a QR matrix out + the human-readable
 * lines printed UNDER the code (the value itself + context). No android.*
 * imports, no UI: the screen/Print stage (Worker App phase) consumes this;
 * JVM tests verify a real ENCODE->DECODE roundtrip.
 *
 * Identity rules baked in here:
 *  - a UNIT label carries the AYROVI unit code (AYP-…) + the ORIGINAL
 *    barcode/SKU + customer + batch code as context lines;
 *  - a BATCH label carries the batch code (AYB-…) — the parcel identity.
 * The original identity is never replaced; MANUAL units simply have no
 * original line.
 */
object BatchBarcodeRenderer {

    /** One human-readable line under the QR: `LABEL: VALUE`. */
    data class LabelLine(val label: String, val value: String)

    /** The encoded label: QR matrix + the readable lines (value first). */
    data class Label(
        val value: String,
        /** QR matrix, [y][x], true = dark module (size × size). */
        val matrix: List<BooleanArray>,
        val size: Int,
        val lines: List<LabelLine>,
    )

    fun unitLabel(
        unitCode: String,
        originalBarcode: String?,
        originalSku: String?,
        customerName: String?,
        batchCode: String?,
    ): Label {
        require(unitCode.startsWith("AYP")) { "unit label needs an AYROVI unit code (AYP-…): $unitCode" }
        val lines = buildList {
            add(LabelLine("AYROVI UNIT", unitCode))
            originalBarcode?.takeIf { it.isNotBlank() }?.let { add(LabelLine("ORIGINAL BARCODE", it)) }
            originalSku?.takeIf { it.isNotBlank() }?.let { add(LabelLine("ORIGINAL SKU", it)) }
            customerName?.takeIf { it.isNotBlank() }?.let { add(LabelLine("CUSTOMER", it)) }
            batchCode?.takeIf { it.isNotBlank() }?.let { add(LabelLine("BATCH", it)) }
        }
        return encode(unitCode, lines)
    }

    fun batchLabel(batchCode: String, customerName: String?): Label {
        require(batchCode.startsWith("AYB")) { "batch label needs an AYROVI batch code (AYB-…): $batchCode" }
        val lines = buildList {
            add(LabelLine("AYROVI BATCH", batchCode))
            customerName?.takeIf { it.isNotBlank() }?.let { add(LabelLine("CUSTOMER", it)) }
        }
        return encode(batchCode, lines)
    }

    private fun encode(value: String, lines: List<LabelLine>): Label {
        val hints = mapOf(EncodeHintType.MARGIN to 1)
        val matrix = QRCodeWriter().encode(value, BarcodeFormat.QR_CODE, 0, 0, hints)
        val grid = List(matrix.height) { y -> BooleanArray(matrix.width) { x -> matrix.get(x, y) } }
        return Label(value, grid, matrix.width, lines)
    }
}
