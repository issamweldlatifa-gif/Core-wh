package com.ayrovi.worker.printer

/**
 * TSPL II command generation (task §5/§16) — PURE string building, no
 * Android imports, golden-tested.
 *
 * PROTOCOL VERIFICATION (owner task §5): the PM-241-BT is a Phomemo /
 * LabeLife-family (Aimo/Quyin OEM) thermal label printer. That family ships
 * two wire engines; the Bluetooth-Classic engine is TSPL II over RFCOMM
 * (the open `thermal-label/labelife` driver suite documents the family as
 * "TSPL II … tspl-c1 (RFCOMM-only)" for ~76 models incl. Phomemo; the
 * community PM-241-BT repo prints via OS drivers, i.e. inconclusive at the
 * raw-byte level — the REAL acceptance print on hardware is the final
 * verification step). ESC/POS is deliberately NOT assumed; the generator
 * is isolated behind [LabelSpec] so an alternate engine can slot in.
 *
 * Wire notes: CRLF line endings, 203 dpi head (8 dots/mm), ASCII-safe text
 * (non-ASCII sanitized to '?'), values quoted + escaped.
 */
object TsplEncoder {

    /** Printable-ASCII sanitizer for TEXT/BARCODE/QR payloads. */
    fun sanitize(value: String): String = buildString(value.length) {
        for (ch in value) {
            append(if (ch.code in 0x20..0x7E) ch else '?')
        }
    }

    /** TSPL quoting: backslash and double quote escaped, then wrapped. */
    private fun q(value: String): String = "\"${value.replace("\\", "\\\\").replace("\"", "\\\"")}\""

    /** One TSPL command line with CRLF. */
    private fun line(sb: StringBuilder, cmd: String) {
        sb.append(cmd).append("\r\n")
    }

    /**
     * Encode a full label. Vertical FLOW layout (dots = mm × 8): title
     * (2× font) → text lines → customer/container/section → QR (4-dot
     * cells ≈ 12 mm) → CODE128 (80-dot ≈ 10 mm bars). Every block stacks
     * strictly below the previous one — no overlap at any data combination.
     */
    fun encode(spec: LabelSpec, printerName: String? = null, dotsPerMm: Int = 8): ByteArray {
        require(spec.widthMm in 20..104) { "label width out of PM-241 range" }
        require(spec.heightMm in 15..200) { "label height out of range" }
        val dot = { mm: Int -> mm * dotsPerMm }
        val sb = StringBuilder(512)
        line(sb, "SIZE ${spec.widthMm} mm,${spec.heightMm} mm")
        line(sb, "GAP ${spec.gapMm} mm,0")
        line(sb, "DIRECTION 1,0")
        line(sb, "REFERENCE 0,0")
        line(sb, "SET TEAR 2")
        line(sb, "CLS")

        var y = dot(3)
        val x = dot(3)
        spec.title?.let { title ->
            line(sb, "TEXT $x,$y,'3',0,2,2,${q(sanitize(title))}")
            y += dot(9)
        }
        for (raw in spec.lines) {
            line(sb, "TEXT $x,$y,'3',0,1,1,${q(sanitize(raw))}")
            y += dot(6)
        }
        spec.customerName?.let { line(sb, "TEXT $x,$y,'3',0,1,1,${q(sanitize("CUSTOMER: $it"))}"); y += dot(6) }
        spec.containerCode?.let { line(sb, "TEXT $x,$y,'3',0,1,1,${q(sanitize("CONTAINER: $it"))}"); y += dot(6) }
        spec.section?.let { line(sb, "TEXT $x,$y,'3',0,1,1,${q(sanitize("SECTION: $it"))}"); y += dot(6) }

        if (y < dot(3)) y = dot(3)
        spec.qrPayload?.let { payload ->
            line(sb, "QRCODE $x,$y,M,4,A,0,M2,${q(sanitize(payload))}")
            y += dot(16)
        }
        spec.barcodeValue?.let { value ->
            line(sb, "BARCODE $x,$y,'128',${dot(10)},1,0,2,2,${q(sanitize(value))}")
        }
        line(sb, "PRINT 1,1")
        return sb.toString().toByteArray(Charsets.US_ASCII)
    }

    /** §13 test label (76×60 mm): title + printer + admin + OK + date, then
     *  the QR of the test payload — the payload value is the QR content. */
    fun testLabel(printerName: String, dateIso: String): LabelSpec = LabelSpec(
        title = "PRINTER TEST",
        lines = listOf(
            printerName,
            "WAREHOUSE ADMIN",
            "CONNECTION OK",
            dateIso.take(10),
        ),
        qrPayload = "PRINTER_TEST_PM241BT|$dateIso",
        widthMm = 76,
        heightMm = 60,
    )
}
