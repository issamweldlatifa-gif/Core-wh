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
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * CameraX/ML Kit text adapter for directed OCR. Emits raw text blocks to the
 * coordinator; [DirectedOcr] plus explicit operator review decide what, if
 * anything, becomes a code. This engine NEVER submits.
 */
@SuppressLint("UnsafeOptInUsageError")
@Composable
fun TextOcrScanner(coordinator: ScanCoordinator, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val previewView = remember { PreviewView(context) }
    DisposableEffect(owner, coordinator) {
        val disposed = AtomicBoolean(false)
        val executor = Executors.newSingleThreadExecutor()
        val recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
        val inFlight = AtomicBoolean(false)
        var lastEmit = 0L
        val providerFuture = ProcessCameraProvider.getInstance(context)
        val preview = Preview.Builder().build().also { it.surfaceProvider = previewView.surfaceProvider }
        val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
        analysis.setAnalyzer(executor) { proxy ->
            if (disposed.get()) proxy.close()
            else analyzeOcr(proxy, disposed, coordinator) { image, onDone ->
                if (!inFlight.compareAndSet(false, true)) onDone()
                else recognizer.process(image)
                    .addOnSuccessListener { visionText ->
                        if (!disposed.get()) {
                            val block = visionText.text
                            val now = System.currentTimeMillis()
                            if (block.isNotBlank() && now - lastEmit > 1200) {
                                lastEmit = now
                                coordinator.onOcrBlock(block)
                            }
                        }
                    }
                    .addOnCompleteListener { inFlight.set(false); onDone() }
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
            recognizer.close()
        }
    }
    AndroidView(factory = { previewView }, modifier = modifier)
}

@SuppressLint("UnsafeOptInUsageError")
private fun analyzeOcr(
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
