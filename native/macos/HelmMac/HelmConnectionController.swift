import Foundation

@MainActor
final class HelmConnectionController: ObservableObject {
    @Published private(set) var isConnected = false
    @Published private(set) var lastAck = "Not connected"
    @Published private(set) var logLines: [String] = []

    private var task: URLSessionWebSocketTask?

    func connect(to endpoint: HelmEndpoint) {
        disconnect()
        appendLog("Connecting \(endpoint.navWebSocketURL.absoluteString)")
        let request = URLRequest(url: endpoint.navWebSocketURL)
        let nextTask = URLSession.shared.webSocketTask(with: request)
        task = nextTask
        isConnected = true
        lastAck = "Opening /nav"
        nextTask.resume()
        sendObject(["t": "hello", "channels": ["nav"], "rateHz": 1])
        sendObject(["t": "conn.list", "token": endpoint.token])
        receiveLoop()
    }

    func disconnect() {
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        isConnected = false
        lastAck = "Disconnected"
    }

    func upsertSerial(_ draft: SerialConnectionDraft, token: String) {
        guard draft.isValid else {
            lastAck = "Serial form is incomplete"
            appendLog("Refused invalid serial form")
            return
        }

        sendObject([
            "t": "conn.upsert",
            "token": token,
            "conn": draft.payload
        ])
    }

    private func sendObject(_ object: [String: Any]) {
        guard let task else {
            lastAck = "Connect before sending"
            appendLog("Send skipped: no WebSocket")
            return
        }
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
              let text = String(data: data, encoding: .utf8) else {
            lastAck = "Could not encode command JSON"
            appendLog("Encode failed for command")
            return
        }

        appendLog("-> \(text)")
        task.send(.string(text)) { [weak self] error in
            Task { @MainActor in
                if let error {
                    self?.lastAck = "Send failed: \(error.localizedDescription)"
                    self?.appendLog("send error: \(error.localizedDescription)")
                }
            }
        }
    }

    private func receiveLoop() {
        task?.receive { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                switch result {
                case .failure(let error):
                    self.isConnected = false
                    self.lastAck = "Receive failed: \(error.localizedDescription)"
                    self.appendLog("receive error: \(error.localizedDescription)")
                case .success(let message):
                    self.handle(message)
                    self.receiveLoop()
                }
            }
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        let text: String
        switch message {
        case .string(let value):
            text = value
        case .data(let data):
            text = String(data: data, encoding: .utf8) ?? "<\(data.count) bytes>"
        @unknown default:
            text = "<unknown message>"
        }

        appendLog("<- \(text)")
        guard let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["t"] as? String else {
            return
        }

        if type == "conn.ack" {
            let ok = object["ok"] as? Bool ?? false
            let id = object["id"] as? String ?? ""
            let error = object["error"] as? String ?? ""
            lastAck = ok ? "Serial config accepted: \(id)" : "Serial config rejected: \(error)"
        } else if type == "conn.list" {
            let count = (object["conns"] as? [[String: Any]])?.count ?? 0
            lastAck = "Connection list has \(count) entr\(count == 1 ? "y" : "ies")"
        } else if type == "sub.ack" {
            lastAck = "Subscribed to nav stream"
        }
    }

    private func appendLog(_ line: String) {
        logLines.append(line)
        if logLines.count > 200 {
            logLines.removeFirst(logLines.count - 200)
        }
    }
}
