package com.ayrovi.worker.ui

import android.content.Context
import com.ayrovi.worker.feedback.AndroidAudioFeedback

/** Temporary API bridge for non-Receiving frozen screens; no audio implementation lives here. */
@Deprecated("Use the application AudioFeedback port and shared feedback controller.")
object FeedbackSounds {
    fun ok(ctx: Context) = AndroidAudioFeedback.get(ctx).success()
    fun bad(ctx: Context) = AndroidAudioFeedback.get(ctx).error()
    fun warn(ctx: Context) = AndroidAudioFeedback.get(ctx).warning()
}
