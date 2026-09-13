package com.ayrovi.worker.batch

import android.content.Context
import android.graphics.Paint
import android.graphics.pdf.PdfDocument
import android.os.Bundle
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.print.PageRange
import android.print.PrintAttributes
import android.print.PrintDocumentAdapter
import android.print.PrintDocumentInfo
import android.print.PrintManager
import kotlin.math.roundToInt

/**
 * BATCH LABEL PRINTING (Phase 2 worker app) — OWNER DECISION 2026-09-13:
 * **the printed page IS the label.** Product-style 60×40 mm stock (Design A
 * "retail classic" — chosen by the owner for mixed goods: clothes,
 * accessories, electronics, general products):
 *
 *   · CODE 128 bars 54×12 mm  (3 mm side margins -> guaranteed quiet zone)
 *   · the AYROVI identity 4 mm bold beneath the bars
 *   · NOTHING else on the label (v74 contract: no customer/product/time)
 *
 * GEOMETRY IS ABSOLUTE MILLIMETRES — never page proportions. The previous
 * renderer drew proportionally on a PrintedPdfDocument page; print services
 * that ignored the custom MediaSize produced huge portrait pages with a
 * stretched barcode and dead white space (owner floor screenshot). The PDF
 * is now written DIRECTLY with an explicit 60×40 mm page — every viewer and
 * printer sees exactly the label. Bars are vector rects, crisp at any DPI
 * (no bitmap resample). No label-printer SDK and no new dependency.
 */
object BatchLabelPrint {

    /** Label stock: 60×40 mm. PDF page units are points (1 pt = 1/72 in). */
    private const val LABEL_W_MM = 60
    private const val LABEL_H_MM = 40
    private fun mmToPt(mm: Float): Float = mm * 72f / 25.4f

    // Design A geometry (mm).
    private const val MARGIN_MM = 3f    // side margins -> 54mm bars, quiet zone kept
    private const val BAR_MM = 54f      // bar width
    private const val BAR_H_MM = 12f    // bar height
    private const val NUM_MM = 4f       // identity digit size (bold)
    private const val TOP_MM = 11f      // block top: bars + number visually centred
    private const val GAP_MM = 4.2f     // bars -> number baseline

    // Job attributes: a concrete media size is REQUIRED by the spooler (v73
    // fix); the PDF page geometry itself no longer depends on it.
    private val LABEL_ATTRIBUTES: PrintAttributes = PrintAttributes.Builder()
        .setMediaSize(PrintAttributes.MediaSize("ayb_label", "AYROVI Label 60x40", 2362, 1575))
        .setResolution(PrintAttributes.Resolution("ayb_300", "AYROVI 300dpi", 300, 300))
        .setColorMode(PrintAttributes.COLOR_MODE_MONOCHROME)
        .setMinMargins(PrintAttributes.Margins(0, 0, 0, 0))
        .build()

    /** Open the system print dialog with one unit label per page. */
    fun printUnitLabels(context: Context, labels: List<BatchBarcodeRenderer.Label>, jobName: String) {
        if (labels.isEmpty()) return
        val printManager = context.getSystemService(Context.PRINT_SERVICE) as PrintManager
        printManager.print(jobName, UnitLabelAdapter(labels), LABEL_ATTRIBUTES)
    }

    private class UnitLabelAdapter(
        private val labels: List<BatchBarcodeRenderer.Label>,
    ) : PrintDocumentAdapter() {

        override fun onLayout(
            oldAttributes: PrintAttributes?,
            newAttributes: PrintAttributes,
            cancellationSignal: CancellationSignal?,
            callback: LayoutResultCallback,
            extras: Bundle?,
        ) {
            if (cancellationSignal?.isCanceled == true) {
                callback.onLayoutCancelled()
                return
            }
            val info = PrintDocumentInfo.Builder("ayrovi-unit-labels.pdf")
                .setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT)
                .setPageCount(labels.size)
                .build()
            callback.onLayoutFinished(info, newAttributes != oldAttributes)
        }

        override fun onWrite(
            requested: Array<out PageRange>,
            destination: ParcelFileDescriptor,
            cancellationSignal: CancellationSignal?,
            callback: WriteResultCallback,
        ) {
            // Label jobs are tiny — write EVERY page and report ALL_PAGES (the
            // PageRange(String) constructor is package-private to Kotlin).
            runCatching {
                val doc = PdfDocument()
                try {
                    for ((index, label) in labels.withIndex()) {
                        if (cancellationSignal?.isCanceled == true) {
                            callback.onWriteCancelled()
                            return
                        }
                        val page = doc.startPage(
                            PdfDocument.PageInfo.Builder(
                                mmToPt(LABEL_W_MM.toFloat()).roundToInt(),
                                mmToPt(LABEL_H_MM.toFloat()).roundToInt(),
                                index + 1,
                            ).create()
                        )
                        renderLabel(page, label)
                        doc.finishPage(page)
                    }
                    doc.writeTo(java.io.FileOutputStream(destination.fileDescriptor))
                } finally {
                    doc.close()
                }
                callback.onWriteFinished(arrayOf(PageRange.ALL_PAGES))
            }.onFailure {
                callback.onWriteFailed(it.message ?: "Label rendering failed.")
            }
        }

        /**
         * Design A — absolute-mm layout on the 60×40 mm page: vector CODE 128
         * bars 54×12 mm at (3mm, 11mm); the identity 4 mm bold centred under
         * the bars. The barcode encodes exactly [label.value] (roundtrip-
         * tested in BatchBarcodeRendererTest) — scanners read the same AYP
         * the server knows.
         */
        private fun renderLabel(page: PdfDocument.Page, label: BatchBarcodeRenderer.Label) {
            val canvas = page.canvas
            val left = mmToPt(MARGIN_MM)
            val top = mmToPt(TOP_MM)
            val barW = mmToPt(BAR_MM)
            val barH = mmToPt(BAR_H_MM)
            val module = barW / label.width

            val dark = Paint().apply { color = android.graphics.Color.BLACK }
            val row = label.matrix[0]
            for (x in 0 until label.width) {
                if (row[x]) {
                    canvas.drawRect(left + x * module, top, left + (x + 1) * module, top + barH, dark)
                }
            }

            val num = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = android.graphics.Color.BLACK
                textAlign = Paint.Align.CENTER
                textSize = mmToPt(NUM_MM)
                isFakeBoldText = true
            }
            canvas.drawText(label.value, mmToPt(LABEL_W_MM / 2f), top + barH + mmToPt(GAP_MM), num)
        }
    }
}
