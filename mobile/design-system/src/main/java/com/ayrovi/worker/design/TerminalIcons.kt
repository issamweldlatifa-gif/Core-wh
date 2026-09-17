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
    // ORDER 01 (station UI cleanup): every station key renders its OWN glyph —
    // batch entries no longer borrow Receiving's PRODUCT/RECEIVING icons,
    // SHIPPING no longer borrows the Receiving CARTON icon, PACKING no longer
    // falls back to PUTAWAY.
    //
    // STATION GLYPH STANDARD (ORDER 01 follow-up, applies to future stations):
    // 24dp viewport, 2dp stroke weight drawn as flat bars (nonZero, single
    // fill #FFFFFFFF, tinted by WorkerIcon), outlined look — no solid blocks.
    // Material Outlined icons (RECEIVING/SORTING/CAMERA/...) already match
    // this weight; new station icons MUST follow it so any mix of tiles on
    // one Home reads as one family.
    BATCH(R.drawable.ic_terminal_batch), BATCH_IN(R.drawable.ic_terminal_batch_in),
    PACKING(R.drawable.ic_terminal_packing), DISPATCH(R.drawable.ic_terminal_dispatch),
    // PRINTER (owner order 2026-09-16): the CT40 prints on its own — the label
    // printer is a first-class thing in the app now, so it gets its own glyph
    // drawn to the same standard as the station icons above.
    PRINTER(R.drawable.ic_terminal_printer),
}

@Composable
fun WorkerIcon(icon: TerminalIcon, description: String?, modifier: Modifier = Modifier, tint: Color = TerminalTokens.text) {
    Icon(painterResource(icon.resource), contentDescription = description, modifier = modifier, tint = tint)
}
