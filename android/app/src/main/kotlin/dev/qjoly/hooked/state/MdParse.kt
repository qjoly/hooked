package dev.qjoly.hooked.state

// The GFM subset Claude writes, parsed the way rune-kit's markdown lays it out: blocks, then inline spans.

sealed interface Md {
    data class Heading(val level: Int, val text: String) : Md
    data class Para(val text: String) : Md

    /** `open` while a streamed fence has not closed yet. */
    data class Code(val lang: String, val code: String, val open: Boolean) : Md

    /** `start` is null for bullets. */
    data class ListBlock(val start: Int?, val items: List<ListItem>) : Md
    data class Quote(val blocks: List<Md>) : Md
    data class Table(val head: List<String>, val rows: List<List<String>>, val align: List<Char>) : Md
    data object Rule : Md
}

/** `task` is null for a plain item, else whether its box is ticked. */
data class ListItem(val blocks: List<Md>, val task: Boolean? = null)

sealed interface Inl {
    data class Text(val s: String) : Inl
    data class Code(val s: String) : Inl
    data class Strong(val c: List<Inl>) : Inl
    data class Em(val c: List<Inl>) : Inl
    data class Strike(val c: List<Inl>) : Inl
    data class Link(val c: List<Inl>, val url: String) : Inl
    data object Break : Inl
}

private val FENCE = Regex("""^( {0,3})(`{3,}|~{3,})\s*([^`\s]*).*$""")
private val HEADING = Regex("""^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$""")
private val RULE = Regex("""^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$""")
private val LIST = Regex("""^( *)([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$""")
private val QUOTE = Regex("""^ {0,3}> ?(.*)$""")
private val TABLE_SEP = Regex("""^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$""")
private val TASK = Regex("""^\[([ xX])][ \t]+(.*)$""", RegexOption.DOT_MATCHES_ALL)

fun parseMarkdown(src: String): List<Md> = blocks(src.replace("\r\n", "\n").split('\n'))

private fun indentOf(line: String): Int {
    var n = 0
    for (c in line) if (c == ' ') n++ else if (c == '\t') n += 4 - n % 4 else break
    return n
}

/** Drops up to `n` columns of leading spaces. */
private fun dedent(line: String, n: Int): String {
    var cols = 0
    var i = 0
    while (i < line.length && cols < n && (line[i] == ' ' || line[i] == '\t')) {
        cols += if (line[i] == '\t') 4 - cols % 4 else 1
        i++
    }
    return line.substring(i)
}

private fun isTableStart(lines: List<String>, i: Int) =
    i + 1 < lines.size && '|' in lines[i] && '-' in lines[i + 1] && TABLE_SEP.matches(lines[i + 1]) &&
        cells(lines[i]).size == cells(lines[i + 1]).size

/** Whether a line opens a block that cuts a paragraph short. */
private fun interrupts(lines: List<String>, i: Int): Boolean {
    val l = lines[i]
    if (FENCE.matches(l) || HEADING.matches(l) || RULE.matches(l) || QUOTE.matches(l) || isTableStart(lines, i)) return true
    val m = LIST.matchEntire(l) ?: return false
    val marker = m.groupValues[2]
    // An ordered list only interrupts a paragraph from 1, and an empty item never does.
    return m.groupValues[4].isNotBlank() && (!marker[0].isDigit() || marker.dropLast(1) == "1")
}

