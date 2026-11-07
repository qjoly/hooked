import SwiftUI

@main
struct HookedApp: App {
    @State private var app = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
                .onOpenURL { app.handle(url: $0) }
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        @Bindable var app = app
        Group {
            if let sessions = app.sessions {
                NavigationStack(path: $app.path) {
                    SessionsListView(store: sessions)
                        .navigationDestination(for: String.self) { id in
                            SessionView(id: id, sessions: sessions) { app.unauthorized() }
                        }
                }
            } else {
                ConnectView()
                    // Rebuild so a deep link or an auth failure re-prefills the form.
                    .id(app.connectMessage ?? "connect")
            }
        }
        .tint(Theme.accent)
        .onChange(of: scenePhase) { _, phase in
            // Streams die in the background anyway; reopen and refetch on return.
            if phase == .background { app.sessions?.stop() } else if phase == .active { app.sessions?.start() }
        }
    }
}
