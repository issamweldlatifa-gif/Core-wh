package com.ayrovi.worker

import com.ayrovi.worker.data.TerminalTask
import com.ayrovi.worker.domain.WorkerQueuePolicy
import kotlin.test.*

class WorkerQueuePolicyTest {
    private val tasks = listOf("receiving", "sorting", "putaway").map { TerminalTask(key = it, ready = true) }
    @Test fun `zero arrivals has no badge and other queues are unknown not invented zeros`() {
        val items = WorkerQueuePolicy.items(tasks, 0)
        assertNull(items.first().badgeCount)
        assertTrue(items.drop(1).all { it.count == null && it.badgeCount == null && !it.available })
    }
    @Test fun `one and multiple arrivals use actual read count`() {
        for (count in listOf(1, 3, 1000)) assertEquals(count, WorkerQueuePolicy.items(tasks, count).first().badgeCount)
        assertNull(WorkerQueuePolicy.items(tasks, null).first().badgeCount)
    }
    @Test fun `unpermitted missing or server disabled task cannot be activated`() {
        assertTrue(WorkerQueuePolicy.items(emptyList(), 4).isEmpty())
        val disabled = WorkerQueuePolicy.items(listOf(TerminalTask(key = "receiving", ready = false)), 3).single()
        assertFalse(disabled.available)
        assertTrue(WorkerQueuePolicy.items(listOf(TerminalTask(key = "admin", ready = true)), 4).isEmpty())
    }
}
