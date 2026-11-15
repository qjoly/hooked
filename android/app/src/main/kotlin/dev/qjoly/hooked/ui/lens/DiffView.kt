package dev.qjoly.hooked.ui.lens

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.qjoly.hooked.data.lens.Annotation
import dev.qjoly.hooked.data.lens.DiffLayout
import dev.qjoly.hooked.data.lens.DiffLine
import dev.qjoly.hooked.data.lens.DiffMode
import dev.qjoly.hooked.data.lens.DiffRow
import dev.qjoly.hooked.data.lens.EXPAND_STEP
import dev.qjoly.hooked.data.lens.Expand
import dev.qjoly.hooked.data.lens.FileDiff
import dev.qjoly.hooked.data.lens.LineKind
import dev.qjoly.hooked.data.lens.LineRange
import dev.qjoly.hooked.data.lens.LineRef
import dev.qjoly.hooked.data.lens.Revealed
import dev.qjoly.hooked.data.lens.Side
import dev.qjoly.hooked.data.lens.emptyRevealed
import dev.qjoly.hooked.ui.kit.KIcon
import dev.qjoly.hooked.ui.kit.Kit
import dev.qjoly.hooked.ui.kit.Lucide
import dev.qjoly.hooked.ui.kit.k
import kotlinx.coroutines.launch
import kotlin.math.ceil

// rune-kit's DiffView (diff/view.rs) over DiffState (diff/state.rs): sticky file headers, folded
// unchanged ranges that open 20 lines at a time, unified or split rows, word changes, line
// selection and annotations under lines. On a tablet the "+" that rune shows on hover sits on the
// selected line, a long press on a line number extends the selection, and a long press on the
// code comments on it. Long lines wrap rather than scroll sideways.

private const val BAR = 3f
private const val LINE_H = 20

/** One entry of the list: a diff row, or an annotation shown under one. */
sealed interface DiffItem {
    val key: String
    val row: Int

    data class RowItem(override val row: Int, override val key: String) : DiffItem
    data class Note(override val row: Int, val a: Annotation, override val key: String) : DiffItem
}

@Stable
class DiffState(split: Boolean = false) {
    var files by mutableStateOf<List<FileDiff>>(emptyList())
        private set
    var mode by mutableStateOf(if (split) DiffMode.SPLIT else DiffMode.UNIFIED)
    var collapsed by mutableStateOf<Set<Int>>(emptySet())
        private set
    private var revealed by mutableStateOf<Revealed>(emptyList())
    var selection by mutableStateOf<LineRange?>(null)
    var annotations by mutableStateOf<List<Annotation>>(emptyList())
    val list = LazyListState()

    val layout: DiffLayout by derivedStateOf { DiffLayout(files, mode, collapsed, revealed) }

    val items: List<DiffItem> by derivedStateOf { buildItems(layout, annotations) }

    /** The list index of each row. */
    private val itemOfRow: IntArray by derivedStateOf {
        val out = IntArray(layout.rows.size)
        items.forEachIndexed { i, it -> if (it is DiffItem.RowItem) out[it.row] = i }
        out
    }

    val visibleFile: Int by derivedStateOf {
        val its = items
        val l = layout
        its.getOrNull(list.firstVisibleItemIndex)?.let { l.rows.getOrNull(it.row)?.file } ?: 0
    }

    fun load(next: List<FileDiff>) {
        files = next
        collapsed = emptySet()
        revealed = emptyRevealed(next)
        selection = null
    }

    fun setCollapsed(f: Int, on: Boolean) {
        collapsed = if (on) collapsed + f else collapsed - f
    }

    fun expand(f: Int, gap: Int, how: Expand) {
        revealed = layout.expand(f, gap, how)
    }

    fun itemOfFile(f: Int): Int? = layout.fileRows.getOrNull(f)?.let { itemOfRow.getOrNull(it) }

    suspend fun scrollToFile(f: Int) {
        itemOfFile(f)?.let { list.animateScrollToItem(it) }
    }

    /** Opens the range the line is folded in, then brings it just below the sticky header. */
    suspend fun scrollToLine(f: Int, at: LineRef) {
        if (f in collapsed) setCollapsed(f, false)
        if (layout.rowOf(f, at) == null) layout.gapHolding(f, at)?.let { expand(f, it, Expand.ALL) }
        val r = layout.rowOf(f, at) ?: return
        val idx = itemOfRow.getOrNull(r) ?: return
        list.animateScrollToItem(maxOf(idx - 3, itemOfFile(f) ?: 0))
    }

