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
import kotlinx.coroutines.delay
import kotlinx.serialization.json.Json
import java.io.File

/** Test-only API responses; no production service, account or stock is contacted. */
internal class ReceivingUiGateway(expectedCartons: Int = 0, var empty: Boolean = false) : ReceivingGateway {
    var writes = 0
    var validationDelay = 0L
    var activeFailure: Exception? = null
    var session = ReceivingSession("session", "RCV-TEST-001", "RECEIVING", "2026-09-06T08:00:00Z",
        arrival = DetailArrival("arrival", "WAR-TEST-001", customerName = "UI TEST FIXTURE"),
        products = listOf(ProductRow(sku = "SKU-TEST", productName = "UI TEST FIXTURE ITEM", expected = 1, received = 0, remaining = 1, difference = -1)),
        tally = ReceivingTally(expectedCartons, 0, 1, 0, 1, 0, 0, 1, 0, 0, expectedCartons))
    override suspend fun arrivals() = if (empty) emptyList() else listOf(ArrivalRow(id = "arrival", code = "WAR-TEST-001"))
    override suspend fun receivingSession(sessionId: String) = session
    override suspend fun activeSession(arrivalIdOrCode: String): ReceivingSession? {
        if (validationDelay > 0) delay(validationDelay)
        activeFailure?.let { throw it }
        if (arrivalIdOrCode != "WAR-TEST-001") throw WorkerRepository.ApiException(404, "Arrival not found.")
        return session
    }
    override suspend fun startReceiving(arrivalIdOrCode: String): ReceivingSession { writes++; return session }
    override suspend fun scanCarton(sessionId: String, code: String, scanType: String, operationId: String, source: String): ReceivingSession {
        if (code != "CTN-TEST") return session.copy(flash = FlashView(kind = "UNKNOWN_CARTON"))
        return session.copy(flash = FlashView(kind = "CARTON_IDENTIFIED", carton = Json.parseToJsonElement("""{"id":"carton","externalCartonId":"CTN-TEST"}""")))
    }
    override suspend fun receiveCarton(sessionId: String, cartonId: String, operationId: String, source: String): ReceivingSession {
        writes++
        session = session.copy(receivedCartonEvents = listOf(CartonEvent(cartonId = "CTN-TEST", status = "RECEIVED")),
            tally = session.tally.copy(receivedCartons = 1, missingCartons = 0))
        return session
    }
    override suspend fun container(code: String): OpContainerDetail {
        if (code != "RCN-TEST") throw WorkerRepository.ApiException(404, "Tote not found.")
        return OpContainerDetail(code = code, type = "RECEIVING", status = "ACTIVE")
    }
    override suspend fun scanArticleAtReceiving(sessionId: String, sku: String, containerCode: String, cartonCode: String?, operationId: String?): ArticleScanResult {
        writes++
        session = session.copy(products = session.products.map { it.copy(received = 1, remaining = 0, difference = 0) },
            tally = session.tally.copy(receivedUnits = 1, receivedProducts = 1, shortUnits = 0))
        return ArticleScanResult(flash = FlashView(kind = "ARTICLE_RECEIVED", article = Json.parseToJsonElement("""{"code":"ART-TEST-001"}""")), matched = true)
    }
    override suspend fun pauseSession(sessionId: String): ReceivingSession { writes++; session = session.copy(status = "PAUSED"); return session }
    override suspend fun resumeSession(sessionId: String): ReceivingSession { writes++; session = session.copy(status = "RECEIVING"); return session }
    override suspend fun completeSession(sessionId: String): ReceivingSession { writes++; session = session.copy(status = "COMPLETED"); return session }
    override suspend fun flagSession(sessionId: String, reason: String, sku: String?, code: String?): ReceivingSession { writes++; return session }
    override suspend fun resolveDiscrepancy(discrepancyId: String, resolution: String): ReceivingSession { writes++; return session }
}
internal class UiJournal : MutationJournal {
    var pending: PendingMutation? = null
    override fun read() = pending
    override fun record(mutation: PendingMutation) { check(pending == null || pending?.id == mutation.id); pending = mutation }
    override fun clear(id: String) { if (pending?.id == id) pending = null }
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
