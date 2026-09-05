package com.ayrovi.worker.di

import android.content.Context
import com.ayrovi.worker.BuildConfig
import com.ayrovi.worker.data.SessionStore
import com.ayrovi.worker.data.WorkerRepository

/** Explicit application-scoped dependency injection; one client/store, no service locator in UI. */
class AppContainer(context: Context) {
    val sessions = SessionStore(context.applicationContext)
    val repository = WorkerRepository(sessions, BuildConfig.API_BASE_URL)
    val connectivity = NetworkMonitor(context.applicationContext, repository.transport::networkAvailable)
}
