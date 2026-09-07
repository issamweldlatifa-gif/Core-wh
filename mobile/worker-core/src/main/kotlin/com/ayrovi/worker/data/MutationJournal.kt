package com.ayrovi.worker.data

import kotlinx.serialization.Serializable

/**
 * A durable stop marker, NOT an offline queue. There is deliberately no replay method/body.
 * Written before dispatch, cleared only after a definite response or authoritative recovery.
 */
interface MutationJournal {
    fun read(): PendingMutation?
    fun record(mutation: PendingMutation)
    fun clear(id: String)
}

@Serializable
data class PendingMutation(
    val id: String,
    val workerId: String,
    val kind: MutationKind,
    val sessionId: String? = null,
    val arrivalCode: String? = null,
    val subject: String? = null,
    val createdAt: Long,
)

/** The marker's id doubles as the backend idempotency key (operationId) for card confirmations. */
@Serializable
enum class MutationKind { START, CONFIRM_PRODUCT, CONFIRM_CARTON, REPORT_MISMATCH, PAUSE, RESUME, FLAG, RESOLVE, COMPLETE }
