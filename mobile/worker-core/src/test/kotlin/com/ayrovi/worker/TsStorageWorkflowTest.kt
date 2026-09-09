@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package com.ayrovi.worker

import com.ayrovi.worker.data.*
import com.ayrovi.worker.domain.TsStorageWorkflow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.*

/**
 * TEMPORARY STORAGE — native station workflow contract tests.
 *
 * Rules under test:
 *  - scan product -> server resolves customer/section -> pending TARGET
 *    container (never typed by the worker);
 *  - scan the target container -> VALID stores, flashes the container and
 *    clears the pending state;
 *  - wrong container -> nothing stored, pending re-pointed to the expected code;
 *  - unknown product -> Review lane prompt -> sendToReview opens the exception;
 *  - Rapport de Fin submits once and locks further submissions.
 */
class TsStorageWorkflowTest {
    private val perms = setOf("receiving.view", "receiving.execute")

    private class FakeTsGateway(
        val scanMisses: Boolean = false,
        var placeResult: TsPlacePayload = TsPlacePayload(status = "VALID", message = "ok"),
    ) : TemporaryStorageGateway {
        var reviewCount = 0
        var reportCount = 0

        override suspend fun tsHome(): TsHomePayload = TsHomePayload(
            station = TsStationRef(id = "stg-1", code = "ST-STG-01", name = "Temporary Storage 1", department = "STAGING"),
            header = TsHeader(activeProducts = 45, containers = 2, completed = 40, remaining = 5, review = 0),
            currentSection = "A",
            sections = listOf(
                TsSectionSummary(letter = "A", products = 45, stored = 40,
                    customers = listOf(TsCustomerSummary("Ahmed", 45, 5))),
            ),
        )

        override suspend fun tsSection(letter: String): TsSectionPayload = TsSectionPayload(
            station = TsStationRef(id = "stg-1", code = "ST-STG-01", name = "Temporary Storage 1"),
            letter = letter,
            customers = listOf(
                TsCustomerGroup(
                    customer = "Ahmed", surname = "Ben Salah", received = 45, stored = 40, remaining = 5,
                    containers = listOf(
                        TsContainerCard("A1", 20, 20, "FULL"),
                        TsContainerCard("A2", 20, 20, "FULL"),
                        TsContainerCard("A3", 0, 20, "EMPTY", active = true),
                    ),
                ),
            ),
        )

        override suspend fun tsScanProduct(code: String, operationId: String): TsScanPayload =
            if (scanMisses) TsScanPayload(status = "PRODUCT_NOT_FOUND", message = "No confirmed product matches this code.")
            else TsScanPayload(
                status = "VALID",
                product = TsScanProductRef(sku = "SKU-A", productName = "Produit A",
                    customer = "Ahmed", surname = "Ben Salah", section = "A"),
                remaining = 5,
                targetContainer = TsTargetContainer(code = "A3", current = 0, capacity = 20, status = "EMPTY"),
            )

        override suspend fun tsPlace(code: String, containerCode: String, operationId: String): TsPlacePayload = placeResult

        override suspend fun tsReview(code: String, reason: String, operationId: String): TsReviewPayload {
            reviewCount += 1
            return TsReviewPayload(status = "REVIEW", review = TsReviewRef(itemId = "rev-1", exceptionCode = "EXC-1", reason = reason))
        }

        override suspend fun tsReportFin(observation: String?): TsReportPayload {
            reportCount += 1
            return TsReportPayload(id = "rep-1", status = "SUBMITTED", stationCode = "ST-STG-01")
        }
    }

    private fun TestScope.workflow(backend: FakeTsGateway = FakeTsGateway()): TsStorageWorkflow =
        TsStorageWorkflow(backend, this).also { it.updateAccess(perms, true); it.activate(perms, true); runCurrent() }

    @Test fun `home loads with header counters and dynamic sections`() = runTest {
        val flow = workflow()
        val state = flow.state.value
        assertTrue(state.loaded)
        assertEquals(45, state.home?.header?.activeProducts)
        assertEquals("A", state.home?.sections?.firstOrNull()?.letter)
        assertNull(state.pending)
    }

    @Test fun `product scan resolves the target container and opens its section board`() = runTest {
        val flow = workflow()
        flow.scan("SKU-A"); runCurrent()
        val state = flow.state.value
        val pending = state.pending
        assertNotNull(pending)
        assertEquals("A3", pending.targetCode)
        assertEquals("A", pending.section)
        assertEquals("Ahmed", pending.customer)
        assertEquals("A", state.letter)
        assertEquals("A3", state.board?.customers?.firstOrNull()?.containers?.getOrNull(2)?.code)
    }

    @Test fun `scanning the target container stores and clears pending with a green flash`() = runTest {
        val flow = workflow()
        flow.scan("SKU-A"); runCurrent()
        flow.scan("A3"); runCurrent()
        val state = flow.state.value
        assertNull(state.pending)
        assertEquals("A3", state.flashOk)
        assertNull(state.flashBad)
    }

    @Test fun `wrong container stores nothing and re-points the target to the expected code`() = runTest {
        val backend = FakeTsGateway(
            placeResult = TsPlacePayload(
                status = "WRONG_CONTAINER",
                message = "Product Ahmed belongs to section A.",
                expected = TsExpectedContainer(section = "A", containerCode = "A3"),
            ),
        )
        val flow = workflow(backend)
        flow.scan("SKU-A"); runCurrent()
        flow.scan("B1"); runCurrent()
        val state = flow.state.value
        assertNotNull(state.pending, "wrong container must keep the product pending")
        assertEquals("A3", state.pending?.targetCode)
        assertEquals("B1", state.flashBad)
        assertNull(state.flashOk)
    }

    @Test fun `unknown product offers the review lane and sendToReview opens the exception`() = runTest {
        val backend = FakeTsGateway(scanMisses = true)
        val flow = workflow(backend)
        flow.scan("ZZZ-UNKNOWN"); runCurrent()
        assertEquals("ZZZ-UNKNOWN", flow.state.value.unknownCode)
        flow.sendToReview(); runCurrent()
        assertNull(flow.state.value.unknownCode)
        assertEquals(1, backend.reviewCount)
    }

    @Test fun `rapport de fin submits once and locks further submissions`() = runTest {
        val backend = FakeTsGateway()
        val flow = workflow(backend)
        flow.submitReport("all clear"); runCurrent()
        assertTrue(flow.state.value.reportSent)
        flow.submitReport("again"); runCurrent()
        assertEquals(1, backend.reportCount, "second submission must be ignored")
    }
}
