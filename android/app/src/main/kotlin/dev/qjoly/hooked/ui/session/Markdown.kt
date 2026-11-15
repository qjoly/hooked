package dev.qjoly.hooked.ui.session

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.qjoly.hooked.state.Inl
import dev.qjoly.hooked.state.ListItem
import dev.qjoly.hooked.state.Md
import dev.qjoly.hooked.state.parseInline
import dev.qjoly.hooked.state.parseMarkdown
import dev.qjoly.hooked.state.plain
import dev.qjoly.hooked.ui.kit.CheckGlyph
import dev.qjoly.hooked.ui.kit.KButton
import dev.qjoly.hooked.ui.kit.KIcon
import dev.qjoly.hooked.ui.kit.Lucide
import dev.qjoly.hooked.ui.kit.Mono
import dev.qjoly.hooked.ui.kit.Size
import dev.qjoly.hooked.ui.kit.Variant
import dev.qjoly.hooked.ui.kit.k

// rune-kit's Markdown with hooked's `md_code` frame: rune's sizes, margins collapsed like CSS.

/** Code block actions: Copy always, Run for shell blocks of a session. */
class CodeActions(val onRun: ((String) -> Unit)? = null, val onCopy: (String) -> Unit)

fun copyText(ctx: Context, text: String, label: String = "hooked") {
    ctx.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText(label, text))
}

fun openUrl(ctx: Context, url: String) {
    runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
}

private fun margins(b: Md): Pair<Int, Int> = when (b) {
    is Md.Para -> 0 to 12
    is Md.Heading -> when (b.level) {
        1 -> 28 to 12
        2 -> 24 to 10
        else -> 20 to 8
    }
    is Md.Code -> 12 to 24
    is Md.ListBlock -> 8 to 12
    is Md.Quote -> 16 to 16
    Md.Rule -> 32 to 32
    is Md.Table -> 12 to 16
}

@Composable
fun RuneMarkdown(
    text: String,
    modifier: Modifier = Modifier,
    color: Color = k.c.fg,
    actions: CodeActions? = null,
) {
    val blocks = remember(text) { parseMarkdown(text) }
    MdBlocks(blocks, modifier.fillMaxWidth(), color, actions)
}

@Composable
private fun MdBlocks(blocks: List<Md>, modifier: Modifier, color: Color, actions: CodeActions?) {
    Column(modifier) {
        var prevBottom = -1
        for (b in blocks) {
            val (top, bottom) = margins(b)
            if (prevBottom >= 0) Spacer(Modifier.height(maxOf(prevBottom, top).dp))
            MdBlock(b, color, actions)
            prevBottom = bottom
        }
    }
}

@Composable
private fun MdBlock(b: Md, color: Color, actions: CodeActions?) {
    val c = k.c
    when (b) {
        is Md.Para -> InlineText(b.text, k.ty.markdown, color)
        is Md.Heading -> InlineText(
            b.text,
            when (b.level) {
                1 -> k.ty.h1
                2 -> k.ty.h2
                else -> k.ty.h3
            },
            if (b.level >= 4) c.muted else color,
        )
        is Md.Code -> CodeBlock(b, actions)
        is Md.ListBlock -> MdList(b, color, actions)
        is Md.Quote -> Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
            Box(Modifier.width(2.dp).fillMaxHeight().clip(RoundedCornerShape(1.dp)).background(c.border))
            MdBlocks(b.blocks, Modifier.weight(1f).padding(start = 12.dp), color, actions)
        }
        is Md.Table -> MdTable(b, color)
        Md.Rule -> Box(Modifier.fillMaxWidth().height(0.5.dp).background(c.border))
    }
}

@Composable
fun inlineAnnotated(spans: List<Inl>, color: Color): AnnotatedString {
    val c = k.c
    val ctx = LocalContext.current
    return buildAnnotatedString {
        fun put(list: List<Inl>) {
            for (s in list) when (s) {
                is Inl.Text -> append(s.s)
                is Inl.Code -> withStyle(SpanStyle(fontFamily = Mono, fontSize = 12.6.sp, background = c.fg.copy(alpha = 0.08f))) {
                    append(" ${s.s} ")
                }
                is Inl.Strong -> withStyle(SpanStyle(fontWeight = FontWeight(670))) { put(s.c) }
                is Inl.Em -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { put(s.c) }
                is Inl.Strike -> withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { put(s.c) }
                is Inl.Link -> withLink(
                    LinkAnnotation.Clickable(
                        s.url,
                        TextLinkStyles(SpanStyle(color = c.accent, textDecoration = TextDecoration.Underline)),
                    ) { openUrl(ctx, s.url) },
                ) { put(s.c) }
                Inl.Break -> append('\n')
            }
        }
        withStyle(SpanStyle(color = color)) { put(spans) }
    }
}

