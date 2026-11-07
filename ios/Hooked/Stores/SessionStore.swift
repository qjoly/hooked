import Foundation
import Observation
import UIKit

struct Attachment: Identifiable {
    let id = UUID()
    let thumbnail: UIImage
    var path: String?
    var failed = false
}

@MainActor @Observable
final class SessionStore {
    let id: String
    let client: HookedClient

    private(set) var detail: SessionDetail?
    private(set) var snapshot: LiveSnapshot?
    private(set) var loadError: String?
    var actionError: String?
    var sending = false
    /// Sent text not yet seen in the transcript, shown as a queued bubble.
    private(set) var outgoing: String?
    var attachments: [Attachment] = []
    /// Set when the server holds a model switch because the prompt cache is warm.
    var heldSwitch: (model: String?, effort: String?, impact: JSON)?

    private var loading = false
    private var reloadAgain = false
    private var streamTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?

    init(id: String, client: HookedClient) {
        self.id = id
        self.client = client
    }

    var session: Session? { detail?.session }
    var isLive: Bool { detail?.session.live ?? false }
    var isBusy: Bool { snapshot?.busy ?? (detail?.session.state == .working) }

    // MARK: Lifecycle

    func start() {
        Task { await load() }
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard let self, !Task.isCancelled else { return }
                if self.isBusy { await self.load() }
            }
        }
    }

    func stop() {
        streamTask?.cancel()
        streamTask = nil
        pollTask?.cancel()
        pollTask = nil
        snapshot = nil
    }

    /// Refetches the detail; calls made while a fetch is in flight collapse into one more fetch.
    func load() async {
        if loading { reloadAgain = true; return }
        loading = true
        defer { loading = false }
        repeat {
            reloadAgain = false
            do {
                let d = try await client.detail(id)
                if d != detail { detail = d }
                loadError = nil
                if let o = outgoing, d.messages.contains(where: { $0.role == "user" && $0.text.contains(o) }) { outgoing = nil }
                if d.session.live, streamTask == nil, pollTask != nil { openStream() }
            } catch is CancellationError {
                return
            } catch {
                loadError = error.localizedDescription
            }
        } while reloadAgain
    }

    private func openStream() {
        streamTask = Task { [weak self, client, id] in
            await SSEClient.run({ try client.request("api/session/stream", query: ["id": id], timeout: 60) },
                               handle: { payload in self?.apply(payload) ?? false })
            self?.streamTask = nil
        }
    }

    private func apply(_ payload: String) -> Bool {
        let snap = LiveSnapshot(JSON.parse(Data(payload.utf8)))
        guard snap.live, !snap.ended else {
            snapshot = nil
            Task { await load() }
            return false
        }
        let prev = snapshot
        snapshot = snap
        // A finished turn or a new pending question lands in the transcript: fetch it.
        if (prev?.busy == true && !snap.busy) || (snap.state != prev?.state && snap.state == "requires_action") {
            Task { await load() }
        }
        return true
    }

    // MARK: Actions

    private func run(_ body: () async throws -> Void) async -> Bool {
        do {
            try await body()
            return true
        } catch is CancellationError {
        } catch {
            actionError = error.localizedDescription
        }
        return false
    }

    func send(_ text: String) async -> Bool {
        let paths = attachments.compactMap(\.path)
        let body = (paths + [text.trimmingCharacters(in: .whitespacesAndNewlines)]).filter { !$0.isEmpty }.joined(separator: " ")
        guard !body.isEmpty, !sending else { return false }
        if attachments.contains(where: { $0.path == nil && !$0.failed }) {
            actionError = "Wait for the photos to finish uploading."
            return false
        }
        sending = true
        defer { sending = false }
        let live = isLive
        let ok = await run { [client, id, effort = session?.effort] in
            if live { try await client.reply(id, text: body) } else { try await client.resume(id, prompt: body, effort: effort) }
        }
        if ok {
            attachments = []
            outgoing = body
            await load()
        }
        return ok
    }

    func resume() async {
        guard !sending else { return }
        sending = true
        defer { sending = false }
        if await run({ [client, id, effort = session?.effort] in try await client.resume(id, prompt: "", effort: effort) }) {
            await load()
        }
    }

    func attach(_ image: UIImage) {
        let a = Attachment(thumbnail: image)
        attachments.append(a)
        Task {
            let jpeg = await Task.detached { image.downscaled(maxSide: 2000).jpegData(compressionQuality: 0.8) }.value
            var path: String?
            if let jpeg { _ = await run { path = try await client.uploadImage(jpeg: jpeg) } }
            guard let i = attachments.firstIndex(where: { $0.id == a.id }) else { return }
            attachments[i].path = path
            attachments[i].failed = path == nil
        }
    }

    func answer(_ selections: [HookedClient.Selection], note: String? = nil) async {
        sending = true
        defer { sending = false }
        if await run({ try await client.answer(id, selections: selections, note: note) }) { await load() }
    }

    func plan(_ action: String, feedback: String? = nil) async {
        sending = true
        defer { sending = false }
        if await run({ try await client.plan(id, action: action, feedback: feedback) }) { await load() }
    }

    func interrupt() async {
        if await run({ try await client.interrupt(id) }) { await load() }
    }

    func kill() async {
        if await run({ try await client.kill(id) }) { await load() }
    }

    func setMode(_ mode: String) async {
        if await run({ try await client.setMode(id, mode) }) { await load() }
    }

    func setModel(model: String?, effort: String?, force: Bool = false) async {
        var impact: JSON?
        guard await run({ impact = try await client.setModel(id, model: model, effort: effort, force: force) }) else { return }
        if let impact { heldSwitch = (model, effort, impact) } else { await load() }
    }

    func setAutoApprove(_ on: Bool) async {
        if await run({ try await client.setAutoApprove(id, on) }) { await load() }
    }
}

extension UIImage {
    func downscaled(maxSide: CGFloat) -> UIImage {
        let side = max(size.width, size.height)
        guard side > maxSide else { return self }
        let scale = maxSide / side
        let target = CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        return UIGraphicsImageRenderer(size: target, format: format).image { _ in draw(in: CGRect(origin: .zero, size: target)) }
    }
}
