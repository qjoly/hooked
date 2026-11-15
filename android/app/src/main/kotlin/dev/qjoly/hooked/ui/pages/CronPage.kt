package dev.qjoly.hooked.ui.pages

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.qjoly.hooked.data.PreviewTone
import dev.qjoly.hooked.data.arr
import dev.qjoly.hooked.data.body
import dev.qjoly.hooked.data.cronOp
import dev.qjoly.hooked.data.cronPreview
import dev.qjoly.hooked.data.cronStamp
import dev.qjoly.hooked.data.cronTasks
import dev.qjoly.hooked.data.firstLine
import dev.qjoly.hooked.data.get
import dev.qjoly.hooked.data.millis
import dev.qjoly.hooked.data.str
import dev.qjoly.hooked.data.text
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.state.agoShort
import dev.qjoly.hooked.ui.kit.KButton
import dev.qjoly.hooked.ui.kit.KIcon
import dev.qjoly.hooked.ui.kit.KTextInput
import dev.qjoly.hooked.ui.kit.Lucide
import dev.qjoly.hooked.ui.kit.Pill
import dev.qjoly.hooked.ui.kit.Pressable
import dev.qjoly.hooked.ui.kit.Size
import dev.qjoly.hooked.ui.kit.Variant
import dev.qjoly.hooked.ui.kit.k
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/** The create / edit form; new tasks start on weekdays at 9:00. */
class CronForm(val id: String?, name: String, schedule: String, cwd: String, prompt: String, enabled: Boolean) {
    var name by mutableStateOf(name)
    var schedule by mutableStateOf(schedule)
    var cwd by mutableStateOf(cwd)
    var prompt by mutableStateOf(prompt)
    var enabled by mutableStateOf(enabled)

    companion object {
        fun of(task: JsonElement?, cwd: String) = CronForm(
            task["id"].str,
            task["name"].str.orEmpty(),
            if (task != null) task["schedule"].str.orEmpty() else "0 9 * * 1-5",
            if (task != null) task["cwd"].str.orEmpty() else cwd,
            task["prompt"].str.orEmpty(),
            task == null || enabledOf(task),
        )
    }
}

private fun enabledOf(t: JsonElement) = (t["enabled"] as? JsonPrimitive)?.booleanOrNull ?: true

class CronModel : PageModel() {
    var tasks by mutableStateOf<List<JsonElement>>(emptyList())
        private set
    var form by mutableStateOf<CronForm?>(null)
    var history by mutableStateOf<String?>(null)

    fun load(app: AppModel) {
        call(app, "Cron") { tasks = it.cronTasks() }
    }

    fun edit(app: AppModel, id: String?) {
        val task = id?.let { i -> tasks.firstOrNull { it["id"].str == i } }
        // rune prefills a new task with the open session's project; here the last one opened.
        val cwd = app.session(app.lastSession)?.project.orEmpty()
        form = CronForm.of(task, cwd)
    }

    /** rune's `cron_op`: flash the outcome, then reload the tasks and the sessions either way. */
    private fun op(app: AppModel, payload: JsonObject, done: String) {
        val c = app.client ?: return
        viewModelScope.launch {
            try {
                c.cronOp(payload)
                app.say("✓ $done")
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                app.say("✗ ${e.message}")
            }
            load(app)
            app.refreshSoon()
        }
    }

    fun save(app: AppModel) {
        val f = form ?: return
        val task = body(
            "id" to f.id,
            "name" to f.name.trim(),
            "schedule" to f.schedule.trim(),
            "cwd" to f.cwd.trim(),
            "prompt" to f.prompt.trim(),
            "enabled" to f.enabled,
        )
        form = null
        op(app, body("op" to "save", "task" to task), "Saved")
    }

    fun toggle(app: AppModel, id: String) {
        val t = tasks.firstOrNull { it["id"].str == id } ?: return
        val on = !enabledOf(t)
        tasks = tasks.map { x -> if (x["id"].str == id) (x as? JsonObject)?.let { JsonObject(it + ("enabled" to JsonPrimitive(on))) } ?: x else x }
        op(app, body("op" to "save", "task" to body("id" to id, "enabled" to on)), if (on) "Enabled" else "Paused")
    }

    fun run(app: AppModel, id: String) = op(app, body("op" to "run", "id" to id), "Started")

    fun delete(app: AppModel, id: String) {
        tasks = tasks.filter { it["id"].str != id }
        op(app, body("op" to "delete", "id" to id), "Deleted")
    }
}

/** rune's Scheduled tasks page: the form, then one card per task with its runs. */
@Composable
fun CronPage(app: AppModel) {
    val m: CronModel = viewModel()
    LaunchedEffect(Unit) { m.load(app) }
    PageFrame("Scheduled tasks", actions = {
        KButton("New task", { m.edit(app, null) }, variant = Variant.CONTRAST, size = Size.REGULAR, icon = Lucide.Plus)
    }) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
            Centered(1000.dp) {
                Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    m.form?.let { CronFormCard(app, m, it) }
                    for (t in m.tasks) TaskCard(app, m, t)
                    if (m.tasks.isEmpty() && m.form == null) Text("No scheduled tasks.", style = k.ty.body, color = k.c.faint)
                }
            }
        }
    }
}

