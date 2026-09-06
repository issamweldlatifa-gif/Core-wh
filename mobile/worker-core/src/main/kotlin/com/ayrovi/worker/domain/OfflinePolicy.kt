package com.ayrovi.worker.domain

/** Deny by default until AYROVI defines an authorized offline protocol. */
enum class OfflineClass { SAFE_OFFLINE, REQUIRES_SERVER, REQUIRES_SERVER_AUTHORIZATION, UNKNOWN }
enum class WorkerOperation { EDIT_DRAFT, CANCEL_SCAN, READ_SESSION, AUTHENTICATE, RECEIVE, PICK, PUTAWAY, COUNT, RETURN, REPORT_EXCEPTION }

object OfflinePolicy {
    fun classify(operation: WorkerOperation): OfflineClass = when (operation) {
        WorkerOperation.EDIT_DRAFT, WorkerOperation.CANCEL_SCAN -> OfflineClass.SAFE_OFFLINE
        WorkerOperation.READ_SESSION -> OfflineClass.REQUIRES_SERVER
        WorkerOperation.AUTHENTICATE, WorkerOperation.RECEIVE, WorkerOperation.PUTAWAY,
        WorkerOperation.REPORT_EXCEPTION -> OfflineClass.REQUIRES_SERVER_AUTHORIZATION
        WorkerOperation.PICK, WorkerOperation.COUNT, WorkerOperation.RETURN -> OfflineClass.UNKNOWN
    }
    fun mayExecuteOffline(operation: WorkerOperation) = classify(operation) == OfflineClass.SAFE_OFFLINE
}
