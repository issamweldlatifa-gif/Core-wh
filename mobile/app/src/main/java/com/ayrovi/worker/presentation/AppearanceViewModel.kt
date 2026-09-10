package com.ayrovi.worker.presentation

import androidx.lifecycle.ViewModel
import com.ayrovi.worker.data.TerminalPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Presentation preference, isolated from workflow/stock state and secure session storage. */
class AppearanceViewModel(private val preferences: TerminalPreferences) : ViewModel() {
    val theme = preferences.theme
    val glove = preferences.glove
    val glare = preferences.glare
    val coachPending = preferences.coachPending
    fun toggleGlove() {
        preferences.setGlove(!glove.value)
    }
    fun toggleGlare() {
        preferences.setGlare(!glare.value)
    }
    fun markCoachDone() {
        preferences.markCoachDone()
    }
    private val mutableWarning = MutableStateFlow<String?>(null)
    val warning = mutableWarning.asStateFlow()
    fun toggleTheme() {
        mutableWarning.value = if (preferences.selectTheme(if (theme.value == com.ayrovi.worker.design.TerminalThemeMode.WHITE) preferences.darkMode else com.ayrovi.worker.design.TerminalThemeMode.WHITE)) null
        else "Display changed for now. Your preference could not be saved."
    }
}
