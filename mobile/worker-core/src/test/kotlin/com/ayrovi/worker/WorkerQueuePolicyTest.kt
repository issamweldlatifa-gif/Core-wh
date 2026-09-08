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
    @Test fun `the lane count reports the real workload`() {
        for (count in listOf(1, 3, 1000)) assertEquals(count, WorkerQueuePolicy.items(tasks, count).first().count)
        assertNull(WorkerQueuePolicy.items(tasks, null).first().count)
    }

    // The badge is an UNREAD indicator, NOT the workload. Pending cards the
    // worker has already seen must not keep a number on the tile — that was
    // the bug where the badge never returned to 0 after finishing the work.
    @Test fun `badge follows unread notifications and not the pending workload`() {
        assertNull(WorkerQueuePolicy.items(tasks, 5, receivingUnread = 0).first().badgeCount)
        assertEquals(2, WorkerQueuePolicy.items(tasks, 5, receivingUnread = 2).first().badgeCount)
        // Everything read while work remains → no badge, count untouched.
        val read = WorkerQueuePolicy.items(tasks, 5, receivingUnread = 0).first()
        assertEquals(5, read.count)
        assertNull(read.badgeCount)
    }

    @Test fun `lanes without a card-level read model never invent an unread badge`() {
        val items = WorkerQueuePolicy.items(tasks, 3, receivingUnread = 3)
        assertTrue(items.drop(1).all { it.badgeCount == null })
    }
    @Test fun `unpermitted missing or server disabled task cannot be activated`() {
        assertTrue(WorkerQueuePolicy.items(emptyList(), 4).isEmpty())
        val disabled = WorkerQueuePolicy.items(listOf(TerminalTask(key = "receiving", ready = false)), 3).single()
        assertFalse(disabled.available)
        assertTrue(WorkerQueuePolicy.items(listOf(TerminalTask(key = "admin", ready = true)), 4).isEmpty())
    }
}
