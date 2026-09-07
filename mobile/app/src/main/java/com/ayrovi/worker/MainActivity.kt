package com.ayrovi.worker

import android.content.Intent
import android.os.Bundle
import androidx.activity.SystemBarStyle
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.toArgb
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

    /**
     * Monotonic request counter bumped whenever an intent asks the worker app
     * to open RECEIVING (a Receiving card tray notification). Read inside
     * setContent so the route reacts both on cold start (onCreate) and when a
     * notification arrives while the singleTask activity is already running
     * (onNewIntent). launchMode="singleTask" → Android always delivers the tap
     * to this one instance, so this is the only entry the UI needs.
     */
    private val openReceivingRequests = mutableStateOf(0L)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        container = runCatching { (application as AyroviWorkerApplication).container }.getOrNull()
        if (intent?.getBooleanExtra(EXTRA_OPEN_RECEIVING, false) == true) openReceivingRequests.value += 1
        applyAppearance(if (BuildConfig.WORKER_LEGACY_FALLBACK) TerminalThemeMode.BLACK
            else container?.appearance?.theme?.value ?: TerminalThemeMode.WHITE)
        setContent {
            val dependencies = container
            if (dependencies == null) {
                AyroviTerminalTheme {
                    TerminalShell(
                        header = { TerminalHeader("TERMINAL LOCKED", "NOT AUTHENTICATED", null, "AUTH_ERROR") },
                        footer = { TerminalFooter("SUPERVISOR ATTENTION REQUIRED") { RetryAction({ recreate() }) } },
                    ) {
                        ErrorState("TERMINAL UNAVAILABLE", "Ask your supervisor for help before using this device.")
                        WarningState("WORK NEEDS CHECKING", "Do not reset this device until your supervisor has checked the last receipt.")
                    }
                }
            } else if (BuildConfig.WORKER_LEGACY_FALLBACK) {
                // Explicit build-time rollback only, SAME application ID. Retire after cutover gates.
                if (dependencies.frozenRollbackAllowed) AyroviApp(dependencies.sessions, dependencies.repository)
                else AyroviTerminalTheme {
                    TerminalShell(
                        header = { TerminalHeader("WORK STOPPED", "SUPERVISOR REQUIRED", null, "CHECKING") },
                        footer = { TerminalFooter("DO NOT RECEIVE THE ITEM AGAIN") {} },
                    ) {
                        WarningState("UNRESOLVED OPERATION", "An earlier receipt needs checking. Ask your supervisor before continuing. Do not reset this device.")
                    }
                }
            } else WorkerTerminalApp(
                dependencies,
                ::applyAppearance,
                openReceivingRequest = openReceivingRequests.value,
            )
        }
    }

    /** Tray-notification tap while the app is already foregrounded/running. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.getBooleanExtra(EXTRA_OPEN_RECEIVING, false)) openReceivingRequests.value += 1
    }

    private fun applyAppearance(mode: TerminalThemeMode) {
        val palette = TerminalPalette.forMode(mode)
        val style = if (mode != TerminalThemeMode.WHITE) SystemBarStyle.dark(palette.background.toArgb())
        else SystemBarStyle.light(palette.background.toArgb(), palette.background.toArgb())
        enableEdgeToEdge(statusBarStyle = style, navigationBarStyle = style)
    }
    override fun onStart() { super.onStart(); container?.connectivity?.start() }
    override fun onStop() { container?.connectivity?.stop(); super.onStop() }

    companion object {
        /** Set by ReceivingNotifier; opens the worker app on RECEIVING home. */
        const val EXTRA_OPEN_RECEIVING = "ayrovi.intent.extra.OPEN_RECEIVING"
    }
}
