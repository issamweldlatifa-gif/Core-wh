package com.ayrovi.worker.batch

import android.content.Context
import android.graphics.Color
import android.os.Bundle
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.print.PageRange
import android.print.PrintAttributes
import android.print.PrintDocumentAdapter
import android.print.PrintDocumentInfo
import android.print.PrintManager
import android.print.pdf.PrintedPdfDocument

/**
 * BATCH LABEL PRINTING (Phase 2 worker app) — the command's print path
 * default: Android Print Framework. One PDF page per unit label:
 * the AYROVI identity (AYP QR from BatchBarcodeRenderer) + the readable
 * lines under it (original barcode/SKU verbatim, customer, batch).
 * No label-printer SDK and no new dependency — every system print service
 * (including "Save as PDF") is reachable from the print dialog.
 */
object BatchLabelPrint {

    // v73 (owner bug: print spooler crashed with "MediaSize.getWidthMils() on a
    // null object reference"): the print system REQUIRES a concrete media size —
    // the spooler and "Save as PDF" read it before our adapter lays anything
    // out. Default-built PrintAttributes carry a NULL MediaSize. One shared
    // labeled set for both the print job and PrintedPdfDocument (60×40 mm
    // label stock; 1 mm = 1000/25.4 mils).
    private val LABEL_ATTRIBUTES: PrintAttributes = PrintAttributes.Builder()
        .setMediaSize(PrintAttributes.MediaSize("ayb_label", "AYROVI Label", 2362, 1575))
        .setResolution(PrintAttributes.Resolution("ayb_300", "AYROVI 300dpi", 300, 300))
        .setColorMode(PrintAttributes.COLOR_MODE_MONOCHROME)
        .setMinMargins(PrintAttributes.Margins(0, 0, 0, 0))
        .build()

    /** Open the system print dialog with one unit label per page. */
    fun printUnitLabels(context: Context, labels: List<BatchBarcodeRenderer.Label>, jobName: String) {
        if (labels.isEmpty()) return
        val printManager = context.getSystemService(Context.PRINT_SERVICE) as PrintManager
        printManager.print(jobName, UnitLabelAdapter(context.applicationContext, labels, LABEL_ATTRIBUTES), LABEL_ATTRIBUTES)
    }

    private class UnitLabelAdapter(
        private val context: Context,
        private val labels: List<BatchBarcodeRenderer.Label>,
        private val pdfAttributes: PrintAttributes,
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
            // Label jobs are tiny — write EVERY page regardless of the
            // requested subset and report ALL_PAGES (the PageRange(String)
            // constructor is package-private to Kotlin and cannot be called
            // from here).
            runCatching {
                java.io.FileOutputStream(destination.fileDescriptor).use { out ->
                    val doc = PrintedPdfDocument(context, pdfAttributes)
                    for (index in labels.indices) {
                        if (cancellationSignal?.isCanceled == true) {
                            callback.onWriteCancelled()
                            return
                        }
                        val page = doc.startPage(index + 1)
                        renderLabel(page, labels[index])
                        doc.finishPage(page)
                    }
                    doc.writeTo(out)
                    doc.close()
                }
                callback.onWriteFinished(arrayOf(PageRange.ALL_PAGES))
            }.onFailure {
                callback.onWriteFailed(it.message ?: "Label rendering failed.")
            }
        }



        /** CODE 128 matrix (one module row) -> white-background bitmap:
         * each module becomes a FULL-HEIGHT vertical bar (modulePx px wide,
         * barHeightPx tall). The renderer stays android-free; pixels live on
         * the print side. */
        private fun bitmapFor(label: BatchBarcodeRenderer.Label, modulePx: Int, barHeightPx: Int): android.graphics.Bitmap {
            val bitmap = android.graphics.Bitmap.createBitmap(label.width * modulePx, barHeightPx, android.graphics.Bitmap.Config.RGB_565)
            bitmap.eraseColor(Color.WHITE)
            val dark = android.graphics.Paint()
            dark.color = Color.BLACK
            val canvas = android.graphics.Canvas(bitmap)
            val row = label.matrix[0]
            for (x in 0 until label.width) {
                if (row[x]) {
                    canvas.drawRect(
                        (x * modulePx).toFloat(), 0f,
                        ((x + 1) * modulePx).toFloat(), barHeightPx.toFloat(),
                        dark,
                    )
                }
            }
            return bitmap
        }

        private fun renderLabel(page: android.graphics.pdf.PdfDocument.Page, label: BatchBarcodeRenderer.Label) {
            // OWNER LABEL CONTRACT (2026-09-12): the barcode + its number
            // beneath it — nothing else on the page.
            val canvas = page.canvas
            val content = page.info.contentRect
            val pageWidth = content.width().toFloat()
            val pageHeight = content.height().toFloat()
            val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)

            // Bars: ~92% of the page width, vertically centered upper-third.
            val barW = pageWidth * 0.92f
            val barH = pageHeight * 0.30f
            val modulePx = (barW / label.width).toInt().coerceAtLeast(2)
            val left = (pageWidth - label.width * modulePx) / 2f
            val top = pageHeight * 0.22f
            val bars = bitmapFor(label, modulePx, barH.toInt())
            canvas.drawBitmap(bars, null, android.graphics.RectF(left, top, left + label.width * modulePx, top + barH), paint)

            // The number beneath the bars: the identity itself, centered, large.
            paint.color = Color.BLACK
            paint.textAlign = android.graphics.Paint.Align.CENTER
            paint.textSize = pageWidth * 0.085f
            paint.isFakeBoldText = true
            canvas.drawText(label.value, pageWidth / 2f, top + barH + pageHeight * 0.09f, paint)
        }
    }
}