package dev.qjoly.hooked.ui.pages

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.qjoly.hooked.data.HookedClient
import dev.qjoly.hooked.data.arr
import dev.qjoly.hooked.data.bulletBlock
import dev.qjoly.hooked.data.count
import dev.qjoly.hooked.data.dbl
import dev.qjoly.hooked.data.digest
import dev.qjoly.hooked.data.digestIndex
import dev.qjoly.hooked.data.generateDigest
import dev.qjoly.hooked.data.get
import dev.qjoly.hooked.data.shiftDate
import dev.qjoly.hooked.data.str
import dev.qjoly.hooked.data.text
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.state.costLabel
import dev.qjoly.hooked.ui.kit.Dot
import dev.qjoly.hooked.ui.kit.KButton
import dev.qjoly.hooked.ui.kit.KTextInput
import dev.qjoly.hooked.ui.kit.Pill
import dev.qjoly.hooked.ui.kit.Pressable
import dev.qjoly.hooked.ui.kit.SectionTitle
import dev.qjoly.hooked.ui.kit.Size
import dev.qjoly.hooked.ui.kit.Variant
import dev.qjoly.hooked.ui.kit.k
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonElement

class DigestModel : PageModel() {
    var digests by mutableStateOf<List<JsonElement>>(emptyList())
        private set
    var date by mutableStateOf<String?>(null)
        private set
    var digest by mutableStateOf<JsonElement?>(null)
        private set
    var pick by mutableStateOf("")

    /** The date a Generate is waiting on, so its end is announced once. */
    private var generating: String? = null
    private var opening: Job? = null

    /** Refetches the index; the first visit opens the latest digest. */
    fun enter(app: AppModel) {
        call(app, "Digest") { c ->
            val v = c.digestIndex()
            digests = v["digests"].arr
            if (date == null) v["latest"].text?.let { open(app, it) }
        }
    }

    fun open(app: AppModel, d: String) {
        date = d
        digest = null
        opening?.cancel()
        opening = call(app, "Digest") { reload(app, it, d) }
    }

    fun step(app: AppModel, delta: Long) {
        date?.let { shiftDate(it, delta) }?.let { open(app, it) }
    }

    fun submitPick(app: AppModel) {
        val d = pick.trim()
        if (shiftDate(d, 0) != null) {
            pick = ""
            open(app, d)
        } else {
            app.say("✗ Type a date as YYYY-MM-DD")
        }
    }

    fun generate(app: AppModel, force: Boolean) {
        val d = date ?: return
        app.say("Generating the digest… this takes a minute")
        generating = d
        call(app, "Digest") { c ->
            try {
                c.generateDigest(d, force)
            } catch (e: Exception) {
                if (e !is CancellationException) generating = null
                throw e
            }
            reload(app, c, d)
        }
    }

    /** The server writes the summary in the background; the page polls while it says `running`. */
    fun poll(app: AppModel) {
        val d = date ?: return
        call(app, "Digest") { reload(app, it, d) }
    }

    private suspend fun reload(app: AppModel, c: HookedClient, d: String) {
        val v = c.digest(d)
        if (date == d) digest = v
        if (generating == d && v["status"].str != "running") {
            generating = null
            if (v["status"].str == "error") app.say("✗ Digest: ${v["error"].str ?: "failed"}") else app.say("✓ Digest generated")
            digests = c.digestIndex()["digests"].arr
        }
    }
}

