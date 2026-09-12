package com.ayrovi.worker.batch

import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.common.GlobalHistogramBinarizer
import com.google.zxing.oned.Code128Reader
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.jupiter.api.Test

/**
 * OWNER LABEL CONTRACT (2026-09-12) on-device encoding: the printed label is
 * a LINEAR CODE 128 barcode of the AYROVI identity with the identity printed
 * beneath it — the printed label MUST decode back to the exact code it was
 * generated from (a label that does not scan is a broken label). Pure JVM
 * roundtrip via zxing core.
 */
class BatchBarcodeRendererTest {

    /**
     * LuminanceSource over the renderer's 1-row matrix, UPSCALED (each module
     * -> `scale` px wide, the row replicated `rows` px tall) with a white
     * paper border — real-image conditions for the binarizer, exactly what a
     * printed/pictured label faces.
     */
    private class MatrixSource(
        private val label: BatchBarcodeRenderer.Label,
        private val scale: Int = 3,
        private val rows: Int = 60,
        private val border: Int = 12,
    ) : com.google.zxing.LuminanceSource(label.width * scale + 2 * border * scale, rows + 2 * border * scale) {
        private val tw = label.width * scale + 2 * border * scale
        private val th = height

        private fun dark(x: Int, y: Int): Boolean {
            if (x < border * scale || x >= border * scale + label.width * scale) return false
            if (y < border * scale || y >= th - border * scale) return false
            return label.matrix[0][(x - border * scale) / scale]
        }

        override fun getRow(y: Int, row: ByteArray?): ByteArray {
            val r = row ?: ByteArray(tw)
            for (x in 0 until tw) r[x] = if (dark(x, y)) 0.toByte() else 255.toByte()
            return r
        }

        override fun getMatrix(): ByteArray {
            val m = ByteArray(tw * th)
            for (y in 0 until th) for (x in 0 until tw) m[y * tw + x] = if (dark(x, y)) 0.toByte() else 255.toByte()
            return m
        }

        override fun isCropSupported() = false
        override fun isRotateSupported() = false
    }

    private fun decode(label: BatchBarcodeRenderer.Label): String {
        val bitmap = BinaryBitmap(GlobalHistogramBinarizer(MatrixSource(label)))
        val result = Code128Reader().decode(bitmap, mapOf(DecodeHintType.TRY_HARDER to true))
        return result.text
    }

    @Test
    fun unit_label_is_a_CODE128_of_the_exact_AYROVI_unit_identity() {
        val label = BatchBarcodeRenderer.unitLabel("AYP-000000123")
        assertEquals("AYP-000000123", decode(label))
        // The printed number beneath the bars IS the identity itself.
        assertEquals("AYP-000000123", label.value)
    }

    @Test
    fun batch_label_is_a_CODE128_of_the_exact_batch_code() {
        val label = BatchBarcodeRenderer.batchLabel("AYB-20260912-00001")
        assertEquals("AYB-20260912-00001", decode(label))
    }

    @Test
    fun every_unit_gets_a_DIFFERENT_barcode_owner_rule() {
        val a = BatchBarcodeRenderer.unitLabel("AYP-000000001")
        val b = BatchBarcodeRenderer.unitLabel("AYP-000000002")
        assertFalse(a.matrix[0].contentEquals(b.matrix[0]))
        assertEquals("AYP-000000001", decode(a))
        assertEquals("AYP-000000002", decode(b))
    }

    @Test
    fun labels_refuse_non_AYROVI_codes() {
        assertFailsWith<IllegalArgumentException> { BatchBarcodeRenderer.unitLabel("SKU-123") }
        assertFailsWith<IllegalArgumentException> { BatchBarcodeRenderer.batchLabel("AYP-000000001") }
    }
}
