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
    val containerCode: String? = null,
    val createdAt: Long,
)

@Serializable
enum class MutationKind { START, IDENTIFY_CARTON, RECEIVE_CARTON, RECEIVE_ARTICLE, PAUSE, RESUME, FLAG, RESOLVE, COMPLETE }
