package com.ayrovi.worker

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.ayrovi.worker.scanner.HoneywellScanner
import com.ayrovi.worker.scanner.ScanCoordinator
import com.ayrovi.worker.scanner.ScannerService
import com.ayrovi.worker.scanner.WorkerDevice
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DeviceDetectionTest {
    @Test fun existingHoneywellDetectorSelectsOnlyKnownCt40Models() {
        for (model in listOf("CT40", "CT40XP", "CT40 XP", "Dolphin CT40", "CT40-L1N")) {
            assertEquals(model, WorkerDevice.CT40, HoneywellScanner.presentationMode("Honeywell", "Honeywell", model))
        }
    }
    @Test fun unknownOtherAndNarrowPhonesFallbackToPhone() {
        for (model in listOf(null, "", "UNKNOWN", "CT30", "CN80", "CT400", "notct40")) {
            assertEquals(WorkerDevice.PHONE, HoneywellScanner.presentationMode("Honeywell", "Honeywell", model))
        }
        assertEquals(WorkerDevice.PHONE, HoneywellScanner.presentationMode("Samsung", "Samsung", "SM-A015"))
        assertEquals(WorkerDevice.PHONE, HoneywellScanner.presentationMode(null, null, "CT40"))
        assertEquals(WorkerDevice.PHONE, HoneywellScanner.presentationMode("Unknown", "Unknown", "CT40"))
        // Width is not an input to this existing detection capability.
    }
    @Test fun plainPhoneReportsNoHardwareScanner() {
        // The CI emulator is a plain phone: no Honeywell Aidc, no DataWedge.
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val service = ScannerService(context, ScanCoordinator({ _, _, _ -> }, {}))
        service.initialize()
        service.start()
        try {
            assertFalse(service.hasHardware)
            assertFalse(service.isAvailable())
        } finally {
            service.stop()
        }
    }
}
