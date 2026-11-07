import Foundation

/// Untyped JSON value: every API read goes through it so a missing or mistyped field never fails a decode.
enum JSON: Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSON])
    case object([String: JSON])

    init(_ s: String?) { self = s.map { .string($0) } ?? .null }
    init(_ b: Bool) { self = .bool(b) }
    init(_ n: Int) { self = .number(Double(n)) }

    init(any: Any?) {
        switch any {
        case let n as NSNumber:
            // JSONSerialization hands booleans back as NSNumber too.
            if CFGetTypeID(n) == CFBooleanGetTypeID() { self = .bool(n.boolValue) } else { self = .number(n.doubleValue) }
        case let s as String: self = .string(s)
        case let a as [Any]: self = .array(a.map { JSON(any: $0) })
        case let o as [String: Any]: self = .object(o.mapValues { JSON(any: $0) })
        default: self = .null
        }
    }

    static func parse(_ data: Data) -> JSON {
        guard !data.isEmpty, let obj = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else { return .null }
        return JSON(any: obj)
    }

    var any: Any {
        switch self {
        case .null: return NSNull()
        case .bool(let b): return b
        case .number(let n): return n == n.rounded() && abs(n) < 1e15 ? Int(n) as Any : n
        case .string(let s): return s
        case .array(let a): return a.map(\.any)
        case .object(let o): return o.mapValues(\.any)
        }
    }

    func data() throws -> Data { try JSONSerialization.data(withJSONObject: any, options: [.fragmentsAllowed]) }

    subscript(key: String) -> JSON {
        if case .object(let o) = self { return o[key] ?? .null }
        return .null
    }

    var isNull: Bool { if case .null = self { return true } else { return false } }

    var string: String? {
        switch self {
        case .string(let s): return s
        case .number(let n): return n == n.rounded() ? String(Int(n)) : String(n)
        case .bool(let b): return b ? "true" : "false"
        default: return nil
        }
    }

    /// Non-empty string, or nil.
    var text: String? { string.flatMap { $0.isEmpty ? nil : $0 } }

    var double: Double? {
        switch self {
        case .number(let n): return n
        case .string(let s): return Double(s)
        case .bool(let b): return b ? 1 : 0
        default: return nil
        }
    }

    var int: Int? { double.map { Int($0) } }

    var bool: Bool {
        switch self {
        case .bool(let b): return b
        case .number(let n): return n != 0
        case .string(let s): return s == "true" || s == "1"
        default: return false
        }
    }

    var array: [JSON] { if case .array(let a) = self { return a } else { return [] } }

    var object: [String: JSON]? { if case .object(let o) = self { return o } else { return nil } }

    /// ISO-8601 string (with or without fractional seconds) or epoch milliseconds.
    var date: Date? {
        switch self {
        case .number(let n): return Date(timeIntervalSince1970: n > 1e11 ? n / 1000 : n)
        case .string(let s):
            if let n = Double(s) { return JSON.number(n).date }
            return JSON.isoFrac.date(from: s) ?? JSON.iso.date(from: s)
        default: return nil
        }
    }

    /// Compact one-line rendering for values of unknown shape.
    var display: String {
        switch self {
        case .null: return "—"
        case .string, .number, .bool: return string ?? ""
        case .array, .object:
            guard let d = try? JSONSerialization.data(withJSONObject: any, options: [.sortedKeys, .fragmentsAllowed]) else { return "" }
            return String(decoding: d, as: UTF8.self)
        }
    }

    nonisolated(unsafe) private static let isoFrac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    nonisolated(unsafe) private static let iso = ISO8601DateFormatter()
}

extension JSON: ExpressibleByStringLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral,
    ExpressibleByDictionaryLiteral, ExpressibleByArrayLiteral, ExpressibleByNilLiteral {
    init(stringLiteral v: String) { self = .string(v) }
    init(booleanLiteral v: Bool) { self = .bool(v) }
    init(integerLiteral v: Int) { self = .number(Double(v)) }
    init(dictionaryLiteral elements: (String, JSON)...) {
        self = .object(Dictionary(elements.filter { !$0.1.isNull }, uniquingKeysWith: { _, b in b }))
    }
    init(arrayLiteral elements: JSON...) { self = .array(elements) }
    init(nilLiteral: ()) { self = .null }
}
