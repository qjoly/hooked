import Foundation
import Security

struct ServerConfig: Codable, Equatable, Sendable {
    var host: String
    var port: Int = 4123
    var https = false

    var baseURL: URL? {
        var c = URLComponents()
        c.scheme = https ? "https" : "http"
        c.host = Self.cleanHost(host)
        c.port = port
        return c.url
    }

    /// Strips a pasted scheme or trailing slash.
    static func cleanHost(_ raw: String) -> String {
        var h = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        for p in ["http://", "https://"] where h.lowercased().hasPrefix(p) { h = String(h.dropFirst(p.count)) }
        while h.hasSuffix("/") { h.removeLast() }
        return h
    }

    private static let key = "serverConfig"

    static func load() -> ServerConfig? {
        guard let d = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(ServerConfig.self, from: d)
    }

    func save() {
        if let d = try? JSONEncoder().encode(self) { UserDefaults.standard.set(d, forKey: Self.key) }
    }

    /// Parses `hooked://connect?host=…&port=…&token=…[&https=1]`.
    static func fromDeepLink(_ url: URL) -> (ServerConfig, String)? {
        guard url.scheme == "hooked", url.host == "connect",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
        let q = Dictionary(items.map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { _, b in b })
        guard let host = q["host"], !host.isEmpty, let token = q["token"], !token.isEmpty else { return nil }
        let https = ["1", "true", "yes"].contains(q["https"]?.lowercased() ?? "")
        return (ServerConfig(host: cleanHost(host), port: Int(q["port"] ?? "") ?? 4123, https: https), token)
    }
}

enum Keychain {
    private static let service = "dev.qjoly.hooked.ios"
    private static let account = "token"

    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    static func token() -> String? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }

    static func setToken(_ token: String) {
        SecItemDelete(query as CFDictionary)
        var q = query
        q[kSecValueData as String] = Data(token.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(q as CFDictionary, nil)
    }
}
