import UIKit

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene else { return }

        if let url = connectionOptions.urlContexts.first?.url {
            DeepLinkCenter.shared.enqueue(url)
        }
        let initialLink = DeepLinkCenter.shared.takePending()

        let root = RootViewController(initialLinkURL: initialLink)
        let window = UIWindow(windowScene: windowScene)
        window.backgroundColor = ModuTheme.paper
        window.rootViewController = root
        window.makeKeyAndVisible()
        self.window = window
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts {
            DeepLinkCenter.shared.enqueue(context.url)
        }
    }
}
