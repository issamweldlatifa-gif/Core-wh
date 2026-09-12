package com.ayrovi.worker.domain

import com.ayrovi.worker.data.TerminalTask
import com.ayrovi.worker.data.WorkCount

/**
 * @param count    workload: how many cards/tasks this lane holds (tile subtitle).
 * @param unread   notifications: how many of them the worker has NOT seen yet.
 */
data class WorkerQueueItem(
    val key: String,
    val label: String,
    val available: Boolean,
    val count: Int?,
    val unread: Int = 0,
) {
    /**
     * The badge is an UNREAD-notification indicator, never a workload total.
     * A lane with 5 cards the worker has already opened shows no badge; the
     * count still describes the remaining work elsewhere on the tile.
     */
    val badgeCount: Int? get() = unread.takeIf { it > 0 }
}

/** Presentation availability is not backend authorization. No made-up counts for absent contracts. */
object WorkerQueuePolicy {
    private val labels = mapOf(
        "receiving" to "RECEIVING", "sorting" to "SORTING", "putaway" to "PUTAWAY",
        "temporary-storage" to "TEMP STORAGE", "shipping" to "SHIPPING", "archive-trace" to "TRACE",
        // AYROVI BATCH (v71, owner-approved): the batch lanes render as station
        // tiles when the backend serves them — the routes/screens already exist.
        "batch" to "BATCH", "batch-in" to "BATCH IN",
    )
    fun items(
        permittedTasks: List<TerminalTask>,
        receivingArrivals: Int?,
        counts: List<WorkCount> = emptyList(),
        receivingUnread: Int = 0,
    ): List<WorkerQueueItem> =
        permittedTasks.filter { it.key in labels }.distinctBy { it.key }.map { task ->
            val key = task.key!!
            WorkerQueueItem(key, labels.getValue(key), task.ready == true && key == "receiving",
                // Receiving counts come only from the worker-scoped Home feed;
                // the generic work-count endpoint is not a card feed.
                if (key == "receiving") receivingArrivals?.takeIf { it >= 0 }
                else counts.firstOrNull { it.key == key }?.assigned?.takeIf { it >= 0 },
                // Only RECEIVING has a card-level read model today; the other
                // lanes report no unread rather than an invented number.
                unread = if (key == "receiving") receivingUnread else 0)
        }
}
