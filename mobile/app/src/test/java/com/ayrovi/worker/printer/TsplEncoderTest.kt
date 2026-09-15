package com.ayrovi.worker.printer

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.test.fail

class TsplEncoderTest {

    @Test
    fun `test label golden - exact TSPL II bytes`() {
        val bytes = TsplEncoder.encode(
            TsplEncoder.testLabel("PM-241-BT", "2026-09-15T10:00:00"),
            printerName = "PM-241-BT",
        )
        val text = bytes.toString(Charsets.US_ASCII)
        val expected = listOf(
            "SIZE 76 mm,60 mm",
            "GAP 2 mm,0",
            "DIRECTION 1,0",
            "REFERENCE 0,0",
            "SET TEAR 2",
            "CLS",
            "TEXT 24,24,'3',0,2,2,\"PRINTER TEST\"",
            "TEXT 24,96,'3',0,1,1,\"PM-241-BT\"",
            "TEXT 24,144,'3',0,1,1,\"WAREHOUSE ADMIN\"",
            "TEXT 24,192,'3',0,1,1,\"CONNECTION OK\"",
            "TEXT 24,240,'3',0,1,1,\"2026-09-15\"",
            "QRCODE 24,288,M,4,A,0,M2,\"PRINTER_TEST_PM241BT|2026-09-15T10:00:00\"",
            "PRINT 1,1",
        ).joinToString("\r\n", postfix = "\r\n")
        assertEquals(expected, text)
    }

    @Test
    fun `qr label keeps customer container section and payload (S10)`() {
        val bytes = TsplEncoder.encode(
            LabelSpec(
                customerName = "AHMED",
                containerCode = "C-0042",
                section = "A",
                qrPayload = "C-0042",
            ),
        )
        val text = bytes.toString(Charsets.US_ASCII)
        assertTrue(text.contains("\"CUSTOMER: AHMED\""))
        assertTrue(text.contains("\"CONTAINER: C-0042\""))
        assertTrue(text.contains("\"SECTION: A\""))
        assertTrue(text.contains("QRCODE"))
        assertTrue(text.contains("\"C-0042\""))
    }

    @Test
    fun `barcode label has NO QR (S11 - separate functions)`() {
        val bytes = TsplEncoder.encode(LabelSpec(barcodeValue = "K1"))
        val text = bytes.toString(Charsets.US_ASCII)
        assertTrue(text.contains("BARCODE 24,"))
        assertFalse("QRCODE" in text)
    }

    @Test
    fun `quotes and backslashes are TSPL-escaped, non-ascii sanitized`() {
        val bytes = TsplEncoder.encode(LabelSpec(lines = listOf("say \"hi\"\\"), qrPayload = "k\"\u0645"))
        val text = bytes.toString(Charsets.US_ASCII)
        assertTrue(text.contains("\"say \\\"hi\\\"\\\\\""))
        assertTrue(text.contains("k\\\"?"))
    }

    @Test
    fun `out of range media is rejected before any wire bytes exist`() {
        try {
            TsplEncoder.encode(LabelSpec(widthMm = 200))
            fail("width 200mm must be rejected")
        } catch (e: IllegalArgumentException) {
            assertTrue("width" in e.message!!)
        }
    }

}
