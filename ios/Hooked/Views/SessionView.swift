import SwiftUI

struct SessionView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase
    let sessions: SessionsStore
    @State private var store: SessionStore
    @State private var atBottom = true
    @State private var confirmKill = false

    init(id: String, sessions: SessionsStore) {
        self.sessions = sessions
        _store = State(initialValue: SessionStore(id: id, client: sessions.client))
    }

    private var summary: Session? { store.session ?? sessions.session(store.id) }

    private var scrollKey: String {
        "\(store.detail?.messages.count ?? 0)|\(store.snapshot?.text.count ?? -1)|\(store.outgoing ?? "")|\(store.detail?.pendingLeadIn?.count ?? 0)"
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 12) {
                    if let d = store.detail {
                        if d.messages.isEmpty { SystemLine(text: "Empty conversation") }
                        ForEach(d.messages) { MessageRow(message: $0).equatable() }
                        if let leadIn = d.pendingLeadIn, d.session.live { AssistantBubble(parts: [.text(leadIn)]) }
                    } else if let err = store.loadError {
                        SystemLine(text: err)
                    } else {
                        ProgressView().padding(.top, 40)
                    }
                    if let o = store.outgoing { UserBubble(text: o, queued: true) }
                    if let snap = store.snapshot, snap.busy { LiveBubble(snapshot: snap) }
                    Color.clear.frame(height: 1).id("bottom")
                        .onAppear { atBottom = true }
                        .onDisappear { atBottom = false }
                }
                .padding(12)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.ground)
            .onChange(of: scrollKey) {
                if atBottom { withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) } }
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) { relatedBar }
        .safeAreaInset(edge: .bottom, spacing: 0) { bottomBar }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) { header }
            ToolbarItem(placement: .topBarTrailing) { menu }
        }
        .onAppear { store.start() }
        .onDisappear { store.stop() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { store.start() } else if phase == .background { store.stop() }
        }
        .onChange(of: sessions.session(store.id)?.changeKey) { Task { await store.load() } }
        .alert("Error", isPresented: Binding(get: { store.actionError != nil }, set: { if !$0 { store.actionError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(store.actionError ?? "")
        }
        .alert("Prompt cache is warm", isPresented: Binding(get: { store.heldSwitch != nil }, set: { if !$0 { store.heldSwitch = nil } })) {
            Button("Switch anyway", role: .destructive) {
                if let h = store.heldSwitch { Task { await store.setModel(model: h.model, effort: h.effort, force: true) } }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(impactText)
        }
        .confirmationDialog("Kill this session?", isPresented: $confirmKill, titleVisibility: .visible) {
            Button("Kill session", role: .destructive) { Task { await store.kill() } }
        } message: {
            Text("The Claude process stops. The transcript stays available.")
        }
    }

    private var impactText: String {
        let fields = store.heldSwitch?.impact.object ?? [:]
        let lines = fields.keys.sorted().map { "\($0): \(fields[$0]?.display ?? "")" }
        return (["Switching models drops the cached prompt and re-sends the whole conversation."] + lines).joined(separator: "\n")
    }

    /// Group mother and siblings, then sessions this one launched or linked to.
    private var related: [(id: String, session: Session?, label: String, isMother: Bool)] {
        let me = store.id
        let group = summary?.group
        var ids = (group?.members ?? []).filter { $0 != me }
        let labels = Dictionary((store.detail?.subSessions ?? []).map { ($0.id, $0.label) }, uniquingKeysWith: { a, _ in a })
        for s in store.detail?.subSessions ?? [] where s.id != me && !ids.contains(s.id) { ids.append(s.id) }
        return ids.map { id in
            let s = sessions.session(id)
            return (id, s, s?.displayTitle ?? labels[id]?.nilIfEmpty ?? String(id.prefix(8)), id == group?.mother)
        }
    }

    @ViewBuilder private var relatedBar: some View {
        let items = related
        if !items.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(items, id: \.id) { r in
                        let style = r.session.map { $0.needsYou ? StateStyle.decision : StateStyle.of($0.state) } ?? StateStyle.of(.unknown)
                        Button { app.path.append(r.id) } label: {
                            HStack(spacing: 5) {
                                if r.isMother { Image(systemName: "arrow.turn.left.up").font(.caption2) }
                                StateDot(style: style, size: 7)
                                Text(r.label).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                            }
                            .frame(maxWidth: 200)
                            .padding(.vertical, 5)
                            .padding(.horizontal, 9)
                            .background(Theme.card, in: Capsule())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(r.isMother ? "Parent: \(r.label)" : r.label)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
            }
            .background(.bar)
        }
    }

    @ViewBuilder private var bottomBar: some View {
        VStack(spacing: 6) {
            if let d = store.detail, d.session.live, d.pendingPlan != nil || d.pendingQuestion != nil {
                ScrollView { PendingCard(store: store, detail: d) }
                    .scrollBounceBehavior(.basedOnSize)
                    .frame(maxHeight: 420)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if store.detail != nil {
                if !store.isLive {
                    HStack {
                        Text("Not running. Sending a message resumes it.")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.muted)
                        Spacer()
                        Button("Resume") { Task { await store.resume() } }
                            .font(.system(size: 13, weight: .semibold))
                            .disabled(store.sending)
                    }
                    .padding(.horizontal, 14)
                }
                ComposerView(store: store, answering: store.isLive && store.detail?.pendingQuestion.map { !$0.isPermission } == true)
            }
        }
        .padding(.top, 6)
        .background(.bar)
    }

    private var header: some View {
        let s = summary
        let style = StateStyle.of(s?.state ?? .unknown)
        let meta = [s?.state == nil ? nil : style.label,
                    PermissionMode.label(store.detail?.permissionMode),
                    s?.model?.shortModel].compactMap { $0 }.joined(separator: " · ")
        return VStack(spacing: 1) {
            Text(s?.displayTitle ?? "Session")
                .font(.system(size: 15, weight: .bold))
                .lineLimit(1)
            HStack(spacing: 5) {
                StateDot(style: style, size: 7)
                Text(meta).font(.system(size: 11, weight: .semibold)).foregroundStyle(style.ink).lineLimit(1)
            }
        }
        .frame(maxWidth: 260)
    }

    private var menu: some View {
        let d = store.detail
        let live = store.isLive
        return Menu {
            Picker("Mode", selection: Binding(get: { d?.permissionMode ?? "default" }, set: { m in Task { await store.setMode(m) } })) {
                ForEach(PermissionMode.live, id: \.self) { Text(PermissionMode.label($0)).tag($0) }
            }
            .pickerStyle(.menu)
            .disabled(!live)
            if !app.capabilities.models.isEmpty {
                Menu("Model") {
                    ForEach(app.capabilities.models) { g in
                        Section(g.label) {
                            ForEach(g.options, id: \.id) { o in
                                Button {
                                    Task { await store.setModel(model: o.id, effort: nil) }
                                } label: {
                                    if d?.session.model == o.id { Label(app.capabilities.modelLabel(o.id), systemImage: "checkmark") } else { Text(app.capabilities.modelLabel(o.id)) }
                                }
                            }
                        }
                    }
                }
                .disabled(!live)
            }
            if !app.capabilities.efforts.isEmpty {
                Picker("Effort", selection: Binding(get: { d?.session.effort ?? "" }, set: { e in Task { await store.setModel(model: nil, effort: e) } })) {
                    if let e = d?.session.effort, !app.capabilities.efforts.contains(e) { Text(e).tag(e) }
                    if d?.session.effort == nil { Text("Default").tag("") }
                    ForEach(app.capabilities.efforts, id: \.self) { Text($0.capitalized).tag($0) }
                }
                .pickerStyle(.menu)
                .disabled(!live)
            }
            Toggle("Auto-approve tools", isOn: Binding(get: { d?.autoApprove ?? false }, set: { on in Task { await store.setAutoApprove(on) } }))
                .disabled(!live)
            Divider()
            Button { Task { await store.load() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
            if live && store.isBusy {
                Button { Task { await store.interrupt() } } label: { Label("Interrupt", systemImage: "stop.circle") }
            }
            if live {
                Button(role: .destructive) { confirmKill = true } label: { Label("Kill session", systemImage: "xmark.octagon") }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel("Session controls")
    }
}
