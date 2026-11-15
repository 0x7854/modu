import UIKit

enum ModuTheme {
    static let paper = UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0x15 / 255, green: 0x17 / 255, blue: 0x11 / 255, alpha: 1)
            : UIColor(red: 0xF2 / 255, green: 0xED / 255, blue: 0xE2 / 255, alpha: 1)
    }

    static let ink = UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0xEE / 255, green: 0xE9 / 255, blue: 0xDC / 255, alpha: 1)
            : UIColor(red: 0x2A / 255, green: 0x2B / 255, blue: 0x24 / 255, alpha: 1)
    }

    static let muted = UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0x9B / 255, green: 0x9C / 255, blue: 0x8E / 255, alpha: 1)
            : UIColor(red: 0x75 / 255, green: 0x75 / 255, blue: 0x69 / 255, alpha: 1)
    }

    static let accent = UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0x90 / 255, green: 0xAB / 255, blue: 0x8E / 255, alpha: 1)
            : UIColor(red: 0x55 / 255, green: 0x72 / 255, blue: 0x5B / 255, alpha: 1)
    }

    static let onAccent = UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0x15 / 255, green: 0x17 / 255, blue: 0x11 / 255, alpha: 1)
            : UIColor(red: 0xF6 / 255, green: 0xF0 / 255, blue: 0xE3 / 255, alpha: 1)
    }

    static let field = UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0x1D / 255, green: 0x21 / 255, blue: 0x1A / 255, alpha: 1)
            : UIColor(red: 0xFF / 255, green: 0xFD / 255, blue: 0xF8 / 255, alpha: 1)
    }

    static let separator = UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(white: 1, alpha: 0.12)
            : UIColor(white: 0, alpha: 0.10)
    }

    static let danger = UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0xFF / 255, green: 0x8A / 255, blue: 0x7A / 255, alpha: 1)
            : UIColor(red: 0xA1 / 255, green: 0x3D / 255, blue: 0x32 / 255, alpha: 1)
    }
}

enum ServerStore {
    private static let key = "modu.server.origin"

    static func load() -> (origin: ServerOrigin?, hadInvalidValue: Bool) {
        guard let raw = UserDefaults.standard.string(forKey: key) else {
            return (nil, false)
        }
        do {
            return (try ServerOrigin.parseUserInput(raw), false)
        } catch {
            UserDefaults.standard.removeObject(forKey: key)
            return (nil, true)
        }
    }

    static func save(_ origin: ServerOrigin) {
        UserDefaults.standard.set(origin.absoluteString, forKey: key)
    }
}

/// Owns the native shell. The web app keeps the login and document state in its
/// persistent WKWebView; this controller only chooses a validated server and
/// forwards a validated document ID through the existing `/#doc-ID` contract.
final class RootViewController: UIViewController {
    private var currentServer: ServerOrigin?
    private var reader: ReaderViewController?
    private var setup: SetupViewController?
    private var pendingDocumentID: String?
    private let initialLinkURL: URL?
    private var deferredPresentation: (() -> Void)?

