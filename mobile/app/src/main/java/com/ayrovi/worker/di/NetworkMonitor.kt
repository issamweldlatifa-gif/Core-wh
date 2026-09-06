package com.ayrovi.worker.di

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities

/** Link availability only; a link becoming available does NOT mean backend ONLINE. */
class NetworkMonitor(context: Context, private val onAvailable: (Boolean) -> Unit) {
    private val manager = context.getSystemService(ConnectivityManager::class.java)
    private var registered = false
    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = report()
        override fun onLost(network: Network) = report()
        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) = report()
    }
    fun start() {
        if (registered) return
        manager.registerDefaultNetworkCallback(callback)
        registered = true
        report()
    }
    fun stop() {
        if (registered) manager.unregisterNetworkCallback(callback)
        registered = false
    }
    private fun report() {
        val capabilities = manager.getNetworkCapabilities(manager.activeNetwork)
        onAvailable(capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true)
    }
}
