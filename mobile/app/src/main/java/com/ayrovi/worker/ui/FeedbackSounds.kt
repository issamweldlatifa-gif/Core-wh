package com.ayrovi.worker.ui

import android.content.Context
import android.media.AudioAttributes
import android.media.ToneGenerator
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

/**
 * CT40 warehouse feedback: sound + haptic on scan outcome.
 * Accept = short beep + tiny tick.
 * Reject = double low beep + long buzz.
 * Warn   = mid beep + short buzz.
 *
 * Uses ToneGenerator so we don't ship audio assets.
 */
object FeedbackSounds {
    private const val STREAM = android.media.AudioManager.STREAM_MUSIC
    @Volatile private var tg: ToneGenerator? = null
    private fun tg(): ToneGenerator = tg ?: synchronized(this) {
        tg ?: ToneGenerator(STREAM, 80).also { tg = it }
    }
    private fun vibe(ctx: Context, ms: Long, amp: Int = -1) {
        try {
            val v = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                (ctx.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
            } else {
                @Suppress("DEPRECATION") ctx.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
            }
            if (!v.hasVibrator()) return
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                v.vibrate(VibrationEffect.createOneShot(ms, if (amp == -1) VibrationEffect.DEFAULT_AMPLITUDE else amp))
            } else {
                @Suppress("DEPRECATION") v.vibrate(ms)
            }
        } catch (_: Exception) {}
    }
    fun ok(ctx: Context) {
        runCatching { tg().startTone(ToneGenerator.TONE_PROP_BEEP, 120) }
        vibe(ctx, 40, 60)
    }
    fun warn(ctx: Context) {
        runCatching {
            tg().startTone(ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD, 160)
            Thread.sleep(180)
            tg().startTone(ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD, 160)
        }
        vibe(ctx, 120, 120)
    }
    fun bad(ctx: Context) {
        runCatching {
            tg().startTone(ToneGenerator.TONE_SUP_ERROR, 320)
            Thread.sleep(340)
            tg().startTone(ToneGenerator.TONE_SUP_ERROR, 320)
        }
        vibe(ctx, 320, 200)
    }
}