    init(initialLinkURL: URL?) {
        self.initialLinkURL = initialLinkURL
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = ModuTheme.paper
        overrideUserInterfaceStyle = .unspecified

        let loaded = ServerStore.load()
        currentServer = loaded.origin

        if let initialLinkURL {
            handleInitialLink(initialLinkURL)
        } else {
            if let server = currentServer {
                showReader(server: server, documentID: nil)
            } else {
                showSetup()
            }
            if loaded.hadInvalidValue {
                deferAfterAppearance { [weak self] in
                    self?.presentSimpleAlert(
                        title: "服务器设置无效",
                        message: "已保存的服务器地址无法通过校验，已清除。请输入你自己的 HTTPS 服务地址。"
                    )
                }
            }
        }

        DeepLinkCenter.shared.attach { [weak self] url in
            self?.handleIncomingLink(url)
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if let deferredPresentation {
            self.deferredPresentation = nil
            deferredPresentation()
        }
    }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        .all
    }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        .default
    }

    // MARK: - Initial state

    private func handleInitialLink(_ url: URL) {
        let link: DeepLink
        do {
            link = try DeepLink.parse(url)
        } catch let error as LinkRouterError {
            showBaseState()
            deferAfterAppearance { [weak self] in
                self?.presentInvalidLink(error)
            }
            return
        } catch {
            showBaseState()
            deferAfterAppearance { [weak self] in
                self?.presentSimpleAlert(title: "无法打开链接", message: "链接格式无效，未连接任何服务器。")
            }
            return
        }

        guard let configured = currentServer else {
            showSetup()
            deferAfterAppearance { [weak self] in
                self?.presentLinkConfirmation(link)
            }
            return
        }

        if link.matches(server: configured) {
            showReader(server: configured, documentID: link.documentID)
        } else {
            showReader(server: configured, documentID: nil)
            deferAfterAppearance { [weak self] in
                self?.presentMismatchAlert(requested: link.server)
            }
        }
    }

    private func showBaseState() {
        if let currentServer {
            showReader(server: currentServer, documentID: nil)
        } else {
            showSetup()
        }
    }

    // MARK: - Warm links

    private func handleIncomingLink(_ url: URL) {
        let link: DeepLink
        do {
            link = try DeepLink.parse(url)
        } catch let error as LinkRouterError {
            presentInvalidLink(error)
            return
        } catch {
            presentSimpleAlert(title: "无法打开链接", message: "链接格式无效，未连接任何服务器。")
            return
        }

        guard let configured = currentServer else {
            presentLinkConfirmation(link)
            return
        }

        guard link.matches(server: configured) else {
            presentMismatchAlert(requested: link.server)
            return
        }

        pendingDocumentID = link.documentID
        if let reader {
            presentedViewController?.dismiss(animated: true)
            reader.presentedViewController?.dismiss(animated: true)
            reader.open(documentID: link.documentID)
        } else {
            showReader(server: configured, documentID: link.documentID)
        }
    }

    // MARK: - Link UI

    private func presentLinkConfirmation(_ link: DeepLink) {
        let alert = UIAlertController(
            title: "确认链接请求的服务器",
            message: """
            此链接要求连接：

            \(link.server.absoluteString)

            并打开文稿 ID：

            \(link.documentID)

            应用尚未保存任何服务器。只有在你确认该服务器属于你时才继续；确认前不会发出请求。
            """,
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "取消", style: .cancel))
        alert.addAction(UIAlertAction(title: "确认并打开", style: .default) { [weak self] _ in
            guard let self else { return }
            ServerStore.save(link.server)
            self.currentServer = link.server
            self.showReader(server: link.server, documentID: link.documentID)
        })
        topPresenter().present(alert, animated: true)
    }

    private func presentMismatchAlert(requested: ServerOrigin) {
        let configured = currentServer?.absoluteString ?? "（未配置）"
        let alert = UIAlertController(
            title: "链接服务器不匹配",
            message: """
            当前服务器：
            \(configured)

            链接要求：
            \(requested.absoluteString)

            为避免把登录状态或文稿请求发往其他服务器，已拒绝此链接；服务器设置未改变。
            """,
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "关闭", style: .cancel))
        if currentServer != nil {
            alert.addAction(UIAlertAction(title: "服务器设置", style: .default) { [weak self] _ in
                DispatchQueue.main.async {
                    self?.presentSettings()
                }
            })
        }
        topPresenter().present(alert, animated: true)
    }

    private func presentInvalidLink(_ error: LinkRouterError) {
        presentSimpleAlert(
            title: "无法打开链接",
            message: "\(error.userMessage)\n\n未连接任何服务器，已拒绝此链接。"
        )
    }

    // MARK: - Setup and settings

    private func showSetup() {
        let controller = SetupViewController(mode: .initial)
        controller.onSave = { [weak self] origin in
            self?.completeInitialSetup(origin)
        }
        setup = controller
        reader = nil
        replaceChild(with: controller)
    }

    private func completeInitialSetup(_ origin: ServerOrigin) {
        let previous = currentServer
        if previous != nil, previous != origin {
            pendingDocumentID = nil
        }
        ServerStore.save(origin)
        currentServer = origin
        let documentID = pendingDocumentID
        showReader(server: origin, documentID: documentID)
    }

    private func showReader(server: ServerOrigin, documentID: String?) {
        let controller = ReaderViewController(server: server, initialDocumentID: documentID)
        controller.onOpenSettings = { [weak self] in
            self?.presentSettings()
        }
        currentServer = server
        pendingDocumentID = documentID
        reader = controller
        setup = nil
        replaceChild(with: controller)
    }

    private func presentSettings() {
        guard let server = currentServer else {
            showSetup()
            return
        }
        let controller = SetupViewController(mode: .settings(server))
        controller.onSave = { [weak self] origin in
            self?.saveSettings(origin)
        }
        controller.onCancel = { [weak self] in
            self?.dismiss(animated: true)
        }
        let navigation = UINavigationController(rootViewController: controller)
        navigation.modalPresentationStyle = UIDevice.current.userInterfaceIdiom == .pad
            ? .formSheet
            : .pageSheet
        navigation.preferredContentSize = CGSize(width: 560, height: 430)
        present(navigation, animated: true)
    }

    private func saveSettings(_ origin: ServerOrigin) {
        guard let previous = currentServer else {
            completeInitialSetup(origin)
            dismiss(animated: true)
            return
        }
        guard origin != previous else {
            dismiss(animated: true)
            return
        }

        let hadPendingDocument = pendingDocumentID != nil
        pendingDocumentID = nil
        ServerStore.save(origin)
        currentServer = origin
        dismiss(animated: true) { [weak self] in
            guard let self else { return }
            self.showReader(server: origin, documentID: nil)
            if hadPendingDocument {
                self.presentSimpleAlert(
                    title: "服务器已更改",
                    message: "待打开的文稿链接已清除。新服务器需要先在网页中登录。"
                )
            }
        }
    }

    // MARK: - Container

    private func replaceChild(with controller: UIViewController) {
        if let existing = children.first {
            existing.willMove(toParent: nil)
            existing.view.removeFromSuperview()
            existing.removeFromParent()
        }
        addChild(controller)
        controller.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(controller.view)
        NSLayoutConstraint.activate([
            controller.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            controller.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            controller.view.topAnchor.constraint(equalTo: view.topAnchor),
            controller.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        controller.didMove(toParent: self)
    }

    private func topPresenter() -> UIViewController {
        var top: UIViewController = self
        while let presented = top.presentedViewController, !presented.isBeingDismissed {
            top = presented
        }
        return top
    }

    private func presentSimpleAlert(title: String, message: String) {
        let presenter = topPresenter()
        guard !(presenter is UIAlertController) else { return }
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "好", style: .default))
        presenter.present(alert, animated: true)
    }

    private func deferAfterAppearance(_ block: @escaping () -> Void) {
        if isViewLoaded, view.window != nil {
            block()
        } else {
            deferredPresentation = block
        }
    }
}
