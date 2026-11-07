import SwiftUI

/// Inline markdown with fenced code blocks rendered as monospaced panels.
struct MarkdownText: View {
    let text: String
    var color: Color = Theme.ink

    private enum Block: Hashable {
        case prose(String)
        case code(String)
    }

    private var blocks: [Block] {
        var out: [Block] = []
        var buf: [Substring] = []
        var inCode = false
        func flush() {
            let s = buf.joined(separator: "\n")
            if inCode { out.append(.code(s)) } else if !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                out.append(.prose(s.trimmingCharacters(in: .newlines)))
            }
            buf = []
        }
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") { flush(); inCode.toggle() } else { buf.append(line) }
        }
        flush()
        return out
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .prose(let s):
                    Text(Self.attributed(s))
                        .font(.system(size: 15))
                        .foregroundStyle(color)
                        .tint(Theme.link)
                        .fixedSize(horizontal: false, vertical: true)
                case .code(let s):
                    CodeBlock(text: s)
                }
            }
        }
        .textSelection(.enabled)
    }

    /// Block syntax is not parsed by the inline mode, so headings become bold lines and bullets dots.
    static func attributed(_ s: String) -> AttributedString {
        let lines = s.split(separator: "\n", omittingEmptySubsequences: false).map { line -> String in
            let t = line.drop { $0 == " " }
            if t.hasPrefix("#") {
                let title = t.drop { $0 == "#" }.trimmingCharacters(in: .whitespaces)
                return title.isEmpty ? String(line) : "**\(title)**"
            }
            if t.hasPrefix("- ") || t.hasPrefix("* ") {
                return String(repeating: " ", count: line.count - t.count) + "• " + t.dropFirst(2)
            }
            return String(line)
        }
        let joined = lines.joined(separator: "\n")
        let opts = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: joined, options: opts)) ?? AttributedString(joined)
    }
}

struct CodeBlock: View {
    let text: String
    var maxLines: Int?

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(text)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(Theme.codeFg)
                .lineLimit(maxLines)
                .padding(10)
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.code, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}
