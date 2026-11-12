package dev.qjoly.hooked.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * The `data:` payloads of a server-sent event stream, reconnecting with backoff until the collector
 * goes away. hooked sends single-line payloads, so each `data:` line is one event.
 */
fun sseFlow(url: String): Flow<String> = channelFlow {
    var backoff = 1_000L
    while (isActive) {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 10_000
        // Longer than the stream's 4 s heartbeat, so a silent connection is a dead one.
        c.readTimeout = 60_000
        c.setRequestProperty("Accept", "text/event-stream")
        val reader = launch(Dispatchers.IO) {
            try {
                c.inputStream.bufferedReader().use { r ->
                    while (true) {
                        val line = r.readLine() ?: break
                        if (line.startsWith("data:")) {
                            backoff = 1_000L
                            send(line.substring(5).trim())
                        }
                    }
                }
            } catch (_: IOException) {
            }
        }
        // Cancelling the collector lands here: disconnecting unblocks the read.
        try {
            reader.join()
        } finally {
            c.disconnect()
        }
        delay(backoff)
        backoff = (backoff * 2).coerceAtMost(30_000L)
    }
}
