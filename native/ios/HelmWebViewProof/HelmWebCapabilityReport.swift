import Foundation

struct HelmWebCapabilityReport: Equatable {
    var url: String = "not loaded"
    var userAgent: String = "unknown"
    var webGPUAvailable: Bool = false
    var webGL2Available: Bool = false
    var webGLAvailable: Bool = false
    var mapLibreLoaded: Bool = false
    var serviceWorkerAvailable: Bool = false
    var devicePixelRatio: Double = 1
    var viewportWidth: Int = 0
    var viewportHeight: Int = 0
    var safeAreaTop: String = "0px"
    var safeAreaBottom: String = "0px"
    var error: String?

    var gpuSummary: String {
        if webGPUAvailable {
            return "WebGPU available"
        }
        if webGL2Available {
            return "WebGL2 fallback"
        }
        if webGLAvailable {
            return "WebGL fallback"
        }
        return "No GPU canvas reported"
    }

    var rendererRecommendation: String {
        if webGPUAvailable && mapLibreLoaded {
            return "Keep web-first: WKWebView can host MapLibre plus WebGPU."
        }
        if webGL2Available && mapLibreLoaded {
            return "Keep web-first for MapLibre; WebGPU layers need fallback or iOS enablement."
        }
        if mapLibreLoaded {
            return "MapLibre loaded, but GPU capability is limited; use this as an escalation signal."
        }
        return "Load Helm before deciding on native MapLibre/Metal."
    }

    static func from(messageBody: Any) -> HelmWebCapabilityReport {
        guard let body = messageBody as? [String: Any] else {
            return HelmWebCapabilityReport(error: "Probe returned non-dictionary payload")
        }

        return HelmWebCapabilityReport(
            url: body["url"] as? String ?? "unknown",
            userAgent: body["userAgent"] as? String ?? "unknown",
            webGPUAvailable: body["webGPUAvailable"] as? Bool ?? false,
            webGL2Available: body["webGL2Available"] as? Bool ?? false,
            webGLAvailable: body["webGLAvailable"] as? Bool ?? false,
            mapLibreLoaded: body["mapLibreLoaded"] as? Bool ?? false,
            serviceWorkerAvailable: body["serviceWorkerAvailable"] as? Bool ?? false,
            devicePixelRatio: doubleValue(body["devicePixelRatio"], fallback: 1),
            viewportWidth: intValue(body["viewportWidth"]),
            viewportHeight: intValue(body["viewportHeight"]),
            safeAreaTop: body["safeAreaTop"] as? String ?? "0px",
            safeAreaBottom: body["safeAreaBottom"] as? String ?? "0px",
            error: body["error"] as? String
        )
    }

    private static func doubleValue(_ value: Any?, fallback: Double) -> Double {
        if let number = value as? NSNumber {
            return number.doubleValue
        }
        if let double = value as? Double {
            return double
        }
        return fallback
    }

    private static func intValue(_ value: Any?) -> Int {
        if let number = value as? NSNumber {
            return number.intValue
        }
        if let int = value as? Int {
            return int
        }
        return 0
    }
}
