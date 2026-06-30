import SwiftUI
import WebKit

struct HelmWebView: UIViewRepresentable {
    let url: URL
    @Binding var capabilityReport: HelmWebCapabilityReport

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.websiteDataStore = .default()
        configuration.userContentController.add(context.coordinator, name: "helmCapability")

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.navigationDelegate = context.coordinator
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        if webView.url != url {
            webView.load(URLRequest(url: url, cachePolicy: .useProtocolCachePolicy, timeoutInterval: 10))
        }
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "helmCapability")
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(capabilityReport: $capabilityReport)
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        private var capabilityReport: Binding<HelmWebCapabilityReport>

        init(capabilityReport: Binding<HelmWebCapabilityReport>) {
            self.capabilityReport = capabilityReport
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            runCapabilityProbe(in: webView)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            NSLog("Helm WKWebView navigation failed: %@", error.localizedDescription)
            capabilityReport.wrappedValue = HelmWebCapabilityReport(url: webView.url?.absoluteString ?? "unknown", error: error.localizedDescription)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            NSLog("Helm WKWebView provisional navigation failed: %@", error.localizedDescription)
            capabilityReport.wrappedValue = HelmWebCapabilityReport(url: webView.url?.absoluteString ?? "unknown", error: error.localizedDescription)
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "helmCapability" else { return }
            capabilityReport.wrappedValue = HelmWebCapabilityReport.from(messageBody: message.body)
        }

        private func runCapabilityProbe(in webView: WKWebView) {
            let script = """
            (() => {
              const canvas = document.createElement('canvas');
              const webgl2 = !!canvas.getContext('webgl2');
              const webgl = webgl2 || !!canvas.getContext('webgl') || !!canvas.getContext('experimental-webgl');
              const styleProbe = document.createElement('div');
              styleProbe.style.cssText = 'position:fixed;top:env(safe-area-inset-top);bottom:env(safe-area-inset-bottom);visibility:hidden;';
              document.documentElement.appendChild(styleProbe);
              const computed = getComputedStyle(styleProbe);
              const payload = {
                url: location.href,
                userAgent: navigator.userAgent,
                webGPUAvailable: !!navigator.gpu,
                webGL2Available: webgl2,
                webGLAvailable: webgl,
                mapLibreLoaded: !!window.maplibregl,
                serviceWorkerAvailable: 'serviceWorker' in navigator,
                devicePixelRatio: window.devicePixelRatio || 1,
                viewportWidth: window.innerWidth || 0,
                viewportHeight: window.innerHeight || 0,
                safeAreaTop: computed.top || '0px',
                safeAreaBottom: computed.bottom || '0px'
              };
              styleProbe.remove();
              window.webkit.messageHandlers.helmCapability.postMessage(payload);
            })();
            """

            webView.evaluateJavaScript(script) { _, error in
                if let error {
                    self.capabilityReport.wrappedValue = HelmWebCapabilityReport(
                        url: webView.url?.absoluteString ?? "unknown",
                        error: "Capability probe failed: \(error.localizedDescription)"
                    )
                }
            }
        }
    }
}