    /** The next (or previous) hunk or file from the top of the view, brought just below the header. */
    suspend fun step(hunks: Boolean, forward: Boolean) {
        val l = layout
        val starts = (if (hunks) l.hunkRows.toList() else l.fileRows.toList()).map { itemOfRow.getOrElse(it) { 0 } }
        val top = list.firstVisibleItemIndex + if (hunks) 2 else 0
        val target = if (forward) starts.firstOrNull { it > top } else starts.lastOrNull { it < top }
        target ?: return
        list.animateScrollToItem(if (hunks) maxOf(target - 2, 0) else target)
    }

    /** A tap on a line number selects it (or clears it when it is the one selected); a long press extends. */
    fun press(f: Int, at: LineRef, extend: Boolean): LineRange? {
        val cur = selection
        val sel = if (extend && cur != null && cur.file == f) cur.copy(end = at) else LineRange.line(f, at)
        selection = if (!extend && cur == sel) null else sel
        return selection
    }

    private fun buildItems(l: DiffLayout, notes: List<Annotation>): List<DiffItem> {
        val by = HashMap<Triple<Int, Side, Int>, MutableList<Annotation>>()
        for (a in notes) by.getOrPut(Triple(a.file, a.at.side, a.at.line)) { ArrayList() } += a
        val out = ArrayList<DiffItem>(l.rows.size + notes.size)
        for ((i, r) in l.rows.withIndex()) {
            val key = l.key(r)
            out += DiffItem.RowItem(i, key)
            if (by.isEmpty()) continue
            val seen = HashSet<String>()
            for (side in Side.entries) {
                val n = l.rowLine(r, side) ?: continue
                for (a in by[Triple(r.file, side, n)].orEmpty()) if (seen.add(a.id)) out += DiffItem.Note(i, a, "$key.a.${a.id}")
            }
        }
        return out
    }
}

@Immutable
class Tints(val line: Color, val gutter: Color, val word: Color, val number: Color, val bar: Color, val count: Color)

@Immutable
class DiffLook(kit: Kit) {
    private val c = kit.c
    private val dark = kit.dark
    val bg = c.bg
    val text = c.fg
    val muted = c.muted
    val faint = c.faint
    val border = c.border
    val headerBg = c.surface
    private fun tints(hue: Color, fg: Color) = Tints(
        line = tint(bg, hue, if (dark) 0.13f else 0.1f),
        gutter = tint(bg, hue, if (dark) 0.2f else 0.17f),
        word = tint(bg, hue, if (dark) 0.32f else 0.27f),
        number = tint(c.muted, hue, 0.7f),
        bar = hue,
        count = fg,
    )
    val add = tints(c.success.icon, c.success.fg)
    val del = tints(c.danger.icon, c.danger.fg)
    val gapBg = tint(bg, c.info.icon, if (dark) 0.1f else 0.06f)
    val emptyBg = tint(bg, c.fg, if (dark) 0.03f else 0.025f)
    val selected = tint(bg, c.info.icon, if (dark) 0.2f else 0.14f)
    val selectedGutter = tint(bg, c.info.icon, if (dark) 0.32f else 0.26f)
    val accent = c.info.icon
    val onAccent = Color.White
    val font: TextStyle = kit.ty.mono.copy(fontSize = 13.sp, lineHeight = 20.sp)
    val label: TextStyle = kit.ty.uiMedium
    val small: TextStyle = kit.ty.mono.copy(fontSize = 12.sp, lineHeight = 16.sp)

    fun tints(kind: LineKind) = when (kind) {
        LineKind.ADDED -> add
        LineKind.REMOVED -> del
        LineKind.CONTEXT -> null
    }

    fun gutterFill(kind: LineKind, selected: Boolean) = when {
        selected -> selectedGutter
        else -> tints(kind)?.gutter ?: bg
    }

    /** One line-number column for numbers of `digits` digits. */
    fun numberW(digits: Int): Dp = ceil(digits * 0.6f * 13f + 16f).dp
}

private fun glyph16(name: String, d: String, fill: Boolean = false): ImageVector = ImageVector.Builder(name, 16.dp, 16.dp, 16f, 16f).addPath(
    pathData = PathParser().parsePathString(d).toNodes(),
    fill = if (fill) SolidColor(Color.Black) else null,
    stroke = if (fill) null else SolidColor(Color.Black),
    strokeLineWidth = 1.25f,
    strokeLineCap = StrokeCap.Round,
    strokeLineJoin = StrokeJoin.Round,
).build()

