package com.ayrovi.worker.domain

import com.ayrovi.worker.data.SessionChangedFailure
import com.ayrovi.worker.data.ContractFailure
import com.ayrovi.worker.data.TransportFailure
import com.ayrovi.worker.data.WorkerRepository
import kotlinx.serialization.SerializationException

enum class MessageTone { INFO, SUCCESS, WARNING, ERROR }

data class OperationalMessage(
    val title: String,
    val detail: String,
    val tone: MessageTone = MessageTone.ERROR,
    val expected: String? = null,
    val scanned: String? = null,
)

/** Preserve backend reasons; do not expose raw HTML/stack traces or silently swallow refusals. */
fun Throwable.toOperationalMessage(): OperationalMessage = when (this) {
    is WorkerRepository.ApiException -> OperationalMessage(
        when (code) {
            401 -> "SIGN IN REQUIRED"
            403 -> "PERMISSION REQUIRED"
            404 -> "RECORD NOT FOUND"
            409 -> "OPERATION CANNOT CONTINUE"
            429 -> "PLEASE WAIT"
            else -> if (outcomeUnknown) "OUTCOME NOT CONFIRMED" else "REQUEST NOT ACCEPTED"
        }, message,
    )
    is SessionChangedFailure -> OperationalMessage("WORKER SESSION CHANGED",
        if (outcomeUnknown) "Do not repeat this receipt. The previous worker's session changed before the result could be confirmed."
        else "Reload your worker context before continuing. Nothing was retried under another login.")
    is TransportFailure -> OperationalMessage(
        if (outcomeUnknown) "OUTCOME NOT CONFIRMED" else "NETWORK UNAVAILABLE", message.orEmpty(),
    )
    is ContractFailure, is SerializationException -> OperationalMessage(
        "SERVER RESPONSE NOT UNDERSTOOD", "Do not repeat the operation. Refresh the server state or ask a supervisor.",
    )
    else -> OperationalMessage("OPERATION STOPPED", "The terminal could not safely continue. Ask a supervisor; do not repeat an unconfirmed receipt.")
}
