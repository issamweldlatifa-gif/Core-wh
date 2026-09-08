package com.ayrovi.worker

import com.ayrovi.worker.data.CartonCard
import com.ayrovi.worker.data.ProductCard
import com.ayrovi.worker.data.ReceivingHome
import com.ayrovi.worker.domain.CardNotificationCenter
import com.ayrovi.worker.domain.CardNotificationState
import kotlin.test.*

/**
 * NOTIFICATION BADGE (PART 2).
 *
 * The badge must represent UNREAD notifications only — never the total number
 * of cards and never the number of completed tasks. These tests pin the
 * lifecycle the old counter-based badge got wrong: it kept showing a number
 * after the worker had read and finished the work.
 */
class CardNotificationCenterTest {

    private fun product(id: String) = ProductCard(id = id, sku = id, expected = 1, remaining = 1)
    private fun carton(id: String) = CartonCard(id = id, externalCartonId = id)

    private fun home(products: List<String> = emptyList(), cartons: List<String> = emptyList()) =
        ReceivingHome(
            productCards = products.map(::product),
            cartonCards = cartons.map(::carton),
            productCardsPending = products.size,
            cartonCardsPending = cartons.size,
        )

    @Test fun `a new card is unread and shows a badge of one`() {
        val state = CardNotificationCenter.reconcile(CardNotificationState(), home(products = listOf("P1")))
        assertEquals(1, state.unreadProduct)
        assertEquals(1, state.badge)
    }

    @Test fun `opening the lane marks it read and the badge disappears immediately`() {
        val feed = home(products = listOf("P1"))
        var state = CardNotificationCenter.reconcile(CardNotificationState(), feed)
        state = CardNotificationCenter.markProductRead(state, feed)
        assertEquals(0, state.unreadProduct)
        // Zero unread renders as NO badge, not as a drawn zero.
        assertNull(state.badge)
    }

    @Test fun `a read card stays read across later polls while the work is still pending`() {
        val feed = home(products = listOf("P1"))
        var state = CardNotificationCenter.markProductRead(
            CardNotificationCenter.reconcile(CardNotificationState(), feed), feed,
        )
        // The card is still in the feed (work not finished) — it must NOT
        // become unread again just because the app polled.
        state = CardNotificationCenter.reconcile(state, feed)
        assertNull(state.badge)
    }

    @Test fun `only the genuinely new card counts when a second card arrives`() {
        val first = home(products = listOf("P1"))
        var state = CardNotificationCenter.markProductRead(
            CardNotificationCenter.reconcile(CardNotificationState(), first), first,
        )
        state = CardNotificationCenter.reconcile(state, home(products = listOf("P1", "P2")))
        assertEquals(1, state.badge, "P1 was already read; only P2 is unread")
    }

    @Test fun `completing the last task drops the badge to zero without a restart`() {
        val feed = home(products = listOf("P1"))
        var state = CardNotificationCenter.reconcile(CardNotificationState(), feed)
        assertEquals(1, state.badge)
        // The card leaves the feed once received: nothing unread remains.
        state = CardNotificationCenter.reconcile(state, home())
        assertNull(state.badge)
        assertEquals(0, state.unreadTotal)
    }

    @Test fun `a completed card does not linger in the read set and cannot resurrect`() {
        val feed = home(products = listOf("P1"))
        var state = CardNotificationCenter.markProductRead(
            CardNotificationCenter.reconcile(CardNotificationState(), feed), feed,
        )
        state = CardNotificationCenter.reconcile(state, home())
        assertTrue(state.readProduct.isEmpty(), "ids of cards that left the feed are pruned")
        // A brand-new card that happens to reuse the id is correctly unread.
        state = CardNotificationCenter.reconcile(state, home(products = listOf("P1")))
        assertEquals(1, state.badge)
    }

    @Test fun `product and carton lanes are counted independently and together`() {
        val feed = home(products = listOf("P1", "P2"), cartons = listOf("C1"))
        var state = CardNotificationCenter.reconcile(CardNotificationState(), feed)
        assertEquals(2, state.unreadProduct)
        assertEquals(1, state.unreadCarton)
        assertEquals(3, state.badge)
        // Reading only the PRODUCT lane must not silence the CARTON lane.
        state = CardNotificationCenter.markProductRead(state, feed)
        assertEquals(1, state.badge)
        state = CardNotificationCenter.markCartonRead(state, feed)
        assertNull(state.badge)
    }

    @Test fun `force-deleted cards clear their notification`() {
        val feed = home(products = listOf("P1"), cartons = listOf("C1"))
        var state = CardNotificationCenter.reconcile(CardNotificationState(), feed)
        assertEquals(2, state.badge)
        // Admin force-deleted the arrival: the backend feed no longer carries
        // the cards, so no notification may claim work is waiting.
        state = CardNotificationCenter.reconcile(state, home())
        assertNull(state.badge)
    }

    @Test fun `an unavailable feed never invents or clears notifications`() {
        val feed = home(products = listOf("P1"))
        val state = CardNotificationCenter.reconcile(CardNotificationState(), feed)
        // A failed poll (null feed) must leave the state exactly as it was.
        assertEquals(state, CardNotificationCenter.reconcile(state, null))
    }

    @Test fun `cards without an id fall back to a stable business identifier`() {
        val feed = ReceivingHome(
            productCards = listOf(ProductCard(id = null, sku = "SKU-9")),
            cartonCards = listOf(CartonCard(id = null, externalCartonId = "CTN-9")),
        )
        var state = CardNotificationCenter.reconcile(CardNotificationState(), feed)
        assertEquals(2, state.badge)
        state = CardNotificationCenter.markAllRead(state, feed)
        // Re-reconciling the same feed keeps them read: the identity is stable.
        assertNull(CardNotificationCenter.reconcile(state, feed).badge)
    }
}
