package com.ayrovi.worker.scanner

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SkuTemplateTest {
    @Test
    fun acceptsSegmentedCode() {
        assertEquals(0.97, SkuTemplate.score("SKU-TEST-001", 1.0))
        assertEquals("SKU", SkuTemplate.id)
    }

    @Test
    fun rejectsQuantitiesShortNoiseAndMergedGarbage() {
        assertNull(SkuTemplate.score("12345", 0.6), "pure digits are quantities, never codes")
        assertNull(SkuTemplate.score("QTY", 0.9), "3-char tokens are noise-prone")
        assertNull(SkuTemplate.score("A".repeat(41), 0.7), "merged reads are garbage")
    }

    @Test
    fun bareWordsScoreBelowSegmentedCodes() {
        val word = SkuTemplate.score("CARTON", 0.9)!!
        val code = SkuTemplate.score("CTN-TEST", 0.9)!!
        assertTrue(code > word, "segmented $code must beat bare word $word")
    }
}

class CompactSkuTemplateTest {
    @Test
    fun idAndShape() {
        assertEquals("COMPACT_SKU", CompactSkuTemplate.id)
        assertEquals("Product SKU", CompactSkuTemplate.label)
    }

    @Test
    fun acceptsTheStrictSShape() {
        // s + letter + 1..20 digits (case-insensitive, as the OCR normalizer
        // uppercases reads and matching is case-insensitive).
        assertNotNull(CompactSkuTemplate.score("sb25092090066487374", 0.9), "the warehouse product code shape")
        assertNotNull(CompactSkuTemplate.score("SB25092090066487374", 0.9), "uppercased read")
        assertNotNull(CompactSkuTemplate.score("sz1", 1.0), "one digit minimum")
        assertNotNull(CompactSkuTemplate.score("sz12345678901234567890", 0.9), "twenty digits maximum")
    }

    @Test
    fun rejectsNonSShapes() {
        // Quantities, bare words, segmented codes and other shapes are rejected.
        assertNull(CompactSkuTemplate.score("12345", 0.9), "quantities are never product codes")
        assertNull(CompactSkuTemplate.score("CARTON", 0.9), "bare words are not the s shape")
        assertNull(CompactSkuTemplate.score("SKU-TEST-001", 0.9), "segmented codes are not the s shape")
        assertNull(CompactSkuTemplate.score("ABC123", 0.9), "must start with s then a letter")
        assertNull(CompactSkuTemplate.score("sa", 0.9), "at least one digit required")
        assertNull(CompactSkuTemplate.score("s", 0.9), "no digits after the letter")
        assertNull(CompactSkuTemplate.score("sa123456789012345678901", 0.9), "more than twenty digits rejected")
        assertNull(CompactSkuTemplate.score("s1b", 0.9), "digit must follow the first letter")
    }

    @Test
    fun scoresHighButNeverFullConfidence() {
        val score = CompactSkuTemplate.score("sz42", 1.0)!!
        assertTrue(score <= 0.97, "template output stays under 1.0 (OCR is a suggestion)")
        assertTrue(score >= 0.9)
    }
}

class DirectedOcrTest {
    private val compact = DirectedOcr() // default template is now the strict product SKU shape
    private val generic = DirectedOcr(SkuTemplate) // multi-purpose segmented reads

    @Test
    fun defaultTemplateIsTheCompactSkuShape() {
        val result = compact.read("AYROVI LOGISTICS\nsb25092090066487374\nQTY 24")
        assertEquals("COMPACT_SKU", result.templateId)
        // OCR normalises to uppercase before scoring, so the candidate is uppercase.
        assertEquals("SB25092090066487374", result.candidate)
        assertEquals(3, result.linesRead)
        assertFalse(result.confirmed, "OCR output is a suggestion until the operator confirms")
    }

    @Test
    fun compactReaderRejectsASegmentedReadFromItsOwnLabelNoise() {
        // The strict template ignores lines that are not the compact s-shape.
        assertNull(compact.read("CARTON\nQTY 24").candidate)
    }

    @Test
    fun genericReaderFindsSkuOnSecondLineOfMultilineBlock() {
        val result = generic.read("AYROVI LOGISTICS\nSKU-TEST-001\nQTY 24")
        assertEquals("SKU", result.templateId)
        assertEquals("SKU-TEST-001", result.candidate)
        assertEquals(0.97, result.confidence)
        assertEquals(3, result.linesRead)
        assertFalse(result.confirmed)
    }

    @Test
    fun genericReaderPrefersSegmentedCodeOverBareWord() {
        val result = generic.read("CARTON\nCTN-TEST")
        assertEquals("CTN-TEST", result.candidate)
        assertTrue(result.alternatives.contains("CARTON"))
    }

    @Test
    fun readEmptyOrNoiseBlockYieldsNoCandidate() {
        assertNull(compact.read("").candidate)
        assertNull(compact.read("???\n!!!").candidate)
        assertEquals(0.0, compact.read("").confidence)
    }

    @Test
    fun readBelowGateYieldsNoCandidateButListsAlternatives() {
        val strict = DirectedOcr(template = SkuTemplate, minConfidence = 0.95)
        val result = strict.read("CARTON")
        assertNull(result.candidate)
        assertEquals(listOf("CARTON"), result.alternatives)
    }

    @Test
    fun confirmedByOperatorGatesSubmission() {
        val found = compact.read("sb25092090066487374")
        assertFalse(found.confirmed)
        assertTrue(found.confirmedByOperator().confirmed)
        val missing = compact.read("???")
        assertFalse(missing.confirmedByOperator().confirmed, "nothing to confirm without a candidate")
    }
}

class DeviceScanModesTest {
    @Test
    fun bothDevicesAreBarcodeFirstWithOcrFallback() {
        listOf(WorkerDevice.PHONE, WorkerDevice.CT40).forEach { device ->
            assertEquals(listOf(CaptureMode.BARCODE, CaptureMode.OCR), DeviceScanModes.modes(device))
            assertEquals(CaptureMode.BARCODE, DeviceScanModes.primary(device))
            assertTrue(DeviceScanModes.supportsOcr(device))
        }
    }

    @Test
    fun ocrIsExplicitFallbackOnCt40Only() {
        assertFalse(DeviceScanModes.ocrIsFallback(WorkerDevice.PHONE))
        assertTrue(DeviceScanModes.ocrIsFallback(WorkerDevice.CT40))
    }
}
