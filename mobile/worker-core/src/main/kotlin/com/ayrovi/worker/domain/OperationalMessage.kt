package com.ayrovi.worker.domain

import com.ayrovi.worker.data.ContractFailure
import com.ayrovi.worker.data.SessionChangedFailure
import com.ayrovi.worker.data.TransportFailure
import com.ayrovi.worker.data.WorkerRepository
import kotlinx.serialization.SerializationException

enum class MessageTone { INFO, SUCCESS, WARNING, ERROR }

data class OperationalMessage(
    val title: String, val detail: String, val tone: MessageTone = MessageTone.ERROR,
    val expected: String? = null, val scanned: String? = null,
)

/** The single worker-safe boundary. Technical API exceptions remain available to diagnostics, not UI. */
object WorkerMessages {
    private val technical = Regex("(?i)(https?://|<[^>]+>|\\b(?:prisma|sql|exception|stacktrace|stack trace|jwt|bearer|token|dto|http|api|backend|worker_native|admin_web|statuscode|undefined|null|permission\\(s\\))\\b|\\w+\\.(?:execute|view|manage|resolve_discrepancy)|\\bat [\\w.]+\\()")
    fun reason(raw: String?, fallback: String): String {
        val text = raw.orEmpty().trim()
        if (text.isBlank() || text.length > 350 || technical.containsMatchIn(text)) return fallback
        return text.replace("Receiving session", "Receiving task").replace("receiving session", "receiving task")
    }
    fun api(code: Int, raw: String, unknown: Boolean): OperationalMessage = when {
        unknown -> OperationalMessage("RECEIPT NOT CONFIRMED", "Do not receive this item again. Check the connection and ask your supervisor.")
        code == 401 -> OperationalMessage("SIGN IN REQUIRED", "Your session has ended. Sign in again to continue.")
        code == 403 -> OperationalMessage("ACTION NOT ALLOWED", reason(raw, "Ask your supervisor to check your access or assignment."))
        // Arrival lookup refusal (receiving audit): an AYROVI-looking code the
        // backend does not know must not surface as a raw lookup error — the
        // operator is redirected to the server queue instead.
        code == 404 && raw.contains("Expected arrival not found", ignoreCase = true) ->
            OperationalMessage("ARRIVAL NOT FOUND", "This arrival is not available. Select an Arrival from the queue or scan its WAR- code.")
        code == 404 -> OperationalMessage("NOT FOUND", reason(raw, "Check the label and scan again."))
        code == 409 -> OperationalMessage("CANNOT CONTINUE", reason(raw, "This task has changed. Refresh it or ask your supervisor."))
        code == 429 -> OperationalMessage("PLEASE WAIT", "Wait a moment before trying again.", MessageTone.WARNING)
        code >= 500 || code == 408 -> OperationalMessage("CONNECTION UNAVAILABLE", "Check the connection, then refresh the task.", MessageTone.WARNING)
        else -> OperationalMessage("CHECK THE CODE", reason(raw, "Check the code or quantity and try again."))
    }
}

fun Throwable.toOperationalMessage(): OperationalMessage = when (this) {
    is WorkerRepository.ApiException -> WorkerMessages.api(code, message, outcomeUnknown)
    is SessionChangedFailure -> OperationalMessage("SESSION CHANGED", if (outcomeUnknown)
        "Do not receive this item again. Ask your supervisor to check the previous receipt."
        else "Sign in and reopen your task.")
    is TransportFailure -> if (outcomeUnknown) OperationalMessage("RECEIPT NOT CONFIRMED",
        "Do not receive this item again. Check the connection and ask your supervisor.")
        else OperationalMessage("CONNECTION UNAVAILABLE", "Check the connection, then try again.", MessageTone.WARNING)
    is ContractFailure, is SerializationException -> OperationalMessage("UNABLE TO VERIFY",
        "Do not repeat the receipt. Refresh the task or ask your supervisor.")
    else -> OperationalMessage("WORK STOPPED", "Ask your supervisor for help. Do not repeat an unconfirmed receipt.")
}
