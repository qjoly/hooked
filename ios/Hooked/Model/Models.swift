import Foundation

enum SessionState: String, Sendable {
    case attention, waiting, working, background, idle, ended, past, unknown

    init(_ raw: String?) { self = raw.flatMap(SessionState.init(rawValue:)) ?? .unknown }
}

struct QuestionOption: Equatable, Sendable {
    let label: String
    let description: String?
}

struct Question: Equatable, Sendable {
    let question: String
    let header: String?
    let multiSelect: Bool
    let options: [QuestionOption]

    init(_ j: JSON) {
        question = j["question"].string ?? ""
        header = j["header"].text
        multiSelect = j["multiSelect"].bool
        options = j["options"].array.map { QuestionOption(label: $0["label"].string ?? $0.string ?? "", description: $0["description"].text) }
    }
}

struct PendingQuestion: Equatable, Sendable {
    let id: String
    let kind: String
    let toolName: String?
    let questions: [Question]

    var isPermission: Bool { kind == "permission" }

    init?(_ j: JSON) {
        guard j.object != nil else { return nil }
        id = j["id"].string ?? ""
        kind = j["kind"].string ?? "question"
        toolName = j["toolName"].text
        questions = j["questions"].array.map(Question.init)
    }
}

struct PendingPlan: Equatable, Sendable {
    let id: String
    let plan: String

    init?(_ j: JSON) {
        guard j.object != nil else { return nil }
        id = j["id"].string ?? ""
        plan = j["plan"].string ?? ""
    }
}

struct SessionGroup: Equatable, Sendable {
    let mother: String?
    let name: String?
    let members: [String]
}

struct TodoSummary: Equatable, Sendable {
    let total: Int
    let done: Int
    let current: String?
}

struct Session: Identifiable, Equatable, Sendable {
    let id: String
    let title: String?
    let projectName: String?
    let project: String?
    let gitBranch: String?
    let state: SessionState
    let live: Bool
    let currentTool: String?
    let activity: String?
    let lastActivity: Date?
    let lastPrompt: String?
    let lastReply: String?
    let model: String?
    let effort: String?
    let hasQuestion: Bool
    let hasPlan: Bool
    let question: PendingQuestion?
    let cost: Double?
    let followup: String?
    let group: SessionGroup?
    let todo: TodoSummary?

    init(_ j: JSON) {
        id = j["id"].string ?? ""
        // The server falls back to a French placeholder when there is no title at all.
        let t = j["title"].text
        title = t == "(sans titre)" ? nil : t
        projectName = j["projectName"].text
        project = j["project"].text
        gitBranch = j["gitBranch"].text
        state = SessionState(j["state"].string)
        live = j["live"].bool
        currentTool = j["currentTool"].text
        activity = j["activity"].text
        lastActivity = j["lastActivity"].date ?? j["lastTs"].date
        lastPrompt = j["lastPrompt"].text
        lastReply = j["lastReply"].text
        model = j["model"].text
        effort = j["effort"].text
        question = PendingQuestion(j["question"])
        hasQuestion = j["hasQuestion"].bool || question != nil
        hasPlan = j["hasPlan"].bool
        cost = j["cost"].double
        followup = j["followup"].text ?? j["followupSuggestion"].text
        let g = j["group"]
        group = g.object == nil ? nil : SessionGroup(mother: g["mother"].text, name: g["name"].text, members: g["members"].array.compactMap(\.string))
        let td = j["todo"]
        todo = td.object == nil ? nil : TodoSummary(total: td["total"].int ?? 0, done: td["done"].int ?? 0, current: td["current"].text)
    }

    var displayTitle: String { title ?? lastPrompt ?? projectName ?? "Untitled session" }

    var needsYou: Bool { state == .attention || state == .waiting || hasQuestion || hasPlan }

    /// Fields whose change means the open conversation is stale.
    var changeKey: String {
        "\(lastActivity?.timeIntervalSince1970 ?? 0)|\(hasQuestion)|\(hasPlan)|\(followup ?? "")|\(state.rawValue)|\(live)"
    }
}

struct Tool: Equatable, Sendable {
    let id: String?
    let name: String
    let detail: String?
    let inputText: String?
    let result: String?

    init(_ j: JSON) {
        id = j["id"].text
        name = j["name"].string ?? "tool"
        detail = j["detail"].text
        inputText = j["inputText"].text
        let r = j["result"]
        result = r.isNull ? nil : (r.string ?? r.display)
    }
}

enum MessagePart: Equatable, Sendable {
    case text(String)
    case tool(Tool)
}

