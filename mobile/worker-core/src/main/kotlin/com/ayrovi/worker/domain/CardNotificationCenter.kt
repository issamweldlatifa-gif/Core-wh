package com.ayrovi.worker.domain

import com.ayrovi.worker.data.CartonCard
import com.ayrovi.worker.data.ProductCard
import com.ayrovi.worker.data.ReceivingHome

/**
 * UNREAD notification state for the dispatched receiving cards.
 *
 * The Worker badge used to render `productCardsPending + cartonCardsPending`,
 * i.e. the number of cards still to receive. That is a WORKLOAD number, not a
 * notification number: it stayed on screen after the worker had already seen
 * (and even completed) the work, and only ever dropped when the backend feed
 * itself drained. The badge must instead answer one question:
 *
 *     "how many dispatched cards has this worker NOT looked at yet?"
 *
 * The model is therefore identity-based, never counter-based:
 *
 *   UNREAD  — the card id is present in the feed and not in the read set
 *   READ    — the worker opened the lane holding that card
 *   dropped — the card left the feed (completed / force-deleted); its id is
 *             pruned from the read set so it can never resurrect a count
 *
 * `badge = unread(feed) = ids(feed) - readIds`. Because it is derived from the
 * authoritative feed on every recomputation, a completed or force-deleted card
 * cannot leave a stale number behind, and no cached counter is ever trusted.
 */
data class CardNotificationState(
    /** Card ids the worker has already seen, partitioned per lane. */
    val readProduct: Set<String> = emptySet(),
    val readCarton: Set<String> = emptySet(),
    /** Live unread counts derived from the last feed reconciliation. */
    val unreadProduct: Int = 0,
    val unreadCarton: Int = 0,
) {
    val unreadTotal: Int get() = unreadProduct + unreadCarton
    /** Badges are absent (null) rather than a drawn zero. */
    val badge: Int? get() = unreadTotal.takeIf { it > 0 }
}

/** Persistence for the read set. Survives process death and re-login. */
interface CardReadStore {
    fun load(workerId: String): Pair<Set<String>, Set<String>>
    fun save(workerId: String, product: Set<String>, carton: Set<String>)
    fun clear(workerId: String)
    /** v1.7.5 purge: remove EVERY worker's read set (finished-rapport wipe). */
    fun clearAll()
}

/** In-memory default: correct for tests and for a device with no store wired. */
class InMemoryCardReadStore : CardReadStore {
    private val data = mutableMapOf<String, Pair<Set<String>, Set<String>>>()
    @Synchronized override fun load(workerId: String) = data[workerId] ?: (emptySet<String>() to emptySet())
    @Synchronized override fun save(workerId: String, product: Set<String>, carton: Set<String>) {
        data[workerId] = product to carton
    }
    @Synchronized override fun clear(workerId: String) { data.remove(workerId) }
    @Synchronized override fun clearAll() { data.clear() }
}

object CardNotificationCenter {

    /** Stable identity of a card across feed refreshes. */
    fun idOf(card: ProductCard): String =
        card.id ?: card.sku ?: card.reference ?: card.identifiers.firstOrNull() ?: ""

    fun idOf(card: CartonCard): String =
        card.id ?: card.externalCartonId ?: card.reference ?: card.qrCodeValue
            ?: card.barcodeValue ?: card.identifiers.firstOrNull() ?: ""

    fun productIds(home: ReceivingHome?): Set<String> =
        home?.productCards.orEmpty().map(::idOf).filter { it.isNotEmpty() }.toSet()

    fun cartonIds(home: ReceivingHome?): Set<String> =
        home?.cartonCards.orEmpty().map(::idOf).filter { it.isNotEmpty() }.toSet()

    /**
     * Reconcile the persisted read set against a fresh feed.
     *
     * Pruning to the live ids is what makes "complete the last task" land on
     * zero without a restart: the completed card leaves the feed, so it is
     * neither unread (not in the feed) nor retained in the read set.
     */
    fun reconcile(previous: CardNotificationState, home: ReceivingHome?): CardNotificationState {
        val liveProduct = productIds(home)
        val liveCarton = cartonIds(home)
        // A null feed (permission-less or a failed poll) must not invent reads
        // or unreads; keep the previous state untouched.
        if (home == null) return previous
        val readProduct = previous.readProduct intersect liveProduct
        val readCarton = previous.readCarton intersect liveCarton
        return previous.copy(
            readProduct = readProduct,
            readCarton = readCarton,
            unreadProduct = (liveProduct - readProduct).size,
            unreadCarton = (liveCarton - readCarton).size,
        )
    }

    /** The worker opened the PRODUCT lane: everything visible there is now READ. */
    fun markProductRead(state: CardNotificationState, home: ReceivingHome?): CardNotificationState {
        val live = productIds(home)
        return state.copy(readProduct = state.readProduct + live, unreadProduct = 0)
    }

    /** The worker opened the CARTON lane: everything visible there is now READ. */
    fun markCartonRead(state: CardNotificationState, home: ReceivingHome?): CardNotificationState {
        val live = cartonIds(home)
        return state.copy(readCarton = state.readCarton + live, unreadCarton = 0)
    }

    /** Reading the whole Home screen acknowledges both lanes. */
    fun markAllRead(state: CardNotificationState, home: ReceivingHome?): CardNotificationState =
        markCartonRead(markProductRead(state, home), home)
}