/** rune's Daily digest: the history on the left, a day's summary, highlights, blockers and sessions on the right. */
@Composable
fun DigestPage(app: AppModel) {
    val m: DigestModel = viewModel()
    LaunchedEffect(Unit) { m.enter(app) }
    val running = m.digest["status"].str == "running"
    LaunchedEffect(m.date, running) {
        while (running) {
            delay(4_000)
            m.poll(app)
        }
    }
    PageFrame("Daily digest", actions = {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            KButton("◀", { m.step(app, -1) }, variant = Variant.GHOST_MUTED, size = Size.REGULAR, enabled = m.date != null)
            KTextInput(m.pick, { m.pick = it }, m.date ?: "YYYY-MM-DD", Modifier.width(130.dp), onSubmit = { m.submitPick(app) })
            KButton("▶", { m.step(app, 1) }, variant = Variant.GHOST_MUTED, size = Size.REGULAR, enabled = m.date != null)
            KButton("Generate", { m.generate(app, false) }, variant = Variant.OUTLINE, size = Size.REGULAR, enabled = m.date != null)
            KButton("Regenerate", { m.generate(app, true) }, variant = Variant.GHOST_MUTED, size = Size.REGULAR, enabled = m.date != null)
        }
    }) {
        Row(Modifier.fillMaxSize()) {
            LazyColumn(
                Modifier.sideList(240.dp, k.c.border),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(10.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                items(m.digests.take(120), key = { it["date"].str.orEmpty() }) { d ->
                    val date = d["date"].str.orEmpty()
                    val on = m.date == date
                    val t = d["totals"]
                    Pressable({ m.open(app, date) }, Modifier.fillMaxWidth().height(32.dp), fill = if (on) k.c.chip else androidx.compose.ui.graphics.Color.Transparent) {
                        Row(Modifier.padding(horizontal = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(date, style = k.ty.ui, color = k.c.fg, maxLines = 1, modifier = Modifier.weight(1f))
                            Text("${count(t["sessions"].dbl)} · ${costLabel(t["cost"].dbl)}", style = k.ty.textXsmall, color = k.c.faint, maxLines = 1)
                        }
                    }
                }
            }
            Box(Modifier.weight(1f).fillMaxHeight()) {
                val d = m.digest
                when {
                    d == null && m.date != null -> PageLoading()
                    d == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text("No digest yet.", style = k.ty.body, color = k.c.faint) }
                    else -> DigestDetail(app, d)
                }
            }
        }
    }
}

@Composable
private fun DigestDetail(app: AppModel, d: JsonElement) {
    val t = d["totals"]
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        Column(Modifier.widthIn(max = 900.dp).fillMaxWidth().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(d["date"].str.orEmpty(), style = k.ty.bodyMedium, color = k.c.fg)
                Pill(d["status"].str.orEmpty(), k.c.muted, k.c.chip)
                Text(
                    "${count(t["sessions"].dbl)} sessions · ${count(t["prompts"].dbl)} prompts · ${costLabel(t["cost"].dbl)}",
                    style = k.ty.textSmall, color = k.c.faint, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            (d["aiError"].text ?: d["error"].text)?.let { Text("Summary failed: $it", style = k.ty.ui, color = k.c.danger.fg) }
            d["summary"].text?.let { PageMarkdown(app, it) }
            val pending = d["pending"].arr.filter { p -> p["id"].str?.let { app.session(it)?.hasQuestion } == true }
            if (pending.isNotEmpty()) {
                SectionTitle("NEEDS ATTENTION")
                for (p in pending) {
                    val id = p["id"].str.orEmpty()
                    Pressable({ app.open(id) }, Modifier.fillMaxWidth(), radius = k.r.sm) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Pill(p["kind"].str ?: "question", k.c.warning.fg, k.c.warning.bg)
                            Text(
                                "${p["title"].str.orEmpty()} — ${p["text"].str.orEmpty()}",
                                style = k.ty.textSmall, color = k.c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                            )
                        }
                    }
                }
            }
            for ((key, title) in listOf("highlights" to "HIGHLIGHTS", "blockers" to "BLOCKERS")) {
                val items = d[key].arr.mapNotNull { it.str }
                if (items.isNotEmpty()) PageMarkdown(app, bulletBlock(title, items))
            }
            SectionTitle("SESSIONS")
            for (x in d["sessions"].arr) DigestSession(app, x)
        }
    }
}

@Composable
private fun DigestSession(app: AppModel, x: JsonElement) {
    val id = x["id"].str.orEmpty()
    Pressable({ app.open(id) }, Modifier.fillMaxWidth(), fill = k.c.surface) {
        PageBox(gap = 4.dp, fill = androidx.compose.ui.graphics.Color.Transparent) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Dot(k.c.stateColor(if (x["statusKind"].str == "done") "background" else "waiting"), 7.dp)
                Text(x["title"].str.orEmpty(), style = k.ty.uiMedium, color = k.c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Text(x["status"].str.orEmpty(), style = k.ty.textXsmall, color = k.c.faint, maxLines = 1)
                Text(costLabel(x["cost"].dbl), style = k.ty.textXsmall, color = k.c.faint, maxLines = 1)
            }
            Text(x["projectName"].str.orEmpty(), style = k.ty.textXsmall, color = k.c.faint)
            for ((f, label) in listOf("accomplished" to "Done", "pending" to "Pending")) {
                x[f].text?.let { Text("$label: $it", style = k.ty.textSmall, color = k.c.muted) }
            }
        }
    }
}
