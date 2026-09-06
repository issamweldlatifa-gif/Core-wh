package com.ayrovi.worker.domain

/** Shared output port. Failure or muted audio must never block a warehouse command. */
interface AudioFeedback {
    fun success()
    fun error()
    fun warning()
    fun notification()

    object Silent : AudioFeedback {
        override fun success() = Unit
        override fun error() = Unit
        override fun warning() = Unit
        override fun notification() = Unit
    }
}

enum class FeedbackSound { SUCCESS, ERROR, WARNING, NOTIFICATION }
object AudioPolicy {
    fun mayPlay(volume: Int, muted: Boolean, normalRinger: Boolean, interruptionsAllowed: Boolean) =
        volume > 0 && !muted && normalRinger && interruptionsAllowed
}
