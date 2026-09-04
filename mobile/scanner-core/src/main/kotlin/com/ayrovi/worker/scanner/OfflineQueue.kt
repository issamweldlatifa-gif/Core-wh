package com.ayrovi.worker.scanner

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Offline operation queue model (pure, serialisable).
 *
 * Every offline operation carries the traceability envelope required by the
 * warehouse OS (worker/device/station/operation ids + local sequence), so a
 * later sync can dedupe against the server by `operationId` and never submit
 * the same physical scan twice. The scanner/UI layer persists queue instances
 * (the store itself lives in the app module — this class only defines the
 * envelope and the queue rules).
 */
@Serializable
data class QueuedOperation(
    val operationId: String, // client-generated UUID; server dedupes on it
    val workerId: String,
    val deviceId: String,
    val stationId: String? = null,
    val endpoint: String, // e.g. /v1/receiving/sessions/{id}/scan-carton
    val method: String = "POST",
    val bodyJson: String, // serialised payload of the operation
    val localSequence: Long,
    val createdAtEpochMs: Long,
    val syncStatus: SyncStatus = SyncStatus.PENDING,
) {
    @Serializable
    enum class SyncStatus {
        @SerialName("PENDING") PENDING,
        @SerialName("SYNCING") SYNCING,
        @SerialName("SYNCED") SYNCED,
        @SerialName("FAILED") FAILED,
    }
}

/**
 * In-memory queue with dedupe rules. `maxSize` protects the device against an
 * unbounded backlog while the network is down (the operator is told the queue
 * is full instead of silently losing work).
 */
class OfflineQueue(
    private val maxSize: Int = 500,
) {
    private val items = LinkedHashMap<String, QueuedOperation>()

    fun enqueue(op: QueuedOperation): EnqueueResult {
        if (items.containsKey(op.operationId)) return EnqueueResult.DUPLICATE
        if (items.size >= maxSize) return EnqueueResult.FULL
        items[op.operationId] = op
        return EnqueueResult.OK
    }

    fun markSyncing(operationId: String) = mutate(operationId) {
        it.copy(syncStatus = QueuedOperation.SyncStatus.SYNCING)
    }

    fun markSynced(operationId: String) = mutate(operationId) {
        it.copy(syncStatus = QueuedOperation.SyncStatus.SYNCED)
    }

    fun markFailed(operationId: String) = mutate(operationId) {
        it.copy(syncStatus = QueuedOperation.SyncStatus.FAILED)
    }

    fun pending(): List<QueuedOperation> =
        items.values.filter { it.syncStatus == QueuedOperation.SyncStatus.PENDING }

    fun remove(operationId: String) {
        items.remove(operationId)
    }

    fun size(): Int = items.size

    fun isEmpty(): Boolean = items.isEmpty()

    private fun mutate(operationId: String, f: (QueuedOperation) -> QueuedOperation) {
        items[operationId]?.let { items[operationId] = f(it) }
    }

    companion object {
        private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

        fun toJson(queue: OfflineQueue): String =
            json.encodeToString(
                kotlinx.serialization.builtins.ListSerializer(QueuedOperation.serializer()),
                queue.items.values.toList(),
            )

        fun fromJson(blob: String): OfflineQueue {
            val parsed = json.decodeFromString(
                kotlinx.serialization.builtins.ListSerializer(QueuedOperation.serializer()),
                blob,
            )
            val q = OfflineQueue()
            parsed.forEach { q.items[it.operationId] = it }
            return q
        }
    }
}

enum class EnqueueResult { OK, DUPLICATE, FULL }
