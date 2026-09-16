package com.ayrovi.worker.printer

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The duplicate-protection window is what stands between the server re-offering
 * a label and a second copy coming out of the printer, so its eviction order is
 * part of the "one action = one label" rule, not an implementation detail.
 */
class JobIdWindowTest {

    @Test
    fun `the oldest claim ages out first - never an arbitrary one`() {
        val window = JobIdWindow(max = 3)
        listOf("job-a", "job-b", "job-c", "job-d").forEach(window::remember)

        assertEquals(listOf("job-b", "job-c", "job-d"), window.ids())
        assertFalse(window.contains("job-a")) // the oldest left
        assertTrue(window.contains("job-b"))  // the label still being offered stayed
        assertTrue(window.contains("job-d"))
    }

    @Test
    fun `a repeated claim does not reorder the window`() {
        val window = JobIdWindow(max = 3)
        listOf("job-a", "job-b").forEach(window::remember)
        window.remember("job-a") // the server offered it again — same claim
        listOf("job-c", "job-d").forEach(window::remember)

        assertEquals(listOf("job-b", "job-c", "job-d"), window.ids())
        assertFalse(window.contains("job-a"))
    }

    @Test
    fun `a blank id never occupies the window`() {
        val window = JobIdWindow(max = 3)
        window.remember("")
        window.remember("   ")

        assertTrue(window.ids().isEmpty())
        assertFalse(window.contains(""))
        assertFalse(window.contains("   "))
    }

    @Test
    fun `the window is bounded by its size`() {
        val window = JobIdWindow(max = 2)
        listOf("job-a", "job-b", "job-c").forEach(window::remember)

        assertEquals(listOf("job-b", "job-c"), window.ids())
    }

    @Test
    fun `a window rebuilt from storage keeps the persisted order`() {
        val window = JobIdWindow.of(listOf("job-a", "job-b", "job-c", "job-d"), max = 3)

        assertEquals(listOf("job-b", "job-c", "job-d"), window.ids())
    }

    @Test
    fun `ids merged from an older build collapse to one claim each`() {
        val window = JobIdWindow.of(listOf("job-a", "job-b", "job-a", "job-c"), max = 5)

        assertEquals(listOf("job-a", "job-b", "job-c"), window.ids())
    }
}
