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

    private val gloveMutable = MutableStateFlow(runCatching {
        preferences.getBoolean("glove_mode", false)
    }.getOrDefault(false))
    val glove = gloveMutable.asStateFlow()

    @Synchronized fun setGlove(enabled: Boolean) {
        runCatching { preferences.edit().putBoolean("glove_mode", enabled).commit() }
        gloveMutable.value = enabled
    }

    /// GLARE BOOST (harsh-sunlight aisles): persisted like the glove mode so a
    /// CT40 coming back from sleep keeps the operator's display choice.
    private val glareMutable = MutableStateFlow(runCatching {
        preferences.getBoolean("glare_boost", false)
    }.getOrDefault(false))
    val glare = glareMutable.asStateFlow()

    @Synchronized fun setGlare(enabled: Boolean) {
        runCatching { preferences.edit().putBoolean("glare_boost", enabled).commit() }
        glareMutable.value = enabled
    }

    /// First-run coach marks: shown once per install, never again.
    private val coachMutable = MutableStateFlow(runCatching {
        !preferences.getBoolean("coach_marks_v2_done", false)
    }.getOrDefault(true))
    val coachPending = coachMutable.asStateFlow()

    @Synchronized fun markCoachDone() {
        runCatching { preferences.edit().putBoolean("coach_marks_v2_done", true).commit() }
        coachMutable.value = false
    }
}
