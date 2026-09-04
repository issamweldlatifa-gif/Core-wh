package com.ayrovi.worker.scanner

import android.annotation.SuppressLint
import android.content.Context
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
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.TextRecognizer
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Single camera scanner for every warehouse station. Produces raw strings
 * through [ScanCoordinator] (barcode/QR first, OCR fallback when enabled) —
 * the same component is reused by Receiving, Sorting, Packing and Shipping.
 */
@SuppressLint("UnsafeOptInUsageError")
@Composable
fun CameraScanner(
    ocrEnabled: Boolean,
    coordinator: ScanCoordinator,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val lifecycleOwner: LifecycleOwner = LocalLifecycleOwner.current
    val previewView = remember { PreviewView(context) }

    DisposableEffect(lifecycleOwner, ocrEnabled) {
        val analysisExecutor = Executors.newSingleThreadExecutor()
        val barcodeScanner = buildBarcodeScanner(context)
        val textRecognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
        val cameraProviderFuture = ProcessCameraProvider.getInstance(context)

        val runnable = Runnable {
            val cameraProvider = cameraProviderFuture.get()
            val preview = Preview.Builder().build().also {
                it.surfaceProvider = previewView.surfaceProvider
            }
            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
            analysis.setAnalyzer(analysisExecutor) { proxy ->
                analyzeProxy(proxy, barcodeScanner, textRecognizer, coordinator, ocrEnabled)
            }
            cameraProvider.unbindAll()
            try {
                cameraProvider.bindToLifecycle(
                    lifecycleOwner,
                    CameraSelector.DEFAULT_BACK_CAMERA,
                    preview,
                    analysis,
                )
            } catch (_: Exception) {
                // Camera busy/unavailable — manual entry fallback stays visible.
            }
        }
        cameraProviderFuture.addListener(runnable, ContextCompat.getMainExecutor(context))

        onDispose {
            analysisExecutor.shutdown()
            barcodeScanner.close()
            textRecognizer.close()
            try {
                if (cameraProviderFuture.isDone) cameraProviderFuture.get().unbindAll()
            } catch (_: Exception) {
                // ignore
            }
        }
    }

    AndroidView(factory = { previewView }, modifier = modifier)
}

private fun buildBarcodeScanner(context: Context): BarcodeScanner {
    val options = BarcodeScannerOptions.Builder()
        .setBarcodeFormats(
            Barcode.FORMAT_QR_CODE,
            Barcode.FORMAT_CODE_128,
            Barcode.FORMAT_CODE_39,
            Barcode.FORMAT_EAN_13,
            Barcode.FORMAT_EAN_8,
            Barcode.FORMAT_UPC_A,
            Barcode.FORMAT_UPC_E,
            Barcode.FORMAT_DATA_MATRIX,
            Barcode.FORMAT_CODABAR,
            Barcode.FORMAT_ITF,
        )
        .build()
    return BarcodeScanning.getClient(options)
}

private fun analyzeProxy(
    proxy: ImageProxy,
    barcodeScanner: BarcodeScanner,
    textRecognizer: TextRecognizer,
    coordinator: ScanCoordinator,
    ocrEnabled: Boolean,
) {
    val mediaImage = proxy.image
    if (mediaImage == null) {
        proxy.close()
        return
    }
    val image = InputImage.fromMediaImage(mediaImage, proxy.imageInfo.rotationDegrees)
    barcodeScanner.process(image)
        .addOnSuccessListener { barcodes ->
            val raw = barcodes.firstNotNullOfOrNull { it.rawValue }
            if (raw != null) {
                coordinator.onScanned(raw, fromOcr = false)
                proxy.close()
            } else if (ocrEnabled) {
                processOcrFallback(textRecognizer, image, coordinator, proxy)
            } else {
                proxy.close()
            }
        }
        .addOnFailureListener { proxy.close() }
}

private fun processOcrFallback(
    recognizer: TextRecognizer,
    image: InputImage,
    coordinator: ScanCoordinator,
    proxy: ImageProxy,
) {
    recognizer.process(image)
        .addOnSuccessListener { visionText ->
            val text = visionText.text
            if (text.isNotBlank()) coordinator.onScanned(text, fromOcr = true)
            proxy.close()
        }
        .addOnFailureListener { proxy.close() }
}
