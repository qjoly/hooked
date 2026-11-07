import Foundation
import Observation

@MainActor @Observable
final class SessionsStore {
    let client: HookedClient

    private(set) var sessions: [Session] = []
    private(set) var loaded = false
    var error: String?

    private var streamTask: Task<Void, Never>?
    private var pendingRefresh: Task<Void, Never>?
    private var lastRefresh = Date.distantPast

    init(client: HookedClient) {
        self.client = client
    }

    func session(_ id: String) -> Session? { sessions.first { $0.id == id } }

    /// Distinct project paths, most recently active first.
    var projects: [String] {
        var seen = Set<String>()
        return sessions.compactMap(\.project).filter { seen.insert($0).inserted }
    }

    func start() {
        guard streamTask == nil else { return }
        Task { await refresh() }
        streamTask = Task { [weak self, client] in
            await SSEClient.run({ try client.request("api/stream", timeout: 60) },
                               handle: { _ in self?.scheduleRefresh(); return self != nil })
        }
    }

    func stop() {
        streamTask?.cancel()
        streamTask = nil
        pendingRefresh?.cancel()
        pendingRefresh = nil
    }

    /// Coalesces ticks: 250 ms debounce, at most one fetch per second.
    private func scheduleRefresh() {
        guard pendingRefresh == nil else { return }
        pendingRefresh = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(250))
            guard let self, !Task.isCancelled else { return }
            let since = Date().timeIntervalSince(self.lastRefresh)
            if since < 1 { try? await Task.sleep(for: .seconds(1 - since)) }
            self.pendingRefresh = nil
            if !Task.isCancelled { await self.refresh() }
        }
    }

    func refresh() async {
        lastRefresh = Date()
        do {
            let list = try await client.sessions()
            if list != sessions { sessions = list }
            loaded = true
            error = nil
        } catch is CancellationError {
        } catch {
            self.error = error.localizedDescription
        }
    }
}