@Composable
private fun CronFormCard(app: AppModel, m: CronModel, f: CronForm) {
    val focus = remember(f) { FocusRequester() }
    LaunchedEffect(f) { if (f.id == null) runCatching { focus.requestFocus() } }
    PageBox(pad = 16.dp, gap = 12.dp, radius = k.r.lg, border = k.c.info.border) {
        Text(if (f.id != null) "Edit task" else "New task", style = k.ty.uiMedium, color = k.c.fg)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            PageField("NAME", Modifier.weight(1f)) { KTextInput(f.name, { f.name = it }, "", Modifier.fillMaxWidth().focusRequester(focus)) }
            PageField("SCHEDULE (CRON, LOCAL TIME)", Modifier.width(260.dp)) { KTextInput(f.schedule, { f.schedule = it }, "", Modifier.fillMaxWidth()) }
        }
        PageField("PROJECT") {
            KTextInput(f.cwd, { f.cwd = it }, "", Modifier.fillMaxWidth(), leading = { KIcon(Lucide.Folder, k.c.muted, 14.dp) })
        }
        val (msg, tone) = remember(f.schedule) { cronPreview(f.schedule, System.currentTimeMillis()) }
        Text(
            msg, style = k.ty.textXsmall,
            color = when (tone) {
                PreviewTone.FAINT -> k.c.faint
                PreviewTone.WARNING -> k.c.warning.fg
                PreviewTone.DANGER -> k.c.danger.fg
            },
        )
        PageField("PROMPT") { PageTextArea(f.prompt, { f.prompt = it }, minRows = 3, maxRows = 12) }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PageSwitch(f.enabled, { f.enabled = !f.enabled }, "Enabled")
            Spacer(Modifier.weight(1f))
            KButton("Cancel", { m.form = null }, variant = Variant.GHOST_MUTED, size = Size.REGULAR)
            KButton("Save", { m.save(app) }, variant = Variant.CONTRAST, size = Size.REGULAR)
        }
    }
}

@Composable
private fun TaskCard(app: AppModel, m: CronModel, t: JsonElement) {
    val id = t["id"].str.orEmpty()
    val on = enabledOf(t)
    val runs = t["runs"].arr
    val showing = m.history == id
    PageBox(pad = 14.dp, gap = 6.dp, radius = k.r.lg) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            PageSwitch(on, { m.toggle(app, id) }, t["name"].str.orEmpty(), Modifier.weight(1f, fill = false))
            Pill(t["schedule"].str.orEmpty(), k.c.muted, k.c.chip)
            Spacer(Modifier.weight(1f))
            KButton("Run now", { m.run(app, id) }, variant = Variant.OUTLINE, size = Size.SMALL, icon = Lucide.Play)
            KButton("Edit", { m.edit(app, id) }, variant = Variant.GHOST_MUTED, size = Size.SMALL)
            // Two taps: a stray touch on a tablet must not drop a task.
            var arming by remember(id) { mutableStateOf(false) }
            if (arming) {
                KButton("Confirm delete", { m.delete(app, id) }, variant = Variant.DANGER, size = Size.SMALL)
                LaunchedEffect(Unit) { kotlinx.coroutines.delay(3_000); arming = false }
            } else {
                KButton("Delete", { arming = true }, variant = Variant.GHOST_MUTED, size = Size.SMALL)
            }
        }
        Text(t["cwd"].str.orEmpty(), style = k.ty.textXsmall, color = k.c.faint)
        Text(firstLine(t["prompt"].str.orEmpty(), 220), style = k.ty.textSmall, color = k.c.muted)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val next = t["nextRun"].millis?.takeIf { on }?.let { "Next ${cronStamp(it)}" }.orEmpty()
            Text(next, style = k.ty.textXsmall, color = k.c.faint)
            if (runs.isNotEmpty()) {
                KButton("${runs.size} runs", { m.history = if (showing) null else id }, variant = Variant.GHOST_MUTED, size = Size.SMALL, icon = Lucide.ChevronDown)
            }
        }
        if (showing) {
            Column(Modifier.padding(start = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                for (r in runs.reversed().take(30)) RunLine(app, r)
            }
        } else {
            runs.lastOrNull()?.let { r ->
                val sid = r["sessionId"].text
                Pressable({ sid?.let(app::open) }, radius = k.r.sm) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        KIcon(Lucide.Clock, k.c.faint, 11.dp)
                        Text("Last run ${agoShort(r["at"].millis, app.now)} ago · open its session", style = k.ty.textXsmall, color = k.c.accent)
                    }
                }
            }
        }
    }
}

@Composable
private fun RunLine(app: AppModel, r: JsonElement) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("${agoShort(r["at"].millis, app.now)} ago", style = k.ty.textXsmall, color = k.c.muted)
        if ((r["manual"] as? JsonPrimitive)?.booleanOrNull == true) Pill("manual", k.c.muted, k.c.chip)
        val error = r["error"].str
        val skipped = r["skipped"].str
        val sid = r["sessionId"].str
        when {
            error != null -> Text(error, style = k.ty.textXsmall, color = k.c.danger.fg)
            skipped != null -> Text("Skipped: $skipped", style = k.ty.textXsmall, color = k.c.warning.fg)
            sid != null -> Pressable({ app.open(sid) }, radius = k.r.xs) {
                Text("Open session", style = k.ty.textXsmall, color = k.c.accent)
            }
        }
    }
}
