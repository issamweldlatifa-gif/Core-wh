package com.ayrovi.worker

data class ReceivingArrival(
    val id: String,
    val code: String,
    val customerName: String,
    val status: String,
    val cartons: Int,
)

data class ReceivingSession(
    val id: String,
    val code: String,
    val status: String,
    val expectedCartons: Int,
    val receivedCartons: Int,
    val flashKind: String? = null,
    val flashMessage: String? = null,
)
