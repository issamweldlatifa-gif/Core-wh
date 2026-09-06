package com.ayrovi.worker

import android.os.Bundle
import androidx.activity.SystemBarStyle
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
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        container = runCatching { (application as AyroviWorkerApplication).container }.getOrNull()
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
            } else WorkerTerminalApp(dependencies, ::applyAppearance)
        }
    }
    private fun applyAppearance(mode: TerminalThemeMode) {
        val palette = TerminalPalette.forMode(mode)
        val style = if (mode != TerminalThemeMode.WHITE) SystemBarStyle.dark(palette.background.toArgb())
        else SystemBarStyle.light(palette.background.toArgb(), palette.background.toArgb())
        enableEdgeToEdge(statusBarStyle = style, navigationBarStyle = style)
    }
    override fun onStart() { super.onStart(); container?.connectivity?.start() }
    override fun onStop() { container?.connectivity?.stop(); super.onStop() }
}
