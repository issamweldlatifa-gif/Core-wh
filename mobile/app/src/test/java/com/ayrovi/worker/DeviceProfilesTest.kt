package com.ayrovi.worker

import com.ayrovi.worker.di.DeviceProfiles
import com.ayrovi.worker.scanner.WorkerDevice
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

/** PHASE 3: the application flavor pins the device profile; AUTO senses. */
class DeviceProfilesTest {

    @Test
    fun `phone flavor is always PHONE regardless of hardware`() =
        assertEquals(WorkerDevice.PHONE, DeviceProfiles.resolve(DeviceProfiles.PHONE) { WorkerDevice.CT40 })

    @Test
    fun `ct40 flavor is always CT40 regardless of hardware`() =
        assertEquals(WorkerDevice.CT40, DeviceProfiles.resolve(DeviceProfiles.CT40) { WorkerDevice.PHONE })

    @Test
    fun `universal follows hardware detection`() {
        assertEquals(WorkerDevice.PHONE, DeviceProfiles.resolve(DeviceProfiles.AUTO) { WorkerDevice.PHONE })
        assertEquals(WorkerDevice.CT40, DeviceProfiles.resolve(DeviceProfiles.AUTO) { WorkerDevice.CT40 })
    }
}
