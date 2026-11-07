import SwiftUI

struct SessionsListView: View {
    @Environment(AppModel.self) private var app
    let store: SessionsStore

    @State private var showEnded = false
    @State private var showSettings = false
    @State private var showNew = false

    private var groups: (needs: [Session], working: [Session], idle: [Session], ended: [Session]) {
        let cutoff = Date().addingTimeInterval(-86400)
        var g: ([Session], [Session], [Session], [Session]) = ([], [], [], [])
        for s in store.sessions {
            // A non-driven session idle for a day is not waiting on anyone any more.
            let stale = !s.live && (s.lastActivity ?? .distantPast) < cutoff
            if s.needsYou && !stale { g.0.append(s); continue }
            switch s.state {
            case .working, .background: g.1.append(s)
            case .ended, .past: if (s.lastActivity ?? .distantPast) > cutoff { g.3.append(s) }
            default: g.2.append(s)
            }
        }
        return g
    }

    var body: some View {
        let g = groups
        List {
            if let err = store.error {
                Section {
                    Label(err, systemImage: "wifi.exclamationmark")
                        .font(.footnote)
                        .foregroundStyle(Theme.muted)
                }
            }
            section("Needs you", g.needs)
            section("Working", g.working)
            section("Idle", g.idle)
            if !g.ended.isEmpty {
                Section {
                    if showEnded { rows(g.ended) }
                } header: {
                    Button {
                        withAnimation { showEnded.toggle() }
                    } label: {
                        HStack {
                            Text("Ended")
                            Text("\(g.ended.count)").monospacedDigit()
                            Spacer()
                            Image(systemName: showEnded ? "chevron.down" : "chevron.right")
                        }
                    }
                    .foregroundStyle(Theme.muted)
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Theme.ground)
        .overlay {
            if !store.loaded && store.error == nil {
                ProgressView()
            } else if store.loaded && store.sessions.isEmpty {
                ContentUnavailableView("No sessions", systemImage: "cup.and.saucer", description: Text("Start one with +."))
            }
        }
        .refreshable { await store.refresh() }
        .navigationTitle("hooked")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { showSettings = true } label: { Image(systemName: "gearshape") }
                    .accessibilityLabel("Connection settings")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { showNew = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel("New session")
            }
        }
        .sheet(isPresented: $showSettings) { ConnectView(editing: true) }
        .sheet(isPresented: $showNew) {
            NewSessionView(store: store) { id in
                showNew = false
                app.path.append(id)
            }
        }
    }

    @ViewBuilder private func section(_ title: String, _ list: [Session]) -> some View {
        if !list.isEmpty {
            Section {
                rows(list)
            } header: {
                HStack {
                    Text(title)
                    Text("\(list.count)").monospacedDigit()
                }
            }
        }
    }

    private func rows(_ list: [Session]) -> some View {
        ForEach(list) { s in
            NavigationLink(value: s.id) { SessionRow(session: s) }
                .listRowBackground(Theme.card)
        }
    }
}

struct SessionRow: View {
    let session: Session

    private var pill: (StateStyle, String?) {
        if session.hasPlan { return (.decision, "Plan") }
        if let q = session.question { return (.decision, q.isPermission ? "Permission" : "Question") }
        if session.hasQuestion { return (.decision, "Question") }
        return (StateStyle.of(session.state), nil)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                StatePill(style: pill.0, label: pill.1)
                Spacer()
                if !session.live {
                    Image(systemName: "pause.circle")
                        .font(.caption2)
                        .foregroundStyle(Theme.muted)
                        .accessibilityLabel("Not running")
                }
                if let d = session.lastActivity {
                    Text(d.shortAge)
                        .font(.system(size: 12))
                        .monospacedDigit()
                        .foregroundStyle(Theme.muted)
                }
            }
            Text(session.displayTitle)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Theme.ink)
                .lineLimit(2)
            if let meta = [session.projectName, session.gitBranch].compactMap({ $0 }).joined(separator: " · ").nilIfEmpty {
                Text(meta)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(Theme.muted)
                    .lineLimit(1)
            }
            if session.state == .working, let act = session.activity ?? session.currentTool ?? session.todo?.current {
                Text(act)
                    .font(.system(size: 12))
                    .foregroundStyle(StateStyle.of(.working).ink)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 4)
    }
}

extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
