import SwiftUI

struct SessionsListView: View {
    @Environment(AppModel.self) private var app
    let store: SessionsStore

    @State private var showEnded = false
    @State private var showSettings = false
    @State private var showNew = false

    /// 0 needs you, 1 working, 2 idle, 3 ended, nil hidden.
    private func bucket(_ s: Session, cutoff: Date) -> Int? {
        // A non-driven session idle for a day is not waiting on anyone any more.
        let stale = !s.live && (s.lastActivity ?? .distantPast) < cutoff
        if s.needsYou && !stale { return 0 }
        switch s.state {
        case .working, .background: return 1
        case .ended, .past: return (s.lastActivity ?? .distantPast) > cutoff ? 3 : nil
        default: return 2
        }
    }

    /// Groups as units under their mother, filed by their most urgent member.
    private var groups: (needs: [SessionUnit], working: [SessionUnit], idle: [SessionUnit], ended: [SessionUnit]) {
        let cutoff = Date().addingTimeInterval(-86400)
        let byId = Dictionary(store.sessions.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var order: [String] = []
        var buckets: [String: [Session]] = [:]
        for s in store.sessions {
            if buckets[s.motherId] == nil { order.append(s.motherId) }
            buckets[s.motherId, default: []].append(s)
        }
        var g: ([SessionUnit], [SessionUnit], [SessionUnit], [SessionUnit]) = ([], [], [], [])
        for m in order {
            let members = buckets[m] ?? []
            guard let mother = byId[m] ?? members.first else { continue }
            let rank = mother.group?.members ?? []
            let kids = members.filter { $0.id != mother.id }
                .sorted { (rank.firstIndex(of: $0.id) ?? .max) < (rank.firstIndex(of: $1.id) ?? .max) }
            let unit = SessionUnit(mother: mother, children: kids)
            switch unit.all.compactMap({ bucket($0, cutoff: cutoff) }).min() {
            case 0: g.0.append(unit)
            case 1: g.1.append(unit)
            case 2: g.2.append(unit)
            case 3: g.3.append(unit)
            default: break
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

    @ViewBuilder private func section(_ title: String, _ list: [SessionUnit]) -> some View {
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

    @ViewBuilder private func rows(_ list: [SessionUnit]) -> some View {
        ForEach(list) { u in
            NavigationLink(value: u.mother.id) { SessionRow(session: u.mother) }
                .listRowBackground(Theme.card)
            ForEach(u.children) { c in
                NavigationLink(value: c.id) { ChildRow(session: c) }
                    .listRowBackground(Theme.card)
            }
        }
    }
}

struct SessionUnit: Identifiable {
    let mother: Session
    let children: [Session]
    var id: String { mother.id }
    var all: [Session] { [mother] + children }
}

/// A group member, listed under its mother.
struct ChildRow: View {
    let session: Session

    var body: some View {
        let style = session.needsYou ? StateStyle.decision : StateStyle.of(session.state)
        HStack(spacing: 8) {
            Image(systemName: "arrow.turn.down.right")
                .font(.caption2)
                .foregroundStyle(Theme.muted)
            StateDot(style: style, size: 7)
            Text(session.displayTitle)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Theme.ink)
                .lineLimit(1)
            Spacer()
            if let d = session.lastActivity {
                Text(d.shortAge).font(.system(size: 12)).monospacedDigit().foregroundStyle(Theme.muted)
            }
        }
        .padding(.leading, 12)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(session.displayTitle), \(style.label)")
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
