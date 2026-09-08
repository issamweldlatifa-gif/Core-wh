package com.ayrovi.worker.domain

import com.ayrovi.worker.data.TerminalTask
import com.ayrovi.worker.data.WorkCount

data class WorkerQueueItem(val key: String, val label: String, val available: Boolean, val count: Int?) {
    val badgeCount: Int? get() = count?.takeIf { it > 0 }
}

/** Presentation availability is not backend authorization. No made-up counts for absent contracts. */
object WorkerQueuePolicy {
    private val labels = mapOf("receiving" to "RECEIVING", "sorting" to "SORTING", "putaway" to "PUTAWAY")
    fun items(permittedTasks: List<TerminalTask>, receivingArrivals: Int?, counts: List<WorkCount> = emptyList()): List<WorkerQueueItem> =
        permittedTasks.filter { it.key in labels }.distinctBy { it.key }.map { task ->
            val key = task.key!!
            WorkerQueueItem(key, labels.getValue(key), task.ready == true && key == "receiving",
                // Receiving counts come only from the worker-scoped Home feed;
                // the generic work-count endpoint is not a card feed.
                if (key == "receiving") receivingArrivals?.takeIf { it >= 0 }
                else counts.firstOrNull { it.key == key }?.assigned?.takeIf { it >= 0 })
        }
}