private fun blocks(lines: List<String>): List<Md> {
    val out = mutableListOf<Md>()
    var i = 0
    while (i < lines.size) {
        val line = lines[i]
        if (line.isBlank()) {
            i++
            continue
        }
        val fenceMatch = FENCE.matchEntire(line)
        if (fenceMatch != null) {
            val pad = fenceMatch.groupValues[1].length
            val fence = fenceMatch.groupValues[2]
            val close = Regex("""^ {0,3}[${fence[0]}]{${fence.length},}\s*$""")
            val body = mutableListOf<String>()
            var j = i + 1
            while (j < lines.size && !close.matches(lines[j])) body += dedent(lines[j++], pad)
            out += Md.Code(fenceMatch.groupValues[3], body.joinToString("\n"), j >= lines.size)
            i = j + 1
            continue
        }
        val heading = HEADING.matchEntire(line)
        if (heading != null) {
            out += Md.Heading(heading.groupValues[1].length, heading.groupValues[2].trim())
            i++
            continue
        }
        if (RULE.matches(line)) {
            out += Md.Rule
            i++
            continue
        }
        if (QUOTE.matches(line)) {
            val inner = mutableListOf<String>()
            while (i < lines.size && lines[i].isNotBlank()) {
                val q = QUOTE.matchEntire(lines[i])
                inner += q?.groupValues?.get(1) ?: lines[i]
                i++
            }
            out += Md.Quote(blocks(inner))
            continue
        }
        if (isTableStart(lines, i)) {
            val head = cells(lines[i])
            val align = cells(lines[i + 1]).map { c ->
                val t = c.trim()
                when {
                    t.startsWith(':') && t.endsWith(':') -> 'c'
                    t.endsWith(':') -> 'r'
                    else -> 'l'
                }
            }
            var j = i + 2
            val rows = mutableListOf<List<String>>()
            while (j < lines.size && lines[j].isNotBlank() && '|' in lines[j]) {
                val r = cells(lines[j])
                rows += List(head.size) { r.getOrElse(it) { "" } }
                j++
            }
            out += Md.Table(head, rows, align)
            i = j
            continue
        }
        if (LIST.matches(line)) {
            val (list, next) = list(lines, i)
            out += list
            i = next
            continue
        }
        val para = mutableListOf(line.trim())
        i++
        while (i < lines.size && lines[i].isNotBlank() && !interrupts(lines, i)) para += lines[i++].trimStart()
        out += Md.Para(para.joinToString("\n"))
    }
    return out
}

private fun list(lines: List<String>, from: Int): Pair<Md.ListBlock, Int> {
    val first = LIST.matchEntire(lines[from])!!
    val base = indentOf(first.groupValues[1])
    val ordered = first.groupValues[2][0].isDigit()
    val start = if (ordered) first.groupValues[2].dropLast(1).toIntOrNull() ?: 1 else null
    val items = mutableListOf<ListItem>()
    var i = from
    while (i < lines.size) {
        val m = LIST.matchEntire(lines[i]) ?: break
        val indent = indentOf(m.groupValues[1])
        if (indent < base || indent > base + 3 || m.groupValues[2][0].isDigit() != ordered) break
        val gap = m.groupValues[3].length
        val content = m.groupValues[4]
        val contentIndent = indent + m.groupValues[2].length + if (gap in 1..4 && content.isNotEmpty()) gap else 1
        val body = mutableListOf(content)
        i++
        var lastBlank = false
        while (i < lines.size) {
            val l = lines[i]
            if (l.isBlank()) {
                var j = i
                while (j < lines.size && lines[j].isBlank()) j++
                if (j < lines.size && indentOf(lines[j]) >= contentIndent) {
                    repeat(j - i) { body += "" }
                    i = j
                    lastBlank = true
                    continue
                }
                break
            }
            val li = indentOf(l)
            val marker = LIST.matchEntire(l)
            when {
                li >= contentIndent -> body += dedent(l, contentIndent)
                // A nested list indented less than the parent's text still belongs to the item.
                marker != null && li > base -> body += dedent(l, li)
                marker == null && !lastBlank && !interrupts(lines, i) -> body += l.trimStart()
                else -> break
            }
            lastBlank = false
            i++
        }
        val task = TASK.matchEntire(body[0])
        if (task != null) body[0] = task.groupValues[2]
        items += ListItem(blocks(body), task?.let { it.groupValues[1] != " " })
        // Blank lines between items keep the list going.
        var j = i
        while (j < lines.size && lines[j].isBlank()) j++
        val next = if (j < lines.size) LIST.matchEntire(lines[j]) else null
        if (j > i && (next == null || indentOf(next.groupValues[1]) !in base..base + 3)) break
        i = j
    }
    return Md.ListBlock(start, items) to i
}

private fun cells(line: String): List<String> {
    var t = line.trim()
    if (t.startsWith('|')) t = t.substring(1)
    if (t.endsWith('|') && !t.endsWith("\\|")) t = t.dropLast(1)
    val out = mutableListOf<String>()
    val cur = StringBuilder()
    var i = 0
    var code = false
    while (i < t.length) {
        val c = t[i]
        when {
            c == '\\' && i + 1 < t.length && t[i + 1] == '|' -> { cur.append('|'); i++ }
            c == '`' -> { code = !code; cur.append(c) }
            c == '|' && !code -> { out += cur.toString().trim(); cur.clear() }
            else -> cur.append(c)
        }
        i++
    }
    out += cur.toString().trim()
    return out
}

