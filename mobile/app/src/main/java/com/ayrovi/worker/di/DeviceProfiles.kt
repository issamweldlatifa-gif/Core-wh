package com.ayrovi.worker.di

import com.ayrovi.worker.scanner.WorkerDevice

/**
 * PHASE 3 (ORDER 1, 2026-09-12): the Gradle flavor pins WHICH application is
 * running — AYROVI Phone / AYROVI CT40 / the transition AYROVI Worker.
 *
 * PHONE and CT40 are hard identities: the profile never depends on what the
 * hardware reports. AUTO (the universal transition app) keeps the historic
 * runtime sensing via [com.ayrovi.worker.scanner.HoneywellScanner.presentationMode].
 */
object DeviceProfiles {
    const val PHONE = "PHONE"
    const val CT40 = "CT40"
    const val AUTO = "AUTO"

    fun resolve(profile: String, detected: () -> WorkerDevice): WorkerDevice = when (profile) {
        PHONE -> WorkerDevice.PHONE
        CT40 -> WorkerDevice.CT40
        else -> detected()
    }
}
