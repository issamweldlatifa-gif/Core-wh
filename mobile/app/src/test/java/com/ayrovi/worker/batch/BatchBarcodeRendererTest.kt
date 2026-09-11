package com.ayrovi.worker.batch

import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.common.GlobalHistogramBinarizer
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

    /**
     * Minimal LuminanceSource over the renderer's matrix, UPSCALED (each QR
     * module -> `scale` px, like a real printed/rendered label) and padded
     * with a white paper border. Binarizers are built for real images — on
     * 1px/module synthetic matrices their thresholds are unstable, which is
     * exactly the condition a broken label would face on paper; a scaled
     * roundtrip proves the ENCODED payload decodes to the exact identity.
     */
    private class MatrixSource(
        private val matrix: List<BooleanArray>,
        private val w: Int,
        private val h: Int,
        private val scale: Int = 4,
        private val border: Int = 8,
    ) : com.google.zxing.LuminanceSource(w * scale + 2 * border * scale, h * scale + 2 * border * scale) {
        private val tw = w * scale + 2 * border * scale

        private fun lum(x: Int, y: Int): Byte {
            if (x < border * scale || y < border * scale ||
                x >= border * scale + w * scale || y >= border * scale + h * scale
            ) return 255.toByte()
            return if (matrix[(y - border * scale) / scale][(x - border * scale) / scale]) 0.toByte() else 255.toByte()
        }

        override fun getRow(y: Int, row: ByteArray?): ByteArray {
            val r = row ?: ByteArray(tw)
            for (x in 0 until tw) r[x] = lum(x, y)
            return r
        }

        override fun getMatrix(): ByteArray {
            val m = ByteArray(tw * height)
            for (y in 0 until height) for (x in 0 until tw) m[y * tw + x] = lum(x, y)
            return m
        }

        override fun isCropSupported() = false
        override fun isRotateSupported() = false
    }

    private fun decode(label: BatchBarcodeRenderer.Label): String {
        val bitmap = BinaryBitmap(GlobalHistogramBinarizer(MatrixSource(label.matrix, label.size, label.size)))
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