private val ExpandUp by lazy { glyph16("expand-up", "M4.5 9.5L8 6L11.5 9.5") }
private val ExpandDown by lazy { glyph16("expand-down", "M4.5 6.5L8 10L11.5 6.5") }
private val ExpandAll by lazy { glyph16("expand-all", "M5 5.5L8 2.5L11 5.5M5 10.5L8 13.5L11 10.5") }
private val TriangleDown by lazy { glyph16("triangle-down", "M4.5 6h7L8 10.5z", fill = true) }
private val TriangleRight by lazy { glyph16("triangle-right", "M6 4.5v7L10.5 8z", fill = true) }

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun DiffView(
    state: DiffState,
    modifier: Modifier = Modifier,
    annotation: @Composable (Annotation) -> Unit,
    onComment: (LineRange) -> Unit,
    onSelect: (LineRange?) -> Unit,
    headerActions: @Composable RowScope.(Int) -> Unit,
) {
    val kit = k
    val look = remember(kit) { DiffLook(kit) }
    val layout = state.layout
    val items = state.items
    val selection = state.selection
    val endRow = selection?.let { layout.rowOf(it.file, it.end) }
    LazyColumn(state = state.list, modifier = modifier.background(look.bg)) {
        for (it in items) {
            when (it) {
                is DiffItem.Note -> item(key = it.key) { Box(Modifier.fillMaxWidth()) { annotation(it.a) } }
                is DiffItem.RowItem -> when (val r = layout.rows[it.row]) {
                    is DiffRow.File -> stickyHeader(key = it.key) { FileHeader(state, look, r.file, headerActions) }
                    is DiffRow.Note -> item(key = it.key) { NoteRow(look, layout, r.file) }
                    is DiffRow.Fold -> item(key = it.key) { FoldRow(state, look, layout, r.file, r.gap) }
                    else -> item(key = it.key) {
                        LineRow(state, look, layout, it.row, selection, endRow == it.row, onComment, onSelect)
                    }
                }
            }
        }
    }
}

