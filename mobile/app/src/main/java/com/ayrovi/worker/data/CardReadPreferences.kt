package com.ayrovi.worker.data

import android.content.Context
import com.ayrovi.worker.domain.CardReadStore

/**
 * Persistent READ set for receiving card notifications.
 *
 * Stores ONLY opaque card identifiers per worker — no auth material, no
 * operational payload (mirroring the TerminalPreferences rule). Losing this
 * file is harmless: cards simply appear unread again, never the other way
 * round, so a worker can never miss a card because of a storage failure.
 */
class CardReadPreferences(
    context: Context,
    fileName: String = "ayrovi_card_reads",
) : CardReadStore {
    private val preferences = context.applicationContext.getSharedPreferences(fileName, Context.MODE_PRIVATE)

    private fun key(workerId: String, lane: String) = "read_${lane}_$workerId"

    override fun load(workerId: String): Pair<Set<String>, Set<String>> {
        val product = runCatching { preferences.getStringSet(key(workerId, "product"), emptySet()) }
            .getOrNull().orEmpty().toSet()
        val carton = runCatching { preferences.getStringSet(key(workerId, "carton"), emptySet()) }
            .getOrNull().orEmpty().toSet()
        return product to carton
    }

    override fun save(workerId: String, product: Set<String>, carton: Set<String>) {
        runCatching {
            preferences.edit()
                // Defensive copies: SharedPreferences must never be handed a
                // set that the caller can still mutate.
                .putStringSet(key(workerId, "product"), HashSet(product))
                .putStringSet(key(workerId, "carton"), HashSet(carton))
                .apply()
        }
    }

    override fun clear(workerId: String) {
        runCatching {
            preferences.edit()
                .remove(key(workerId, "product"))
                .remove(key(workerId, "carton"))
                .apply()
        }
    }
}
