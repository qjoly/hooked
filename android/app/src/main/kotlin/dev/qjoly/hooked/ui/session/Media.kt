package dev.qjoly.hooked.ui.session

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import dev.qjoly.hooked.data.HookedClient
import dev.qjoly.hooked.data.arr
import dev.qjoly.hooked.data.bool
import dev.qjoly.hooked.data.bytes
import dev.qjoly.hooked.data.dbl
import dev.qjoly.hooked.data.get
import dev.qjoly.hooked.data.mediaQuery
import dev.qjoly.hooked.data.str
import dev.qjoly.hooked.data.text
import dev.qjoly.hooked.ui.kit.KButton
import dev.qjoly.hooked.ui.kit.KIcon
import dev.qjoly.hooked.ui.kit.Lucide
import dev.qjoly.hooked.ui.kit.Pill
import dev.qjoly.hooked.ui.kit.ProvideKit
import dev.qjoly.hooked.ui.kit.Size
import dev.qjoly.hooked.ui.kit.Variant
import dev.qjoly.hooked.ui.kit.k
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject

/** Where a conversation's pictures come from, and how one opens big. */
class MediaEnv(val client: HookedClient, val session: String, val open: (List<String>, Int, Boolean) -> Unit) {
    /** `pasted` images come from a user message; the rest a tool call delivered. */
    fun query(path: String, pasted: Boolean) = mediaQuery(session, path, pasted)

    fun url(path: String, pasted: Boolean = false) = query(path, pasted).let { (p, q) -> client.url(p, q) }
}

private object PictureCache {
    private val map = object : LinkedHashMap<String, ImageBitmap>(32, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, ImageBitmap>?) = size > 48
    }

    @Synchronized
    fun get(key: String) = map[key]

    @Synchronized
    fun put(key: String, img: ImageBitmap) {
        map[key] = img
    }
}

@Composable
private fun rememberPicture(env: MediaEnv, path: String, pasted: Boolean): ImageBitmap? {
    val pic by produceState(PictureCache.get(path), path) {
        if (value != null) return@produceState
        value = withContext(Dispatchers.IO) {
            runCatching {
                val (p, q) = env.query(path, pasted)
                val raw = env.client.bytes(p, q)
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(raw, 0, raw.size, bounds)
                var sample = 1
                while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= 2400) sample *= 2
                BitmapFactory.decodeByteArray(raw, 0, raw.size, BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
            }.getOrNull()
        }?.also { PictureCache.put(path, it) }
    }
    return pic
}

private fun fileName(p: String) = p.substringAfterLast('/')

/** rune's `picture`: fitted in `maxW × maxH` at half its pixel size, a placeholder while it loads. */
@Composable
fun Picture(env: MediaEnv, path: String, maxW: Dp, maxH: Dp, all: List<String> = listOf(path), pasted: Boolean = false) {
    val c = k.c
    val img = rememberPicture(env, path, pasted)
    val shape = RoundedCornerShape(k.r.md)
    val base = Modifier.clip(shape).border(1.dp, c.border, shape).clickable { env.open(all, all.indexOf(path).coerceAtLeast(0), pasted) }
    if (img == null) {
        Column(
            base.size(minOf(maxW, 180.dp), minOf(maxH, 110.dp)).background(c.chip),
            verticalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            KIcon(Lucide.Image, c.faint, 18.dp)
            Text(fileName(path), style = k.ty.textXsmall, color = c.faint, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 8.dp))
        }
        return
    }
    val w = img.width.coerceAtLeast(1) / 2f
    val h = img.height.coerceAtLeast(1) / 2f
    val scale = minOf(maxW.value / w, maxH.value / h, 1f)
    Image(img, fileName(path), base.size((w * scale).dp, (h * scale).dp), contentScale = ContentScale.Fit)
}

/** The lightbox: one picture, its name, the position in the set; swipe or the arrows to step. */
@Composable
fun ImageViewer(env: MediaEnv, paths: List<String>, start: Int, pasted: Boolean, onClose: () -> Unit) {
    val kit = k
    var index by remember { mutableIntStateOf(start.coerceIn(0, (paths.size - 1).coerceAtLeast(0))) }
    val path = paths.getOrNull(index) ?: return
    fun step(d: Int) {
        if (paths.size > 1) index = (index + d).mod(paths.size)
    }
    Dialog(onClose, DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        ProvideKit(kit) {
            val c = k.c
            Box(
                Modifier.fillMaxSize().background(c.scrim.copy(alpha = 0.8f))
                    .clickable(remember { MutableInteractionSource() }, indication = null, onClick = onClose)
                    .pointerInput(paths) {
                        var dx = 0f
                        detectHorizontalDragGestures(onDragStart = { dx = 0f }, onDragEnd = { if (dx < -80) step(1) else if (dx > 80) step(-1) }) { _, d -> dx += d }
                    }
                    .padding(top = 30.dp),
                contentAlignment = Alignment.TopCenter,
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Row(
                        Modifier.clip(RoundedCornerShape(k.r.md)).background(c.bg).padding(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Text(fileName(path), style = k.ty.uiMedium, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 420.dp))
                        if (paths.size > 1) {
                            Text("${index + 1} / ${paths.size} · swipe", style = k.ty.textXsmall, color = c.faint)
                            KButton("Previous", { step(-1) }, variant = Variant.GHOST_MUTED, size = Size.REGULAR, icon = Lucide.ArrowLeft)
                            KButton("Next", { step(1) }, variant = Variant.GHOST_MUTED, size = Size.REGULAR, icon = Lucide.ArrowRight)
                        }
                        KButton("Close", onClose, variant = Variant.GHOST_MUTED, size = Size.REGULAR)
                    }
                    BoxWithConstraints(Modifier.fillMaxSize().padding(bottom = 30.dp), contentAlignment = Alignment.TopCenter) {
                        val img = rememberPicture(env, path, pasted)
                        if (img == null) {
                            Text("Loading…", style = k.ty.body, color = c.faint)
                        } else {
                            val w = img.width / 2f
                            val h = img.height / 2f
                            val scale = minOf(maxWidth.value / w, maxHeight.value / h, 2f)
                            Image(img, fileName(path), Modifier.size((w * scale).dp, (h * scale).dp).clip(RoundedCornerShape(k.r.md)), contentScale = ContentScale.Fit)
                        }
                    }
                }
            }
        }
    }
}