@Composable
private fun FileHeader(state: DiffState, look: DiffLook, f: Int, actions: @Composable RowScope.(Int) -> Unit) {
    val file = state.files.getOrNull(f) ?: return
    val collapsed = f in state.collapsed
    val scope = rememberCoroutineScope()
    Column(Modifier.fillMaxWidth().height(44.dp).background(look.headerBg)) {
        Box(Modifier.fillMaxWidth().height(1.dp).background(if (f > 0) look.border else look.headerBg))
        Row(
            Modifier.fillMaxWidth().weight(1f).padding(horizontal = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Box(
                Modifier.size(24.dp).clip(RoundedCornerShape(6.dp)).combinedClickable(remember { MutableInteractionSource() }, null) {
                    state.setCollapsed(f, !collapsed)
                    val at = state.itemOfFile(f)
                    if (at != null && state.list.firstVisibleItemIndex > at) scope.launch { state.scrollToFile(f) }
                },
                contentAlignment = Alignment.Center,
            ) { KIcon(if (collapsed) TriangleRight else TriangleDown, look.muted, 16.dp, label = if (collapsed) "Expand file" else "Collapse file") }
            Text(file.path, style = look.label, color = look.text, maxLines = 1, overflow = TextOverflow.StartEllipsis, modifier = Modifier.weight(1f, fill = false))
            Spacer(Modifier.weight(1f))
            if (file.additions > 0) Text("+${file.additions}", style = look.small, color = look.add.count)
            if (file.deletions > 0) Text("−${file.deletions}", style = look.small, color = look.del.count)
            actions(f)
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(look.border))
    }
}

private fun gutterW(look: DiffLook, file: FileDiff, mode: DiffMode): Dp {
    val n = look.numberW(file.digits)
    return BAR.dp + if (mode == DiffMode.UNIFIED) n * 2 else n
}

@Composable
private fun NoteRow(look: DiffLook, layout: DiffLayout, f: Int) {
    val file = layout.files[f]
    val msg = if (file.binary) "Binary file not shown" else "No changes"
    Box(Modifier.fillMaxWidth().height(40.dp).background(look.bg).padding(start = gutterW(look, file, layout.mode) + 12.dp), contentAlignment = Alignment.CenterStart) {
        Text(msg, style = look.small, color = look.muted)
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun FoldRow(state: DiffState, look: DiffLook, layout: DiffLayout, f: Int, gap: Int) {
    val file = layout.files[f]
    val hidden = layout.hidden(f, gap) ?: 0
    val last = gap == file.hunks.size
    Row(Modifier.fillMaxWidth().height(32.dp).background(look.gapBg), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(Modifier.width(gutterW(look, file, layout.mode)), horizontalArrangement = Arrangement.spacedBy(2.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
            if (file.expandable) {
                @Composable
                fun button(how: Expand, icon: ImageVector, label: String) = Box(
                    Modifier.size(24.dp).clip(RoundedCornerShape(6.dp)).combinedClickable(remember { MutableInteractionSource() }, null) { state.expand(f, gap, how) },
                    contentAlignment = Alignment.Center,
                ) { KIcon(icon, look.muted, 16.dp, label = label) }
                val step = minOf(hidden, EXPAND_STEP)
                if (hidden <= EXPAND_STEP) {
                    button(Expand.ALL, ExpandAll, "Show $hidden hidden lines")
                } else {
                    if (gap > 0) button(Expand.DOWN, ExpandDown, "Show $step more lines below")
                    if (!last) button(Expand.UP, ExpandUp, "Show $step more lines above")
                }
            }
        }
        if (hidden > 0) {
            val count = if (hidden == 1) "1 unchanged line" else "$hidden unchanged lines"
            val all = file.expandable && hidden > EXPAND_STEP
            Box(
                Modifier.height(24.dp).clip(RoundedCornerShape(6.dp))
                    .then(if (all) Modifier.combinedClickable(remember { MutableInteractionSource() }, null) { state.expand(f, gap, Expand.ALL) } else Modifier)
                    .padding(horizontal = 6.dp),
                contentAlignment = Alignment.Center,
            ) { Text(count, style = look.small, color = look.muted) }
        }
        file.hunks.getOrNull(gap)?.let { Text(it.header(), style = look.small, color = look.faint, maxLines = 1, overflow = TextOverflow.Ellipsis) }
    }
}

/** One side of a row: its kind, numbers and text. */
private data class Cell(val kind: LineKind, val old: Int?, val new: Int?, val text: String, val changes: List<IntRange>, val noNewline: Boolean) {
    /** The side the line reads from and its number there. */
    fun source(): LineRef = when {
        kind == LineKind.REMOVED && old != null -> LineRef(Side.OLD, old)
        new != null -> LineRef(Side.NEW, new)
        old != null -> LineRef(Side.OLD, old)
        else -> LineRef(Side.NEW, 1)
    }
}

private fun cellOf(l: DiffLine) = Cell(l.kind, l.old, l.new, l.text, l.changes, l.noNewline)

@Composable
private fun LineRow(
    state: DiffState,
    look: DiffLook,
    layout: DiffLayout,
    i: Int,
    selection: LineRange?,
    plus: Boolean,
    onComment: (LineRange) -> Unit,
    onSelect: (LineRange?) -> Unit,
) {
    val r = layout.rows[i]
    val f = r.file
    val file = layout.files[f]
    val (a, b) = when (r) {
        is DiffRow.Ctx -> Cell(LineKind.CONTEXT, r.old, r.new, file.contextLine(r.old, r.new).orEmpty(), emptyList(), false) to null
        is DiffRow.Line -> cellOf(layout.line(f, r.hunk, r.index)) to null
        is DiffRow.Pair -> cellOf(layout.line(f, r.hunk, r.del)) to cellOf(layout.line(f, r.hunk, r.add))
        else -> return
    }
    val press = { at: LineRef, extend: Boolean -> onSelect(state.press(f, at, extend)) }
    val comment = { at: LineRef ->
        val sel = state.selection
        onComment(if (sel != null && sel.file == f && layout.contains(sel, at)) sel else LineRange.line(f, at))
    }
    val numberW = look.numberW(file.digits)
    if (layout.mode == DiffMode.UNIFIED) {
        val selected = layout.rowSelected(selection, i)
        val fill = if (selected) look.selected else look.tints(a.kind)?.line ?: look.bg
        val src = a.source()
        Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min).heightIn(min = LINE_H.dp).background(fill)) {
            Box(Modifier.fillMaxHeight()) {
                Row(Modifier.fillMaxHeight().background(look.gutterFill(a.kind, selected))) {
                    Bar(look, a.kind)
                    Number(look, a.old, a.old?.let { LineRef(Side.OLD, it) } ?: src, a.kind, selected, numberW, press)
                    Number(look, a.new, a.new?.let { LineRef(Side.NEW, it) } ?: src, a.kind, selected, numberW, press)
                }
                if (plus) Plus(look, Modifier.offset(x = BAR.dp + numberW * 2 - 10.dp, y = 2.dp)) { comment(selection?.end ?: src) }
            }
            Code(look, a, Modifier.weight(1f)) { comment(src) }
        }
        return
    }
    // Split: removed lines left, added right, unchanged lines on both sides; an added or deleted file takes one column.
    val (old, new) = when {
        b != null -> a to b
        a.kind == LineKind.REMOVED -> a to null
        a.kind == LineKind.ADDED -> null to a
        else -> a to a
    }
    val single = file.soleSide()
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min).heightIn(min = LINE_H.dp)) {
        @Composable
        fun half(side: Side, c: Cell?, mod: Modifier) {
            if (c == null) {
                Box(mod.fillMaxHeight().background(look.emptyBg))
                return
            }
            val selected = layout.rowSelected(selection, i, side)
            val n = if (side == Side.OLD) c.old else c.new
            val src = if (side == Side.OLD) file.oldText else file.newText
            val cell = if (c.kind == LineKind.CONTEXT && n != null) c.copy(text = src?.line(n) ?: c.text) else c
            val at = n?.let { LineRef(side, it) } ?: cell.source()
            Box(mod.fillMaxHeight()) {
                Row(Modifier.fillMaxSize().background(if (selected) look.selected else look.tints(c.kind)?.line ?: look.bg)) {
                    Bar(look, c.kind)
                    Box(Modifier.fillMaxHeight().background(look.gutterFill(c.kind, selected))) {
                        Number(look, n, at, c.kind, selected, numberW, press)
                    }
                    Code(look, cell, Modifier.weight(1f)) { comment(at) }
                }
                val end = selection?.end
                if (plus && end != null && end.side == side) Plus(look, Modifier.offset(x = BAR.dp + numberW - 10.dp, y = 2.dp)) { comment(end) }
            }
        }
        when (single) {
            Side.OLD -> half(Side.OLD, old, Modifier.weight(1f))
            Side.NEW -> half(Side.NEW, new, Modifier.weight(1f))
            null -> {
                half(Side.OLD, old, Modifier.weight(1f))
                Box(Modifier.width(1.dp).fillMaxHeight().background(look.border))
                half(Side.NEW, new, Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun Bar(look: DiffLook, kind: LineKind) {
    Box(Modifier.width(BAR.dp).fillMaxHeight().background(look.tints(kind)?.bar ?: Color.Transparent))
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun Number(look: DiffLook, n: Int?, at: LineRef, kind: LineKind, selected: Boolean, width: Dp, press: (LineRef, Boolean) -> Unit) {
    Box(
        Modifier.width(width).fillMaxHeight()
            .combinedClickable(remember { MutableInteractionSource() }, null, onLongClick = { press(at, true) }) { press(at, false) }
            .padding(horizontal = 8.dp),
        contentAlignment = Alignment.TopEnd,
    ) {
        if (n != null) Text(n.toString(), style = look.font, color = if (selected) look.text else look.tints(kind)?.number ?: look.faint, maxLines = 1)
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun Plus(look: DiffLook, modifier: Modifier, onClick: () -> Unit) {
    Box(
        modifier.size(16.dp).clip(RoundedCornerShape(4.dp)).background(look.accent)
            .combinedClickable(remember { MutableInteractionSource() }, null, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { KIcon(Lucide.Plus, look.onAccent, 12.dp, label = "Comment on this line") }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun Code(look: DiffLook, c: Cell, modifier: Modifier, onLong: () -> Unit) {
    val word = look.tints(c.kind)?.word
    val shown = remember(c.text, c.changes, word) { tabbed(c.text, if (word != null) c.changes else emptyList(), word) }
    Column(
        modifier.combinedClickable(remember { MutableInteractionSource() }, null, onLongClick = onLong) {}.padding(start = 12.dp, end = 24.dp),
    ) {
        Text(shown, style = look.font, color = look.text)
        if (c.noNewline) Text("No newline at end of file", style = look.small, color = look.muted, modifier = Modifier.alpha(0.6f).padding(bottom = 2.dp))
    }
}

/** The text with tabs padded to four columns and the word changes on their tint. */
private fun tabbed(text: String, changes: List<IntRange>, word: Color?): AnnotatedString {
    val map = IntArray(text.length + 1)
    val sb = StringBuilder()
    for ((i, ch) in text.withIndex()) {
        map[i] = sb.length
        if (ch == '\t') repeat(4 - sb.length % 4) { sb.append(' ') } else sb.append(ch)
    }
    map[text.length] = sb.length
    return buildAnnotatedString {
        append(sb.toString())
        if (word != null) for (r in changes) {
            val s = map[r.first.coerceIn(0, text.length)]
            val e = map[(r.last + 1).coerceIn(0, text.length)]
            if (e > s) addStyle(SpanStyle(background = word), s, e)
        }
    }
}
