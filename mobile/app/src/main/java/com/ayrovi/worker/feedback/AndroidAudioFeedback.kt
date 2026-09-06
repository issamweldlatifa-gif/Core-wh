package com.ayrovi.worker.feedback

import android.app.NotificationManager
import android.content.Context
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
import com.ayrovi.worker.domain.AudioFeedback
import com.ayrovi.worker.domain.AudioPolicy
import com.ayrovi.worker.domain.FeedbackSound
import java.util.concurrent.Executors

/** Refactored existing ToneGenerator/haptic implementation: one owner, no sleeps/UI-thread work. */
class AndroidAudioFeedback private constructor(context: Context) : AudioFeedback {
    private val app = context.applicationContext
    private val audio = app.getSystemService(AudioManager::class.java)
    private val notifications = app.getSystemService(NotificationManager::class.java)
    private val executor = Executors.newSingleThreadExecutor { task -> Thread(task, "worker-feedback").apply { isDaemon = true } }
    private var generator: ToneGenerator? = null

    override fun success() = play(FeedbackSound.SUCCESS)
    override fun error() = play(FeedbackSound.ERROR)
    override fun warning() = play(FeedbackSound.WARNING)
    override fun notification() = play(FeedbackSound.NOTIFICATION)

    private fun play(sound: FeedbackSound) {
        runCatching { executor.execute {
            runCatching {
                val allowed = AudioPolicy.mayPlay(
                    audio.getStreamVolume(AudioManager.STREAM_NOTIFICATION),
                    audio.isStreamMute(AudioManager.STREAM_NOTIFICATION),
                    audio.ringerMode == AudioManager.RINGER_MODE_NORMAL,
                    notifications.currentInterruptionFilter == NotificationManager.INTERRUPTION_FILTER_ALL,
                )
                if (!allowed) return@execute
                val tone = when (sound) {
                    FeedbackSound.SUCCESS -> ToneGenerator.TONE_PROP_ACK to 100
                    FeedbackSound.ERROR -> ToneGenerator.TONE_PROP_NACK to 160
                    FeedbackSound.WARNING -> ToneGenerator.TONE_PROP_BEEP2 to 140
                    FeedbackSound.NOTIFICATION -> ToneGenerator.TONE_PROP_BEEP to 70
                }
                val player = generator ?: ToneGenerator(AudioManager.STREAM_NOTIFICATION, 65).also { generator = it }
                player.startTone(tone.first, tone.second)
                if (sound != FeedbackSound.NOTIFICATION && Settings.System.getInt(app.contentResolver, Settings.System.HAPTIC_FEEDBACK_ENABLED, 1) == 1) {
                    val vibrator = if (Build.VERSION.SDK_INT >= 31) app.getSystemService(VibratorManager::class.java).defaultVibrator
                        else @Suppress("DEPRECATION") (app.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator)
                    if (vibrator.hasVibrator()) vibrator.vibrate(VibrationEffect.createOneShot(
                        if (sound == FeedbackSound.ERROR) 100 else 35, VibrationEffect.DEFAULT_AMPLITUDE))
                }
            }
        } }
    }

    companion object {
        @Volatile private var instance: AndroidAudioFeedback? = null
        fun get(context: Context): AndroidAudioFeedback = instance ?: synchronized(this) {
            instance ?: AndroidAudioFeedback(context).also { instance = it }
        }
    }
}
