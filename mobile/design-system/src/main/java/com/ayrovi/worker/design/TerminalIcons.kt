package com.ayrovi.worker.design

import androidx.annotation.DrawableRes
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource

/** The one production icon family: selected Material Icons Outlined vectors (Apache-2.0). */
enum class TerminalIcon(@DrawableRes val resource: Int) {
    RECEIVING(R.drawable.ic_terminal_receiving), SORTING(R.drawable.ic_terminal_sorting), PUTAWAY(R.drawable.ic_terminal_putaway),
    SCANNER(R.drawable.ic_terminal_scanner), STATION(R.drawable.ic_terminal_station),
    ONLINE(R.drawable.ic_terminal_online), OFFLINE(R.drawable.ic_terminal_offline), SUCCESS(R.drawable.ic_terminal_success),
    ERROR(R.drawable.ic_terminal_error), WARNING(R.drawable.ic_terminal_warning), REFRESH(R.drawable.ic_terminal_refresh),
    SETTINGS(R.drawable.ic_terminal_settings), BACK(R.drawable.ic_terminal_back),    CAMERA(R.drawable.ic_terminal_camera), MANUAL(R.drawable.ic_terminal_manual), QUEUE(R.drawable.ic_terminal_queue),
    CLOSE(R.drawable.ic_terminal_close), CHECK(R.drawable.ic_terminal_check),
    REPORT(R.drawable.ic_terminal_report),
    STORAGE(R.drawable.ic_terminal_storage),
    PRODUCT(R.drawable.ic_terminal_product), CARTON(R.drawable.ic_terminal_carton),
    GLARE(R.drawable.ic_terminal_glare),
}

@Composable
fun WorkerIcon(icon: TerminalIcon, description: String?, modifier: Modifier = Modifier, tint: Color = TerminalTokens.text) {
    Icon(painterResource(icon.resource), contentDescription = description, modifier = modifier, tint = tint)
}
