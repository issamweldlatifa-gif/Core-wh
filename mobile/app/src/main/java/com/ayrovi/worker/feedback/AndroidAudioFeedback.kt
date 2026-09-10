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
                // Sound honors the full silence policy (volume, mute, ringer,
                // Do-Not-Disturb): a silenced phone stays silent.
                val allowed = AudioPolicy.mayPlay(
                    audio.getStreamVolume(AudioManager.STREAM_NOTIFICATION),
                    audio.isStreamMute(AudioManager.STREAM_NOTIFICATION),
                    audio.ringerMode == AudioManager.RINGER_MODE_NORMAL,
                    notifications.currentInterruptionFilter == NotificationManager.INTERRUPTION_FILTER_ALL,
                )
                if (allowed) {
                    // Zebra-class scan beeps: short and sharp (SUCCESS is the
                    // classic high pip), loud enough for warehouse noise.
                    val tone = when (sound) {
                        FeedbackSound.SUCCESS -> ToneGenerator.TONE_CDMA_PIP to 80
                        FeedbackSound.ERROR -> ToneGenerator.TONE_PROP_NACK to 180
                        FeedbackSound.WARNING -> ToneGenerator.TONE_PROP_BEEP2 to 130
                        FeedbackSound.NOTIFICATION -> ToneGenerator.TONE_PROP_BEEP to 70
                    }
                    val player = generator ?: ToneGenerator(AudioManager.STREAM_NOTIFICATION, 80).also { generator = it }
                    player.startTone(tone.first, tone.second)
                }
                // Haptics are SCAN feedback, not notification: one tap for
                // success, two for error, three for warning. They fire whenever
                // the system haptic setting is on — even in silent mode, where
                // vibration is the operator's only channel.
                if (sound != FeedbackSound.NOTIFICATION &&
                    Settings.System.getInt(app.contentResolver, Settings.System.HAPTIC_FEEDBACK_ENABLED, 1) == 1) {
                    val vibrator = if (Build.VERSION.SDK_INT >= 31) app.getSystemService(VibratorManager::class.java).defaultVibrator
                        else @Suppress("DEPRECATION") (app.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator)
                    if (!vibrator.hasVibrator()) return@execute
                    when (sound) {
                        FeedbackSound.SUCCESS -> vibrator.vibrate(
                            VibrationEffect.createOneShot(45, VibrationEffect.DEFAULT_AMPLITUDE))
                        FeedbackSound.ERROR -> vibrator.vibrate(
                            VibrationEffect.createWaveform(longArrayOf(0, 70, 60, 70), -1))
                        else -> vibrator.vibrate(
                            VibrationEffect.createWaveform(longArrayOf(0, 40, 50, 40, 50, 40), -1))
                    }
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
