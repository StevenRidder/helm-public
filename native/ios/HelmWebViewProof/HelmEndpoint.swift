import Foundation

struct HelmEndpoint: Identifiable, Hashable {
    let id: String
    let name: String
    let host: String
    let port: Int
    let tls: Bool
    let fingerprint: String?

    init(name: String, host: String, port: Int, tls: Bool = false, fingerprint: String? = nil) {
        self.name = name
        self.host = host
        self.port = port
        self.tls = tls
        self.fingerprint = fingerprint
        self.id = "\(host):\(port)"
    }

    var url: URL {
        var components = URLComponents()
        components.scheme = tls ? "https" : "http"
        components.host = host
        components.port = port
        components.path = "/"
        return components.url ?? URL(string: "http://127.0.0.1:9001/")!
    }

    var subtitle: String {
        "\(tls ? "https" : "http")://\(host):\(port)"
    }
}
