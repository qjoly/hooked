import SwiftUI

struct NewSessionView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let store: SessionsStore
    let onLaunched: (String) -> Void

    @State private var cwd = ""
    @State private var prompt = ""
    @State private var model = ""
    @State private var effort = ""
    @State private var mode = "default"
    @State private var launching = false
    @State private var error: String?
    @State private var showAllProjects = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Project") {
                    TextField("Absolute path", text: $cwd)
                        .font(.system(size: 14, design: .monospaced))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    let projects = store.projects
                    ForEach(showAllProjects ? projects : Array(projects.prefix(6)), id: \.self) { p in
                        Button { cwd = p } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text((p as NSString).lastPathComponent).foregroundStyle(Theme.ink)
                                    Text(p).font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.head)
                                }
                                Spacer()
                                if cwd == p { Image(systemName: "checkmark").foregroundStyle(Theme.accent) }
                            }
                        }
                    }
                    if projects.count > 6 && !showAllProjects {
                        Button("Show all \(projects.count) projects") { showAllProjects = true }
                    }
                }
                Section("Prompt") {
                    TextField("What should Claude do?", text: $prompt, axis: .vertical)
                        .lineLimit(4...12)
                }
                Section("Options") {
                    Picker("Model", selection: $model) {
                        Text("Default").tag("")
                        if !model.isEmpty && !app.capabilities.models.contains(where: { $0.options.contains { $0.id == model } }) {
                            Text(model).tag(model)
                        }
                        ForEach(app.capabilities.models) { g in
                            ForEach(g.options, id: \.id) { o in Text(app.capabilities.modelLabel(o.id)).tag(o.id) }
                        }
                    }
                    Picker("Effort", selection: $effort) {
                        Text("Default").tag("")
                        if !effort.isEmpty && !app.capabilities.efforts.contains(effort) { Text(effort).tag(effort) }
                        ForEach(app.capabilities.efforts, id: \.self) { Text($0.capitalized).tag($0) }
                    }
                    Picker("Mode", selection: $mode) {
                        ForEach(PermissionMode.launch, id: \.self) { Text(PermissionMode.label($0)).tag($0) }
                    }
                }
                if let error {
                    Section { Text(error).foregroundStyle(StateStyle.of(.attention).ink) }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.ground)
            .navigationTitle("New session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if launching { ProgressView() } else {
                        Button("Launch") { Task { await launch() } }
                            .disabled(cwd.trimmingCharacters(in: .whitespaces).isEmpty || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
            .interactiveDismissDisabled(launching)
        }
        .task { await loadDefaults() }
    }

    private func loadDefaults() async {
        if cwd.isEmpty, let p = store.projects.first { cwd = p }
        if app.capabilities.models.isEmpty, let caps = try? await store.client.capabilities() { app.capabilities = caps }
        guard let d = try? await store.client.defaults() else { return }
        if model.isEmpty { model = d.model ?? "" }
        if effort.isEmpty { effort = d.effort ?? "" }
        if let m = d.mode, PermissionMode.launch.contains(m) { mode = m }
    }

    private func launch() async {
        launching = true
        error = nil
        defer { launching = false }
        do {
            let id = try await store.client.launch(
                cwd: cwd.trimmingCharacters(in: .whitespaces),
                prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines),
                model: model.nilIfEmpty, effort: effort.nilIfEmpty, mode: mode)
            await store.refresh()
            onLaunched(id)
        } catch {
            self.error = error.localizedDescription
        }
    }
}
