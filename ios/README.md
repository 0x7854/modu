# 墨读 iOS / iPadOS 原生外壳

这是放在 `ios/` 下的轻量原生外壳：UIKit + WKWebView，支持 iPhone 与 iPad、iOS 16 及以上。它只负责连接**你自己输入的 HTTPS 墨读服务器**，网页登录、文档列表和阅读体验仍由现有云文库网页提供。

本迭代不包含分享扩展、文件导入、离线正文、推送、JavaScript 原生桥或服务令牌处理。

## 当前验证状态（如实说明）

- 当前开发机只有 CommandLineTools，**没有完整 Xcode，也没有 iOS SDK / 模拟器**。
- 因此本次**没有执行 `xcodebuild`，没有构建模拟器，没有在 iPad/iPhone 上签名或安装**。
- 本机完成 plist / 工程语法检查、Swift 语法解析和 Foundation 路由测试；完整 iOS SDK 构建交由 GitHub macOS CI 检查，结果以当前提交的 workflow 为准。
- 仓库维护者用 GitHub macOS runner 做最终 Swift 编译与 iOS SDK 构建验证是合适的，但这不等于已在真机安装。

## 直接打开

用完整版 Xcode 打开：

```text
ios/Modu.xcodeproj
```

共享 scheme 名为 **Modu**，target 也是 **Modu**。工程是手写的、自包含的，没有 SwiftPM、CocoaPods、Carthage、脚本构建阶段或外部工具依赖。

## 环境前提

1. 一台安装完整 **Xcode** 的 macOS（只装 CommandLineTools 不够）。
2. Xcode 中安装可用的 **iOS 16+ SDK / Simulator**。
3. 一个 Apple ID 可用于 Xcode **Personal Team** 免费签名。无需付费开发者计划。
4. iPhone/iPad 上需要信任电脑；iOS 16 及以上还需要在“设置 → 隐私与安全性 → 开发者模式”开启 Developer Mode 并重启设备。

## 使用免费 Personal Team 安装

1. 打开 Xcode → Settings → Accounts，添加 Apple ID。
2. 选中项目中的 **Modu** target → Signing & Capabilities。
3. 勾选 **Automatically manage signing**。
4. 在 **Team** 中选择你的 Personal Team。工程默认 **Team 为空**，这是有意留空，避免写入任何个人团队标识。
5. Bundle Identifier 默认是通用值：

   ```text
   org.modu.reader.dev
   ```

   如果提示已被占用或注册失败，在 target 的 Signing & Capabilities 中追加一个唯一后缀，例如 `org.modu.reader.dev.local`。不要写入真实姓名、个人域名或团队 ID。
6. 连接设备，选择该设备为运行目标，按 Run（⌘R）。
7. 首次安装后如被阻止，到设备“设置 → 通用 → VPN 与设备管理”信任对应开发者证书；再回到桌面启动 Modu。

### 免费签名的真实限制

- 免费 Personal Team 的 provisioning profile 通常 **7 天过期**。过期后 App 无法启动，需要重新用 Xcode Run 安装。
- 免费账号通常有设备上自签 App 数量限制（常见为 3 个），且不支持推送、App Store 发布等能力。
- 到期提醒、重新签名和每周安装是免费方案的一部分，不是这个工程能绕过的限制。
- 模拟器构建不需要设备签名；真机安装必须选择你自己的 Team。

当前仓库没有记录任何 Team ID、证书、设备 UDID、账号、密码或私有服务地址。

## 首次配置服务器

App 不内置生产服务器域名。第一次启动会显示原生设置页：

1. 只输入 **HTTPS origin**，例如 `https://主机:8443` 这种形式，不要带路径、查询参数、片段、用户名或密码。
2. 只支持 `https://`。应用没有 ATS 明文例外；自签名证书也不会被绕过，请使用设备信任的 HTTPS 证书。
3. 保存到 `UserDefaults`（键为 `modu.server.origin`）。
4. 之后在 WKWebView 的网页登录页输入账号密码。**原生层不接触用户名、密码、Cookie 内容或任何令牌。**

WKWebView 使用默认的持久化 `WKWebsiteDataStore`，因此登录 Cookie 和网页 localStorage 会在 App 重启后保留。退出登录请在网页内操作。