@Composable
private fun InlineText(src: String, style: TextStyle, color: Color, modifier: Modifier = Modifier, align: TextAlign? = null) {
    val spans = remember(src) { parseInline(src) }
    Text(inlineAnnotated(spans, color), style = style, modifier = modifier, textAlign = align)
}

private val SHELLS = setOf("sh", "bash", "shell", "zsh")

@Composable
private fun CodeBlock(b: Md.Code, actions: CodeActions?) {
    val c = k.c
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        if (actions != null) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(b.lang, style = k.ty.textXsmall, color = c.faint)
                Spacer(Modifier.weight(1f))
                val run = actions.onRun
                if (run != null && b.lang.lowercase() in SHELLS && b.code.isNotBlank() && !b.open) {
                    KButton("Run", { run(b.code) }, variant = Variant.GHOST_MUTED, size = Size.SMALL, icon = Lucide.Terminal)
                }
                KButton("Copy", { actions.onCopy(b.code) }, variant = Variant.GHOST_MUTED, size = Size.SMALL, icon = Lucide.Copy)
            }
        }
        val shape = RoundedCornerShape(6.dp)
        Box(
            Modifier.fillMaxWidth().clip(shape).background(c.surface).border(0.5.dp, c.border, shape)
                .horizontalScroll(rememberScrollState()).padding(12.dp),
        ) {
            Text(b.code.ifEmpty { " " }, style = k.ty.mono.copy(fontSize = 13.sp, lineHeight = 20.sp), color = c.fg, softWrap = false)
        }
    }
}

@Composable
private fun MdList(b: Md.ListBlock, color: Color, actions: CodeActions?) {
    val c = k.c
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        b.items.forEachIndexed { i, item: ListItem ->
            Row(Modifier.fillMaxWidth()) {
                Box(Modifier.width(32.dp), contentAlignment = Alignment.TopCenter) {
                    when (item.task) {
                        null -> Text(b.start?.let { "${it + i}." } ?: "•", style = k.ty.markdown, color = c.muted)
                        else -> Box(
                            Modifier.padding(top = 3.dp).size(16.dp).clip(RoundedCornerShape(k.r.sm))
                                .background(if (item.task) c.chip else Color.Transparent)
                                .border(1.dp, if (item.task) c.border2 else c.border, RoundedCornerShape(k.r.sm)),
                            contentAlignment = Alignment.Center,
                        ) { if (item.task) KIcon(CheckGlyph, c.fg, 12.dp) }
                    }
                }
                MdBlocks(item.blocks, Modifier.weight(1f), color, actions)
            }
        }
    }
}

@Composable
private fun MdTable(t: Md.Table, color: Color) {
    val c = k.c
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val style = k.ty.markdown
    val widths: List<Dp> = remember(t, style) {
        t.head.indices.map { col ->
            val texts = listOf(t.head[col]) + t.rows.map { it.getOrElse(col) { "" } }
            val px = texts.maxOf { s -> measurer.measure(parseInline(s).joinToString("") { it.plain() }, style).size.width }
            with(density) { (px.toDp() + 20.dp).coerceIn(120.dp, 360.dp) }
        }
    }
    val shape = RoundedCornerShape(k.r.md)
    Box(Modifier.horizontalScroll(rememberScrollState())) {
        Column(Modifier.clip(shape).border(1.dp, c.border, shape)) {
            TableRow(t.head, widths, t.align, color, head = true)
            t.rows.forEach { r ->
                Box(Modifier.height(1.dp).width(widths.fold(0.dp) { a, w -> a + w }).background(c.border))
                TableRow(r, widths, t.align, color, head = false)
            }
        }
    }
}

@Composable
private fun TableRow(cells: List<String>, widths: List<Dp>, align: List<Char>, color: Color, head: Boolean) {
    val c = k.c
    Row(Modifier.background(if (head) c.surface else Color.Transparent).height(IntrinsicSize.Min)) {
        cells.forEachIndexed { i, cell ->
            InlineText(
                cell,
                if (head) k.ty.markdown.copy(fontWeight = FontWeight(600)) else k.ty.markdown,
                color,
                Modifier.width(widths.getOrElse(i) { 120.dp }).padding(horizontal = 10.dp, vertical = 6.dp),
                when (align.getOrNull(i)) {
                    'r' -> TextAlign.End
                    'c' -> TextAlign.Center
                    else -> TextAlign.Start
                },
            )
        }
    }
}
