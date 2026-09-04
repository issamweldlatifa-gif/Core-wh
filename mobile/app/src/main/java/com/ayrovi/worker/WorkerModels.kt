package com.ayrovi.worker

data class AuthTokens(val accessToken: String, val refreshToken: String)

data class WorkerTask(
    val key: String,
    val label: String,
    val permission: String,
    val ready: Boolean,
)

data class WorkerStation(
    val code: String,
    val name: String,
    val department: String,
)

data class WorkerContext(
    val worker: WorkerIdentity? = null,
    val station: WorkerStation?,
    val tasks: List<WorkerTask>,
    val home: String,
)

data class WorkerIdentity(
    val id: String,
    val name: String,
    val employeeCode: String,
    val role: String,
)
