import Foundation

enum SSEClient {
    /// Yields the `data:` payload of each event. hooked sends single-line payloads, which matters
    /// because `AsyncBytes.lines` drops the blank lines that would otherwise delimit events.
    static func events(_ request: URLRequest) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var r = request
                    r.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    let (bytes, resp) = try await HookedClient.session.bytes(for: r)
                    try HookedClient.check(status: (resp as? HTTPURLResponse)?.statusCode ?? 0)
                    for try await line in bytes.lines {
                        if line.hasPrefix("data:") {
                            continuation.yield(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces))
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// Runs `handle` on every event and reconnects with exponential backoff until cancelled.
    /// `handle` returns false to stop for good; an auth failure is reported and also stops.
    @MainActor
    static func run(
        _ makeRequest: () throws -> URLRequest,
        onUnauthorized: @MainActor () -> Void,
        handle: @MainActor (String) -> Bool
    ) async {
        var backoff: Double = 1
        while !Task.isCancelled {
            do {
                for try await payload in events(try makeRequest()) {
                    backoff = 1
                    if !handle(payload) { return }
                }
            } catch HookedError.unauthorized {
                onUnauthorized()
                return
            } catch {}
            if Task.isCancelled { return }
            try? await Task.sleep(for: .seconds(backoff))
            backoff = min(backoff * 2, 30)
        }
    }
}
