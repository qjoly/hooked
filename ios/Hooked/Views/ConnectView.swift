import SwiftUI

struct ConnectView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    /// True when opened from the sessions list to edit an existing connection.
    var editing = false

    @State private var host = ""
    @State private var port = "4123"
    @State private var token = ""
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
                Section("Token") {
                    HStack {
                        SecureField("Token", text: $token)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Button {
                            if let s = UIPasteboard.general.string { token = s.trimmingCharacters(in: .whitespacesAndNewlines) }
                        } label: {
                            Image(systemName: "doc.on.clipboard")
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Paste token")
                    }
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
                    .disabled(testing || ServerConfig.cleanHost(host).isEmpty || token.isEmpty || Int(port) == nil)
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
        token = app.savedToken
        message = app.connectMessage
    }

    private func testAndSave() async {
        let config = ServerConfig(host: ServerConfig.cleanHost(host), port: Int(port) ?? 4123, https: https)
        let t = token.trimmingCharacters(in: .whitespacesAndNewlines)
        testing = true
        defer { testing = false }
        do {
            _ = try await HookedClient(config: config, token: t).get("api/sessions", timeout: 10)
            app.save(config, token: t)
            if editing { dismiss() }
        } catch {
            message = error.localizedDescription
        }
    }
}
