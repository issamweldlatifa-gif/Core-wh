package com.ayrovi.worker.presentation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.ayrovi.worker.data.MutationJournal
import com.ayrovi.worker.data.ReceivingGateway
import com.ayrovi.worker.domain.ReceivingWorkflow

/** Thin Android lifecycle host. Business/interaction sequencing is unit-testable in worker-core. */
class ReceivingViewModel(gateway: ReceivingGateway, journal: MutationJournal, workerId: String, permissions: Set<String>) : ViewModel() {
    val workflow = ReceivingWorkflow(gateway, journal, workerId, permissions, viewModelScope)
    val state = workflow.state
    private var initialized = false

    fun activate(permissions: Set<String>, available: Boolean, recoverySessionId: String?) {
        workflow.updateAccess(permissions, available)
        if (available && !initialized) {
            initialized = true
            workflow.initialize(recoverySessionId)
        }
    }
}