## 自定义链接与待打开文稿

注册的 URL scheme：

```text
modu-reader://open?server=<urlencoded HTTPS origin>&document=<32 位小写十六进制>
```

其中 `server` 建议对 `https://...` 做 URL 编码（仅含合法 origin 字符时也接受原值），`document` 必须严格匹配：

```text
^[a-f0-9]{32}$
```

现有网页契约已检查：`cloud/public/cloud.js` 从 `location.hash` 读取 `#doc-<id>`，只接受 32 位小写十六进制；登录页会保留 URL，登录后 bootstrap 会按该 hash 打开目标文档。因此本 App 只把文稿 ID 拼成：

```text
https://你的服务器/?nativeOpen=<随机值>#doc-<id>
```

随机参数确保热启动时重新载入，而不是只改 URL 片段。并交给网页，不调用私有 API，不注入 JavaScript，也不处理导入令牌。

行为：

- **冷启动**：`UIScene` 的 connection options 会取到 URL；已配置且同服务器时直接载入目标 hash。
- **热启动**：`scene(_:openURLContexts:)` 转发给根控制器，重新载入目标 hash。
- **未配置服务器**：不会静默信任链接。会显示可见确认框，列出链接请求的服务器和文稿 ID，只有点“确认并打开”才保存服务器；取消则不连接。
- **链接服务器与已配置服务器不一致**：可见地拒绝，显示当前服务器与链接要求，不自动切换。
- **无效链接 / 伪造 ID / 非法 origin**：可见提示并拒绝，不发请求。
- **更改服务器**：清除原生待打开文稿，重新载入新服务器的网页登录；不会把旧服务器的登录状态发往新服务器。旧服务器在 WKWebView 中留下的 Cookie 仍只属于旧 host，若需要彻底退出，切回旧服务器在网页内退出登录。
- 登录后目标文稿仍保留：因为目标通过 URL hash 进入网页，云文库的登录流会保留并消费该 hash。

配套快捷指令可在 Mac 上生成并签名：

```sh
python3 scripts/build-shortcut.py --native --sign
```

生成 `.build/shortcuts/Open-in-Modu-App.shortcut`。先安装原生 App，再将该文件通过 AirDrop 或“文件”发送至 iPad 并添加；填入服务网址和现有仅导入凭证。系统分享时选择“用墨读 App 打开”。它上传成功后会打开原生入口。不要覆盖仍在使用的网页快捷指令；未安装 App 时该链接无法打开。

在模拟器中测试（需要完整 Xcode 和已启动的模拟器；当前机器做不到）：

```sh
xcrun simctl openurl booted 'modu-reader://open?server=https%3A%2F%2F你的主机&document=0123456789abcdef0123456789abcdef'
```

真机上可由 Shortcut 或任意能打开 URL 的调试方式触发。

## 导航与安全边界

`ReaderViewController` 的 WKWebView 策略：

- **主框架同 origin**：留在 WKWebView 内，包括同 origin 的路径、hash 和 API。
- **外部 HTTPS 主框架**：取消 WebView 导航，改用 `SFSafariViewController` 打开，不把 WKWebView 的 Cookie 或登录态交给外部页面。
- **HTTP、`mailto:`、`tel:`、自定义 scheme 等**：主框架一律阻止并给出原生提示。
- **iframe / 子框架**：策略只检查主框架，子框架导航直接放行，避免破坏网页内 `sandbox="allow-scripts"` 的 HTML 预览 iframe。
- **带用户名/密码的 URL**：阻止。
- **新窗口 / `target="_blank"`**：同 origin 回到当前 WebView；外部 HTTPS 交给 SFSafariViewController；不安全的 scheme 阻止。
- **无原生桥**：没有 `WKScriptMessageHandler`，没有任意 `evaluateJavaScript`，不读取网页输入。
- **无令牌**：不读取、不保存、不转发快捷指令的导入令牌；只使用 URL 中的 32 位文稿 ID。
- **无跨 origin 认证串用**：所有外部页面都在 Safari 视图控制器中打开，不与受信任服务器共享 WKWebView 会话。

保留的 WebView 能力：持久化登录 Cookie、网页 localStorage、网页主题、旋转、安全区域、登录表单键盘。工具栏提供原生“重新载入”“服务器设置”，加载时显示进度与活动指示；导航失败显示原生错误面板、重试按钮和设置入口。

