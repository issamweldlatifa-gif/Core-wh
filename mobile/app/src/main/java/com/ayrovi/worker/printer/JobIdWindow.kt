package com.ayrovi.worker.printer

/**
 * THE DUPLICATE-PROTECTION WINDOW (task §18) — the job ids this handheld has
 * already claimed, oldest first, bounded.
 *
 * Why not simply "a set in preferences": the eviction has to be OLDEST-FIRST.
 * A label the CT40 printed but could not REPORT stays QUEUED on the server and
 * is offered again on the next poll — its id must survive in this window until
 * the report lands. Dropping an arbitrary id (what an unordered `StringSet`
 * does) can forget exactly the label that is still being offered, and the next
 * poll puts a second copy on paper: the owner's rule is one action = one label.
 *
 * Pure Kotlin on purpose: the policy is unit-tested without Android, and the
 * store only does the reading and writing.
 */
internal class JobIdWindow(private val max: Int = DEFAULT_MAX) {

    private val order = ArrayDeque<String>()
    private val seen = HashSet<String>()

    init {
        require(max > 0) { "the duplicate-protection window must hold at least one id" }
    }

    fun contains(jobId: String): Boolean = seen.contains(jobId)

    /**
     * Remembers one claim. Blank ids are ignored (they are refused upstream and
     * must never occupy the window) and a repeat does not reorder the queue —
     * the first claim is what decides when the id ages out.
     */
    fun remember(jobId: String) {
        if (jobId.isBlank() || !seen.add(jobId)) return
        order.addLast(jobId)
        while (order.size > max) seen.remove(order.removeFirst())
    }

    /** Oldest → newest. What gets persisted, so the order survives a restart. */
    fun ids(): List<String> = order.toList()

    companion object {
        /** ~a busy day of labels on one handheld; the ring above is the guard. */
        const val DEFAULT_MAX = 200

        /** Rebuilds a window from persisted ids (oldest first), ignoring blanks. */
        fun of(ids: List<String>, max: Int = DEFAULT_MAX): JobIdWindow {
            val window = JobIdWindow(max)
            ids.forEach { window.remember(it) }
            return window
        }
    }
}
