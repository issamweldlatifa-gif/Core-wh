package com.ayrovi.worker.push

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.ayrovi.worker.MainActivity
import com.ayrovi.worker.R
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Receives NEW_RECEIVING_CARD pushes from the backend.
 *
 * WHY A SERVICE AND NOT AN IN-APP LISTENER: the worker must be told about a
 * new receiving card while the app is backgrounded or fully closed. Android
 * starts this service for a data message even when no activity exists, so
 * the notification is posted by the OS-visible process, not by a running UI.
 *
 * The backend sends DATA messages (not `notification` payloads) so that this
 * handler runs in all three states — foreground, background and killed —
 * giving one single notification path instead of two divergent ones.
 */
class AyroviMessagingService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        // Persist locally; the app uploads it to /notifications/push-token as
        // soon as an authenticated session exists (a token can arrive before
        // login, when no bearer token is available yet).
        PushTokenStore(applicationContext).save(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        val title = data["title"] ?: message.notification?.title ?: "AYROVI Receiving"
        val body = data["body"] ?: message.notification?.body ?: "New receiving card arrived"
        val route = data["route"] ?: ROUTE_RECEIVING
        notify(applicationContext, title, body, route)
    }

    companion object {
        const val CHANNEL_ID = "ayrovi_receiving"
        const val ROUTE_RECEIVING = "/terminal/receiving"
        const val EXTRA_ROUTE = "ayrovi.route"
        private const val NOTIFICATION_ID = 4201

        fun ensureChannel(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Receiving cards",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply { description = "New receiving cards dispatched to the floor" }
            context.getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
        }

        /** Post the notification; tapping it opens the Receiving queue. */
        fun notify(context: Context, title: String, body: String, route: String) {
            ensureChannel(context)
            // Deep link: MainActivity is singleTask, so this reuses the running
            // instance when there is one and cold-starts otherwise — the same
            // destination in all three app states.
            val intent = Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                putExtra(EXTRA_ROUTE, route)
            }
            val pending = PendingIntent.getActivity(
                context, 0, intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val notification = NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(title)
                .setContentText(body)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setAutoCancel(true)
                .setContentIntent(pending)
                .build()
            runCatching {
                NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notification)
            } // POST_NOTIFICATIONS may be denied; never crash the service.
        }
    }
}
