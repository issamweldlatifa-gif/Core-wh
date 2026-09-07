package com.ayrovi.worker.di

import android.content.Context
import com.ayrovi.worker.domain.WorkerSessionUseCase
import com.ayrovi.worker.BuildConfig
import com.ayrovi.worker.scanner.HoneywellScanner
import com.ayrovi.worker.scanner.WorkerDevice
import com.ayrovi.worker.feedback.AndroidAudioFeedback
import com.ayrovi.worker.feedback.ReceivingNotifier
import com.ayrovi.worker.design.TerminalThemeMode
import com.ayrovi.worker.data.TerminalPreferences
import com.ayrovi.worker.data.SessionStore
import com.ayrovi.worker.data.WorkerRepository

/** Explicit application-scoped dependency injection; one client/store, no service locator in UI. */
class AppContainer(context: Context) {
    val device = runCatching { HoneywellScanner.presentationMode() }.getOrDefault(WorkerDevice.PHONE)
    val audio = AndroidAudioFeedback.get(context.applicationContext)
    val notifier = ReceivingNotifier(context.applicationContext)
    val sessions = SessionStore(context.applicationContext)
    init { check(sessions.deviceCode.isNotBlank()) { "Secure device identity is unavailable." } }
    val repository = WorkerRepository(sessions, BuildConfig.API_BASE_URL)
    val appearance = TerminalPreferences(context.applicationContext,
        defaultMode = if (device == WorkerDevice.CT40) TerminalThemeMode.INDUSTRIAL else TerminalThemeMode.WHITE,
        darkMode = if (device == WorkerDevice.CT40) TerminalThemeMode.INDUSTRIAL else TerminalThemeMode.BLACK)
    val workerSession = WorkerSessionUseCase(repository, sessions)
    val frozenRollbackAllowed = sessions.read() == null
    val connectivity = NetworkMonitor(context.applicationContext, repository.transport::networkAvailable)
}
