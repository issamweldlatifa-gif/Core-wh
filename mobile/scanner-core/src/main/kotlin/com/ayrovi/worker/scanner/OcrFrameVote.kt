package com.ayrovi.worker.scanner

/**
 * Multi-frame OCR confidence (Order §3): one bad camera frame must never be
 * accepted on its own. The live camera stream feeds every block through
 * [DirectedOcr]; this stabiliser keeps a short rolling window of the most
 * recent per-frame candidates and only "locks" a candidate once the SAME
 * normalised candidate has been seen repeatedly within a short time window.
 *
 * Pure logic (no Android, no ML Kit) so it is fully unit-testable. Speed is
 * preserved:
 *  - the window is tiny (default 3 frames / ~2.5 s) — the operator holding a
 *    steady label reaches the threshold in well under a second at 12–15 fps
 *    analysis cadence;
 *  - a high-confidence single frame never blocks submission (the review UI
 *    still asks the operator to confirm), while repeated bad reads are simply
 *    discarded.
 *
 * The locked candidate is a SUGGESTION: it is sent to the review UI exactly
 * like a single-frame candidate, and the operator still confirms it before
 * anything is submitted. Hardware/barcode scans never pass through here.
 */
class OcrFrameVote(
    /** Consecutive identical candidates required to lock. */
    private val threshold: Int = 2,
    /** Frames older than this are forgotten (a moved camera resets the vote). */
    private val windowMs: Long = 2_500,
    private val clock: () -> Long = { System.currentTimeMillis() },
) {
    private data class Hit(val token: String, val at: Long)

    private val recent = ArrayDeque<Hit>()
    private var locked: String? = null

    /**
     * Record one frame's best candidate (null = the frame had no valid SKU).
     * Returns the locked candidate once it has been seen [threshold] times in
     * the window, otherwise null. A locked value keeps being returned until
     * [reset] so the UI can act on it exactly once.
     */
    @Synchronized
    fun observe(candidate: String?): String? {
        val now = clock()
        locked?.let { return it }
        // Forget stale frames (camera moved / label changed).
        while (recent.isNotEmpty() && now - recent.first().at > windowMs) recent.removeFirst()
        if (candidate.isNullOrBlank()) {
            // A frame with no candidate weakens — but does not fully erase —
            // the running vote (ML Kit intermittently drops a frame).
            if (recent.size >= 2) recent.removeFirst()
            return null
        }
        val token = candidate.uppercase()
        recent.addLast(Hit(token, now))
        val count = recent.count { it.token == token }
        if (count >= threshold) {
            locked = token
            return token
        }
        return null
    }

    /** Clear the vote (new scan session, lane change, after confirmation). */
    @Synchronized
    fun reset() {
        recent.clear()
        locked = null
    }
}
