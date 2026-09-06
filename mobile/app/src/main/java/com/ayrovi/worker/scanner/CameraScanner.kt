package com.ayrovi.worker.scanner

import android.annotation.SuppressLint
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** One CameraX/ML Kit adapter for the pilot and frozen fallback. Never interprets a SKU. */
@SuppressLint("UnsafeOptInUsageError")
@Composable
fun CameraScanner(ocrEnabled: Boolean, coordinator: ScanCoordinator, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val previewView = remember { PreviewView(context) }
    DisposableEffect(owner, coordinator) {
        val disposed = AtomicBoolean(false)
        val executor = Executors.newSingleThreadExecutor()
        val reader = BarcodeScanning.getClient()
        val providerFuture = ProcessCameraProvider.getInstance(context)
        val preview = Preview.Builder().build().also { it.surfaceProvider = previewView.surfaceProvider }
        val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
        analysis.setAnalyzer(executor) { proxy ->
            if (disposed.get()) proxy.close()
            else analyze(proxy, disposed, coordinator) { image, onDone ->
                reader.process(image)
                    .addOnSuccessListener { barcodes ->
                        if (!disposed.get()) {
                            val values = barcodes.filter { !it.rawValue.isNullOrBlank() }.distinctBy { it.rawValue }
                            if (values.size == 1) {
                                val barcode = values.single()
                                coordinator.onScanned(barcode.rawValue!!, false, "CAMERA",
                                    if (barcode.format == Barcode.FORMAT_QR_CODE) ScanSymbology.QR else ScanSymbology.BARCODE)
                            } else if (values.size > 1) {
                                coordinator.unavailable("Several barcodes visible — isolate the intended label")
                            }
                        }
                    }
                    .addOnFailureListener { if (!disposed.get()) coordinator.unavailable("Camera decode failed — retry or enter the code") }
                    .addOnCompleteListener { onDone() }
            }
        }
        providerFuture.addListener({
            if (!disposed.get()) {
                try { providerFuture.get().bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis) }
                catch (_: Exception) { coordinator.unavailable("Camera unavailable — use the hardware scanner or manual entry") }
            }
        }, ContextCompat.getMainExecutor(context))
        onDispose {
            disposed.set(true)
            analysis.clearAnalyzer()
            if (providerFuture.isDone) runCatching { providerFuture.get().unbind(preview, analysis) }
            executor.shutdown()
            reader.close()
        }
    }
    AndroidView(factory = { previewView }, modifier = modifier)
}

@SuppressLint("UnsafeOptInUsageError")
private fun analyze(
    proxy: ImageProxy,
    disposed: AtomicBoolean,
    coordinator: ScanCoordinator,
    process: (InputImage, () -> Unit) -> Unit,
) {
    val media = proxy.image
    if (media == null || disposed.get()) { proxy.close(); return }
    val closed = AtomicBoolean(false)
    val close = { if (closed.compareAndSet(false, true)) proxy.close(); Unit }
    try { process(InputImage.fromMediaImage(media, proxy.imageInfo.rotationDegrees), close) }
    catch (_: Exception) {
        close()
        if (!disposed.get()) coordinator.unavailable("Camera unavailable — retry or enter the code")
    }
}
