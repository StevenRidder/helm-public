import Foundation

struct HelmEndpoint: Identifiable, Hashable {
    let id: String
    var name: String
    var host: String
    var port: Int
    var tls: Bool
    var fingerprint: String?
    var token: String

    init(name: String, host: String, port: Int, tls: Bool = false, fingerprint: String? = nil, token: String = "") {
        self.name = name
        self.host = host
        self.port = port
        self.tls = tls
        self.fingerprint = fingerprint
        self.token = token
        self.id = "\(host):\(port)"
    }

    var httpURL: URL {
        var components = URLComponents()
        components.scheme = tls ? "https" : "http"
        components.host = host
        components.port = port
        components.path = "/"
        return components.url ?? URL(string: "http://127.0.0.1:9001/")!
    }

    var navWebSocketURL: URL {
        var components = URLComponents()
        components.scheme = tls ? "wss" : "ws"
        components.host = host
        components.port = port
        components.path = "/nav"
        if !token.isEmpty {
            components.queryItems = [URLQueryItem(name: "token", value: token)]
        }
        return components.url ?? URL(string: "ws://127.0.0.1:9001/nav")!
    }

    var subtitle: String {
        "\(tls ? "https" : "http")://\(host):\(port)"
    }
}