// Inline spans.

private const val PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"

fun parseInline(s: String): List<Inl> = InlineParser(s).run()

private class InlineParser(private val s: String) {
    private val out = mutableListOf<Inl>()
    private val buf = StringBuilder()

    private fun flush() {
        if (buf.isNotEmpty()) {
            out += Inl.Text(buf.toString())
            buf.clear()
        }
    }

    private fun emit(i: Inl) {
        flush()
        out += i
    }

    fun run(): List<Inl> {
        var i = 0
        while (i < s.length) {
            val c = s[i]
            i = when (c) {
                '\\' -> escape(i)
                '\n' -> newline(i)
                '`' -> code(i)
                '*', '_' -> emphasis(i)
                '~' -> strike(i)
                '[' -> link(i, image = false)
                '!' -> if (i + 1 < s.length && s[i + 1] == '[') link(i + 1, image = true) else literal(i)
                '<' -> angle(i)
                'h' -> bare(i)
                else -> literal(i)
            }
        }
        flush()
        return out
    }

    private fun literal(i: Int): Int {
        buf.append(s[i])
        return i + 1
    }

    private fun escape(i: Int): Int {
        if (i + 1 >= s.length) return literal(i)
        val n = s[i + 1]
        return when {
            n == '\n' -> { emit(Inl.Break); i + 2 }
            n in PUNCT -> { buf.append(n); i + 2 }
            else -> literal(i)
        }
    }

    private fun newline(i: Int): Int {
        if (buf.endsWith("  ")) {
            buf.setLength(buf.trimEnd(' ').length)
            emit(Inl.Break)
        } else {
            buf.setLength(buf.trimEnd(' ').length)
            buf.append(' ')
        }
        var j = i + 1
        while (j < s.length && s[j] == ' ') j++
        return j
    }

    private fun run(i: Int, c: Char): Int {
        var j = i
        while (j < s.length && s[j] == c) j++
        return j - i
    }

    private fun code(i: Int): Int {
        val n = run(i, '`')
        var j = i + n
        while (j < s.length) {
            if (s[j] == '`') {
                val m = run(j, '`')
                if (m == n) {
                    var body = s.substring(i + n, j).replace('\n', ' ')
                    if (body.length >= 2 && body.startsWith(' ') && body.endsWith(' ') && body.isNotBlank()) body = body.substring(1, body.length - 1)
                    emit(Inl.Code(body))
                    return j + m
                }
                j += m
            } else {
                j++
            }
        }
        buf.append("`".repeat(n))
        return i + n
    }

    /** Index of the closing `delim` for an opener ending at `from`, or -1. */
    private fun closing(from: Int, delim: String): Int {
        val c = delim[0]
        var j = from
        while (j < s.length) {
            when (s[j]) {
                '`' -> {
                    // Code spans hide their delimiters.
                    val n = run(j, '`')
                    val end = s.indexOf("`".repeat(n), j + n)
                    j = if (end < 0) j + n else end + n
                    continue
                }
                '\\' -> {
                    j += 2
                    continue
                }
            }
            if (s[j] == c) {
                val runLen = run(j, c)
                if (j > from && !s[j - 1].isWhitespace() && runLen >= delim.length) {
                    val exact = runLen == delim.length || runLen == 3
                    val wordAfter = c == '_' && j + runLen < s.length && s[j + runLen].isLetterOrDigit()
                    // A longer run closes with its last characters, leaving the first to an inner span.
                    if (exact && !wordAfter) return j + (runLen - delim.length)
                }
                j += runLen
                continue
            }
            j++
        }
        return -1
    }

