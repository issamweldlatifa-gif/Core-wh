package com.ayrovi.worker

import com.ayrovi.worker.data.AuthTokens
import com.ayrovi.worker.data.ConnectionState
import com.ayrovi.worker.data.SessionSnapshot
import com.ayrovi.worker.data.SessionStorage
import com.ayrovi.worker.data.TemporaryStorageGateway
import com.ayrovi.worker.data.TsContainerCard
import com.ayrovi.worker.data.TsCustomerGroup
import com.ayrovi.worker.data.TsCustomerSummary
import com.ayrovi.worker.data.TsExpectedContainer
import com.ayrovi.worker.data.TsHeader
import com.ayrovi.worker.data.TsHomePayload
import com.ayrovi.worker.data.TsPlacePayload
import com.ayrovi.worker.data.TsPlacedContainer
import com.ayrovi.worker.data.TsReviewPayload
import com.ayrovi.worker.data.TsReviewRef
import com.ayrovi.worker.data.TsReportPayload
import com.ayrovi.worker.data.TsScanPayload
import com.ayrovi.worker.data.TsScanProductRef
import com.ayrovi.worker.data.TsSectionPayload
import com.ayrovi.worker.data.TsSectionSummary
import com.ayrovi.worker.data.TsStationRef
import com.ayrovi.worker.data.TsTargetContainer
import com.ayrovi.worker.data.WorkerRepository
import com.ayrovi.worker.data.WorkerTransport
import kotlinx.coroutines.flow.MutableStateFlow

/**
 * Test-only fixtures for the TEMPORARY STORAGE station: the unified scanner is
 * proven on the REAL screen (not on an isolated composable) with the same
 * server truth shape the backend returns. No production service, account or
 * stock is contacted.
 */
internal class TsUiGateway : TemporaryStorageGateway {
    var placements = 0
    var home: TsHomePayload = TsHomePayload(
        station = TsStationRef(id = "station", code = "ST-TS-01", name = "Temporary Storage", department = "TS"),
        header = TsHeader(activeProducts = 2, containers = 1, completed = 0, remaining = 2, review = 0),
        currentSection = "A",
        sections = listOf(
            TsSectionSummary(
                letter = "A", products = 2, stored = 0,
                customers = listOf(TsCustomerSummary(customer = "CLIENT-TEST", received = 2, remaining = 2)),
            ),
        ),
    )
    var board: TsSectionPayload = TsSectionPayload(
        station = TsStationRef(code = "ST-TS-01"),
        letter = "A",
        reviewItems = emptyList(),
        customers = listOf(
            TsCustomerGroup(
                customer = "CLIENT-TEST", surname = null, received = 2, stored = 0, remaining = 2,
                containers = listOf(TsContainerCard(code = "CONT-TEST", current = 0, capacity = 10, status = "OPEN", active = true)),
            ),
        ),
    )

    override suspend fun tsHome(): TsHomePayload = home

    override suspend fun tsSection(letter: String): TsSectionPayload = board.copy(letter = letter)

    override suspend fun tsScanProduct(code: String, operationId: String): TsScanPayload =
        if (code.uppercase() == "SKU-TEST") TsScanPayload(
            status = "VALID",
            product = TsScanProductRef(
                sku = "SKU-TEST", reference = "REF-TEST", productName = "UI TEST FIXTURE ITEM",
                customer = "CLIENT-TEST", section = "A",
            ),
            remaining = 2,
            targetContainer = TsTargetContainer(code = "CONT-TEST", current = 0, capacity = 10, status = "OPEN", mustCreate = false),
        ) else TsScanPayload(status = "PRODUCT_NOT_FOUND")

    override suspend fun tsPlace(code: String, containerCode: String, operationId: String): TsPlacePayload =
        if (containerCode.uppercase() == "CONT-TEST") {
            placements++
            TsPlacePayload(
                status = "VALID", itemId = "item-test",
                container = TsPlacedContainer(code = containerCode, current = 1, capacity = 10, status = "OPEN"),
                remaining = 1, nextTarget = null,
            )
        } else TsPlacePayload(
            status = "WRONG_CONTAINER",
            message = "Nothing was stored.",
            expected = TsExpectedContainer(section = "A", containerCode = "CONT-TEST"),
        )

    override suspend fun tsReview(code: String, reason: String, operationId: String): TsReviewPayload =
        TsReviewPayload(status = "REVIEW", review = TsReviewRef(itemId = "item-test", exceptionCode = "TS_REVIEW", reason = reason), notifiedAdmins = 1)

    override suspend fun tsReportFin(observation: String?): TsReportPayload =
        TsReportPayload(id = "report-test", status = "SUBMITTED", stationCode = "ST-TS-01", notifiedAdmins = 1, message = null)
}

/** Session storage double: the station screen only needs it to build the repository. */
internal class UiSessionStorage : SessionStorage {
    override val deviceCode: String = "DEV-TEST"
    override var employeeCode: String? = "WORKER-TEST"
    private var version = 0L
    private var tokens: AuthTokens? = null
    override fun snapshot() = SessionSnapshot(version, tokens)
    override fun replace(expectedVersion: Long, tokens: AuthTokens, newLogin: Boolean): Boolean {
        version += 1; this.tokens = tokens; return true
    }
    override fun clear() { tokens = null; version += 1 }
    override fun clearIfVersion(expectedVersion: Long): Boolean { version += 1; tokens = null; return true }
    override fun clearIfIdentity(expectedIdentity: Long): Boolean { version += 1; tokens = null; return true }
}

/** Transport double: no request ever leaves the device during the UI tests. */
internal class UiTransport : WorkerTransport {
    override val connection = MutableStateFlow(ConnectionState.ONLINE)
    override suspend fun request(method: String, path: String, body: String?, authenticated: Boolean): String = "{}"
    override fun networkAvailable(available: Boolean) = Unit
}

internal fun uiRepository() = WorkerRepository(UiSessionStorage(), UiTransport())
