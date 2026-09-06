package com.ayrovi.worker.domain

import com.ayrovi.worker.data.MeResponse
import com.ayrovi.worker.data.TerminalContext
import com.ayrovi.worker.data.TerminalTask

/** Visibility only. NestJS guards remain the authorization boundary on every request. */
object WorkerAccess {
    const val VIEW_RECEIVING = "receiving.view"
    const val EXECUTE_RECEIVING = "receiving.execute"
    const val RESOLVE_RECEIVING = "receiving.resolve_discrepancy"

    fun isWorkerSession(me: MeResponse) = me.application == "WORKER_NATIVE" &&
        "WORKER_NATIVE" in me.allowedApplications && !me.user?.id.isNullOrBlank()

    fun visibleTasks(me: MeResponse, context: TerminalContext): List<TerminalTask> = permittedTasks(me, context).filter { it.ready == true }

    fun permittedTasks(me: MeResponse, context: TerminalContext): List<TerminalTask> {
        if (!isWorkerSession(me) || context.worker?.id != me.user?.id) return emptyList()
        return context.tasks.filter { task ->
            task.permission != null && task.permission in me.permissions &&
                (task.key != "receiving" || VIEW_RECEIVING in me.permissions)
        }.distinctBy { it.key }
    }
}
