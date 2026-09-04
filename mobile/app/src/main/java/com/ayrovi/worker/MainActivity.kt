package com.ayrovi.worker

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.remember
import com.ayrovi.worker.data.SessionStore
import com.ayrovi.worker.ui.AyroviApp

/**
 * AYROVI Worker — native Android worker terminal.
 *
 * This is NOT a WebView. It is a real native app whose single job is to open
 * a WORKER_NATIVE session, render the workflow the backend assigns to this
 * worker/station, and run the shared Scanner Core for that workflow.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val store = SessionStore(applicationContext)
        setContent {
            val sessionStore = remember { store }
            AyroviApp(store = sessionStore)
        }
    }
}
