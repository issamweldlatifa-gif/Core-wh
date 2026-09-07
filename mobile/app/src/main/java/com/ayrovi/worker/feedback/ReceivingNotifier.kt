package com.ayrovi.worker.feedback

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.ayrovi.worker.MainActivity
import com.ayrovi.worker.design.R

/**
 * Receiving card notifications (rebuild §17): when a new PRODUCT or CARTON
 * card is automatically dispatched to this worker, the device raises a
 * notification — the worker does NOT need to open Receiving to discover it.
 *
 * Works on phones and on CT40-class rugged devices through the standard
 * Android notification mechanism (Honeywell ships a NotificationManager on
 * the CT40); failures (permission denied / channel blocked) degrade silently
 * — in-app counters + audio are the fallback, so a worker is never blocked.
 */
class ReceivingNotifier(private val context: Context) {
    init {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = context.getSystemService(NotificationManager::class.java)
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Receiving cards",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = "New product and carton cards dispatched to this device"
            }
            manager?.createNotificationChannel(channel)
        }
    }

    private fun permitted(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    /** Show a "new card" tray notification. Safe to call without the runtime permission. */
    fun newCard(product: Boolean, count: Int) {
        if (!permitted() || count <= 0) return
        val title = if (product) "New Product Card received" else "New Carton Card received"
        val body = if (product) "$count product card(s) waiting to receive." else "$count carton card(s) waiting to receive."
        runCatching {
            val intent = Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            }
            val pending = PendingIntent.getActivity(
                context, if (product) 1001 else 1002, intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val notification = NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_terminal_receiving)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_REMINDER)
                .setAutoCancel(true)
                .setContentIntent(pending)
                .build()
            NotificationManagerCompat.from(context).notify(if (product) NOTIF_PRODUCT else NOTIF_CARTON, notification)
        }
    }

    companion object {
        private const val CHANNEL_ID = "ayrovi_receiving_cards"
        private const val NOTIF_PRODUCT = 2101
        private const val NOTIF_CARTON = 2102
    }
}
