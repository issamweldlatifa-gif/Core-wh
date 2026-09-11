package com.ayrovi.worker.batch

import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import org.junit.jupiter.api.Test

/**
 * Phase 2 contract on-device encoding: the printed label MUST decode back to
 * the exact AYROVI identity it was generated from (a label that does not
 * scan is a broken label). Pure JVM roundtrip via zxing core.
 */
class BatchBarcodeRendererTest {

    /** Minimal LuminanceSource over the renderer's boolean matrix. */
    private class MatrixSource(
        private val matrix: List<BooleanArray>,
        private val w: Int,
        private val h: Int,
    ) : com.google.zxing.LuminanceSource(w, h) {
        override fun getRow(y: Int, row: ByteArray?): ByteArray {
            val r = row ?: ByteArray(w)
            for (x in 0 until w) r[x] = if (matrix[y][x]) 0 else 255.toByte()
            return r
        }

        override fun getMatrix(): ByteArray {
            val m = ByteArray(w * h)
            for (y in 0 until h) for (x in 0 until w) m[y * w + x] = if (matrix[y][x]) 0 else 255.toByte()
            return m
        }

        override fun isCropSupported() = false
        override fun isRotateSupported() = false
    }

    private fun decode(label: BatchBarcodeRenderer.Label): String {
        val bitmap = BinaryBitmap(HybridBinarizer(MatrixSource(label.matrix, label.size, label.size)))
        val result = QRCodeReader().decode(bitmap, mapOf(DecodeHintType.TRY_HARDER to true))
        return result.text
    }

    @Test
    fun `unit label roundtrips the AYROVI unit identity`() {
        val label = BatchBarcodeRenderer.unitLabel(
            "AYP-000000123",
            originalBarcode = "5901234567890",
            originalSku = "SB123",
            customerName = "Ahmed Akrmi",
            batchCode = "AYB-20260911-00001",
        )
        assertEquals("AYP-000000123", decode(label))
        // The human-readable block under the code carries value + context:
        val values = label.lines.map { "${it.label}: ${it.value}" }
        assertTrue(values.contains("AYROVI UNIT: AYP-000000123"))
        assertTrue(values.contains("ORIGINAL BARCODE: 5901234567890"))
        assertTrue(values.contains("CUSTOMER: Ahmed Akrmi"))
        assertTrue(values.contains("BATCH: AYB-20260911-00001"))
    }

    @Test
    fun `batch label roundtrips the batch code`() {
        val label = BatchBarcodeRenderer.batchLabel("AYB-20260911-00025", "Ahmed Akrmi")
        assertEquals("AYB-20260911-00025", decode(label))
    }

    @Test
    fun `manual unit has NO invented original lines`() {
        val label = BatchBarcodeRenderer.unitLabel("AYP-000000124", null, null, "Client X", null)
        assertEquals("AYP-000000124", decode(label))
        assertFalse(label.lines.any { it.label.startsWith("ORIGINAL") })
    }

    @Test
    fun `unit labels refuse non-AYP codes`() {
        assertFailsWith<IllegalArgumentException> {
            BatchBarcodeRenderer.unitLabel("SKU-123", null, null, null, null)
        }
    }
}
