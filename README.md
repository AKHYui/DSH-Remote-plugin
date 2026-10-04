# dsh-remote-bridge
**简体中文** | [English](README.en.md)

DeepSeek Harness 桌面插件：把运行 DSH 的那台机器通过一条**出站** WSS 挂到你的中继上，手机端 App 由此可以远程列会话、发消息、处理审批与提问。零运行时依赖。

## 它是什么

- 装在**运行 DSH 的宿主机**上（不是中继服务器），由 DSH 加载为插件。
- 链路：手机 App → 中继 → 本插件 → DSH。插件是**主动拨号方**。
- 提供的能力：列会话、跟随实时事件流、发送消息（文本 / 内嵌图片 / 上传文件换 `receiptId`）、切换模型、中止回合、代答审批与 `ask_user_question` 提问。
- 前置条件：一个已部署的中继（[DSH-Remote-backend](https://github.com/AKHYui/DSH-Remote-backend)）以及它签发的连接器令牌。
- 安全边界：**持有手机令牌的人等价于能在这台机器上执行命令**，中继与手机令牌请按同一敏感级别对待。

## 架构

```
手机 App ──HTTPS/WSS──▶ 中继 ◀──出站 WSS── dsh-remote-bridge ──▶ DSH Host（会话、工具、模型）
```

插件只发起出站连接（`wss://<中继主机>:<端口>/api/v1/attach`），宿主机**不需要**在防火墙上开放任何入站端口，家用 NAT 或没有公网 IP 也能用。
中继只做鉴权、限流、转发与审计，不解析也不落盘任何会话内容。

## 环境要求

| 项 | 要求 |
|---|---|
| 操作系统 | Linux（本文命令可直接照抄；Windows / macOS 的差异在每节末尾以 `> Windows:` 备注） |
| DSH | 提供 `dsh plugin` 命令的版本；本插件在 profile `desktop` 上验证 |
| Node.js | `>=22.19`（`package.json` 的 `engines`）。插件跑在 DSH 自带运行时内，通常不必单独安装 Node；只有 `tools/simulate.mjs` 需要你自己有 Node |
| 中继 | 已部署且可达，能给出 `wss://…/api/v1/attach` 地址 |
| 凭据 | 中继签发的 `connectorToken`（一机一令牌，可单独吊销） |
| 可选 | 中继证书由自建 CA 签发时，需要该 CA 的 PEM 文件（配 `tlsCaFile`） |

## 部署

四步：签发令牌 → 安装插件 → 写配置 → 重启 DSH。

### 1. 在中继上签发连接器令牌

```bash
cd /opt/dsh-backend
sudo -u dshrelay env DSH_RELAY_DB=/opt/dsh-backend/var/relay.db \
  .venv/bin/python -m app.cli issue-connector --name home-pc
```

- `dshrelay` 是后端仓库默认的服务账号，换成你自己的服务用户即可；`DSH_RELAY_DB` 指向中继的 SQLite。
- 输出里的 `token` 就是 `connectorToken`；`--name` 的值（上例 `home-pc`）通常也用作 `deviceId`。
- **令牌只显示一次**，请立即存入密码管理器；泄漏后用 `revoke-connector` 吊销并重新签发。

### 2. 安装插件

```bash
sudo mkdir -p /opt/dsh-remote-bridge
sudo chown "$USER" /opt/dsh-remote-bridge
git clone https://github.com/AKHYui/DSH-Remote-plugin.git /opt/dsh-remote-bridge
dsh plugin --profile desktop add link:/opt/dsh-remote-bridge
```

- `link:` 后面是**仓库根目录**（`package.json` 所在处），不是它内部的子目录。
- 安装后，包自带的 `cordis.patch.yml` 会把一条 `remote-bridge` 条目插入该 profile：此时配置还是空的，插件不会启动，下一步用同一个 `id` 覆盖它。

> Windows: 目录可放任意位置（例 `D:\dsh-remote-bridge`），`link:` 用该目录即可。

### 3. 写配置

向 `~/.dsh/profiles/desktop/cordis.patch.yml` 追加（键名与 `src/config.js` 的 `DEFAULT_CONFIG` 一致）：

```yaml
- id: remote-bridge
  name: dsh-remote-bridge
  config:
    serverUrl: 'wss://relay.example.com:58443/api/v1/attach'
    connectorToken: '<connector token>'
    deviceId: 'home-pc'
    deviceName: 'home-pc'
    tlsCaFile: '/etc/dsh-remote-bridge/ca.crt'
    autoConnect: true
    reconnect: true
    heartbeatMs: 30000
    approvalTimeoutMs: 90000
    allowedSessions: []
    hideArchivedSessions: true
    allowInsecure: false
    logLevel: info
    debugLog: '/tmp/dsh-remote-bridge.log'
```

- `serverUrl` 必须是中继的 attach 端点；写成 `https://` 或 `http://` 会被自动改写为 `wss://` / `ws://`。
- `tlsCaFile` 指向签发中继证书的 CA（PEM），放在 DSH 进程可读的位置；插件在拨号前会把它并入进程信任库。
- `connectorToken` 是密钥：也可以不写进文件，改用环境变量 `DSH_REMOTE_BRIDGE_TOKEN`（环境变量优先于此项）。
- 任何键都可以用对应的 `DSH_REMOTE_BRIDGE_*` 环境变量覆盖，见下方「配置」。
- `debugLog` 指向一个 DSH 进程**可写**的文件，插件才会写诊断日志；写入失败会被静默忽略。

> Windows: 路径写 Windows 形式，例如 `tlsCaFile: 'D:\dsh-remote-bridge\certs\ca.crt'`（单引号内反斜杠是字面量）。

### 4. 重启 DSH

按你启动 DSH 的方式重启它：`systemctl --user restart` 你的 DSH 服务、在桌面会话里退出后重新打开、或前台运行时 `Ctrl-C` 再重跑。

> **源码改动（`src/`）必须重启 DSH 才生效**：宿主不做 HMR，Node 的 ESM 模块缓存也不会因为停用 / 启用 / 重装插件而清除。
> **而 profile patch 里的配置是活的**：改完几秒内插件就会被重新创建并读到新值，不必重启。

### 5. 确认已连上

```bash
tail -n 5 /tmp/dsh-remote-bridge.log    # debugLog 打开时才有这个文件
```

再看 DSH 自己的输出（控制台 / 日志），应出现 `connected to wss://… as device "home-pc" (relay protocol v1)`。

| 日志行 | 含义 |
|---|---|
| `bridge init deviceId=home-pc debugLog=/tmp/dsh-remote-bridge.log` | 插件每次被创建都写一行；用来判断配置改动有没有生效 |
| `desktop withdraw: {"gateway":true,…,"finishRemoteEvent":true,…}` | 启动自证：手机先作答时撤回桌面弹窗所需的宿主内部面可用。`finishRemoteEvent:false` 时撤回不生效，**其余功能不受影响** |
| `reconnecting in 1000ms (attempt 1)` | 链路未建立，按指数退避重试（1s 起、×2、上限 30s） |

### 不装进 DSH 也能验证

用桩上下文把**真实插件**挂到真实中继上，不需要 DSH：

```bash
cd /opt/dsh-remote-bridge
node tools/simulate.mjs --server wss://relay.example.com:58443/api/v1/attach \
  --token '<connector token>' --device-id dev-sim --ca /etc/dsh-remote-bridge/ca.crt
```

常用参数：`--ask` 三秒后发起一次模拟审批；`--events <ms>` 每 `<ms>` 毫秒合成一条会话事件（`0` 关闭，默认 5000）；`--seconds <n>` n 秒后退出；`--log <level>` 调整日志级别；`--no-demo-ops` 不装演示用的 Remote 处理器。完整列表：`node tools/simulate.mjs --help`。

## 配置

profile patch 的 `config:` 与同名环境变量可二选一或并用（**环境变量优先**）。

| 键 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `serverUrl` | `DSH_REMOTE_BRIDGE_SERVER_URL` | 空 | **必填**。中继 attach 地址，`wss://<主机>:<端口>/api/v1/attach` |
| `connectorToken` | `DSH_REMOTE_BRIDGE_TOKEN` | 空 | **必填**。中继签发的连接器令牌（密钥）。推荐用环境变量 |
| `deviceId` | `DSH_REMOTE_BRIDGE_DEVICE_ID` | 空 | **必填**。这台机器的稳定标识，手机用它寻址；同一中继上必须唯一 |
| `deviceName` | `DSH_REMOTE_BRIDGE_DEVICE_NAME` | `deviceId` | 展示名 |
| `autoConnect` | `DSH_REMOTE_BRIDGE_AUTO_CONNECT` | `true` | 加载后是否立即拨号；`false` 时插件已装载但不发任何流量 |
| `reconnect` | `DSH_REMOTE_BRIDGE_RECONNECT` | `true` | 断线后是否重连（指数退避：1s 起、×2、上限 30s、±20% 抖动） |
| `reconnectOnReplaced` | 无 | `false` | 被同 `deviceId` 的新连接接管（闭码 `4001`）后是否抢回 |
| `heartbeatMs` | `DSH_REMOTE_BRIDGE_HEARTBEAT_MS` | `30000` | 保活间隔；**最小 5000** |
| `approvalTimeoutMs` | `DSH_REMOTE_BRIDGE_APPROVAL_TIMEOUT_MS` | `90000` | 等手机作答的上限，超时后回落桌面应答器；**最小 1000** |
| `allowedSessions` | `DSH_REMOTE_BRIDGE_ALLOWED_SESSIONS` | `[]` | 会话白名单（数组，或逗号分隔字符串）。空 = 全部放行；同时作用于 op 目标与审批 / 提问的转发 |
| `hideArchivedSessions` | `DSH_REMOTE_BRIDGE_HIDE_ARCHIVED_SESSIONS` | `true` | 把已归档会话从 `session.list` 里剔掉；设 `false` 可重新列出 |
| `allowInsecure` | `DSH_REMOTE_BRIDGE_ALLOW_INSECURE` | `false` | 允许 `ws://`。**仅本地开发**：令牌会明文传输，启动时打印一条 WARNING |
| `tlsCaFile` | `DSH_REMOTE_BRIDGE_TLS_CA_FILE` | 空 | 签发中继证书的 CA（PEM 文件路径） |
| `logLevel` | `DSH_REMOTE_BRIDGE_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `silent` |
| `debugLog` | `DSH_REMOTE_BRIDGE_DEBUG_LOG` | 空（关） | 诊断日志文件路径；**默认关** |

布尔键接受 `1/true/yes/on` 与 `0/false/no/off`（大小写不敏感）；`allowedSessions` 接受数组或逗号分隔字符串；
`heartbeatMs`、`approvalTimeoutMs` 低于下限会被拒绝启动。

## 运维与排错

| 现象 | 处理 |
|---|---|
| DSH 输出 `not starting: N configuration problem(s) above` | 配置缺失或非法。三项必填（`serverUrl` / `connectorToken` / `deviceId`），且 `heartbeatMs >= 5000`、`approvalTimeoutMs >= 1000` |
| 手机上所有 op 都回 `op_not_supported` | 插件是旧版本 → 重启 DSH |
| 闭码 `4401`：`the connector token was rejected` | 令牌被吊销或从未有效 → 在中继上重新签发，更新配置（配置是活的，几秒生效） |
| 闭码 `4001`：`another DSH instance took over this device id` | 两台机器用了同一个 `deviceId` → 改成唯一值；确实要让先来的抢回才打开 `reconnectOnReplaced` |
| 闭码 `4400`：协议版本不一致 | 插件与中继的线协议版本不匹配 → 两端同时升级，不要靠放宽校验绕过 |
| 每 ~30 秒固定重连一次 | 中继把插件的 `ping` 当非法帧（旧中继只认单向心跳）→ 升级中继 |
| 设了 `tlsCaFile` 仍连不上 | 该 PEM 不是签发中继证书的 CA，或 DSH 进程读不到它。确认路径可读；退路是 `NODE_EXTRA_CA_CERTS=<PEM>` 并重启 DSH |
| 改了 `src/` 但行为没变 | 必须重启 DSH（见「部署」第 4 步） |
| `debugLog` 文件是空的 | 路径对 DSH 进程不可写，或 `debugLog` 没配；写入失败不会报错 |
| 手机上仍显示已归档会话 | `hideArchivedSessions` 为 `false`、插件是旧版本（重启 DSH），或手机上的任务列表尚未刷新（重新打开抽屉即会刷新） |
| 手机上一条会话都看不到 | `allowedSessions` 白名单里没有那些会话 id |
| 手机上不弹审批 / 提问 | 手机端需要能收到中继的实时事件，或在重新进入 App 时拉取待处理列表；`approvalTimeoutMs` 超时后请求会回落到桌面应答器 |

## 测试

```bash
cd /opt/dsh-remote-bridge
node --test                      # 149 个用例，8 个测试文件
node --test test/ops.test.js     # 单个文件
npm test                         # 等价（零依赖，无需 npm install）
```

## 仓库结构

| 路径 | 内容 |
|---|---|
| `src/index.js` | 插件入口：配置校验、启动与释放 |
| `src/bridge.js` | 把传输、op 表、事件扇出、审批与撤回装成一个可释放的整体 |
| `src/link.js` | 出站 WSS：拨号、`hello`、心跳、退避重连、运行时 CA 信任 |
| `src/protocol.js` | 协议常量：`PROTOCOL_VERSION`、帧编解码、**op 白名单**、topic、错误码、闭码 |
| `src/ops.js` | op → 宿主 Remote 的映射、参数包装、`allowedSessions` 与归档过滤 |
| `src/events.js` | 订阅管理与事件扇出（有界队列，慢连接不阻塞宿主） |
| `src/approvals.js` | 审批与提问的桥接：与桌面抢答、超时 / 取消 / 断链回落 |
| `src/desktop-withdraw.js` | 手机先答时结算桌面那条待答请求，使桌面弹窗自行消失 |
| `src/config.js` | 配置解析与校验（profile `config:` + `DSH_REMOTE_BRIDGE_*`） |
| `src/log.js`、`src/debug-log.js` | 分级控制台日志；可选的诊断文件日志 |
| `test/` | 8 个测试文件，149 个用例 |
| `tools/simulate.mjs` | 用桩上下文把真实插件挂到真实中继上（脱离 DSH 联调 / 验收） |
| `tools/fake-ctx.mjs` | 桩 `ctx` 与 WebSocket 替身，供测试与模拟器使用 |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | 线协议、帧类型与 op 契约 |
| `cordis.patch.yml` | 包自带的 patch 层：把插件条目插入 profile，配置由你的 profile patch 覆盖 |

## 相关仓库

- [DSH-Remote-plugin](https://github.com/AKHYui/DSH-Remote-plugin) —— 本仓库，DSH 桌面插件
- [DSH-Remote-backend](https://github.com/AKHYui/DSH-Remote-backend) —— 中继服务（FastAPI + SQLite）
- [DSH-Remote-app](https://github.com/AKHYui/DSH-Remote-app) —— 手机端 Flutter 客户端

## 许可

MIT，见 [LICENSE](LICENSE)。