## URL 路由与回归测试

核心校验全部在 Foundation-only 的：

```text
ios/Modu/LinkRouter.swift
```

包括 `ServerOrigin`、`DeepLink` 和严格错误类型；不 import UIKit / WebKit。

执行无 Xcode 依赖的 Swift 回归测试：

```sh
./ios/Scripts/test-link-router.sh
```

脚本用 `swiftc` 直接编译 `LinkRouter.swift` 与 `Tests/LinkRouterTests.swift`，不依赖 XCTest、Xcode 工程或 iOS SDK。为避免受限沙箱阻挡系统临时目录，脚本把临时文件和 module cache 放到仓库内 `.build/ios-link-router-tests/`（`.build/` 已被 `.gitignore` 忽略）。

覆盖的重点：

- 合法 origin：大小写归一、默认 443 端口移除、IPv4、IPv6、punycode、localhost。
- 恶意/非法 origin：`http`、用户信息、路径、查询、片段、反斜杠、百分号编码混淆、`@` 主机混淆、非法端口、空主机、非 ASCII 主机、超长/畸形 IPv6。
- 合法深链接：URL 编码 server、scheme/host 大小写、`#doc` 文档 ID、IPv6 server。
- 恶意/非法深链接：错误 scheme/host、路径、端口、片段、重复参数、未知参数、缺失参数、空值、大写或非十六进制 ID、31/33 位 ID、换行/空格/畸形百分号、HTTP server、带路径/凭据的 server。
- 已配置服务器与链接 server 的等价匹配及异服务器拒绝。

测试**不访问网络**，不读取任何服务器的真实地址或凭据。

## 本次实际完成的检查

```text
plutil -lint ios/Modu/Info.plist                          OK
plutil -lint ios/Modu.xcodeproj/project.pbxproj           OK
```

`Contents.json` 是 asset catalog 的 JSON（不是 plist）；本机 `plutil` 不接受 JSON。Foundation 路由测试和 Swift 语法解析由维护者在本机执行；完整 iOS SDK 构建由 GitHub macOS CI 检查，真机未安装。

## 文件清单

```text
ios/
├── Modu.xcodeproj/
│   ├── project.pbxproj
│   ├── project.xcworkspace/contents.xcworkspacedata
│   └── xcshareddata/xcschemes/Modu.xcscheme
├── Modu/
│   ├── AppDelegate.swift
│   ├── SceneDelegate.swift
│   ├── RootViewController.swift
│   ├── ReaderViewController.swift
│   ├── SetupViewController.swift
│   ├── LinkRouter.swift
│   ├── Info.plist
│   └── Assets.xcassets/
│       ├── Contents.json
│       └── AppIcon.appiconset/
│           ├── AppIcon-1024.png
│           └── Contents.json
├── Tests/LinkRouterTests.swift
├── Scripts/test-link-router.sh
└── README.md
```

App 图标复用了仓库既有墨读图标管线的 1024px PNG，放入 asset catalog 的 `AppIcon`，没有新增外部图标依赖。Bundle、scheme、URL scheme 和通用 Team 空值都在工程中明确配置。

## 已知限制

- **当前机器不能构建模拟器，也没有在真实 iPad/iPhone 上完成构建、签名或安装。**
- 免费 Personal Team 的 7 天有效期需要每周重新 Run；这是 Apple 的限制。
- 没有分享扩展、文件导入扩展、后台同步、推送或离线正文。
- 不提供 App Store 发布支持；没有 privacy manifest、加密出口合规以外的上架材料或商店文案。
- 服务器必须提供 iOS 信任的 HTTPS 证书，并实现现有网页的登录和 `/#doc-<32hex>` 契约；自签名证书、HTTP、任意路径的反向代理前缀都不在此迭代的兼容范围内。
- `SFSafariViewController` 的 Cookie 与 App 内 WKWebView 相互独立；外部链接页面不会继承墨读登录态。
- 更改服务器不会主动删除旧 host 的 WKWebView 数据；如要清除旧登录，请切回旧服务器并在网页中退出。
- 工程名/scheme 固定为 `Modu`；如改 Bundle Identifier，不需要改 scheme。
