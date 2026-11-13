# 墨读云文档库 · 自部署说明

本目录是一个**独立**的 Node 服务，不复用 Electron、jsdom 或本地阅读服务。它只依赖 Node 内置模块，目标机不需要 `npm install`。下面的命令面向一台全新的 Ubuntu/Debian 主机，示例域名为 `md.example.com`，请整体替换成你自己的域名。

> 本仓库只准备可复现的构建产物与部署命令，**不会执行远程部署**。账户密码和同步令牌由部署者通过交互命令生成，不写入源码、环境文件或仓库。

## 1. 运行环境

- **Node.js 24 或更高版本**（`node --version` 应显示 `v24.x` 或更高；`package.json` 的 `engines.node` 为 `>=24`）。
- nginx（用于 TLS 终止和反向代理）。
- systemd。
- 一个可写的私密数据目录 `/var/lib/modu`，权限 `0700`，所有者 `modu`。
- 建议 1 GB 内存；示例 unit 把 Node 堆限制在 128 MB、进程内存限制在 256 MB。

Node 可以来自发行版仓库、NodeSource、nvm 或官方二进制。示例 unit 假定 Node 安装在 `/opt/modu-node/bin/node`；如果你的 `node` 在 `/usr/bin/node`，把 unit 里的 `ExecStart` 改成对应路径即可。

## 2. 生产布局

```
/opt/modu/releases/1.3.0/cloud/server.js   # 服务入口
/opt/modu/releases/1.3.0/cloud/manage.js   # 账户/令牌管理
/opt/modu/releases/1.3.0/cloud/public/     # 登录页、阅读 UI、PWA、vendor
/opt/modu/releases/1.3.0/deploy/           # systemd / nginx / env 示例
/opt/modu/current -> /opt/modu/releases/1.3.0
/var/lib/modu/                             # MODU_CLOUD_DATA（users.json + docs）
/etc/modu/cloud.env                        # 环境变量，root:modu 0640 或 0600
```

Node 只监听 `127.0.0.1:4680`。公网由 nginx 终止 TLS 后反代，不直接暴露 4680。

## 3. 在仓库中构建云服务包

在仓库根目录执行（Node 24+）：

```bash
node --version          # 应为 v24.x 或更高
npm run pack:cloud
```

产物：

```
dist/modu-cloud-1.3.0.tar.gz
dist/modu-cloud-1.3.0.tar.gz.sha256
```

校验并上传到服务器：

```bash
# macOS
shasum -a 256 -c dist/modu-cloud-1.3.0.tar.gz.sha256
# Linux
sha256sum -c dist/modu-cloud-1.3.0.tar.gz.sha256

scp dist/modu-cloud-1.3.0.tar.gz dist/modu-cloud-1.3.0.tar.gz.sha256 \
  user@server.example.com:/tmp/
```

包内顶层是 `cloud/`、`deploy/`、`LICENSE` 和 `THIRD_PARTY_NOTICES.md`。云服务不需要 `npm ci`，因为 `cloud/package.json` 没有第三方依赖。

## 4. 创建系统账户与数据目录

```bash
sudo adduser --system --group --home /var/lib/modu \
  --shell /usr/sbin/nologin modu
sudo install -d -o modu -g modu -m 0700 /var/lib/modu
sudo install -d -o root -g root -m 0755 /opt/modu/releases
```

## 5. 解包并切换 current

```bash
sudo mkdir -p /opt/modu/releases/1.3.0
sudo tar -xzf /tmp/modu-cloud-1.3.0.tar.gz -C /opt/modu/releases/1.3.0
sudo chown -R root:root /opt/modu/releases/1.3.0
sudo chmod -R go-w /opt/modu/releases/1.3.0
sudo ln -sfn /opt/modu/releases/1.3.0 /opt/modu/current
```

## 6. 配置环境文件

```bash
sudo install -d -o root -g modu -m 0750 /etc/modu
sudo install -o root -g modu -m 0640 \
  /opt/modu/current/deploy/modu-cloud.env.example \
  /etc/modu/cloud.env
sudoedit /etc/modu/cloud.env
```

至少修改：

```dotenv
MODU_PUBLIC_ORIGIN=https://md.example.com
MODU_CLOUD_DATA=/var/lib/modu
MODU_CLOUD_HOST=127.0.0.1
MODU_CLOUD_PORT=4680
MODU_TRUST_PROXY=1
MODU_COOKIE_SECURE=auto
```

**不要**把密码、同步令牌或任何私钥写进这个文件；账户由第 8 步的交互命令创建。

## 7. 安装 systemd 与 nginx

```bash
# systemd
sudo install -o root -g root -m 0644 \
  /opt/modu/current/deploy/modu-cloud.service \
  /etc/systemd/system/modu-cloud.service
sudo systemctl daemon-reload
sudo systemctl enable --now modu-cloud

# 先确认本机 Node 路径；示例 unit 使用 /opt/modu-node/bin/node
command -v node
sudo systemctl status modu-cloud --no-pager
```

如果 `node` 不在 `/opt/modu-node/bin/node`，修改 unit：

```bash
sudo systemctl edit modu-cloud
```

在 override 中设置实际的 `ExecStart`，然后：

```bash
sudo systemctl daemon-reload
sudo systemctl restart modu-cloud
```

TLS 证书先签发，再启用 nginx 的 443 配置。以 Let's Encrypt + certbot 为例（DNS 需先解析到本机，80 端口可用）：

```bash
sudo apt-get update
sudo apt-get install -y nginx certbot
sudo certbot certonly --standalone -d md.example.com
```

安装 nginx 站点：

