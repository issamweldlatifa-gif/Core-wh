package com.ayrovi.worker.presentation

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import android.util.Base64
import androidx.activity.compose.ManagedActivityResultLauncher
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.FileProvider
import com.ayrovi.worker.data.ReportPhotoInput
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * Report photo capture: camera shot or gallery pick, downscaled and encoded
 * as a JPEG data URL that fits the backend limit (~2MB of binary per photo).
 */
internal class ReportPhotoCapture(
    private val context: Context,
    private val takePicture: ManagedActivityResultLauncher<Uri, Boolean>,
    private val pickImage: ManagedActivityResultLauncher<String, Uri?>,
) {
    private var pendingShot: Uri? = null

    fun camera() {
        val dir = File(context.cacheDir, "report_photos").apply { mkdirs() }
        val file = File(dir, "shot_${System.currentTimeMillis()}.jpg")
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        pendingShot = uri
        takePicture.launch(uri)
    }

    fun gallery() = pickImage.launch("image/*")

    internal fun onShotTaken(ok: Boolean, done: (ReportPhotoInput?) -> Unit) {
        val uri = pendingShot
        pendingShot = null
        if (!ok || uri == null) {
            done(null)
            return
        }
        done(encode(uri, "camera"))
    }

    internal fun onPicked(uri: Uri?, done: (ReportPhotoInput?) -> Unit) {
        if (uri == null) {
            done(null)
            return
        }
        done(encode(uri, "gallery"))
    }

    private fun encode(uri: Uri, caption: String): ReportPhotoInput? = runCatching {
        val bitmap = decodeBounded(uri) ?: return null
        var quality = 75
        var bytes = compress(bitmap, quality)
        // Shrink until the data URL fits the backend photo limit (10 tries max).
        var attempt = 0
        while (bytes.size > MAX_BYTES && attempt < 10) {
            attempt++
            quality = (quality - 10).coerceAtLeast(30)
            bytes = compress(bitmap, quality)
        }
        if (bytes.size > MAX_BYTES) return null
        if (!bitmap.isRecycled) bitmap.recycle()
        ReportPhotoInput(
            "data:image/jpeg;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP),
            caption,
        )
    }.getOrNull()

    private fun decodeBounded(uri: Uri): Bitmap? {
        val raw = if (Build.VERSION.SDK_INT >= 28) {
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(context.contentResolver, uri))
        } else {
            @Suppress("DEPRECATION")
            context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it) }
        } ?: return null
        val longest = maxOf(raw.width, raw.height).coerceAtLeast(1)
        if (longest <= MAX_DIMENSION) return raw
        val scale = MAX_DIMENSION.toFloat() / longest
        val scaled = Bitmap.createScaledBitmap(
            raw,
            (raw.width * scale).toInt().coerceAtLeast(1),
            (raw.height * scale).toInt().coerceAtLeast(1),
            true,
        )
        raw.recycle()
        return scaled
    }

    private fun compress(bitmap: Bitmap, quality: Int): ByteArray {
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, quality, out)
        return out.toByteArray()
    }

    companion object {
        const val MAX_DIMENSION = 1600
        const val MAX_BYTES = 2_200_000
    }
}

@Composable
internal fun rememberReportPhotoCapture(onPhoto: (ReportPhotoInput?) -> Unit): ReportPhotoCapture {
    val context = LocalContext.current
    // The launcher callbacks delegate to the holder so the temp camera URI
    // survives recomposition; results arrive on the main thread.
    lateinit var holder: ReportPhotoCapture
    val takePicture = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        holder.onShotTaken(ok, onPhoto)
    }
    val pickImage = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        holder.onPicked(uri, onPhoto)
    }
    holder = remember(context, takePicture, pickImage) { ReportPhotoCapture(context, takePicture, pickImage) }
    return holder
}
