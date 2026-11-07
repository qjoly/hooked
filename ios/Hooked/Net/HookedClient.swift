import Foundation

enum HookedError: LocalizedError, Equatable {
    case notDriven(String)
    case server(Int, String)
    case badURL
    case transport(String)

    var errorDescription: String? {
        switch self {
        case .notDriven(let m): return m.isEmpty ? "This session is not driven by hooked." : m
        case .server(let code, let m): return m.isEmpty ? "Server error (\(code))" : m
        case .badURL: return "Invalid server address"
        case .transport(let m): return m
        }
    }
}

struct HookedClient: Sendable {
    let config: ServerConfig

    static let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.waitsForConnectivity = false
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: c)
    }()

    func request(_ path: String, query: [String: String] = [:], timeout: TimeInterval = 20) throws -> URLRequest {
        guard let base = config.baseURL, var c = URLComponents(url: base.appendingPathComponent(path), resolvingAgainstBaseURL: false) else {
            throw HookedError.badURL
        }
        if !query.isEmpty { c.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) } }
        guard let url = c.url else { throw HookedError.badURL }
        var r = URLRequest(url: url, timeoutInterval: timeout)
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        return r
    }

    func get(_ path: String, query: [String: String] = [:], timeout: TimeInterval = 20) async throws -> JSON {
        try await send(request(path, query: query, timeout: timeout))
    }

    func post(_ path: String, _ body: JSON, timeout: TimeInterval = 30) async throws -> JSON {
        var r = try request(path, timeout: timeout)
        r.httpMethod = "POST"
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = try body.data()
        return try await send(r)
    }

    private func send(_ r: URLRequest) async throws -> JSON {
        let data: Data, resp: URLResponse
        do { (data, resp) = try await Self.session.data(for: r) } catch {
            if (error as? URLError)?.code == .cancelled || error is CancellationError { throw CancellationError() }
            throw HookedError.transport(error.localizedDescription)
        }
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        let json = JSON.parse(data)
        try Self.check(status: status, body: json)
        if case .bool(false) = json["ok"] { throw HookedError.server(status, json["error"].string ?? "") }
        return json
    }

    static func check(status: Int, body: JSON = .null) throws {
        let msg = body["error"].string ?? ""
        switch status {
        case 200..<300: return
        case 409: throw HookedError.notDriven(msg)
        default: throw HookedError.server(status, msg)
        }
    }
}

// MARK: - Endpoints

extension HookedClient {
    func sessions() async throws -> [Session] {
        try await get("api/sessions")["sessions"].array.map(Session.init).filter { !$0.id.isEmpty }
    }

    func detail(_ id: String) async throws -> SessionDetail {
        SessionDetail(try await get("api/session", query: ["id": id], timeout: 30))
    }

    func capabilities() async throws -> Capabilities { Capabilities(try await get("api/capabilities")) }

    func defaults() async throws -> Defaults {
        let j = try await get("api/defaults")
        return Defaults(model: j["model"].text, effort: j["effort"].text, mode: j["mode"].text)
    }

    func reply(_ id: String, text: String) async throws {
        _ = try await post("api/reply", ["id": JSON(id), "text": JSON(text)])
    }

    struct Selection: Sendable {
        var multi: Bool
        var indices: [Int]
        var other: String?
    }

    func answer(_ id: String, selections: [Selection], note: String?) async throws {
        let sel: [JSON] = selections.map { s in
            ["multi": JSON(s.multi), "indices": .array(s.indices.map { JSON($0) }), "other": JSON(s.other)]
        }
        _ = try await post("api/reply", ["id": JSON(id), "selections": .array(sel), "note": JSON(note)])
    }

    func plan(_ id: String, action: String, feedback: String? = nil) async throws {
        _ = try await post("api/plan", ["id": JSON(id), "action": JSON(action), "feedback": JSON(feedback)])
    }

    func interrupt(_ id: String) async throws { _ = try await post("api/interrupt", ["id": JSON(id)]) }

    func kill(_ id: String) async throws { _ = try await post("api/kill", ["id": JSON(id)]) }

    func setMode(_ id: String, _ mode: String) async throws { _ = try await post("api/mode", ["id": JSON(id), "mode": JSON(mode)]) }

    /// Returns the cache impact when the server holds the switch because the prompt cache is warm.
    func setModel(_ id: String, model: String?, effort: String?, force: Bool) async throws -> JSON? {
        let r = try await post("api/model", ["id": JSON(id), "model": JSON(model), "effort": JSON(effort), "force": force ? true : nil])
        return r["held"].bool ? r["cacheImpact"] : nil
    }

    func setAutoApprove(_ id: String, _ on: Bool) async throws {
        _ = try await post("api/auto-approve", ["id": JSON(id), "on": JSON(on)])
    }

    func launch(cwd: String, prompt: String, model: String?, effort: String?, mode: String?) async throws -> String {
        let r = try await post("api/launch", ["cwd": JSON(cwd), "prompt": JSON(prompt), "model": JSON(model), "effort": JSON(effort), "permissionMode": JSON(mode)], timeout: 60)
        guard let id = r["sessionId"].text else { throw HookedError.server(200, "The server did not return a session id") }
        return id
    }

    func uploadImage(jpeg: Data) async throws -> String {
        let r = try await post("api/upload-image", ["dataUrl": JSON("data:image/jpeg;base64," + jpeg.base64EncodedString())], timeout: 60)
        guard let path = r["path"].text else { throw HookedError.server(200, "Upload returned no path") }
        return path
    }
}
