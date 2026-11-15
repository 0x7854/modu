import UIKit

final class SetupViewController: UIViewController, UITextFieldDelegate {
    enum Mode {
        case initial
        case settings(ServerOrigin)
    }

    var onSave: ((ServerOrigin) -> Void)?
    var onCancel: (() -> Void)?

    private let mode: Mode
    private let scrollView = UIScrollView()
    private let stack = UIStackView()
    private let field = UITextField()
    private let errorLabel = UILabel()
    private let saveButton = UIButton(type: .system)

    init(mode: Mode) {
        self.mode = mode
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = ModuTheme.paper
        configureNavigation()
        configureLayout()
        configureContent()

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(keyboardWillChangeFrame),
            name: UIResponder.keyboardWillChangeFrameNotification,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    private var isSettings: Bool {
        if case .settings = mode { return true }
        return false
    }

    private func configureNavigation() {
        guard isSettings else { return }
        navigationItem.title = "服务器设置"
        navigationItem.leftBarButtonItem = UIBarButtonItem(
            title: "取消",
            style: .plain,
            target: self,
            action: #selector(cancelTapped)
        )
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            title: "保存",
            style: .done,
            target: self,
            action: #selector(saveTapped)
        )
    }

    private func configureLayout() {
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.alwaysBounceVertical = true
        scrollView.keyboardDismissMode = .interactive
        view.addSubview(scrollView)

        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.axis = .vertical
        stack.alignment = .fill
        stack.spacing = 14
        scrollView.addSubview(stack)

        let width = stack.widthAnchor.constraint(
            equalTo: scrollView.frameLayoutGuide.widthAnchor,
            constant: -48
        )
        width.priority = .defaultHigh

        NSLayoutConstraint.activate([
            scrollView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),

            stack.centerXAnchor.constraint(equalTo: scrollView.frameLayoutGuide.centerXAnchor),
            stack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor, constant: 28),
            stack.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor, constant: -28),
            stack.widthAnchor.constraint(lessThanOrEqualToConstant: 560),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: scrollView.frameLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: scrollView.frameLayoutGuide.trailingAnchor, constant: -24),
            width,
        ])
    }

    private func configureContent() {
        let seal = UILabel()
        seal.text = "墨"
        seal.textAlignment = .center
        seal.textColor = ModuTheme.onAccent
        seal.backgroundColor = ModuTheme.accent
        seal.font = UIFont(name: "Songti SC", size: 30) ?? .systemFont(ofSize: 30, weight: .semibold)
        seal.layer.cornerRadius = 14
        seal.layer.masksToBounds = true
        seal.translatesAutoresizingMaskIntoConstraints = false
        seal.widthAnchor.constraint(equalToConstant: 58).isActive = true
        seal.heightAnchor.constraint(equalToConstant: 58).isActive = true

        let sealRow = UIStackView(arrangedSubviews: [seal])
        sealRow.axis = .horizontal
        sealRow.alignment = .leading
        stack.addArrangedSubview(sealRow)

        let eyebrow = UILabel()
        eyebrow.text = "PRIVATE READER"
        eyebrow.font = UIFont.preferredFont(forTextStyle: .caption1)
        eyebrow.textColor = ModuTheme.muted
        eyebrow.setContentHuggingPriority(.required, for: .vertical)
        stack.addArrangedSubview(eyebrow)

        let title = UILabel()
        title.text = isSettings ? "更换服务器" : "连接你的墨读服务器"
        title.font = UIFontMetrics(forTextStyle: .largeTitle).scaledFont(
            for: .systemFont(ofSize: 30, weight: .bold)
        )
        title.textColor = ModuTheme.ink
        title.numberOfLines = 0
        title.adjustsFontForContentSizeCategory = true
        stack.addArrangedSubview(title)

        let intro = UILabel()
        intro.text = isSettings
            ? "保存新服务器后会重新载入网页。原服务器上的网页登录不会被发送到新服务器；待打开的文稿链接会被清除。"
            : "只连接你自己的墨读 HTTPS 服务。应用不内置服务器地址，登录在网页内完成。"
        intro.font = UIFont.preferredFont(forTextStyle: .body)
        intro.textColor = ModuTheme.muted
        intro.numberOfLines = 0
        intro.adjustsFontForContentSizeCategory = true
        stack.addArrangedSubview(intro)

        stack.setCustomSpacing(24, after: intro)

        let fieldLabel = UILabel()
        fieldLabel.text = "HTTPS 服务器 origin"
        fieldLabel.font = UIFont.preferredFont(forTextStyle: .headline)
        fieldLabel.textColor = ModuTheme.ink
        stack.addArrangedSubview(fieldLabel)

        field.translatesAutoresizingMaskIntoConstraints = false
        field.borderStyle = .none
        field.backgroundColor = ModuTheme.field
        field.layer.cornerRadius = 12
        field.layer.masksToBounds = true
        field.textColor = ModuTheme.ink
        field.tintColor = ModuTheme.accent
        field.font = UIFont.preferredFont(forTextStyle: .body)
        field.adjustsFontForContentSizeCategory = true
        field.placeholder = "https://主机名或域名"
        field.textContentType = .URL
        field.keyboardType = .URL
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.spellCheckingType = .no
        field.returnKeyType = .go
        field.clearButtonMode = .whileEditing
        field.delegate = self
        field.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 14, height: 1))
        field.leftViewMode = .always
        field.rightView = UIView(frame: CGRect(x: 0, y: 0, width: 8, height: 1))
        field.rightViewMode = .always
        field.heightAnchor.constraint(greaterThanOrEqualToConstant: 50).isActive = true
        stack.addArrangedSubview(field)

        if case .settings(let origin) = mode {
            field.text = origin.absoluteString
        }

        let hint = UILabel()
        hint.text = "只填 origin，例如 https://主机:8443。不支持 http、路径、查询参数、片段或内嵌用户名密码。"
        hint.font = UIFont.preferredFont(forTextStyle: .footnote)
        hint.textColor = ModuTheme.muted
        hint.numberOfLines = 0
        hint.adjustsFontForContentSizeCategory = true
        stack.addArrangedSubview(hint)

        errorLabel.font = UIFont.preferredFont(forTextStyle: .footnote)
        errorLabel.textColor = ModuTheme.danger
        errorLabel.numberOfLines = 0
        errorLabel.isHidden = true
        stack.addArrangedSubview(errorLabel)

        var buttonConfiguration = UIButton.Configuration.filled()
        buttonConfiguration.title = isSettings ? "保存服务器" : "保存并连接"
        buttonConfiguration.baseBackgroundColor = ModuTheme.accent
        buttonConfiguration.baseForegroundColor = ModuTheme.onAccent
        buttonConfiguration.cornerStyle = .large
        buttonConfiguration.contentInsets = NSDirectionalEdgeInsets(
            top: 14, leading: 18, bottom: 14, trailing: 18
        )
        saveButton.configuration = buttonConfiguration
        saveButton.titleLabel?.adjustsFontForContentSizeCategory = true
        saveButton.addTarget(self, action: #selector(saveTapped), for: .touchUpInside)
        saveButton.isHidden = isSettings
        stack.addArrangedSubview(saveButton)

        let footer = UILabel()
        footer.text = isSettings
            ? "更改服务器只更新本机设置。要退出旧服务器，请在旧服务器的网页内退出登录。"
            : "应用不保存网页密码，没有 JavaScript 桥，也不处理快捷指令令牌。自定义链接只接受 32 位小写十六进制文稿 ID。"
        footer.font = UIFont.preferredFont(forTextStyle: .footnote)
        footer.textColor = ModuTheme.muted
        footer.numberOfLines = 0
        footer.adjustsFontForContentSizeCategory = true
        stack.addArrangedSubview(footer)
    }

    @objc private func saveTapped() {
        view.endEditing(true)
        let raw = field.text ?? ""
        do {
            let origin = try ServerOrigin.parseUserInput(raw)
            showError(nil)
            onSave?(origin)
        } catch let error as ServerOriginError {
            showError(error.userMessage)
        } catch {
            showError("服务器地址格式不正确。")
        }
    }

    @objc private func cancelTapped() {
        view.endEditing(true)
        onCancel?()
    }

    private func showError(_ message: String?) {
        errorLabel.text = message
        errorLabel.isHidden = message == nil
        if let message {
            UIAccessibility.post(notification: .announcement, argument: message)
        }
    }

    @objc private func keyboardWillChangeFrame(_ notification: Notification) {
        guard let endFrame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else {
            return
        }
        let converted = view.convert(endFrame, from: nil)
        let overlap = max(0, view.bounds.maxY - converted.minY)
        scrollView.contentInset.bottom = overlap
        scrollView.verticalScrollIndicatorInsets.bottom = overlap
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        saveTapped()
        return true
    }
}
