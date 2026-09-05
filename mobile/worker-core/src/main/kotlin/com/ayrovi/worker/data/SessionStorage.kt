package com.ayrovi.worker.data

/** One secure store per application. Token rotation and a NEW login are different boundaries. */
interface SessionStorage {
    val deviceCode: String
    var employeeCode: String?
    fun snapshot(): SessionSnapshot
    fun replace(expectedVersion: Long, tokens: AuthTokens, newLogin: Boolean = false): Boolean
    fun clear()
    fun clearIfVersion(expectedVersion: Long): Boolean
    fun clearIfIdentity(expectedIdentity: Long): Boolean
    fun accessToken(): String? = snapshot().tokens?.accessToken
    fun refreshToken(): String? = snapshot().tokens?.refreshToken
    fun hasSession(): Boolean = snapshot().tokens != null
}

data class SessionSnapshot(val version: Long, val tokens: AuthTokens?, val identityVersion: Long = 0) {
    override fun toString() = "SessionSnapshot(version=$version, authenticated=${tokens != null})"
}
