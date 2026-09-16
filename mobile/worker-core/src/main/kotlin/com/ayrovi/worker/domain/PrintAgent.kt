package com.ayrovi.worker.domain

import com.ayrovi.worker.data.WorkerTransport
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * STATION PRINT AGENT (owner order 2026-09-16, open item «PC → CT40 printer»).
 *
 * A label can be queued from ANY screen (station display, admin console). When
 * the display is configured with transport `CT40`, the bytes must come out of
 * the thermal printer PAIRED TO THE OPERATOR'S HANDHELD — a web page cannot
 * reach a Bluetooth SPP link, the app on the CT40 can.
 *
 * This class is the whole network half of that agent, and it is deliberately
 * dumb + safe:
 *  - it authenticates as a normal WORKER (JWT, the existing session) — never a
 *    display token, so no shared secret travels to a phone;
 *  - the SERVER decides what a worker may see (only labels of the stations
 *    assigned to that worker — `Station.assignedWorkerId`);
 *  - it only ever reads the pending queue and reports an outcome; it cannot
 *    create a job, so a compromised handheld cannot print arbitrary labels;
 *  - NO Android imports: the poller/UI owns the threading (see
 *    `PrintAgentRunner` in the app module).
 */
class PrintAgent(
    private val transport: WorkerTransport,
    private val json: Json = Json { ignoreUnknownKeys = true },
) {

    /**
     * Labels waiting for a handheld/bridge printer at the worker's stations,
     * oldest first. Returns an empty list when the worker has no station — the
     * server answers `{jobs: [], stations: []}` rather than an error, so the
     * agent degrades to "nothing to do" instead of a red screen.
     */
    suspend fun pending(limit: Int = DEFAULT_LIMIT): List<AgentPrintJob> {
        val safeLimit = limit.coerceIn(1, MAX_LIMIT)
        val raw = transport.request("GET", "/v1/print-jobs/pending?limit=$safeLimit")
        return parseJobs(raw)
    }

    /**
     * Report the physical outcome of a claimed label. `PRINTED`/`FAILED` are
     * terminal on the server: a second report is answered as a duplicate, so a
     * flaky link can retry this call safely.
     */
    suspend fun report(jobId: String, printed: Boolean, error: String? = null): Boolean {
        if (jobId.isBlank()) return false
        val body = buildString {
            append("{\"status\":\"")
            append(if (printed) "PRINTED" else "FAILED")
            append("\"")
            if (!printed) {
                append(",\"error\":")
                append(JsonPrimitive(error?.take(300) ?: "Printer failed"))
            }
            append("}")
        }
        return try {
            transport.request("POST", "/v1/print-jobs/${jobId.trim()}/result", body)
            true
        } catch (_: Exception) {
            // The queue already applied local duplicate protection; a lost
            // report only means the server keeps the job QUEUED and it will be
            // re-offered — never a reason to crash the agent.
            false
        }
    }

    companion object {
        const val DEFAULT_LIMIT = 5
        const val MAX_LIMIT = 20

        /** The job list out of the server payload (never throws: bad JSON = empty). */
        fun parseJobs(raw: String): List<AgentPrintJob> = try {
            val root = Json.parseToJsonElement(raw).jsonObject
            val jobs = root["jobs"] as? JsonArray ?: JsonArray(emptyList())
            jobs.mapNotNull { element -> runCatching { job(element.jsonObject) }.getOrNull() }
        } catch (_: Exception) {
            emptyList()
        }

        private fun job(obj: JsonObject): AgentPrintJob = AgentPrintJob(
            id = obj.str("id"),
            stationId = obj.str("stationId"),
            target = obj.str("target"),
            targetRef = obj["targetRef"]?.jsonPrimitive?.contentOrNull,
            copies = obj["copies"]?.jsonPrimitive?.intOrNull ?: 1,
            transport = obj.str("transport"),
            displayName = (obj["display"] as? JsonObject)?.let { it.str("name").takeIf(String::isNotBlank) },
            requestedAt = obj["requestedAt"]?.jsonPrimitive?.contentOrNull,
            label = labelOf(obj["payload"] as? JsonObject),
        )

        private fun JsonObject.str(key: String): String =
            this[key]?.jsonPrimitive?.contentOrNull.orEmpty()

        /**
         * The SAME label the browser transport prints (`display-print.ts`):
         * title → the code (as Code128, with the human-readable value under the
         * bars) → the useful rows. Kept in one place so both transports stay
         * identical, and stock is the 60×40 mm Design-A label the owner chose.
         */
        fun labelOf(payload: JsonObject?): AgentLabel {
            if (payload == null) return AgentLabel(title = "AYROVI LABEL", lines = emptyList(), barcodeValue = null)
            val code = payload["code"]?.jsonPrimitive?.contentOrNull
                ?: payload["reference"]?.jsonPrimitive?.contentOrNull
            val lines = mutableListOf<String>()
            code?.let { lines += it }
            payload["kind"]?.jsonPrimitive?.contentOrNull?.let { kind ->
                val qty = payload["quantity"]?.jsonPrimitive?.intOrNull
                lines += if (qty != null && qty > 1) "$kind x $qty" else kind
            }
            payload["customer"]?.jsonPrimitive?.contentOrNull?.let { lines += "CUSTOMER: $it" }
            (payload["station"] as? JsonObject)?.str("code")?.takeIf(String::isNotBlank)?.let { lines += "STATION: $it" }
            (payload["worker"] as? JsonObject)?.str("code")?.takeIf(String::isNotBlank)?.let { lines += "WORKER: $it" }
            payload["status"]?.jsonPrimitive?.contentOrNull?.let { lines += it }
            payload["scanCount"]?.jsonPrimitive?.intOrNull?.let { lines += "SCANS: $it" }
            // A reprint says so on paper too — the operator and the auditor can
            // tell a duplicate label from the original without the system.
            if (payload["reprint"]?.jsonPrimitive?.contentOrNull == "true") lines += "REPRINT"
            return AgentLabel(
                title = payload["title"]?.jsonPrimitive?.contentOrNull?.takeIf(String::isNotBlank) ?: "AYROVI LABEL",
                lines = lines,
                barcodeValue = code,
            )
        }
    }
}

/** One queued label as the handheld sees it. */
data class AgentPrintJob(
    val id: String,
    val stationId: String,
    val target: String,
    val targetRef: String?,
    val copies: Int,
    val transport: String,
    val displayName: String?,
    val requestedAt: String?,
    val label: AgentLabel,
)

/** What goes on paper — transport-agnostic (TSPL on the CT40, HTML in a browser). */
data class AgentLabel(
    val title: String,
    val lines: List<String>,
    val barcodeValue: String?,
    val widthMm: Int = 60,
    val heightMm: Int = 40,
    val gapMm: Int = 2,
)
