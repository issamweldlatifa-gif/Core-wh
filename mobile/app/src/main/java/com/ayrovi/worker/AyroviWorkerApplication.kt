package com.ayrovi.worker

import android.app.Application
import com.ayrovi.worker.di.AppContainer

class AyroviWorkerApplication : Application() {
    // Lazy so Keystore/config errors can be rendered fail-closed by the Activity.
    val container: AppContainer by lazy { AppContainer(applicationContext) }
}
