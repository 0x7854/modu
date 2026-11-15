import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        if let url = launchOptions?[.url] as? URL {
            DeepLinkCenter.shared.enqueue(url)
        }
        return true
    }

    func application(
        _ app: UIApplication,
        open url: URL,
        options: [UIApplication.OpenURLOptionsKey: Any] = [:]
    ) -> Bool {
        DeepLinkCenter.shared.enqueue(url)
        return true
    }

    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(
            name: "Default Configuration",
            sessionRole: connectingSceneSession.role
        )
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }
}

/// Bridges cold- and warm-launch URLs to the root controller. The same URL can
/// arrive through both UIApplication and UIScene callbacks, so identical
/// deliveries within a short window are coalesced.
final class DeepLinkCenter {
    static let shared = DeepLinkCenter()

    private var pendingURL: URL?
    private var handler: ((URL) -> Void)?
    private var lastURL: URL?
    private var lastDelivery = Date.distantPast

    private init() {}

    func enqueue(_ url: URL) {
        let now = Date()
        if lastURL == url, now.timeIntervalSince(lastDelivery) < 1.5 {
            return
        }
        lastURL = url
        lastDelivery = now
        if let handler {
            handler(url)
        } else {
            pendingURL = url
        }
    }

    func attach(_ handler: @escaping (URL) -> Void) {
        self.handler = handler
        if let pendingURL {
            self.pendingURL = nil
            handler(pendingURL)
        }
    }

    func takePending() -> URL? {
        defer { pendingURL = nil }
        return pendingURL
    }
}
