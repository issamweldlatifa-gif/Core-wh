package com.ayrovi.worker

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.ayrovi.worker.design.*
import com.ayrovi.worker.di.AppContainer
import com.ayrovi.worker.presentation.WorkerTerminalApp
import com.ayrovi.worker.ui.AyroviApp

/** One native app/launcher. No WebView, no independent client per workflow. */
class MainActivity : ComponentActivity() {
    private var container: AppContainer? = null
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        container = runCatching { (application as AyroviWorkerApplication).container }.getOrNull()
        setContent {
            val dependencies = container
            if (dependencies == null) {
                AyroviTerminalTheme {
                    TerminalShell(
                        header = { TerminalHeader("TERMINAL LOCKED", "NOT AUTHENTICATED", null, "AUTH_ERROR") },
                        footer = { TerminalFooter("SUPERVISOR ATTENTION REQUIRED") { RetryAction({ recreate() }) } },
                    ) {
                        ErrorState("SECURE STARTUP UNAVAILABLE", "The terminal could not open secure storage or validate its configuration. No insecure fallback is allowed.")
                        WarningState("DO NOT CLEAR APP DATA YET", "A supervisor must reconcile any unresolved work before resetting this device.")
                    }
                }
            } else if (BuildConfig.WORKER_LEGACY_FALLBACK) {
                // Explicit build-time rollback only, SAME application ID. Retire after cutover gates.
                if (dependencies.frozenRollbackAllowed) AyroviApp(dependencies.sessions, dependencies.repository)
                else AyroviTerminalTheme {
                    TerminalShell(
                        header = { TerminalHeader("ROLLBACK BLOCKED", "DEVICE RECONCILIATION REQUIRED", null, "CHECKING") },
                        footer = { TerminalFooter("DO NOT REPLAY RECEIPTS") {} },
                    ) {
                        WarningState("UNRESOLVED OPERATION", "This device has an unresolved native operation. Use the approved native recovery build and reconcile with a supervisor before switching clients. Do not clear app data.")
                    }
                }
            } else WorkerTerminalApp(dependencies)
        }
    }
    override fun onStart() { super.onStart(); container?.connectivity?.start() }
    override fun onStop() { container?.connectivity?.stop(); super.onStop() }
}
