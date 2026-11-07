import Foundation

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

    /// Parses `hooked://connect?host=…&port=…[&https=1]`.
    static func fromDeepLink(_ url: URL) -> ServerConfig? {
        guard url.scheme == "hooked", url.host == "connect",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
        let q = Dictionary(items.map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { _, b in b })
        guard let host = q["host"], !host.isEmpty else { return nil }
        let https = ["1", "true", "yes"].contains(q["https"]?.lowercased() ?? "")
        return (ServerConfig(host: cleanHost(host), port: Int(q["port"] ?? "") ?? 4123, https: https))
    }
}
