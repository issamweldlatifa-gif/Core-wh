package com.ayrovi.worker

import com.ayrovi.worker.design.TerminalIcon
import com.ayrovi.worker.presentation.stationIcon
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Test

/**
 * ORDER 01 (CT40 station UI cleanup) — station isolation contract for the
 * HOME STATIONS grid: every station renders ONLY its own icon.
 *
 * Reported defect: the BATCH entries borrowed Receiving-family icons
 * (batch -> PRODUCT, batch-in -> RECEIVING). The audit found the same defect
 * class on SHIPPING (CARTON = the Receiving carton-lane icon) and PACKING
 * (PUTAWAY fallback). Keys are the backend task-registry keys
 * (backend/src/modules/operations/task-registry.ts).
 */
class StationIconMappingTest {

    @Test
    fun `batch stations render their own icons never receiving family icons`() {
        assertEquals(TerminalIcon.BATCH, stationIcon("batch"))
        assertEquals(TerminalIcon.BATCH_IN, stationIcon("batch-in"))
        val receivingFamily = listOf(TerminalIcon.RECEIVING, TerminalIcon.PRODUCT, TerminalIcon.CARTON)
        for (key in listOf("batch", "batch-in")) {
            for (foreign in receivingFamily) {
                assertNotEquals(foreign, stationIcon(key), "station '$key' must not render receiving icon $foreign")
            }
        }
    }

    @Test
    fun `every live station key maps to its own expected icon`() {
        val expected = mapOf(
            "sorting" to TerminalIcon.SORTING,
            "putaway" to TerminalIcon.PUTAWAY,
            "temporary-storage" to TerminalIcon.STORAGE,
            "packing" to TerminalIcon.PACKING,
            "shipping" to TerminalIcon.DISPATCH,
            "archive-trace" to TerminalIcon.STATION,
            "batch" to TerminalIcon.BATCH,
            "batch-in" to TerminalIcon.BATCH_IN,
        )
        for ((key, icon) in expected) assertEquals(icon, stationIcon(key))
    }

    @Test
    fun `station icons are pairwise distinct no duplicates between stations`() {
        val liveStationKeys = listOf(
            "sorting", "putaway", "temporary-storage", "packing",
            "shipping", "archive-trace", "batch", "batch-in",
        )
        val icons = liveStationKeys.map { stationIcon(it) }
        assertEquals(icons.size, icons.distinct().size, "two stations share one icon")
    }

    @Test
    fun `receiving owned icons are never returned for any station key`() {
        // RECEIVING (the Receiving tile), PRODUCT and CARTON (the Receiving
        // product/carton lanes) stay exclusive to Receiving.
        val liveStationKeys = listOf(
            "sorting", "putaway", "temporary-storage", "packing",
            "shipping", "archive-trace", "batch", "batch-in",
        )
        val receivingOwned = listOf(TerminalIcon.RECEIVING, TerminalIcon.PRODUCT, TerminalIcon.CARTON)
        for (key in liveStationKeys) {
            for (foreign in receivingOwned) {
                assertNotEquals(foreign, stationIcon(key), "station '$key' borrows receiving icon $foreign")
            }
        }
    }

    @Test
    fun `unknown keys fall back to the generic station glyph`() {
        assertEquals(TerminalIcon.STATION, stationIcon("something-new"))
        // The admin-board spelling "customer-sorting" is NOT a task-registry
        // key — it must never masquerade as a live station mapping.
        assertEquals(TerminalIcon.STATION, stationIcon("customer-sorting"))
    }
}
