import SwiftUI

struct ConnectView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    /// True when opened from the sessions list to edit an existing connection.
    var editing = false

    @State private var host = ""
    @State private var port = "4123"
    @State private var https = false
    @State private var testing = false
    @State private var message: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Host or IP", text: $host)
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("Port", text: $port)
                        .keyboardType(.numberPad)
                    Toggle("HTTPS", isOn: $https)
                } header: {
                    Text("Server")
                } footer: {
                    Text("The machine running hooked, reachable from this phone (LAN or WireGuard).")
                }
                if let message {
                    Section {
                        Label(message, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(StateStyle.of(.attention).ink)
                    }
                }
                Section {
                    Button {
                        Task { await testAndSave() }
                    } label: {
                        HStack {
                            Text("Test & Save").fontWeight(.semibold)
                            Spacer()
                            if testing { ProgressView() }
                        }
                    }
                    .disabled(testing || ServerConfig.cleanHost(host).isEmpty || Int(port) == nil)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.ground)
            .navigationTitle(editing ? "Connection" : "Connect to hooked")
            .navigationBarTitleDisplayMode(editing ? .inline : .large)
            .toolbar {
                if editing {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                }
            }
        }
        .onAppear(perform: prefill)
    }

    private func prefill() {
        if let c = app.savedConfig {
            host = c.host
            port = String(c.port)
            https = c.https
        }
    }

    private func testAndSave() async {
        let config = ServerConfig(host: ServerConfig.cleanHost(host), port: Int(port) ?? 4123, https: https)
        testing = true
        defer { testing = false }
        do {
            _ = try await HookedClient(config: config).get("api/sessions", timeout: 10)
            app.save(config)
            if editing { dismiss() }
        } catch {
            message = error.localizedDescription
        }
    }
}
