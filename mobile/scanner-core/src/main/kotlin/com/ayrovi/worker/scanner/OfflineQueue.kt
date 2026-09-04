package com.ayrovi.worker.scanner

import java.util.UUID

data class PendingOperation(
    val id: String = UUID.randomUUID().toString(),
    val endpoint: String,
    val payload: String,
    val createdAtEpochMs: Long,
    val attempts: Int = 0,
    val lastError: String? = null,
)

interface OfflineOperationQueue {
    fun enqueue(operation: PendingOperation): Boolean
    fun pending(): List<PendingOperation>
    fun markRetry(id: String, error: String): Boolean
    fun remove(id: String): Boolean
}

class InMemoryOfflineOperationQueue : OfflineOperationQueue {
    private val values = LinkedHashMap<String, PendingOperation>()

    override fun enqueue(operation: PendingOperation): Boolean {
        if (values.containsKey(operation.id)) return false
        values[operation.id] = operation
        return true
    }

    override fun pending(): List<PendingOperation> = values.values.toList()

    override fun markRetry(id: String, error: String): Boolean {
        val current = values[id] ?: return false
        values[id] = current.copy(attempts = current.attempts + 1, lastError = error)
        return true
    }

    override fun remove(id: String): Boolean = values.remove(id) != null
}

class OfflineSyncEngine(private val queue: OfflineOperationQueue) {
    fun <T> sync(send: (PendingOperation) -> Result<T>): SyncReport {
        var succeeded = 0
        var failed = 0
        queue.pending().forEach { operation ->
            val result = send(operation)
            if (result.isSuccess) {
                queue.remove(operation.id)
                succeeded++
            } else {
                queue.markRetry(operation.id, result.exceptionOrNull()?.message ?: "SYNC_FAILED")
                failed++
            }
        }
        return SyncReport(succeeded, failed, queue.pending().size)
    }
}

data class SyncReport(val succeeded: Int, val failed: Int, val remaining: Int)
