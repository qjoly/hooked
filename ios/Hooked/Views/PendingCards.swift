import SwiftUI

struct PillButtonStyle: ButtonStyle {
    var primary = false
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 14, weight: .semibold))
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .frame(maxWidth: .infinity, minHeight: 40)
            .padding(.horizontal, 10)
            .foregroundStyle(primary ? Theme.onAccent : Theme.ink)
            .background(primary ? Theme.accent : Theme.card, in: Capsule())
            .overlay { if !primary { Capsule().strokeBorder(Theme.line) } }
            .opacity(configuration.isPressed ? 0.75 : enabled ? 1 : 0.45)
    }
}

/// Question, permission or plan waiting on the user, docked above the composer.
struct PendingCard: View {
    let store: SessionStore
    let detail: SessionDetail

    var body: some View {
        Group {
            if let plan = detail.pendingPlan {
                PlanCard(store: store, plan: plan)
            } else if let q = detail.pendingQuestion {
                if q.isPermission { PermissionCard(store: store, ask: q) } else { QuestionCard(store: store, ask: q) }
            }
        }
        .disabled(store.sending)
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .card()
        .padding(.horizontal, 10)
    }
}

private struct CardHeader: View {
    let label: String
    var detail: String?

    var body: some View {
        HStack {
            StatePill(style: .decision, label: label)
            if let detail { Text(detail).font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.muted).lineLimit(1) }
            Spacer()
        }
    }
}

struct PermissionCard: View {
    let store: SessionStore
    let ask: PendingQuestion
    @State private var denying = false
    @State private var reason = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            CardHeader(label: "Permission", detail: ask.toolName)
            Text(ask.questions.first?.question ?? "Claude wants to use \(ask.toolName ?? "a tool")")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.ink)
            if let d = ask.questions.first?.options.first?.description, d != "Run this call only." {
                Text(d).font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.muted).lineLimit(6)
            }
            // Option order is the server contract: 0 allow once, 1 allow always, 2 deny.
            HStack(spacing: 8) {
                Button("Allow once") { pick(0) }.buttonStyle(PillButtonStyle(primary: true))
                Button("Allow always") { pick(1) }.buttonStyle(PillButtonStyle())
                Button("Deny") { denying = true }.buttonStyle(PillButtonStyle())
            }
        }
        .alert("Deny this call?", isPresented: $denying) {
            TextField("Reason (optional)", text: $reason)
            Button("Deny", role: .destructive) { pick(2, note: reason) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Claude reads the reason and picks another route.")
        }
    }

    private func pick(_ i: Int, note: String? = nil) {
        Task { await store.answer([.init(multi: false, indices: [i])], note: note?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty) }
    }
}

struct QuestionCard: View {
    let store: SessionStore
    let ask: PendingQuestion
    @State private var picked: [Set<Int>] = []
    @State private var other: [String] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            CardHeader(label: "Question")
            ForEach(Array(ask.questions.enumerated()), id: \.offset) { qi, q in
                VStack(alignment: .leading, spacing: 6) {
                    if let h = q.header {
                        Text(h.uppercased()).font(.system(size: 11, weight: .bold)).foregroundStyle(Theme.muted)
                    }
                    Text(q.question).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.ink)
                    ForEach(Array(q.options.enumerated()), id: \.offset) { oi, o in
                        optionRow(qi: qi, oi: oi, option: o, multi: q.multiSelect)
                    }
                    TextField("Other…", text: binding(qi), axis: .vertical)
                        .font(.system(size: 14))
                        .lineLimit(1...4)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 7)
                        .background(Theme.panel, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
            }
            Button("Send answer") { submit() }
                .buttonStyle(PillButtonStyle(primary: true))
                .disabled(!complete)
        }
        .onAppear(perform: reset)
        .onChange(of: ask.id) { reset() }
    }

    private func reset() {
        picked = Array(repeating: [], count: ask.questions.count)
        other = Array(repeating: "", count: ask.questions.count)
    }

    private func binding(_ qi: Int) -> Binding<String> {
        Binding(get: { qi < other.count ? other[qi] : "" }, set: { if qi < other.count { other[qi] = $0 } })
    }

    private var complete: Bool {
        picked.count == ask.questions.count && zip(picked, other).allSatisfy { !$0.isEmpty || !$1.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    private func optionRow(qi: Int, oi: Int, option: QuestionOption, multi: Bool) -> some View {
        let on = qi < picked.count && picked[qi].contains(oi)
        return Button {
            guard qi < picked.count else { return }
            if multi { if on { picked[qi].remove(oi) } else { picked[qi].insert(oi) } } else { picked[qi] = [oi] }
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: multi ? (on ? "checkmark.square.fill" : "square") : (on ? "largecircle.fill.circle" : "circle"))
                    .foregroundStyle(on ? Theme.accent : Theme.muted)
                    .font(.system(size: 17))
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label).font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.ink)
                    if let d = option.description { Text(d).font(.system(size: 12)).foregroundStyle(Theme.muted) }
                }
                Spacer(minLength: 0)
            }
            .padding(8)
            .background(on ? Theme.crema : Color.clear, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func submit() {
        let sel = ask.questions.indices.map { i in
            HookedClient.Selection(multi: ask.questions[i].multiSelect, indices: picked[i].sorted(),
                                   other: other[i].trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty)
        }
        Task { await store.answer(sel) }
    }
}

struct PlanCard: View {
    let store: SessionStore
    let plan: PendingPlan
    @State private var askFeedback = false
    @State private var feedback = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            CardHeader(label: "Plan")
            ScrollView {
                MarkdownText(text: plan.plan.isEmpty ? "_Empty plan_" : plan.plan)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 260)
            HStack(spacing: 8) {
                Button("Approve") { act("approve") }.buttonStyle(PillButtonStyle(primary: true))
                Button("Approve (auto)") { act("approve-auto") }.buttonStyle(PillButtonStyle())
            }
            HStack(spacing: 8) {
                Button("Keep planning") { act("keep") }.buttonStyle(PillButtonStyle())
                Button("With feedback…") { askFeedback = true }.buttonStyle(PillButtonStyle())
            }
        }
        .alert("Keep planning with feedback", isPresented: $askFeedback) {
            TextField("Feedback", text: $feedback, axis: .vertical)
            Button("Send") { act("keep-feedback", feedback: feedback) }
            Button("Cancel", role: .cancel) {}
        }
    }

    private func act(_ action: String, feedback: String? = nil) {
        let f = feedback?.trimmingCharacters(in: .whitespacesAndNewlines)
        if action == "keep-feedback" && (f ?? "").isEmpty { return }
        Task { await store.plan(action, feedback: f) }
    }
}
