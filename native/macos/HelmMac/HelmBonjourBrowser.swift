import Foundation

@MainActor
final class HelmBonjourBrowser: NSObject, ObservableObject {
    @Published private(set) var endpoints: [HelmEndpoint] = []
    @Published private(set) var status = "Ready to scan for _helm._tcp"

    private let browser = NetServiceBrowser()
    private var servicesByName: [String: NetService] = [:]

    override init() {
        super.init()
        browser.delegate = self
    }

    func start() {
        status = "Scanning local network for Helm"
        browser.stop()
        servicesByName.removeAll()
        endpoints.removeAll()
        browser.searchForServices(ofType: "_helm._tcp.", inDomain: "local.")
    }

    func stop() {
        browser.stop()
        status = "Scan stopped"
    }

    private func upsert(service: NetService) {
        guard service.port > 0 else { return }
        let host = normalizeHost(service.hostName)
        guard !host.isEmpty else { return }

        let txt = Self.parseTXT(service.txtRecordData())
        let tls = txt["tls"] == "1" || txt["tls"]?.lowercased() == "true"
        let displayName = txt["name"].flatMap { $0.isEmpty ? nil : $0 } ?? service.name
        let endpoint = HelmEndpoint(
            name: displayName,
            host: host,
            port: service.port,
            tls: tls,
            fingerprint: txt["fp"] ?? txt["fingerprint"]
        )

        endpoints.removeAll { $0.id == endpoint.id || $0.name == endpoint.name }
        endpoints.append(endpoint)
        endpoints.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        status = endpoints.isEmpty ? "Scanning local network for Helm" : "Found \(endpoints.count) Helm service\(endpoints.count == 1 ? "" : "s")"
    }

    private func normalizeHost(_ hostName: String?) -> String {
        guard var host = hostName?.trimmingCharacters(in: .whitespacesAndNewlines), !host.isEmpty else {
            return ""
        }
        if host.hasSuffix(".") {
            host.removeLast()
        }
        return host
    }

    private static func parseTXT(_ data: Data?) -> [String: String] {
        guard let data else { return [:] }
        let records = NetService.dictionary(fromTXTRecord: data)
        var txt: [String: String] = [:]
        for (key, value) in records {
            txt[key] = String(data: value, encoding: .utf8)
        }
        return txt
    }
}

extension HelmBonjourBrowser: NetServiceBrowserDelegate {
    nonisolated func netServiceBrowserWillSearch(_ browser: NetServiceBrowser) {
        Task { @MainActor in
            self.status = "Scanning local network for Helm"
        }
    }

    nonisolated func netServiceBrowser(_ browser: NetServiceBrowser, didNotSearch errorDict: [String: NSNumber]) {
        Task { @MainActor in
            self.status = "Bonjour scan failed: \(errorDict)"
        }
    }

    nonisolated func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
        Task { @MainActor in
            service.delegate = self
            self.servicesByName[service.name] = service
            service.resolve(withTimeout: 5)
            if !moreComing {
                self.status = "Resolving Helm service\(self.servicesByName.count == 1 ? "" : "s")"
            }
        }
    }

    nonisolated func netServiceBrowser(_ browser: NetServiceBrowser, didRemove service: NetService, moreComing: Bool) {
        Task { @MainActor in
            self.servicesByName.removeValue(forKey: service.name)
            self.endpoints.removeAll { $0.name == service.name }
            if !moreComing {
                self.status = self.endpoints.isEmpty ? "No Helm services visible" : "Found \(self.endpoints.count) Helm service\(self.endpoints.count == 1 ? "" : "s")"
            }
        }
    }
}

extension HelmBonjourBrowser: NetServiceDelegate {
    nonisolated func netServiceDidResolveAddress(_ sender: NetService) {
        Task { @MainActor in
            self.upsert(service: sender)
        }
    }

    nonisolated func netService(_ sender: NetService, didNotResolve errorDict: [String: NSNumber]) {
        Task { @MainActor in
            self.status = "Could not resolve \(sender.name): \(errorDict)"
        }
    }
}
