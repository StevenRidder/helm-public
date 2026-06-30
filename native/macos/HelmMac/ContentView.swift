import AppKit
import SwiftUI

struct ContentView: View {
    @StateObject private var browser = HelmBonjourBrowser()
    @StateObject private var connection = HelmConnectionController()

    @State private var selectedEndpoint: HelmEndpoint?
    @State private var manualHost = "127.0.0.1"
    @State private var manualPort = 9001
    @State private var useTLS = false
    @State private var ownerToken = ""
    @State private var serialDraft = SerialConnectionDraft()
    @State private var serialDevices: [String] = SerialDeviceScanner.visibleDevicePaths()

    private var activeEndpoint: HelmEndpoint {
        var endpoint = selectedEndpoint ?? HelmEndpoint(
            name: "Manual Helm server",
            host: manualHost,
            port: manualPort,
            tls: useTLS
        )
        endpoint.token = ownerToken.trimmingCharacters(in: .whitespacesAndNewlines)
        return endpoint
    }

    var body: some View {
        NavigationSplitView {
            List(selection: $selectedEndpoint) {
                Section("Boat server") {
                    Text(browser.status)
                        .font(.footnote)
                        .foregroundStyle(.secondary)

                    Button("Scan Bonjour") {
                        browser.start()
                    }

                    ForEach(browser.endpoints) { endpoint in
                        Button {
                            selectedEndpoint = endpoint
                            manualHost = endpoint.host
                            manualPort = endpoint.port
                            useTLS = endpoint.tls
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
                }

                Section("Manual") {
                    TextField("Host", text: $manualHost)
                        .textFieldStyle(.roundedBorder)
                    Stepper(value: $manualPort, in: 1...65535) {
                        Text("Port \(manualPort)")
                    }
                    Toggle("TLS", isOn: $useTLS)
                    SecureField("Owner token", text: $ownerToken)
                        .textFieldStyle(.roundedBorder)
                }
            }
            .navigationTitle("Helm")
            .toolbar {
                Button("Refresh") {
                    serialDevices = SerialDeviceScanner.visibleDevicePaths()
                    browser.start()
                }
            }
        } detail: {
            VStack(alignment: .leading, spacing: 16) {
                endpointHeader
                serialPanel
                logPanel
            }
            .padding(20)
            .navigationTitle("macOS client")
        }
        .onAppear {
            browser.start()
        }
    }

    private var endpointHeader: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 6) {
                Text(activeEndpoint.name)
                    .font(.title2.weight(.semibold))
                Text(activeEndpoint.subtitle)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Text(connection.lastAck)
                    .font(.caption)
                    .foregroundStyle(connection.isConnected ? .green : .secondary)
            }

            Spacer()

            Button(connection.isConnected ? "Disconnect" : "Connect /nav") {
                if connection.isConnected {
                    connection.disconnect()
                } else {
                    connection.connect(to: activeEndpoint)
                }
            }

            Button("Open Web UI") {
                NSWorkspace.shared.open(activeEndpoint.httpURL)
            }
        }
    }

    private var serialPanel: some View {
        GroupBox("Serial NMEA 0183") {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    TextField("Name", text: $serialDraft.name)
                    Toggle("Enabled", isOn: $serialDraft.enabled)
                        .toggleStyle(.switch)
                }

                HStack {
                    TextField("/dev/cu.usbserial-1410", text: $serialDraft.devicePath)
                    Menu("Detected") {
                        if serialDevices.isEmpty {
                            Text("No /dev/cu.* devices visible")
                        } else {
                            ForEach(serialDevices, id: \.self) { path in
                                Button(path) {
                                    serialDraft.devicePath = path
                                }
                            }
                        }
                    }
                    Button("Rescan") {
                        serialDevices = SerialDeviceScanner.visibleDevicePaths()
                    }
                }

                HStack {
                    Picker("Baud", selection: $serialDraft.baud) {
                        ForEach([4800, 9600, 38400, 57600, 115200], id: \.self) { baud in
                            Text("\(baud)").tag(baud)
                        }
                    }
                    .pickerStyle(.segmented)

                    Stepper(value: $serialDraft.priority, in: 0...100) {
                        Text("Priority \(serialDraft.priority)")
                    }
                    .frame(width: 180)
                }

                HStack {
                    Button("Send conn.upsert") {
                        connection.upsertSerial(serialDraft, token: activeEndpoint.token)
                    }
                    .disabled(!connection.isConnected || !serialDraft.isValid)

                    Text("Uses CONN-9 contract: type=serial, address=device path, port=baud.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(8)
        }
    }

    private var logPanel: some View {
        GroupBox("Command log") {
            ScrollView {
                Text(connection.logLines.joined(separator: "\n"))
                    .font(.system(.caption, design: .monospaced))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
                    .padding(8)
            }
            .frame(minHeight: 220)
        }
    }
}

#Preview {
    ContentView()
}
