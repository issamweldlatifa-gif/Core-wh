package com.ayrovi.worker.domain

/** Non-replayed outcome event. A successful decoder alone never emits warehouse success. */
data class ReceivingSignal(val id: Long, val tone: MessageTone, val title: String, val detail: String, val code: String? = null)
