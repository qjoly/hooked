package dev.qjoly.hooked.data.lens

import org.intellij.markdown.MarkdownElementTypes
import org.intellij.markdown.MarkdownTokenTypes
import org.intellij.markdown.flavours.gfm.GFMFlavourDescriptor
import org.intellij.markdown.parser.CancellationToken
import org.intellij.markdown.parser.MarkdownParser

// desktop-rune's mddiff.rs (the web's mdDiff.js): both versions cut into the blocks a reader sees
// (a top-level list into its items), the block lists diffed, and each block kept with the source
// lines it was cut from, so a tap on a block finds its lines in the diff and back.

enum class MdKind { CTX, ADD, DEL }

data class MdBlock(val key: String, val text: String, val lines: IntRange)

/** A block of the rendered diff, with its source lines on each side it is on. */
data class MdPiece(val kind: MdKind, val text: String, val old: IntRange?, val new: IntRange?) {
    fun lines(side: Side) = if (side == Side.OLD) old else new

    /** The lines a tap on it selects: on the new side, unless it was removed. */
    fun source(): Pair<Side, IntRange>? = new?.let { Side.NEW to it } ?: old?.let { Side.OLD to it }
}

fun isMarkdown(path: String): Boolean {
    val p = path.substringBefore(" · ").lowercase()
    return p.endsWith(".md") || p.endsWith(".markdown") || p.endsWith(".mdx")
}

/** The end of a leading `---` front matter block and its YAML. */
private fun frontMatter(src: String): Pair<Int, String>? {
    if (!src.startsWith("---")) return null
    val rest = src.substring(3)
    val first = rest.indexOf('\n').takeIf { it >= 0 } ?: return null
    if (rest.substring(0, first).isNotBlank()) return null
    val body = rest.substring(first + 1)
    var at = 0
    while (at < body.length) {
        val nl = body.indexOf('\n', at)
        val end = if (nl < 0) body.length else nl + 1
        val line = body.substring(at, end)
        if (line.trimEnd() == "---") return (3 + first + 1 + at + line.length) to body.substring(0, maxOf(at - 1, 0))
        at = end
    }
    return null
}

private val parser by lazy { MarkdownParser(GFMFlavourDescriptor(), true, CancellationToken.NonCancellable) }

fun mdBlocks(source: String): List<MdBlock> {
    val src = source.replace("\r\n", "\n")
    val breaks = src.indices.filter { src[it] == '\n' }
    fun lineOf(at: Int): Int {
        var lo = 0
        var hi = breaks.size
        while (lo < hi) {
            val mid = (lo + hi) / 2
            if (breaks[mid] < at) lo = mid + 1 else hi = mid
        }
        return lo + 1
    }
    fun linesOf(at: Int, piece: String) = lineOf(at)..lineOf(at + maxOf(piece.length - 1, 0))
    val out = ArrayList<MdBlock>()
    var body = src
    frontMatter(body)?.let { (end, yaml) ->
        val key = body.substring(0, end).trimEnd()
        out += MdBlock(key, "```yaml\n$yaml\n```", linesOf(0, key))
        body = body.substring(end)
    }
    val base = src.length - body.length
    val root = runCatching { parser.buildMarkdownTreeFromString(body as CharSequence) }.getOrNull() ?: return out
    for (node in root.children) {
        when (node.type) {
            MarkdownTokenTypes.EOL, MarkdownTokenTypes.WHITE_SPACE -> {}
            MarkdownElementTypes.UNORDERED_LIST, MarkdownElementTypes.ORDERED_LIST -> {
                var ordinal: Long? = null
                for (item in node.children.filter { it.type == MarkdownElementTypes.LIST_ITEM }) {
                    val piece = body.substring(item.startOffset, item.endOffset).trimEnd()
                    if (node.type == MarkdownElementTypes.ORDERED_LIST && ordinal == null) ordinal = leadingNumber(piece)
                    val n = ordinal
                    val text = if (node.type == MarkdownElementTypes.ORDERED_LIST && n != null) renumber(piece, n).also { ordinal = n + 1 } else piece
                    out += MdBlock(piece, text, linesOf(base + item.startOffset, piece))
                }
            }
            else -> {
                val piece = body.substring(node.startOffset, node.endOffset).trimEnd()
                if (piece.isNotBlank()) out += MdBlock(piece, piece, linesOf(base + node.startOffset, piece))
            }
        }
    }
    return out
}

private fun leadingNumber(item: String): Long? = item.trimStart().takeWhile { it in '0'..'9' }.toLongOrNull()

private fun renumber(item: String, n: Long): String {
    val lead = item.length - item.trimStart().length
    val digits = item.substring(lead).takeWhile { it in '0'..'9' }.length
    if (digits == 0) return item
    return item.substring(0, lead) + n + item.substring(lead + digits)
}

/** The new version's blocks in order, each removed block just before what replaced it. */
fun blockDiff(old: String, new: String): List<MdPiece> {
    val a = mdBlocks(old)
    val b = mdBlocks(new)
    val n = a.size
    val m = b.size
    val lcs = Array(n + 1) { IntArray(m + 1) }
    for (i in n - 1 downTo 0) for (j in m - 1 downTo 0) {
        lcs[i][j] = if (a[i].key == b[j].key) lcs[i + 1][j + 1] + 1 else maxOf(lcs[i + 1][j], lcs[i][j + 1])
    }
    var i = 0
    var j = 0
    val out = ArrayList<MdPiece>()
    while (i < n || j < m) {
        if (i < n && j < m && a[i].key == b[j].key) {
            out += MdPiece(MdKind.CTX, b[j].text, a[i].lines, b[j].lines)
            i++
            j++
        } else if (i < n && (j == m || lcs[i + 1][j] >= lcs[i][j + 1])) {
            out += MdPiece(MdKind.DEL, a[i].text, a[i].lines, null)
            i++
        } else {
            out += MdPiece(MdKind.ADD, b[j].text, null, b[j].lines)
            j++
        }
    }
    return out
}

/** A file's rendered diff: its two texts, else the lines its hunks hold. */
fun filePieces(f: FileDiff): List<MdPiece> {
    fun sideText(side: Side) = f.text(side) ?: f.hunks.flatMap { it.lines }.filter { it.number(side) != null }.joinToString("\n") { it.text }
    return blockDiff(sideText(Side.OLD), sideText(Side.NEW))
}

/** The piece showing line `line` of `side`: the last one starting at or before it. */
fun pieceAt(pieces: List<MdPiece>, side: Side, line: Int): Int? =
    pieces.indexOfLast { p -> p.lines(side)?.let { it.first <= line } ?: false }.takeIf { it >= 0 }

/** The pieces a line selection spans. */
fun covered(pieces: List<MdPiece>, sel: LineRange): IntRange? {
    val a = pieceAt(pieces, sel.start.side, sel.start.line) ?: return null
    val b = pieceAt(pieces, sel.end.side, sel.end.line) ?: return null
    return minOf(a, b)..maxOf(a, b)
}