struct Message: Identifiable, Equatable, Sendable {
    let id: Int
    let role: String
    let ts: Date?
    let text: String
    let truncated: Bool
    let tools: [Tool]
    let parts: [MessagePart]
    let kind: String?
    let auto: Bool

    init(index: Int, _ j: JSON) {
        id = index
        role = j["role"].string ?? "system"
        ts = j["ts"].date
        text = j["text"].string ?? ""
        truncated = j["truncated"].bool
        tools = j["tools"].array.map(Tool.init)
        parts = j["parts"].array.compactMap { p in
            switch p["type"].string {
            case "text": return p["text"].text.map(MessagePart.text)
            case "tool": return p["tool"].object == nil ? nil : .tool(Tool(p["tool"]))
            default: return nil
            }
        }
        kind = j["kind"].text
        auto = j["auto"].bool
    }

    /// Parts to render, rebuilt from text + tools when the server sent none.
    var renderParts: [MessagePart] {
        if !parts.isEmpty { return parts }
        return (text.isEmpty ? [] : [.text(text)]) + tools.map(MessagePart.tool)
    }
}

struct SessionDetail: Equatable, Sendable {
    let session: Session
    let pendingQuestion: PendingQuestion?
    let pendingPlan: PendingPlan?
    let pendingLeadIn: String?
    let permissionMode: String?
    let autoApprove: Bool
    let messages: [Message]

    init(_ j: JSON) {
        session = Session(j)
        pendingQuestion = PendingQuestion(j["pendingQuestion"])
        pendingPlan = PendingPlan(j["pendingPlan"])
        pendingLeadIn = j["pendingLeadIn"].text
        permissionMode = j["permissionMode"].text
        autoApprove = j["autoApprove"].bool
        messages = j["messages"].array.enumerated().map { Message(index: $0.offset, $0.element) }
    }
}

/// One frame of /api/session/stream.
struct LiveSnapshot: Equatable, Sendable {
    var live = true
    var state = "idle"
    var busy = false
    var activity: String?
    var text = ""
    var thinking = ""
    var tool: String?
    var ended = false

    init() {}

    init(_ j: JSON) {
        live = j["live"].isNull ? true : j["live"].bool
        state = j["state"].string ?? "idle"
        busy = j["busy"].bool
        activity = j["activity"].text
        text = j["text"].string ?? ""
        thinking = j["thinking"].string ?? ""
        tool = j["tool"].text
        ended = j["ended"].bool
    }
}

struct ModelGroup: Identifiable, Equatable, Sendable {
    var id: String { label }
    let label: String
    let options: [(id: String, label: String)]

    static func == (a: ModelGroup, b: ModelGroup) -> Bool {
        a.label == b.label && a.options.map(\.id) == b.options.map(\.id)
    }
}

struct Capabilities: Equatable, Sendable {
    var models: [ModelGroup] = []
    var efforts: [String] = []

    init() {}

    init(_ j: JSON) {
        // Options are [id, label] tuples on the wire.
        models = j["models"].array.map { g in
            ModelGroup(label: g["label"].string ?? "", options: g["opts"].array.compactMap { o in
                let pair = o.array
                if pair.count >= 2, let id = pair[0].string { return (id, pair[1].string ?? id) }
                if let id = o["id"].string ?? o.string { return (id, o["label"].string ?? id) }
                return nil
            })
        }
        efforts = j["efforts"].array.compactMap(\.string)
    }

    func modelLabel(_ id: String) -> String {
        for g in models { if let o = g.options.first(where: { $0.id == id }) { return o.id == g.label.lowercased() ? g.label : "\(g.label) \(o.label)" } }
        return id
    }
}

struct Defaults: Equatable, Sendable {
    var model: String?
    var effort: String?
    var mode: String?
}

enum PermissionMode {
    static let live = ["default", "auto", "plan"]
    static let launch = ["default", "acceptEdits", "auto", "plan", "bypassPermissions", "dontAsk"]

    static func label(_ m: String?) -> String {
        switch m {
        case "default", nil: return "Normal"
        case "acceptEdits": return "Accept edits"
        case "auto": return "Auto"
        case "plan": return "Plan"
        case "bypassPermissions": return "Bypass"
        case "dontAsk": return "Don't ask"
        case let other?: return other
        }
    }
}

extension String {
    /// "claude-opus-4-8" → "opus 4.8".
    var shortModel: String {
        guard hasPrefix("claude-") else { return self }
        let parts = dropFirst(7).split(separator: "-")
        guard let fam = parts.first else { return self }
        let ver = parts.dropFirst().filter { $0.count < 5 }.joined(separator: ".")
        return ver.isEmpty ? String(fam) : "\(fam) \(ver)"
    }
}
