package com.ayrovi.worker.presentation

import androidx.lifecycle.ViewModel
import com.ayrovi.worker.data.TerminalPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Presentation preference, isolated from workflow/stock state and secure session storage. */
class AppearanceViewModel(private val preferences: TerminalPreferences) : ViewModel() {
    val theme = preferences.theme
    private val mutableWarning = MutableStateFlow<String?>(null)
    val warning = mutableWarning.asStateFlow()
    fun toggleTheme() {
        mutableWarning.value = if (preferences.selectTheme(theme.value.next())) null
        else "Contrast changed for this session only. The display preference could not be saved."
    }
}
