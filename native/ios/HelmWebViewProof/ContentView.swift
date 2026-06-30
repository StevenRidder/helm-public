import SwiftUI

struct ContentView: View {
    @StateObject private var browser = HelmBonjourBrowser()
    @State private var selectedEndpoint: HelmEndpoint?
    @State private var manualURLText = "http://127.0.0.1:9001/"
    @State private var loadedURL = URL(string: "http://127.0.0.1:9001/")!
    @State private var capabilityReport = HelmWebCapabilityReport()

    var body: some View {
        NavigationSplitView {
            List(selection: $selectedEndpoint) {
                Section {
                    Text(browser.status)
                        .font(.footnote)
                        .foregroundStyle(.secondary)

                    Button("Scan for Helm boat server") {
                        browser.start()
                    }

                    ForEach(browser.endpoints) { endpoint in
                        Button {
                            selectedEndpoint = endpoint
                            loadedURL = endpoint.url
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(endpoint.name)
                                Text(endpoint.subtitle)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                if let fingerprint = endpoint.fingerprint {
                                    Text("fp \(fingerprint)")
                                        .font(.caption2)
                                        .foregroundStyle(.tertiary)
                                        .lineLimit(1)
                                }
                            }
                        }
                    }
                } header: {
                    Text("Bonjour")
                }

                Section {
                    TextField("http://helm.local:9001/", text: $manualURLText)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()

                    Button("Load manual address") {
                        if let url = URL(string: manualURLText), url.scheme != nil {
                            loadedURL = url
                        }
                    }
                } header: {
                    Text("Fallback")
                } footer: {
                    Text("NATIVE-5 keeps the product web-first: prove WKWebView + MapLibre/WebGPU before escalating to native MapLibre/Metal.")
                }

                Section {
                    CapabilityRow(label: "Renderer", value: capabilityReport.gpuSummary)
                    CapabilityRow(label: "MapLibre", value: capabilityReport.mapLibreLoaded ? "loaded" : "not observed")
                    CapabilityRow(label: "Service worker", value: capabilityReport.serviceWorkerAvailable ? "available" : "unavailable")
                    CapabilityRow(label: "Viewport", value: "\(capabilityReport.viewportWidth)×\(capabilityReport.viewportHeight) @\(String(format: "%.1f", capabilityReport.devicePixelRatio))x")
                    CapabilityRow(label: "Safe area", value: "top \(capabilityReport.safeAreaTop), bottom \(capabilityReport.safeAreaBottom)")

                    if let error = capabilityReport.error {
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                } header: {
                    Text("Web renderer gate")
                } footer: {
                    Text(capabilityReport.rendererRecommendation)
                }
            }
            .navigationTitle("Helm")
            .toolbar {
                Button("Refresh") {
                    browser.start()
                }
            }
        } detail: {
            HelmWebView(url: loadedURL, capabilityReport: $capabilityReport)
                .ignoresSafeArea()
                .navigationTitle(loadedURL.host ?? "Helm")
                .navigationBarTitleDisplayMode(.inline)
        }
        .onAppear {
            browser.start()
        }
    }
}

private struct CapabilityRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack {
            Text(label)
            Spacer()
            Text(value)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.trailing)
        }
        .font(.caption)
    }
}

#Preview {
    ContentView()
}
