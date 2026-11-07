import Foundation
import Observation

@MainActor @Observable
final class AppModel {
    private(set) var config: ServerConfig?
    private(set) var client: HookedClient?
    private(set) var sessions: SessionsStore?
    /// Shown on the connect screen after a failure that sent the user back there.
    var connectMessage: String?
    var capabilities = Capabilities()
    var path: [String] = []

    init() {
        if let c = ServerConfig.load(), let t = Keychain.token() { connect(c, token: t) }
    }

    var savedConfig: ServerConfig? { config ?? ServerConfig.load() }
    var savedToken: String { Keychain.token() ?? "" }

    func save(_ c: ServerConfig, token: String) {
        c.save()
        Keychain.setToken(token)
        connect(c, token: token)
    }

    private func connect(_ c: ServerConfig, token: String) {
        sessions?.stop()
        config = c
        connectMessage = nil
        path = []
        let client = HookedClient(config: c, token: token)
        self.client = client
        let store = SessionsStore(client: client) { [weak self] in self?.unauthorized() }
        sessions = store
        store.start()
        Task { [weak self] in
            if let caps = try? await client.capabilities() { self?.capabilities = caps }
        }
    }

    func unauthorized() {
        sessions?.stop()
        sessions = nil
        client = nil
        path = []
        connectMessage = "Invalid token"
    }

    func handle(url: URL) {
        guard let (c, token) = ServerConfig.fromDeepLink(url) else { return }
        save(c, token: token)
    }
}
