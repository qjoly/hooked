package dev.qjoly.hooked

import android.content.Context
import androidx.core.content.edit
import java.net.URI
import java.net.URLDecoder

data class ServerConfig(val host: String, val port: Int = DEFAULT_PORT, val https: Boolean = false) {
    val base: String
        get() {
            // An IPv6 literal needs brackets inside a URL.
            val h = if (':' in host && !host.startsWith("[")) "[$host]" else host
            return "${if (https) "https" else "http"}://$h:$port"
        }

    fun save(ctx: Context) {
        prefs(ctx).edit {
            putString("host", host)
            putInt("port", port)
            putBoolean("https", https)
        }
    }

    companion object {
        const val DEFAULT_PORT = 4123

        fun load(ctx: Context): ServerConfig? {
            val p = prefs(ctx)
            val host = p.getString("host", null)?.takeIf { it.isNotBlank() } ?: return null
            return ServerConfig(host, p.getInt("port", DEFAULT_PORT), p.getBoolean("https", false))
        }

        /** Strips a pasted scheme, path or trailing slash. */
        fun cleanHost(raw: String): String {
            var h = raw.trim()
            for (p in listOf("http://", "https://")) if (h.startsWith(p, ignoreCase = true)) h = h.substring(p.length)
            return h.substringBefore('/')
        }

        /** Parses `hooked://connect?host=…&port=…[&https=1]`, the same link the iOS app takes. */
        fun fromLink(link: String): ServerConfig? {
            val uri = runCatching { URI(link) }.getOrNull() ?: return null
            if (uri.scheme != "hooked" || uri.host != "connect") return null
            val q = (uri.rawQuery ?: "").split('&').filter { '=' in it }.associate {
                val (k, v) = it.split('=', limit = 2)
                k to URLDecoder.decode(v, "UTF-8")
            }
            val host = q["host"]?.let(::cleanHost)?.takeIf { it.isNotEmpty() } ?: return null
            val port = q["port"]?.toIntOrNull()?.takeIf { it in 1..65535 } ?: DEFAULT_PORT
            return ServerConfig(host, port, q["https"]?.lowercase() in setOf("1", "true", "yes"))
        }
    }
}

/** App settings kept on the device. */
object AppPrefs {
    /** Background notifications and the waiting count, on by default like the desktop app. */
    fun notify(ctx: Context) = prefs(ctx).getBoolean("notify", true)

    fun setNotify(ctx: Context, on: Boolean) = prefs(ctx).edit { putBoolean("notify", on) }
}

private fun prefs(ctx: Context) = ctx.getSharedPreferences("hooked", Context.MODE_PRIVATE)
