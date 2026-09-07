// hooked-prompt-panel — a glassy Spotlight/Raycast-style one-shot input panel.
// Reads a citation (the selected text) on stdin, shows a translucent floating panel with
// a big input field, and prints the typed instruction to stdout.
//   exit 0 = submitted (stdout = instruction)   exit 1 = cancelled (Esc / click away)
// Build: swiftc -O hooked-prompt-panel.swift -o hooked-prompt-panel

import Cocoa

let citation = (String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? "")
    .trimmingCharacters(in: .whitespacesAndNewlines)

// First non-empty line of the selection, for a one-line preview above the field.
let citePreview: String = citation
    .split(separator: "\n", omittingEmptySubsequences: true)
    .first.map(String.init) ?? ""
let hasCite = !citePreview.isEmpty

final class KeyPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

final class App: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
    let panel: KeyPanel
    let field = NSTextField()

    override init() {
        let W: CGFloat = 680, PAD: CGFloat = 24, FIELD_H: CGFloat = 40
        let previewH: CGFloat = hasCite ? 17 : 0
        let gap: CGFloat = hasCite ? 12 : 0
        let H = PAD + previewH + gap + FIELD_H + PAD

        panel = KeyPanel(contentRect: NSRect(x: 0, y: 0, width: W, height: H),
                         styleMask: [.borderless],
                         backing: .buffered, defer: false)
        super.init()

        let vev = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: W, height: H))
        vev.material = .hudWindow
        vev.blendingMode = .behindWindow
        vev.state = .active
        vev.wantsLayer = true
        vev.layer?.cornerRadius = 18
        vev.layer?.masksToBounds = true
        vev.autoresizingMask = [.width, .height]

        if hasCite {
            let preview = NSTextField(labelWithString: "\u{275D} " + citePreview)
            preview.frame = NSRect(x: PAD, y: PAD + FIELD_H + gap, width: W - 2 * PAD, height: previewH)
            preview.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
            preview.textColor = .secondaryLabelColor
            preview.lineBreakMode = .byTruncatingTail
            preview.backgroundColor = .clear
            preview.isBezeled = false
            vev.addSubview(preview)
        }

        field.frame = NSRect(x: PAD, y: PAD, width: W - 2 * PAD, height: FIELD_H)
        field.placeholderString = "Instruction about the cited text\u{2026}"
        field.font = NSFont.systemFont(ofSize: 22, weight: .regular)
        field.textColor = .labelColor
        field.isBezeled = false
        field.isBordered = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.delegate = self
        field.cell?.wraps = false
        field.cell?.isScrollable = true
        vev.addSubview(field)

        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .modalPanel
        panel.isMovableByWindowBackground = true
        panel.hidesOnDeactivate = false
        panel.contentView = vev
    }

    func applicationDidFinishLaunching(_ n: Notification) {
        NSApp.activate(ignoringOtherApps: true)
        // Position a little above centre, Spotlight-style.
        if let vf = panel.screen?.visibleFrame ?? NSScreen.main?.visibleFrame {
            let x = vf.midX - panel.frame.width / 2
            let y = vf.midY + vf.height * 0.12
            panel.setFrameOrigin(NSPoint(x: x, y: y))
        }
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(field)
    }

    func finish(_ text: String?) {
        if let t = text { FileHandle.standardOutput.write(Data(t.utf8)) }
        exit(text == nil ? 1 : 0)
    }

    // Enter submits, Esc cancels.
    func control(_ c: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        if sel == #selector(NSResponder.insertNewline(_:)) { finish(field.stringValue); return true }
        if sel == #selector(NSResponder.cancelOperation(_:)) { finish(nil); return true }
        return false
    }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