/** Files SendUserFile delivered: a caption, pictures, then chips for the rest. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SentFiles(env: MediaEnv, send: JsonObject) {
    val c = k.c
    val ctx = LocalContext.current
    val files = send["files"].arr
    val pics = files.filter { it["kind"].str == "image" }.mapNotNull { it["path"].text }
    Column(Modifier.fillMaxWidth().padding(start = 10.dp, end = 10.dp, bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        send["caption"].text?.let { Text(it, style = k.ty.textSmall, color = c.muted) }
        if (pics.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                pics.forEach { Picture(env, it, 320.dp, 220.dp, pics) }
            }
        }
        val others = files.filter { it["kind"].str != "image" }.mapNotNull { it["path"].text }
        if (others.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                others.forEach { p ->
                    val shape = RoundedCornerShape(k.r.sm)
                    Row(
                        Modifier.height(24.dp).clip(shape).border(1.dp, c.border, shape).clickable { openUrl(ctx, env.url(p)) }.padding(horizontal = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(5.dp),
                    ) {
                        KIcon(Lucide.Link, c.muted, 12.dp)
                        Text(fileName(p), style = k.ty.textSmall, color = c.fg, maxLines = 1)
                    }
                }
            }
        }
    }
}

/** show_image / show_video / show_audio: the work, before and after, what changed and the checks. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ShowWork(env: MediaEnv, show: JsonObject) {
    val c = k.c
    val ctx = LocalContext.current
    val kind = show["kind"].str ?: "image"
    val timed = kind != "image"
    val path = show["path"].str.orEmpty()
    val before = show["compare"].str.orEmpty()
    Column(Modifier.fillMaxWidth().padding(start = 10.dp, end = 10.dp, bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            KIcon(if (kind == "audio") Lucide.Music else Lucide.Image, c.muted, 13.dp)
            Text(
                show["title"].text ?: show["name"].str.orEmpty(), style = k.ty.textSmallMedium, color = c.fg,
                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
            )
            show["url"].text?.let { page -> KButton("Open page", { openUrl(ctx, page) }, variant = Variant.GHOST_MUTED, size = Size.SMALL, icon = Lucide.Link) }
        }
        when {
            timed -> FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                // No in-app player: the clip opens in the system one, as rune's fallback does.
                if (before.isNotEmpty()) Clip(env, before, kind, "Before")
                Clip(env, path, kind, if (before.isNotEmpty()) "After" else null)
            }
            before.isEmpty() -> Picture(env, path, 640.dp, 420.dp, listOf(path))
            else -> Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                listOf("Before" to before, "After" to path).forEach { (label, p) ->
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(label, style = k.ty.textXsmallMedium, color = c.faint)
                        Picture(env, p, 320.dp, 360.dp, listOf(before, path))
                    }
                }
            }
        }
        fun at(v: kotlinx.serialization.json.JsonElement?): String =
            v["at"].dbl?.takeIf { timed }?.toLong()?.let { "${it / 60}:${(it % 60).toString().padStart(2, '0')} " }.orEmpty()
        show["changes"].arr.forEach { ch ->
            val title = ch["title"].str.orEmpty()
            val detail = ch["detail"].text
            Text(
                "• ${at(ch)}$title" + (detail?.let { " — $it" } ?: ""),
                style = if (detail == null) k.ty.textSmallMedium else k.ty.textSmall, color = c.fg,
            )
        }
        val checks = show["checks"].arr
        if (checks.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                checks.forEach { ch ->
                    val ok = ch["ok"].bool
                    val tone = if (ok) c.success else c.danger
                    Pill("${if (ok) "✓" else "✗"} ${ch["name"].str.orEmpty()}", tone.fg, tone.bg)
                }
            }
        }
    }
}

@Composable
private fun Clip(env: MediaEnv, path: String, kind: String, label: String?) {
    val c = k.c
    val ctx = LocalContext.current
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        label?.let { Text(it, style = k.ty.textXsmallMedium, color = c.faint) }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            KButton("Play", { openUrl(ctx, env.url(path)) }, variant = Variant.NEUTRAL, size = Size.SMALL, icon = Lucide.Play)
            KIcon(if (kind == "audio") Lucide.Music else Lucide.Monitor, c.muted, 13.dp)
            Text(fileName(path), style = k.ty.textXsmall, color = c.faint, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 360.dp))
        }
    }
}
