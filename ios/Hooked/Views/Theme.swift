import SwiftUI
import UIKit

extension Color {
    init(hex: UInt32) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xff) / 255, green: Double((hex >> 8) & 0xff) / 255, blue: Double(hex & 0xff) / 255)
    }

    /// Light/dark pair resolved by the trait collection.
    init(light: UInt32, dark: UInt32) {
        self.init(UIColor { t in
            let hex = t.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: 1)
        })
    }
}

/// Roast neutral ladder and espresso/latte interaction colours from DESIGN.md.
enum Theme {
    static let ground = Color(light: 0xe9ebdf, dark: 0x18110e)
    static let card = Color(light: 0xffffff, dark: 0x261b18)
    static let panel = Color(light: 0xf2f3ec, dark: 0x1e1512)
    static let line = Color(light: 0xdadacd, dark: 0x3a2d27)
    static let ink = Color(light: 0x18110e, dark: 0xf2f3ec)
    static let muted = Color(light: 0x6e6056, dark: 0xaaa497)
    static let accent = Color(light: 0x261b18, dark: 0xe4cdb1)
    static let onAccent = Color(light: 0xfbfbf8, dark: 0x1e1512)
    static let userBubble = Color(light: 0x261b18, dark: 0x3a2d27)
    static let userText = Color(hex: 0xfbfbf8)
    static let code = Color(light: 0x1e1512, dark: 0x110a09)
    static let codeFg = Color(hex: 0xe8e1d6)
    static let crema = Color(light: 0xf3e5d9, dark: 0x3a2a1f)
    static let link = Color(light: 0x76482d, dark: 0xd9ad8a)
}

enum MarkShape {
    case diamond, disc, ring, hairline, square
}

/// A state family: label + shape + hue, never hue alone.
struct StateStyle {
    let label: String
    let shape: MarkShape
    let hue: Color
    let ink: Color
    let pulses: Bool

    var soft: Color { hue.opacity(0.14) }

    static func of(_ s: SessionState) -> StateStyle {
        switch s {
        case .attention: return .init(label: "Attention", shape: .diamond, hue: Color(light: 0xc43d4d, dark: 0xed737b), ink: Color(light: 0xa12437, dark: 0xed737b), pulses: true)
        case .waiting: return .init(label: "Waiting", shape: .disc, hue: Color(light: 0xe1901f, dark: 0xf5ad5a), ink: Color(light: 0x8b5500, dark: 0xf5ad5a), pulses: true)
        case .working: return .init(label: "Working", shape: .disc, hue: Color(light: 0x418d50, dark: 0x70c47e), ink: Color(light: 0x256b35, dark: 0x70c47e), pulses: true)
        case .background: return .init(label: "Background", shape: .ring, hue: Color(light: 0x9e59b3, dark: 0xca92dc), ink: Color(light: 0x804293, dark: 0xca92dc), pulses: true)
        case .idle, .unknown: return .init(label: "Idle", shape: .hairline, hue: Color(light: 0x92a1a9, dark: 0x6f7d84), ink: Color(light: 0x6e6056, dark: 0xaaa497), pulses: false)
        case .ended: return .init(label: "Ended", shape: .square, hue: Color(light: 0x96684f, dark: 0xbe947d), ink: Color(light: 0x724a34, dark: 0xbe947d), pulses: false)
        case .past: return .init(label: "Past", shape: .square, hue: Color(light: 0x96684f, dark: 0xbe947d), ink: Color(light: 0x724a34, dark: 0xbe947d), pulses: false)
        }
    }

    /// Pending question, permission or plan: the attention family, as on the web.
    static let decision = of(.attention)
}

struct StateDot: View {
    let style: StateStyle
    var size: CGFloat = 8
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let mark = shape.frame(width: size, height: size)
        if style.pulses && !reduceMotion {
            PhaseAnimator([false, true]) { on in
                mark.opacity(on ? 0.35 : 1)
            } animation: { _ in .easeInOut(duration: 0.9) }
        } else {
            mark
        }
    }

    @ViewBuilder private var shape: some View {
        switch style.shape {
        case .diamond: Rectangle().fill(style.hue).rotationEffect(.degrees(45)).scaleEffect(0.78)
        case .disc: Circle().fill(style.hue)
        case .ring: Circle().strokeBorder(style.hue, lineWidth: size * 0.3)
        case .hairline: Circle().strokeBorder(style.hue, lineWidth: 1)
        case .square: Rectangle().fill(style.hue).scaleEffect(0.85)
        }
    }
}

struct StatePill: View {
    let style: StateStyle
    var label: String?

    var body: some View {
        HStack(spacing: 5) {
            StateDot(style: style)
            Text((label ?? style.label).uppercased())
                .font(.system(size: 11, weight: .heavy))
                .monospacedDigit()
        }
        .foregroundStyle(style.ink)
        .padding(.vertical, 3)
        .padding(.leading, 8)
        .padding(.trailing, 9)
        .background(style.soft, in: Capsule())
        .accessibilityElement(children: .combine)
    }
}

struct CardBackground: ViewModifier {
    var radius: CGFloat = 16
    func body(content: Content) -> some View {
        content
            .background(Theme.card, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Theme.line, lineWidth: 0.5))
            .shadow(color: .black.opacity(0.06), radius: 1, y: 1)
    }
}

extension View {
    func card(radius: CGFloat = 16) -> some View { modifier(CardBackground(radius: radius)) }
}

extension Date {
    /// "now", "4m", "3h", "2d".
    var shortAge: String {
        let s = max(0, Date().timeIntervalSince(self))
        if s < 60 { return "now" }
        if s < 3600 { return "\(Int(s / 60))m" }
        if s < 86400 { return "\(Int(s / 3600))h" }
        return "\(Int(s / 86400))d"
    }
}
