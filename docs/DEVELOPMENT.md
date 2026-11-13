# 开发说明

## 环境

- Node.js 24+、npm。
- 桌面启动和 Mac 打包在 macOS 上进行；图标生成调用 Swift 与系统图形工具，需要安装 Xcode Command Line Tools。
- 浏览器界面测试使用 Playwright；首次运行先安装浏览器。

```bash
npm ci
npm start
```

## 结构

| 目录 | 用途 |
| --- | --- |
| `electron/` | Mac 应用窗口、文件打开、同步和受限 IPC |
| `lib/`、`server.js` | 本地文件读取、Markdown 渲染及实时更新 |
| `public/` | 本地阅读界面 |
| `cloud/` | 独立云端服务、账号和文档存储、PWA |
| `deploy/` | systemd、nginx、环境变量示例 |
| `scripts/` | 图标生成、Mac 应用与云服务打包 |
| `test/` | 服务、同步、交互与回归测试 |
| `docs/examples/`、`examples/` | 虚构 Markdown 和 HTML 示例 |

## 验证

基础检查：

```bash
npm test
```

文件夹接口和同步检查：

```bash
node --test --test-concurrency=1 test/library-store.test.js test/library-api.test.js test/library-clients.test.js
```

浏览器界面检查：

```bash
npx playwright install chromium webkit
node --test --test-concurrency=1 test/cloud-folder-drag.test.js test/library-ui.test.js test/fluid-drawer.test.js test/edge-navigation.test.js
```

浏览器不可用时，有些界面测试会跳过。跳过不等于验证通过。自动化触屏事件也不能替代真实 iPad / iPhone 验证。

## 构建

```bash
npm run pack
npm run test:packaged
npm run pack:cloud
```

Mac 构建仅生成 Apple Silicon 版本，未接入 Apple Developer ID 公证。云端压缩包只包含服务代码、公开页面和部署模板，不含账户或数据目录。

默认应用输出为 `dist/墨读.app`，云端包为 `dist/modu-cloud-1.3.0.tar.gz`，临时构建文件在 `.build/`。`MODU_WORKSPACE_ROOT` 只接受仓库内目录。不要把用户配置、私人文档、服务器数据或本机测试截图放进发布包。

## 修改边界

本地 Markdown 阅读不依赖云端；文件夹分类与文档正文分开保存。分类请求带版本号，遇到其他设备并发修改时应提示刷新，不能静默覆盖。

HTML 使用受限 iframe 执行页面脚本；不要为了兼容某个页面直接取消隔离，或向页面开放文件系统、Electron IPC、同步令牌。

## 提交问题与改进

问题描述请包含：设备与系统、操作步骤、预期行为、实际行为。使用虚构文档复现，截图前遮住账号和私人内容。

修改后说明运行了哪些检查，以及哪些设备或情况尚未验证。涉及数据存储、认证和同步时补上对应失败路径测试。