```bash
sudo install -o root -g root -m 0644 \
  /opt/modu/current/deploy/nginx-mdc.conf.example \
  /etc/nginx/sites-available/modu-cloud
sudo ln -sfn /etc/nginx/sites-available/modu-cloud \
  /etc/nginx/sites-enabled/modu-cloud
```

把示例中的 `md.example.com` 和 `/etc/letsencrypt/live/md.example.com/...` 替换成实际域名与证书路径，然后：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

如果使用其他 CA 或已有证书，只改 `ssl_certificate` 和 `ssl_certificate_key` 两行。

## 8. 创建阅读账户与同步令牌

阅读登录和 Mac 同步令牌是两套独立凭据。同一账户的用户名/密码用于浏览器登录；同步令牌只给 Mac，不能用于网页登录。

```bash
sudo -u modu env MODU_CLOUD_DATA=/var/lib/modu \
  /opt/modu-node/bin/node /opt/modu/current/cloud/manage.js add-user alice
```

命令会提示输入至少 10 位密码，并**只显示一次**同步令牌。把令牌直接填进 Mac 墨读的“云端文库 → 修改配置”，不要写入 README、env、脚本或聊天记录。

其他管理命令：

```bash
sudo -u modu env MODU_CLOUD_DATA=/var/lib/modu \
  /opt/modu-node/bin/node /opt/modu/current/cloud/manage.js list-users

sudo -u modu env MODU_CLOUD_DATA=/var/lib/modu \
  /opt/modu-node/bin/node /opt/modu/current/cloud/manage.js rotate-token alice

sudo -u modu env MODU_CLOUD_DATA=/var/lib/modu \
  /opt/modu-node/bin/node /opt/modu/current/cloud/manage.js reset-password alice
```

`reset-password` 会递增内部 `authVersion`，使旧登录会话立即失效；同步令牌保持不变。`rotate-token` 只轮换同步令牌，旧令牌立即失效。

## 9. 验证

```bash
curl -fsS https://md.example.com/healthz
curl -sSI https://md.example.com/ | grep -iE 'strict-transport|content-security|x-frame'
```

预期 `healthz` 返回 `{"ok":true,"service":"modu-cloud",...}`。浏览器登录后，会话 Cookie 应为 `Secure; HttpOnly; SameSite=Strict`。应用同时校验 Origin、`Sec-Fetch-Site` 和 CSRF 头；公网只应通过 HTTPS。

## 10. Mac 端配置

1. 打开 Mac 墨读，顶栏点 **云端**。
2. 填 `https://md.example.com`（公网明文 HTTP 会被拒绝，只有 localhost 测试允许 HTTP）和第 8 步只显示一次的同步令牌。
3. 保存并测试连接；状态显示同步账号。
4. 打开一份 Markdown 或 HTML，点 **加入当前文稿**；或把文件拖进窗口，在弹出选择里点 **加入云端文库**。
5. 之后该文件变化会在约 1.2 秒 debounce 后上传；也可点 **手动同步**。移除列表项只停止本地同步，云端副本保留。

只有主动加入的文稿会同步。普通打开、最近阅读、拖入后选择“仅打开阅读”都不会上传。凭据保存在 `~/Library/Application Support/墨读/cloud-sync.json`（`0600`），不写入源码。

## 11. 备份与恢复

备份：

```bash
sudo install -d -o root -g root -m 0700 /var/backups/modu
sudo systemctl stop modu-cloud
sudo tar -czf /var/backups/modu/modu-data-$(date +%F).tar.gz -C /var/lib/modu .
sudo systemctl start modu-cloud
```

恢复时把归档解到 `/var/lib/modu`，保持 `modu:modu` `0700`。重点是 `users.json`（密码 hash、同步令牌 hash、authVersion）和 `docs/<userId>/`。恢复前先停服务，恢复后重启。

## 12. 升级与回滚

升级使用版本目录 + `current` 软链，不原地覆盖：

```bash
# 在构建机生成新包并上传后
sudo mkdir -p /opt/modu/releases/1.3.0
sudo tar -xzf /tmp/modu-cloud-1.3.0.tar.gz -C /opt/modu/releases/1.3.0
sudo chown -R root:root /opt/modu/releases/1.3.0
sudo chmod -R go-w /opt/modu/releases/1.3.0
sudo ln -sfn /opt/modu/releases/1.3.0 /opt/modu/current
sudo systemctl restart modu-cloud
```

回滚时把 `current` 指回上一个仍保留的 release 目录，再 `sudo systemctl restart modu-cloud`。升级和回滚都保留 `/var/lib/modu`；切换前先做第 11 步的本地备份。

## 13. 资源与安全边界

- `MemoryHigh=192M`、`MemoryMax=256M`、`NODE_OPTIONS=--max-old-space-size=128`。
- 文档单份最多 2 MB、每账户最多 500 份；上传请求限 3 MB。
- 服务端**不做** Markdown SSR，不加载 jsdom；浏览器端使用本地打包的 markdown-it + DOMPurify。
- 云端**不同步图片**：正文可用，图片位置显示明确占位，不会读取 Mac 上任意本地文件。
- 阅读登录限速 5 次/15 分钟；API 与上传有独立限速；Cookie 为 HttpOnly + SameSite=Strict，HTTPS 下加 Secure；写操作要求 CSRF。
- 数据目录与文档文件权限 0600/0700；不提供目录浏览、路径输入或删除接口。
- HTML 交互页在 iframe sandbox 与响应 CSP sandbox 中运行，只允许内联脚本/样式和内嵌图片；外部 CDN、相邻资源、网络请求、弹窗、表单提交和父页面访问不开放。刷新、切换或文档更新会重置页面内交互状态。
- 图片、在线编辑、全文搜索等不在本版范围。

第三方组件与许可见仓库根目录的 `THIRD_PARTY_NOTICES.md` 和 `LICENSE`。
