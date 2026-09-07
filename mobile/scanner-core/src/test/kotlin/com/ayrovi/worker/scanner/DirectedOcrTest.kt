package com.ayrovi.worker.scanner

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
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

class DirectedOcrTest {
    private val ocr = DirectedOcr()

    @Test
    fun readFindsSkuOnSecondLineOfMultilineBlock() {
        val result = ocr.read("AYROVI LOGISTICS\nSKU-TEST-001\nQTY 24")
        assertEquals("SKU", result.templateId)
        assertEquals("SKU-TEST-001", result.candidate)
        assertEquals(0.97, result.confidence)
        assertEquals(3, result.linesRead)
        assertFalse(result.confirmed, "OCR output is a suggestion until the operator confirms")
    }

    @Test
    fun readPrefersSegmentedCodeOverBareWord() {
        val result = ocr.read("CARTON\nCTN-TEST")
        assertEquals("CTN-TEST", result.candidate)
        assertTrue(result.alternatives.contains("CARTON"))
    }

    @Test
    fun readEmptyOrNoiseBlockYieldsNoCandidate() {
        assertNull(ocr.read("").candidate)
        assertNull(ocr.read("???\n!!!").candidate)
        assertEquals(0.0, ocr.read("").confidence)
    }

    @Test
    fun readBelowGateYieldsNoCandidateButListsAlternatives() {
        val strict = DirectedOcr(minConfidence = 0.95)
        val result = strict.read("CARTON")
        assertNull(result.candidate, "0.81 must not pass a 0.95 gate")
        assertEquals(listOf("CARTON"), result.alternatives)
    }

    @Test
    fun confirmedByOperatorGatesSubmission() {
        val found = ocr.read("SKU-TEST-001")
        assertFalse(found.confirmed)
        assertTrue(found.confirmedByOperator().confirmed)
        val missing = ocr.read("???")
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
