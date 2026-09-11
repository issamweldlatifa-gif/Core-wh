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

    /** Open the system print dialog with one unit label per page. */
    fun printUnitLabels(context: Context, labels: List<BatchBarcodeRenderer.Label>, jobName: String) {
        if (labels.isEmpty()) return
        val printManager = context.getSystemService(Context.PRINT_SERVICE) as PrintManager
        printManager.print(jobName, UnitLabelAdapter(context.applicationContext, labels), PrintAttributes.Builder().build())
    }

    private class UnitLabelAdapter(
        private val context: Context,
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

        private val pdfAttributes: PrintAttributes = PrintAttributes.Builder().build()

        /** QR matrix -> white-background bitmap (modulePx px per module). The
         * renderer itself stays android-free; pixels live on the print side. */
        private fun bitmapFor(label: BatchBarcodeRenderer.Label, modulePx: Int): android.graphics.Bitmap {
            val side = label.size * modulePx
            val bitmap = android.graphics.Bitmap.createBitmap(side, side, android.graphics.Bitmap.Config.RGB_565)
            bitmap.eraseColor(Color.WHITE)
            val dark = android.graphics.Paint()
            dark.color = Color.BLACK
            val canvas = android.graphics.Canvas(bitmap)
            for (y in 0 until label.size) {
                for (x in 0 until label.size) {
                    if (label.matrix[y][x]) {
                        canvas.drawRect(
                            (x * modulePx).toFloat(), (y * modulePx).toFloat(),
                            ((x + 1) * modulePx).toFloat(), ((y + 1) * modulePx).toFloat(),
                            dark,
                        )
                    }
                }
            }
            return bitmap
        }

        private fun renderLabel(page: android.graphics.pdf.PdfDocument.Page, label: BatchBarcodeRenderer.Label) {
            // Content size from the page info (public API): the content rect
            // excludes the printable margins.
            val canvas = page.canvas
            val content = page.info.contentRect
            val pageWidth = content.width().toFloat()
            val pageHeight = content.height().toFloat()
            val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)

            // QR block: ~70% of the page width, centered near the top.
            val qrSize = pageWidth * 0.7f
            val qrBitmap = bitmapFor(label, modulePx = 4)
            val left = (pageWidth - qrSize) / 2f
            val top = pageHeight * 0.06f
            canvas.drawBitmap(qrBitmap, null, android.graphics.RectF(left, top, left + qrSize, top + qrSize), paint)

            // Readable lines under the code (value + context).
            var y = top + qrSize + pageHeight * 0.05f
            paint.color = Color.BLACK
            for (line in label.lines) {
                val isHead = line.label.startsWith("AYROVI")
                paint.textSize = if (isHead) pageWidth * 0.075f else pageWidth * 0.055f
                paint.isFakeBoldText = isHead
                canvas.drawText("${line.label}: ${line.value}", pageWidth * 0.08f, y, paint)
                y += if (isHead) pageWidth * 0.1f else pageWidth * 0.08f
                if (y > pageHeight * 0.97f) break
            }
        }
    }
}