    private fun emphasis(i: Int): Int {
        val c = s[i]
        val n = run(i, c)
        if (c == '_' && i > 0 && s[i - 1].isLetterOrDigit()) {
            buf.append(c.toString().repeat(n))
            return i + n
        }
        for (len in minOf(n, 3) downTo 1) {
            val open = i + len
            if (open >= s.length || s[open].isWhitespace()) continue
            val delim = c.toString().repeat(len)
            val end = closing(open, delim)
            if (end < 0) continue
            val inner = parseInline(s.substring(open, end))
            flush()
            out += when (len) {
                3 -> Inl.Strong(listOf(Inl.Em(inner)))
                2 -> Inl.Strong(inner)
                else -> Inl.Em(inner)
            }
            return end + len
        }
        buf.append(c.toString().repeat(n))
        return i + n
    }

    private fun strike(i: Int): Int {
        if (run(i, '~') != 2) return literal(i)
        val end = s.indexOf("~~", i + 2)
        if (end <= i + 2) return literal(i)
        emit(Inl.Strike(parseInline(s.substring(i + 2, end))))
        return end + 2
    }

    private fun link(i: Int, image: Boolean): Int {
        var depth = 0
        var j = i
        while (j < s.length) {
            when (s[j]) {
                '\\' -> j++
                '[' -> depth++
                ']' -> if (--depth == 0) break
            }
            j++
        }
        if (j + 1 >= s.length || s[j + 1] != '(') return fail(i, image)
        var k = j + 2
        var parens = 1
        while (k < s.length) {
            when (s[k]) {
                '(' -> parens++
                ')' -> if (--parens == 0) break
            }
            k++
        }
        if (k >= s.length) return fail(i, image)
        var url = s.substring(j + 2, k).trim()
        url = url.substringBefore(' ').removePrefix("<").removeSuffix(">")
        val label = s.substring(i + 1, j)
        emit(Inl.Link(if (image) listOf(Inl.Text(label.ifEmpty { "image" })) else parseInline(label), url))
        return k + 1
    }

    /** Not a link after all: the bracket, and the bang before it, stay text. */
    private fun fail(i: Int, image: Boolean): Int {
        if (image) buf.append('!')
        return literal(i)
    }

    private fun angle(i: Int): Int {
        val end = s.indexOf('>', i)
        if (end < 0) return literal(i)
        val inner = s.substring(i + 1, end)
        if (!Regex("""(https?://|mailto:)\S+""").matches(inner)) return literal(i)
        emit(Inl.Link(listOf(Inl.Text(inner)), inner))
        return end + 1
    }

    private fun bare(i: Int): Int {
        if (!(s.startsWith("https://", i) || s.startsWith("http://", i)) || (i > 0 && s[i - 1].isLetterOrDigit())) return literal(i)
        var j = i
        while (j < s.length && !s[j].isWhitespace() && s[j] != '<') j++
        var url = s.substring(i, j)
        while (url.isNotEmpty() && url.last() in ".,:;!?'\"*_") url = url.dropLast(1)
        while (url.endsWith(")") && url.count { it == ')' } > url.count { it == '(' }) url = url.dropLast(1)
        if (url.length <= "https://".length) return literal(i)
        emit(Inl.Link(listOf(Inl.Text(url)), url))
        return i + url.length
    }
}

/** Plain text of inline spans, for copy and accessibility. */
fun Inl.plain(): String = when (this) {
    is Inl.Text -> s
    is Inl.Code -> s
    is Inl.Strong -> c.joinToString("") { it.plain() }
    is Inl.Em -> c.joinToString("") { it.plain() }
    is Inl.Strike -> c.joinToString("") { it.plain() }
    is Inl.Link -> c.joinToString("") { it.plain() }
    Inl.Break -> "\n"
}

/** The plan's paragraphs, headings and list items as plain lines to quote. */
fun planPassages(plan: String): List<String> {
    val out = mutableListOf<String>()
    fun walk(blocks: List<Md>) {
        for (b in blocks) when (b) {
            is Md.Para -> out += parseInline(b.text).joinToString("") { it.plain() }
            is Md.Heading -> out += parseInline(b.text).joinToString("") { it.plain() }
            is Md.ListBlock -> b.items.forEach { walk(it.blocks) }
            is Md.Quote -> walk(b.blocks)
            is Md.Code -> out += b.code
            is Md.Table -> b.rows.forEach { out += it.joinToString(" · ") }
            Md.Rule -> {}
        }
    }
    walk(parseMarkdown(plan))
    return out.filter { it.isNotBlank() }
}
