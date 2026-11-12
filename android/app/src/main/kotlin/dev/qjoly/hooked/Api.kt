package dev.qjoly.hooked

import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

object Api {
    fun open(url: String, timeoutMs: Int): HttpURLConnection =
        (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = timeoutMs
            readTimeout = timeoutMs
        }

    fun get(url: String, timeoutMs: Int = 10_000): String {
        val c = open(url, timeoutMs)
        try {
            if (c.responseCode !in 200..299) throw IOException("HTTP ${c.responseCode}")
            return c.inputStream.bufferedReader().use { it.readText() }
        } finally {
            c.disconnect()
        }
    }

    /** Answers only for a hooked service: the meta endpoint is its own. */
    fun ping(cfg: ServerConfig) {
        val body = get("${cfg.base}/api/session-meta", 5_000)
        if (!JSONObject(body).has("meta")) throw IOException("not a hooked service")
    }

    fun sessions(cfg: ServerConfig): List<SessionInfo> {
        val list = JSONObject(get("${cfg.base}/api/sessions")).optJSONArray("sessions") ?: return emptyList()
        // Snoozes live in the meta; without it nothing is snoozed.
        val meta = runCatching { JSONObject(get("${cfg.base}/api/session-meta")).optJSONObject("meta") }.getOrNull()
        return (0 until list.length()).mapNotNull { i ->
            val s = list.optJSONObject(i) ?: return@mapNotNull null
            val id = s.optString("id").takeIf { it.isNotEmpty() } ?: return@mapNotNull null
            val m = meta?.optJSONObject(id)
            SessionInfo(
                id = id,
                title = s.optString("title").takeIf { it.isNotEmpty() && it != "null" && it != "(sans titre)" } ?: "(untitled)",
                project = s.optString("projectName").takeIf { it != "null" }.orEmpty(),
                state = s.optString("state"),
                hasQuestion = s.optBoolean("hasQuestion"),
                snoozedUntil = m?.optLong("snoozeUntil") ?: 0,
            )
        }
    }
}
