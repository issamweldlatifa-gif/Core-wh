package com.ayrovi.worker.presentation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.ayrovi.worker.data.ReceivingGateway
import com.ayrovi.worker.data.ReportPhotoInput
import com.ayrovi.worker.data.ReportPhotoView
import com.ayrovi.worker.domain.AudioFeedback
import com.ayrovi.worker.domain.MessageTone
import com.ayrovi.worker.domain.ReceivingReportWorkflow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * CONFIRMATION REPORT (ORDER 01) — worker entry.
 *
 * Holds the not-yet-sent photo picks (device memory only; anything saved or
 * submitted is re-read from the server view). Draft/submit always send the
 * full set: persisted photos re-sent as inputs + pending picks, because the
 * backend replaces the photo set when the photos key is present. A pending
 * pick is dropped only once its bytes reappear in the persisted view, so a
 * failed send never loses a photo.
 */
class ReceivingReportViewModel(
    gateway: ReceivingGateway,
    permissions: Set<String>,
    private val audio: AudioFeedback = AudioFeedback.Silent,
) : ViewModel() {
    private val workflow = ReceivingReportWorkflow(gateway, permissions, viewModelScope)
    val state = workflow.state

    private val _pending = MutableStateFlow<List<ReportPhotoInput>>(emptyList())
    val pendingPhotos: StateFlow<List<ReportPhotoInput>> = _pending.asStateFlow()

    private var initialized = false
    private var foreground = false
    private var lastSent: List<ReportPhotoInput> = emptyList()

    init {
        viewModelScope.launch {
            workflow.events.collect { event ->
                runCatching {
                    when (event.tone) {
                        MessageTone.SUCCESS -> if (foreground) audio.success()
                        MessageTone.ERROR -> if (foreground) audio.error()
                        MessageTone.WARNING -> if (foreground) audio.warning()
                        MessageTone.INFO -> Unit
                    }
                }
            }
        }
        viewModelScope.launch {
            state.collect { current ->
                reconcilePending()
                // No open session/report: no photo picks may survive either.
                if (!current.loading && current.noSession && current.report == null) {
                    _pending.value = emptyList()
                    lastSent = emptyList()
                }
            }
        }
    }

    fun activate(permissions: Set<String>, available: Boolean) {
        workflow.updateAccess(permissions)
        // The report starts with loading=true, so gating on !loading here
        // NEVER opens (that clause was copied from the home screen, whose
        // initial busy=false). The initialized flag is the only guard:
        // open once when the lane is available.
        // After submit the submitted report stays visible (locked) — the
        // screen is empty only when there is truly no session/report, in
        // which case a revisit runs a fresh lookup so a NEW session (if
        // the worker started one) loads without a manual REFRESH.
        if (available && (!initialized || (state.value.noSession && state.value.report == null))) {
            initialized = true
            workflow.initialize()
        }
    }

    fun setForeground(value: Boolean) {
        foreground = value
    }

    fun refresh() = workflow.refresh()

    fun dismissMessage() = workflow.dismissMessage()

    /** Full photo set for the next draft/submit (persisted re-sent + pending). */
    fun fullPhotos(): List<ReportPhotoInput> {
        val persisted = state.value.report?.photos.orEmpty().mapNotNull { p: ReportPhotoView ->
            val url = p.dataUrl
            if (url.isNullOrBlank()) null else ReportPhotoInput(url, p.caption, p.lineId)
        }
        return persisted + _pending.value
    }

    fun canAddPhoto(): Boolean = fullPhotos().size < ReceivingReportWorkflow.MAX_PHOTOS

    fun addPending(photo: ReportPhotoInput) {
        if (!canAddPhoto()) return
        _pending.update { it + photo }
    }

    fun removePending(index: Int) {
        _pending.update { current ->
            if (index in current.indices) current.filterIndexed { i, _ -> i != index } else current
        }
    }

    fun saveDraft(description: String?, observation: String?) {
        lastSent = _pending.value
        workflow.saveDraft(description, observation, fullPhotos().take(ReceivingReportWorkflow.MAX_PHOTOS))
    }

    fun damage(lineId: String, quantity: Int, note: String?) = workflow.damage(lineId, quantity, note)

    fun submit(description: String?, observation: String?) {
        lastSent = _pending.value
        workflow.submit(description, observation, fullPhotos().take(ReceivingReportWorkflow.MAX_PHOTOS))
    }

    private fun reconcilePending() {
        if (lastSent.isEmpty()) return
        val persisted = state.value.report?.photos.orEmpty().mapNotNull { it.dataUrl }.toSet()
        if (persisted.isEmpty()) return
        val confirmed = lastSent.map { it.dataUrl }.toSet().intersect(persisted)
        if (confirmed.isEmpty()) return
        _pending.update { list -> list.filterNot { it.dataUrl in confirmed } }
        lastSent = lastSent.filterNot { it.dataUrl in confirmed }
    }
}
