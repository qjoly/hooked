import PhotosUI
import SwiftUI

struct ComposerView: View {
    let store: SessionStore
    var answering = false

    @State private var text = ""
    @State private var items: [PhotosPickerItem] = []

    private var hasContent: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.attachments.contains { $0.path != nil }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !store.attachments.isEmpty { thumbnails }
            HStack(alignment: .bottom, spacing: 8) {
                PhotosPicker(selection: $items, maxSelectionCount: 4, matching: .images) {
                    Image(systemName: "photo.on.rectangle")
                        .font(.system(size: 18))
                        .frame(width: 36, height: 36)
                }
                .foregroundStyle(Theme.muted)
                .accessibilityLabel("Attach photos")

                TextField(answering ? "Type your own answer…" : "Message Claude", text: $text, axis: .vertical)
                    .font(.system(size: 15))
                    .lineLimit(1...6)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Theme.panel, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Theme.line, lineWidth: 0.5))

                if store.isBusy {
                    roundButton("stop.fill", label: "Interrupt", filled: false) { Task { await store.interrupt() } }
                }
                if hasContent || !store.isBusy {
                    roundButton(store.sending ? "ellipsis" : "arrow.up", label: "Send", filled: true) {
                        Task { if await store.send(text) { text = "" } }
                    }
                    .disabled(!hasContent || store.sending)
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .onChange(of: items) { _, new in
            guard !new.isEmpty else { return }
            items = []
            for item in new {
                Task {
                    if let data = try? await item.loadTransferable(type: Data.self), let img = UIImage(data: data) { store.attach(img) }
                }
            }
        }
    }

    private func roundButton(_ symbol: String, label: String, filled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 15, weight: .bold))
                .frame(width: 36, height: 36)
                .foregroundStyle(filled ? Theme.onAccent : StateStyle.of(.attention).ink)
                .background(filled ? Theme.accent : Theme.card, in: Circle())
                .overlay { if !filled { Circle().strokeBorder(Theme.line) } }
        }
        .accessibilityLabel(label)
    }

    private var thumbnails: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(store.attachments) { a in
                    Image(uiImage: a.thumbnail)
                        .resizable()
                        .scaledToFill()
                        .frame(width: 56, height: 56)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .overlay {
                            if a.failed {
                                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(StateStyle.of(.attention).hue)
                            } else if a.path == nil {
                                ProgressView()
                            }
                        }
                        .overlay(alignment: .topTrailing) {
                            Button {
                                store.attachments.removeAll { $0.id == a.id }
                            } label: {
                                Image(systemName: "xmark.circle.fill").symbolRenderingMode(.palette).foregroundStyle(.white, .black.opacity(0.6))
                            }
                            .offset(x: 6, y: -6)
                            .accessibilityLabel("Remove photo")
                        }
                }
            }
            .padding(.top, 6)
            .padding(.horizontal, 4)
        }
    }
}
