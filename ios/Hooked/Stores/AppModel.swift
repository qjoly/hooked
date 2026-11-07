import Foundation
import Observation

@MainActor @Observable
final class AppModel {
    private(set) var config: ServerConfig?
    private(set) var client: HookedClient?
    private(set) var sessions: SessionsStore?
    var capabilities = Capabilities()
    var path: [String] = []

    init() {
        if let c = ServerConfig.load() { connect(c) }
    }

    var savedConfig: ServerConfig? { config ?? ServerConfig.load() }

    func save(_ c: ServerConfig) {
        c.save()
        connect(c)
    }

    private func connect(_ c: ServerConfig) {
        sessions?.stop()
        config = c
        path = []
        let client = HookedClient(config: c)
        self.client = client
        let store = SessionsStore(client: client)
        sessions = store
        store.start()
        Task { [weak self] in
            if let caps = try? await client.capabilities() { self?.capabilities = caps }
        }
    }

    func handle(url: URL) {
        guard let c = ServerConfig.fromDeepLink(url) else { return }
        save(c)
    }
}
