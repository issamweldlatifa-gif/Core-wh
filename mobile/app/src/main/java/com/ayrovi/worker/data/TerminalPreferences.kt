package com.ayrovi.worker.data

import android.content.Context
import com.ayrovi.worker.design.TerminalThemeMode
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Non-sensitive display preferences ONLY. Never stores auth, permissions, task or receipt data. */
class TerminalPreferences(context: Context, fileName: String = "ayrovi_terminal_appearance",
    defaultMode: TerminalThemeMode = TerminalThemeMode.WHITE,
    val darkMode: TerminalThemeMode = TerminalThemeMode.BLACK) {
    private val preferences = context.applicationContext.getSharedPreferences(fileName, Context.MODE_PRIVATE)
    private val mutable = MutableStateFlow(runCatching {
        TerminalThemeMode.valueOf(preferences.getString("contrast_mode", defaultMode.name) ?: defaultMode.name)
    }.getOrDefault(defaultMode))
    val theme = mutable.asStateFlow()

    @Synchronized fun selectTheme(mode: TerminalThemeMode): Boolean {
        // A failed display-preference write is NOT an auth fallback. The selected contrast still
        // applies for this process; callers explicitly report that it was not persisted.
        val persisted = runCatching { preferences.edit().putString("contrast_mode", mode.name).commit() }.getOrDefault(false)
        mutable.value = mode
        return persisted
    }
}
