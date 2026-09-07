package com.ayrovi.worker

import android.content.ContentValues
import android.graphics.Bitmap
import android.os.Build
import android.provider.MediaStore
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.ComposeContentTestRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.test.platform.app.InstrumentationRegistry
import com.ayrovi.worker.data.*
import com.ayrovi.worker.domain.AudioFeedback
import java.io.File

/**
 * Test-only gateway for the RECEIVING HOME rebuild: serves the home feed
 * (PRODUCT + CARTON cards and counters) and the lane scan endpoints. No
 * production service, account or stock is contacted.
 */
internal class ReceivingUiGateway(expectedCartons: Int = 1, var empty: Boolean = false) : ReceivingGateway {
    var writes = 0
    var productCards = listOf(
        ProductCard(id = "line", sku = "SKU-TEST", productName = "UI TEST FIXTURE ITEM",
            expected = 1, received = 0, remaining = 1, status = "EXPECTED", identifiers = listOf("SKU-TEST")),
    )
    var cartonCards = listOf(
        CartonCard(id = "carton", externalCartonId = "CTN-TEST", trackingNumber = "TRK-TEST",
            cartonNumber = 1, totalCartons = expectedCartons.coerceAtLeast(1), status = "EXPECTED",
            identifiers = listOf("CTN-TEST", "TRK-TEST")),
    )
    private fun feed() = ReceivingHome(
        productCards = productCards.filter { it.received < it.expected },
        cartonCards = cartonCards.filter { it.status != "RECEIVED" },
        productCardsPending = productCards.count { it.received < it.expected },
        cartonCardsPending = cartonCards.count { it.status != "RECEIVED" },
        productList = productCards.mapNotNull { p ->
            if (p.received >= p.expected) null else HomeProductRow("WAR-TEST-001", p.sku ?: p.reference, p.productName, p.remaining)
        },
        cartonList = cartonCards.mapNotNull { c ->
            if (c.status == "RECEIVED") null else HomeCartonRow("WAR-TEST-001", c.externalCartonId, c.trackingNumber, 1)
        },
    )
    override suspend fun receivingHome(): ReceivingHome = if (empty) ReceivingHome() else feed()

    override suspend fun homeConfirmProduct(
        identifier: String, identifierType: String, quantity: Int,
        operationId: String, source: String, startedAt: String?,
    ): HomeScanResult {
        writes++
        if (identifier.uppercase() != "SKU-TEST") {
            return HomeScanResult(ok = false, flash = FlashView(kind = "MISMATCH", cardType = "PRODUCT", code = identifier), home = feed())
        }
        productCards = productCards.map { it.copy(received = 1, remaining = 0, status = "RECEIVED") }
        return HomeScanResult(ok = true, sessionId = "session", flash = FlashView(kind = "MATCH", cardType = "PRODUCT", code = "SKU-TEST"), home = feed())
    }

    override suspend fun homeConfirmCarton(
        identifier: String, identifierType: String,
        operationId: String, source: String, startedAt: String?,
    ): HomeScanResult {
        writes++
        if (identifier.uppercase() != "CTN-TEST" && identifier.uppercase() != "TRK-TEST") {
            return HomeScanResult(ok = false, flash = FlashView(kind = "MISMATCH", cardType = "CARTON", code = identifier), home = feed())
        }
        cartonCards = cartonCards.map { it.copy(status = "RECEIVED") }
        return HomeScanResult(ok = true, sessionId = "session", flash = FlashView(kind = "MATCH", cardType = "CARTON", code = "CTN-TEST"), home = feed())
    }

    override suspend fun homeMismatch(
        cardType: String, identifier: String, identifierType: String, source: String, startedAt: String?,
    ): HomeScanResult {
        writes++
        return HomeScanResult(ok = true, flash = FlashView(kind = "MISMATCH", cardType = cardType, code = identifier), home = feed())
    }

    // Legacy session contract kept to satisfy the interface; the home flow does not call it.
    override suspend fun arrivals() = listOf(ArrivalRow(id = "arrival", code = "WAR-TEST-001"))
    override suspend fun receivingSession(sessionId: String): ReceivingSession = throw UnsupportedOperationException("home flow")
    override suspend fun activeSession(arrivalIdOrCode: String): ReceivingSession? = null
    override suspend fun startReceiving(arrivalIdOrCode: String): ReceivingSession = throw UnsupportedOperationException("home flow")
    override suspend fun confirmProduct(sessionId: String, identifier: String, identifierType: String, quantity: Int, operationId: String, source: String, startedAt: String?): ReceivingSession = throw UnsupportedOperationException("home flow")
    override suspend fun confirmCarton(sessionId: String, identifier: String, identifierType: String, operationId: String, source: String, startedAt: String?): ReceivingSession = throw UnsupportedOperationException("home flow")
    override suspend fun reportMismatch(sessionId: String, cardType: String, identifier: String, identifierType: String, source: String, startedAt: String?): ReceivingSession = throw UnsupportedOperationException("home flow")
    override suspend fun pauseSession(sessionId: String): ReceivingSession = throw UnsupportedOperationException("home flow")
    override suspend fun resumeSession(sessionId: String): ReceivingSession = throw UnsupportedOperationException("home flow")
    override suspend fun completeSession(sessionId: String): ReceivingSession = throw UnsupportedOperationException("home flow")
    override suspend fun flagSession(sessionId: String, reason: String, sku: String?, code: String?): ReceivingSession = throw UnsupportedOperationException("home flow")
    override suspend fun resolveDiscrepancy(discrepancyId: String, resolution: String): ReceivingSession = throw UnsupportedOperationException("home flow")
}

internal class RecordingAudio : AudioFeedback {
    var positive = 0; var negative = 0; var caution = 0; var newWork = 0
    override fun success() { positive++ }
    override fun error() { negative++ }
    override fun warning() { caution++ }
    override fun notification() { newWork++ }
}

/** Public test media survives Gradle uninstalling the test app; CI collects it before emulator teardown. */
internal fun saveNativeScreenshot(rule: ComposeContentTestRule, name: String) {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val bitmap = rule.onNodeWithTag("HANDHELD").captureToImage().asAndroidBitmap()
    if (Build.VERSION.SDK_INT >= 29) {
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, "$name.png")
            put(MediaStore.Images.Media.MIME_TYPE, "image/png")
            put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/AYROVI-UI-Tests")
        }
        val uri = checkNotNull(context.contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values))
        checkNotNull(context.contentResolver.openOutputStream(uri)).use { check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
    } else {
        val directory = File(context.getExternalFilesDir(null), "ui-evidence").apply { mkdirs() }
        File(directory, "$name.png").outputStream().use { check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
    }
}
