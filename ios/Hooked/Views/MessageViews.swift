import SwiftUI

struct MessageRow: View, Equatable {
    let message: Message

    var body: some View {
        switch message.role {
        case "user" where !message.auto:
            UserBubble(text: message.text, truncated: message.truncated)
        case "assistant":
            AssistantBubble(parts: message.renderParts, truncated: message.truncated)
        default:
            SystemLine(text: message.auto ? "Automatic wake-up" : message.text, compact: message.kind == "compact")
        }
    }
}

private func bubbleShape(mine: Bool) -> UnevenRoundedRectangle {
    UnevenRoundedRectangle(topLeadingRadius: 16, bottomLeadingRadius: mine ? 16 : 5,
                           bottomTrailingRadius: mine ? 5 : 16, topTrailingRadius: 16, style: .continuous)
}

struct UserBubble: View {
    let text: String
    var truncated = false
    var queued = false

    var body: some View {
        HStack {
            Spacer(minLength: 48)
            VStack(alignment: .trailing, spacing: 4) {
                Text(text)
                    .font(.system(size: 15))
                    .foregroundStyle(queued ? Theme.ink : Theme.userText)
                    .textSelection(.enabled)
                if truncated { TruncatedNote().foregroundStyle(Theme.userText.opacity(0.7)) }
                if queued {
                    Text("Sending…").font(.system(size: 11, weight: .semibold)).foregroundStyle(StateStyle.of(.waiting).ink)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .background(queued ? StateStyle.of(.waiting).soft : Theme.userBubble, in: bubbleShape(mine: true))
            .overlay {
                if queued { bubbleShape(mine: true).stroke(StateStyle.of(.waiting).hue, style: StrokeStyle(lineWidth: 1, dash: [4, 3])) }
            }
        }
    }
}

struct AssistantBubble: View {
    let parts: [MessagePart]
    var truncated = false

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(parts.enumerated()), id: \.offset) { _, part in
                    switch part {
                    case .text(let t): MarkdownText(text: t)
                    case .tool(let tool): ToolChip(tool: tool)
                    }
                }
                if truncated { TruncatedNote().foregroundStyle(Theme.muted) }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .background(Theme.card, in: bubbleShape(mine: false))
            .overlay(bubbleShape(mine: false).stroke(Theme.line, lineWidth: 0.5))
            Spacer(minLength: 16)
        }
    }
}

private struct TruncatedNote: View {
    var body: some View {
        Text("Message truncated, open it in the web dashboard for the full text.").font(.system(size: 11))
    }
}

struct SystemLine: View {
    let text: String
    var compact = false

    var body: some View {
        HStack(spacing: 6) {
            if compact { Image(systemName: "rectangle.compress.vertical") }
            Text(text).lineLimit(3)
        }
        .font(.system(size: 12))
        .foregroundStyle(Theme.muted)
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 2)
    }
}

struct ToolChip: View {
    let tool: Tool
    @State private var open = false

    private static let cap = 3000

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.snappy(duration: 0.2)) { open.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .bold))
                        .rotationEffect(.degrees(open ? 90 : 0))
                    Text(tool.name).fontWeight(.semibold)
                    if let d = tool.detail { Text(d).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.middle) }
                }
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(Theme.ink)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(Theme.panel, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            .buttonStyle(.plain)
            if open {
                if let input = tool.inputText { section("Input", input) }
                if let result = tool.result { section("Result", result) }
                if tool.inputText == nil && tool.result == nil {
                    Text("No details").font(.system(size: 11)).foregroundStyle(Theme.muted)
                }
            }
        }
    }

    private func section(_ title: String, _ body: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title.uppercased()).font(.system(size: 10, weight: .bold)).foregroundStyle(Theme.muted)
            CodeBlock(text: body.count > Self.cap ? String(body.prefix(Self.cap)) + "\n…" : body, maxLines: 40)
        }
    }
}

/// The turn in progress, fed by /api/session/stream.
struct LiveBubble: View {
    let snapshot: LiveSnapshot

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 8) {
                if !snapshot.text.isEmpty {
                    MarkdownText(text: snapshot.text)
                } else if !snapshot.thinking.isEmpty {
                    Text(snapshot.thinking.suffix(400))
                        .font(.system(size: 13).italic())
                        .foregroundStyle(Theme.muted)
                        .lineLimit(4)
                }
                HStack(spacing: 6) {
                    StateDot(style: .of(.working))
                    Text(snapshot.activity ?? snapshot.tool ?? (snapshot.text.isEmpty && !snapshot.thinking.isEmpty ? "Thinking…" : "Working…"))
                        .font(.system(size: 12))
                        .foregroundStyle(StateStyle.of(.working).ink)
                        .lineLimit(1)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .background(Theme.card, in: bubbleShape(mine: false))
            .overlay(bubbleShape(mine: false).stroke(StateStyle.of(.working).hue.opacity(0.5), style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
            Spacer(minLength: 16)
        }
    }
}
