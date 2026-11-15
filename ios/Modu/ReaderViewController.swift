import SafariServices
import UIKit
import WebKit

final class ReaderViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    var onOpenSettings: (() -> Void)?

    private let server: ServerOrigin
    private let initialDocumentID: String?
    private let webView: WKWebView
    private let navigationBar = UINavigationBar()
    private let progressView = UIProgressView(progressViewStyle: .bar)
    private let activityIndicator = UIActivityIndicatorView(style: .medium)
    private let titleLabel = UILabel()
    private let errorView = UIView()
    private let errorDetailLabel = UILabel()
    private let retryButton = UIButton(type: .system)
    private let blockedBanner = InsetLabel()
    private var progressObservation: NSKeyValueObservation?
    private var lastRequestedURL: URL?
    private var bannerHideWorkItem: DispatchWorkItem?

    init(server: ServerOrigin, initialDocumentID: String?) {
        self.server = server
        self.initialDocumentID = initialDocumentID

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        webView = WKWebView(frame: .zero, configuration: configuration)

        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    deinit {
        progressObservation?.invalidate()
        bannerHideWorkItem?.cancel()
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = ModuTheme.paper
        configureNavigationBar()
        configureWebView()
        configureErrorView()
        configureBanner()
        activateLayout()
        observeProgress()
        loadInitialPage()
    }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        .all
    }

    // MARK: - Public

    func open(documentID: String) {
        guard let url = documentURL(documentID) else { return }
        load(url)
    }

    // MARK: - UI

    private func configureNavigationBar() {
        navigationBar.translatesAutoresizingMaskIntoConstraints = false
        let appearance = UINavigationBarAppearance()
        appearance.configureWithOpaqueBackground()
        appearance.backgroundColor = ModuTheme.paper
        appearance.shadowColor = ModuTheme.separator
        appearance.titleTextAttributes = [
            .foregroundColor: ModuTheme.ink,
            .font: UIFont.preferredFont(forTextStyle: .headline),
        ]
        navigationBar.standardAppearance = appearance
        navigationBar.scrollEdgeAppearance = appearance
        navigationBar.compactAppearance = appearance
        navigationBar.tintColor = ModuTheme.accent

        activityIndicator.hidesWhenStopped = true
        activityIndicator.color = ModuTheme.accent

        titleLabel.text = server.displayName
        titleLabel.font = UIFont.preferredFont(forTextStyle: .headline)
        titleLabel.textColor = ModuTheme.ink
        titleLabel.lineBreakMode = .byTruncatingMiddle
        titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        titleLabel.accessibilityLabel = "服务器 \(server.absoluteString)"

        let titleStack = UIStackView(arrangedSubviews: [activityIndicator, titleLabel])
        titleStack.axis = .horizontal
        titleStack.alignment = .center
        titleStack.spacing = 6

        let item = UINavigationItem()
        item.titleView = titleStack
        let reload = UIBarButtonItem(
            image: UIImage(systemName: "arrow.clockwise"),
            style: .plain,
            target: self,
            action: #selector(reloadTapped)
        )
        reload.accessibilityLabel = "重新载入"
        let settings = UIBarButtonItem(
            image: UIImage(systemName: "gearshape"),
            style: .plain,
            target: self,
            action: #selector(settingsTapped)
        )
        settings.accessibilityLabel = "服务器设置"
        item.rightBarButtonItems = [settings, reload]
        navigationBar.setItems([item], animated: false)
        view.addSubview(navigationBar)

        progressView.translatesAutoresizingMaskIntoConstraints = false
        progressView.progressTintColor = ModuTheme.accent
        progressView.trackTintColor = .clear
        progressView.progress = 0
        view.addSubview(progressView)
    }

    private func configureWebView() {
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        view.addSubview(webView)
    }

    private func configureErrorView() {
        errorView.translatesAutoresizingMaskIntoConstraints = false
        errorView.backgroundColor = ModuTheme.paper
        errorView.isHidden = true
        view.addSubview(errorView)

        let icon = UIImageView(image: UIImage(systemName: "exclamationmark.triangle"))
        icon.tintColor = ModuTheme.danger
        icon.contentMode = .scaleAspectFit
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.widthAnchor.constraint(equalToConstant: 34).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 34).isActive = true

        let title = UILabel()
        title.text = "无法载入页面"
        title.font = UIFont.preferredFont(forTextStyle: .title2)
        title.textColor = ModuTheme.ink
        title.textAlignment = .center
        title.numberOfLines = 0

        errorDetailLabel.font = UIFont.preferredFont(forTextStyle: .body)
        errorDetailLabel.textColor = ModuTheme.muted
        errorDetailLabel.textAlignment = .center
        errorDetailLabel.numberOfLines = 0

        retryButton.setTitle("重试", for: .normal)
        retryButton.titleLabel?.font = UIFont.preferredFont(forTextStyle: .headline)
        retryButton.setTitleColor(ModuTheme.onAccent, for: .normal)
        retryButton.backgroundColor = ModuTheme.accent
        retryButton.layer.cornerRadius = 12
        retryButton.contentEdgeInsets = UIEdgeInsets(top: 12, left: 30, bottom: 12, right: 30)
        retryButton.addTarget(self, action: #selector(retryTapped), for: .touchUpInside)

        let settingsButton = UIButton(type: .system)
        settingsButton.setTitle("服务器设置", for: .normal)
        settingsButton.titleLabel?.font = UIFont.preferredFont(forTextStyle: .body)
        settingsButton.setTitleColor(ModuTheme.accent, for: .normal)
        settingsButton.addTarget(self, action: #selector(settingsTapped), for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [
            icon, title, errorDetailLabel, retryButton, settingsButton,
        ])
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 12
        errorView.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: errorView.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: errorView.centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: errorView.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: errorView.trailingAnchor, constant: -24),
            errorDetailLabel.widthAnchor.constraint(lessThanOrEqualToConstant: 460),
            retryButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 160),
        ])
    }

    private func configureBanner() {
        blockedBanner.translatesAutoresizingMaskIntoConstraints = false
        blockedBanner.backgroundColor = UIColor.black.withAlphaComponent(0.82)
        blockedBanner.textColor = .white
        blockedBanner.font = UIFont.preferredFont(forTextStyle: .footnote)
        blockedBanner.textAlignment = .center
        blockedBanner.numberOfLines = 0
        blockedBanner.layer.cornerRadius = 10
        blockedBanner.layer.masksToBounds = true
        blockedBanner.alpha = 0
        blockedBanner.isHidden = true
        blockedBanner.insets = UIEdgeInsets(top: 9, left: 13, bottom: 9, right: 13)
        view.addSubview(blockedBanner)
    }

    private func activateLayout() {
        NSLayoutConstraint.activate([
            navigationBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            navigationBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            navigationBar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),

            progressView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            progressView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            progressView.topAnchor.constraint(equalTo: navigationBar.bottomAnchor),
            progressView.heightAnchor.constraint(equalToConstant: 2),

            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.topAnchor.constraint(equalTo: progressView.bottomAnchor),
            webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),

            errorView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            errorView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            errorView.topAnchor.constraint(equalTo: progressView.bottomAnchor),
            errorView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),

            blockedBanner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            blockedBanner.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 16),
            blockedBanner.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -16),
            blockedBanner.bottomAnchor.constraint(equalTo: webView.bottomAnchor, constant: -16),
            blockedBanner.widthAnchor.constraint(lessThanOrEqualToConstant: 480),
        ])
    }

    private func observeProgress() {
        progressObservation = webView.observe(\.estimatedProgress, options: [.new]) { [weak self] webView, _ in
            guard let self else { return }
            self.progressView.progress = Float(webView.estimatedProgress)
            if webView.estimatedProgress >= 1 {
                self.progressView.isHidden = true
            }
        }
    }

    // MARK: - Loading

    private func loadInitialPage() {
        let url = initialDocumentID.flatMap { documentURL($0) } ?? rootURL()
        load(url)
    }

    private func load(_ url: URL) {
        lastRequestedURL = url
        errorView.isHidden = true
        progressView.isHidden = false
        progressView.progress = 0
        activityIndicator.startAnimating()
        var request = URLRequest(url: url)
        request.cachePolicy = .useProtocolCachePolicy
        request.timeoutInterval = 30
        webView.load(request)
    }

    private func rootURL() -> URL {
        guard let url = URL(string: server.absoluteString + "/") else {
            preconditionFailure("ServerOrigin invariant violated")
        }
        return url
    }

    private func documentURL(_ documentID: String) -> URL? {
        guard DeepLink.isDocumentID(documentID) else { return nil }
        return URL(string: server.absoluteString + "/?nativeOpen=" + UUID().uuidString + "#doc-" + documentID)
    }

    @objc private func reloadTapped() {
        if let url = webView.url, isInternal(url) {
            load(url)
        } else if let url = lastRequestedURL {
            load(url)
        } else {
            loadInitialPage()
        }
    }

    @objc private func retryTapped() {
        reloadTapped()
    }

    @objc private func settingsTapped() {
        onOpenSettings?()
    }

    // MARK: - Navigation policy

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        // Keep sandboxed HTML iframe navigation working: this policy applies
        // only to the main frame. The preview iframe has its own HTTP CSP.
        guard let targetFrame = navigationAction.targetFrame, targetFrame.isMainFrame else {
            decisionHandler(.allow)
            return
        }
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if url.absoluteString == "about:blank" {
            decisionHandler(.allow)
            return
        }
        if isInternal(url) {
            decisionHandler(.allow)
            return
        }
        decisionHandler(.cancel)
        handleExternalURL(url)
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        if url.absoluteString == "about:blank" {
            return nil
        }
        if isInternal(url) {
            webView.load(URLRequest(url: url))
        } else {
            handleExternalURL(url)
        }
        return nil
    }

    private func isInternal(_ url: URL) -> Bool {
        guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        parts.path = ""
        parts.query = nil
        parts.fragment = nil
        guard let raw = parts.string, let origin = try? ServerOrigin(validating: raw) else { return false }
        return origin == server
    }

    private func handleExternalURL(_ url: URL) {
        guard url.user == nil, url.password == nil else {
            showBlockedMessage("已阻止包含用户名或密码的链接")
            return
        }
        guard let scheme = url.scheme?.lowercased() else {
            showBlockedMessage("已阻止无效链接")
            return
        }
        switch scheme {
        case "https":
            openExternally(url)
        case "http":
            showBlockedMessage("已阻止不安全的 HTTP 链接")
        default:
            showBlockedMessage("已阻止不支持的链接协议：\(scheme)")
        }
    }

    private func openExternally(_ url: URL) {
        guard presentedViewController == nil else { return }
        let safari = SFSafariViewController(url: url)
        safari.delegate = self
        safari.dismissButtonStyle = .done
        safari.preferredBarTintColor = ModuTheme.paper
        safari.preferredControlTintColor = ModuTheme.accent
        present(safari, animated: true)
    }

    private func showBlockedMessage(_ message: String) {
        bannerHideWorkItem?.cancel()
        blockedBanner.text = message
        blockedBanner.isHidden = false
        UIView.animate(withDuration: 0.18) {
            self.blockedBanner.alpha = 1
        }
        let work = DispatchWorkItem { [weak self] in
            UIView.animate(withDuration: 0.2, animations: {
                self?.blockedBanner.alpha = 0
            }, completion: { _ in
                self?.blockedBanner.isHidden = true
            })
        }
        bannerHideWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.2, execute: work)
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        progressView.isHidden = false
        progressView.progress = 0
        errorView.isHidden = true
        activityIndicator.startAnimating()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        activityIndicator.stopAnimating()
        progressView.progress = 1
        progressView.isHidden = true
        errorView.isHidden = true
    }

    func webView(
        _ webView: WKWebView,
        didFail navigation: WKNavigation!,
        withError error: Error
    ) {
        handleNavigationFailure(error)
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        handleNavigationFailure(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        showError("网页进程已终止。你可以重试载入。")
    }

    private func handleNavigationFailure(_ error: Error) {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain, nsError.code == NSURLErrorCancelled {
            return
        }
        if nsError.domain == "WebKitErrorDomain", nsError.code == 102 || nsError.code == 101 {
            return
        }
        showError(nsError.localizedDescription)
    }

    private func showError(_ detail: String) {
        activityIndicator.stopAnimating()
        progressView.isHidden = true
        errorDetailLabel.text = detail
        errorView.isHidden = false
        view.bringSubviewToFront(errorView)
        view.bringSubviewToFront(blockedBanner)
    }
}

extension ReaderViewController: SFSafariViewControllerDelegate {}

private final class InsetLabel: UILabel {
    var insets = UIEdgeInsets.zero

    override func drawText(in rect: CGRect) {
        super.drawText(in: rect.inset(by: insets))
    }

    override var intrinsicContentSize: CGSize {
        let size = super.intrinsicContentSize
        return CGSize(
            width: size.width + insets.left + insets.right,
            height: size.height + insets.top + insets.bottom
        )
    }
}
