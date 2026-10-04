# dsh-remote-bridge（DeepSeek Harness 桌面插件）

> 三个仓库之一：**桌面插件（本仓库）** · [中继后端](https://github.com/AKHYui/DSH-Remote-backend) · [手机 App](https://github.com/AKHYui/DSH-Remote-app)

DeepSeek Harness（DSH）插件：把本机 harness 通过一条**出站** WSS 挂到你自建的中继上，
手机连同一个中继，于是人在外面也能列会话、看实时流、发消息、切模型、传附件，
并处理审批与提问。Node ESM，**零运行时依赖**（只用 Node 内置能力与全局 `WebSocket`）。

```
手机 App ──▶ 中继 ◀──出站 WSS── 插件(DSH)
```

两件与运维直接相关的事实：

1. **不开任何入站端口。** 插件永远是拨号方（dialer），所以家用 NAT / 无公网 IP 也能用。
   代价是这台机器必须能主动访问中继。
2. **持有手机令牌 == 这台机器的 shell。** 白名单里的 op 能发消息、能执行本机 agent 的命令，
   而这些命令跑在你这台桌面上。中继与手机侧必须当同等敏感的东西来对待。

审批与提问走 DSH 的 waterfall：**两端同时弹，谁先提交按谁的**；手机不作答就回落到桌面原生应答器，
桌面体验零回归。手机先答时插件会主动结算桌面那条 forwarded event，否则桌面的窗口会一直等着
一个不可能有答案的请求（见「排错」与 `src/desktop-withdraw.js`）。

---

## 安装

### 前置条件

| 项 | 要求 | 为什么 |
|---|---|---|
| Node | ≥ 22.19（`package.json` 的 `engines`） | 私有 CA 的运行时信任走 `node:tls` 的 `setDefaultCACertificates()` |
| DSH | 一版暴露 `typertGateway` 与 `session` Remote 命名空间的构建 | 插件声明 `inject = ['typertGateway']`；所有 op 都经它转发 |
| 中继 | 已部署、能签发**连接器令牌**，并提供 `…/api/v1/attach` | 插件是拨号方，需要地址与令牌 |

DSH 的 `typertGateway` 缺失时插件保持惰性（打印一行错误），不会让 DSH 起不来。

### 方式一：DSH 桌面版

设置 → 插件 → 从本地目录安装，指向本目录（含 `package.json` 的那一层），然后重启 DSH。

### 方式二：dsh CLI

```powershell
dsh plugin --profile desktop add link:<绝对路径>
```

例如：

```powershell
dsh plugin --profile desktop add link:D:\dsh-remote-bridge\plugin
```

### 装完之后写入了什么

| 位置 | 内容 |
|---|---|
| `~/.dsh/profiles/<profile>/package.json` | `dependencies` 里多一条 `"dsh-remote-bridge": "link:<绝对路径>"`，`dsh.profile.bundles` 里多一个 `dsh-remote-bridge` |
| `~/.dsh/profiles/<profile>/cordis.patch.yml` | 一个 `- id: remote-bridge` / `name: dsh-remote-bridge` 的块（由 `cordis.patch.yml` 的 `insert` 合并进来），`config:` 下是上一节那张表的键 |

`link:` 只登记路径，插件源码仍在你的 checkout 里——改源码不需要重新安装，但**需要重启 DSH**
（原因见「调试」）。

### 怎么确认它真的加载了

插件用 `[dsh-remote-bridge]` 作前缀往主机日志写。启动成功的第一行是：

```
[dsh-remote-bridge] starting (protocol v1) deviceId=<deviceId> server=<serverUrl> [<key><-env|profile> …]
```

方括号里是每个键的来源（`env` / `profile`），全用默认值时是 `[defaults]`。中继可达时，
再往后会出现：

```
[dsh-remote-bridge] connected to <serverUrl> as device "<deviceId>" (relay protocol v1)
```

此时手机端**应当能看到这台设备在线**。看到 `starting` 但没有 `connected` → 网络或令牌问题
（见「排错」）。完全没有 `starting` → 插件没被加载，或配置校验失败（那会有 `not starting: …`）。

### 卸载

```powershell
dsh plugin --profile <profile> remove dsh-remote-bridge
```

然后手动删掉 `cordis.patch.yml` 里那个 `remote-bridge` 块（CLI 只动 profile 的 `package.json`
与 `node_modules`，不会替你清理 patch 层里的配置）。

---

## 配置

来源有两处，**环境变量优先于 profile patch**（`src/config.js`）：profile 的 `config:` 块，
或同名的 `DSH_REMOTE_BRIDGE_*` 环境变量。键名、默认值、环境变量一一对应：

| 键 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `serverUrl` | `DSH_REMOTE_BRIDGE_SERVER_URL` | `''` | **必填**。中继 attach 地址，如 `wss://relay.example.com/api/v1/attach` |
| `connectorToken` | `DSH_REMOTE_BRIDGE_TOKEN` | `''` | **必填**。中继签发的连接器令牌（密钥） |
| `deviceId` | `DSH_REMOTE_BRIDGE_DEVICE_ID` | `''` | **必填**。稳定标识，如 `home-pc`；手机用它寻址这台机器 |
| `deviceName` | `DSH_REMOTE_BRIDGE_DEVICE_NAME` | `deviceId` | 展示名 |
| `autoConnect` | `DSH_REMOTE_BRIDGE_AUTO_CONNECT` | `true` | DSH 加载插件后是否立即连接 |
| `reconnect` | `DSH_REMOTE_BRIDGE_RECONNECT` | `true` | 断线后是否重连（指数退避 1s 起、×2、上限 30s、±20% 抖动） |
| `reconnectOnReplaced` | —（无环境变量） | `false` | 被同 `deviceId` 的新连接接管（闭码 `4001`）后是否抢回 |
| `heartbeatMs` | `DSH_REMOTE_BRIDGE_HEARTBEAT_MS` | `30000` | 插件侧保活间隔；**最小 5000** |
| `approvalTimeoutMs` | `DSH_REMOTE_BRIDGE_APPROVAL_TIMEOUT_MS` | `90000` | 等手机作答的上限，超时后回落桌面；**最小 1000** |
| `allowedSessions` | `DSH_REMOTE_BRIDGE_ALLOWED_SESSIONS` | `[]` | 会话白名单（数组，或逗号分隔的字符串）。空 = 全部放行 |
| `hideArchivedSessions` | `DSH_REMOTE_BRIDGE_HIDE_ARCHIVED_SESSIONS` | `true` | 从 `session.list` 里剔掉**已归档**会话：归档集合只住在宿主的 Workspace 注册表里，唯一的出口是 `workspace.follow` 的**第一帧**，插件读那一帧就关流（不缓存，所以归档立刻生效）；读不到就**原样返回**，绝不会因此让手机丢掉整个列表。设 `false` 可以把它们列回来——profile 配置是**活**的，改完几秒生效，不必重启 DSH |
| `allowInsecure` | `DSH_REMOTE_BRIDGE_ALLOW_INSECURE` | `false` | 允许 `ws://`。**仅本地开发**：令牌会明文传输，会打印一条 WARNING |
| `tlsCaFile` | `DSH_REMOTE_BRIDGE_TLS_CA_FILE` | `''` | PEM 文件路径：给中继证书签名的 CA（自建内部 CA 时需要） |
| `logLevel` | `DSH_REMOTE_BRIDGE_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`（另有 `silent`） |
| `debugLog` | `DSH_REMOTE_BRIDGE_DEBUG_LOG` | `''`（关） | 诊断日志文件路径，见「调试」。**默认关** |

布尔键接受 `1/true/yes/on` 与 `0/false/no/off`（大小写不敏感）；`allowedSessions` 接受数组或
逗号分隔字符串；`heartbeatMs` 与 `approvalTimeoutMs` 低于下限会被拒绝。

两条规范化规则（`src/config.js`）：

- `https://` 与 `http://` 会被改写成 `wss://` 与 `ws://`（查询串保留）。
- 非 `wss://` 且没开 `allowInsecure` 时**拒绝启动**；开了也只降级为一条 WARNING。

**三个必填键（`serverUrl` / `connectorToken` / `deviceId`）缺任意一个，插件不启动**：
它只逐条打印问题、最后一行是 `not starting: N configuration problem(s)`，然后返回一个空 disposer。
**不会**影响 DSH 的任何其他功能。

一个实现细节，写运维脚本前值得知道：`reconnectOnReplaced` 是四个布尔键里唯一**没有**对应环境变量的
一个（其余三个都有）。`autoConnect: false` 会**真的**只加载不拨号：不开任何 socket、不做任何重试，
但 waterfall 与 op 表都已就绪——相当于一个随时能用一个配置改动打开的开关。

密钥建议只放环境变量：profile patch 是会被你打开、复制、贴给别人看的文件，而
`connectorToken` 是「等价于这台机器 shell」的凭据。另外那三个键以外的任何解析错误同样会让插件
停住，日志里会把键名和实际收到的值都写出来。

---

## 调试

### 单元测试

```powershell
node --test
```

当前 **136 个用例，全绿**（8 个文件：`test/config|protocol|link|ops|events|approvals|desktop-withdraw|bridge.test.js`）。
覆盖的是插件的每一层行为，尤其是**只有接上真宿主才会暴露的那几类**：

| 面 | 有专门用例的行为 |
|---|---|
| 配置 | 必填缺失逐条上报、布尔/整数/列表解析、`https→wss` 规范化、明文拒绝、数值下限 |
| 协议 | 全部中继帧的解码与拒绝、未知字段容忍、token 查询串、闭码表、退避与抖动上限 |
| 链路 | 握手与 `hello`、心跳、静默强制重连、`4001`/`4400`/`4401` 的终止性、普通掉线的退避、CA 先装后拨号 |
| op | op 表与白名单一致、**按真实网关的参数名校验每个 op**、错误归一化、`allowedSessions` 过滤 |
| 事件 | 订阅与扇出、`sessionIds` 过滤、队列上限丢弃、**每个事件只绑一次** |
| 审批 | 两个 waterfall 的 `prepend`、抢答、超时/取消/链路断开一律回落、一次请求只出一帧 ask |
| 撤回 | 对象身份匹配、宽松匹配的歧义保护、迟到的 pending 记录重试、拿不到内部面时是 no-op 而不是崩溃 |
| 桥接 | 端到端帧流程、流式 open/chunk/end、`cancel`、慢 op 不阻塞后续帧 |

`node --test` 不需要 DSH、不需要中继、不需要网络。

### 模拟器：用桩上下文驱动真实插件

```powershell
node tools/simulate.mjs --server ws://127.0.0.1:8787/api/v1/attach `
     --token <tok> --device-id dev-sim --events 300 [--ask [--ask-wait]]
```

它跑的是**真实的** `createBridge()`，只把 DSH 换成一个桩上下文（`tools/fake-ctx.mjs`
提供 `typertGateway` / `on` / `effect`）。所以不装 DSH 也能对着真实（或本机）中继验证整条链路。

| 选项 | 含义 |
|---|---|
| `--server <url>` | attach 地址（必填，或用 `DSH_REMOTE_BRIDGE_SERVER_URL`） |
| `--token <tok>` | 连接器令牌（必填，或用 `DSH_REMOTE_BRIDGE_TOKEN`） |
| `--device-id <id>` | 设备 id，默认 `dev-sim` |
| `--events <ms>` | 每 `<ms>` **毫秒**合成一条 `session/event`（**间隔，不是条数**；默认 5000，`0` = 不发） |
| `--ask` | 3 秒后发起一次模拟审批请求，用来验手机审批这条路 |
| `--ask-wait` | 只与 `--ask` 连用：让桩 `next()` 像真实宿主那样把请求挂成 **pending forwarded event** |
| `--approval-timeout-ms <n>` | 等手机作答的上限（默认 90000） |
| `--seconds <n>` | n 秒后打印 `bridge.status()` 并退出（默认一直跑，Ctrl+C 停止） |
| `--log <level>` | `debug` / `info` / `warn` / `error`（默认 `info`） |
| `--ca <file>` | 中继证书的 CA（PEM）：中继用内部 CA 时必填 |
| `--no-demo-ops` | 不装演示用的 Remote 处理器（此时 op 会以 `not found` 失败） |

默认装了一套演示 Remote（`session.list` / `page` / `prompt` / `cancel` / `create` /
`modelCatalog` / `fileUploads.upload` 与流式 `session.follow`），所以中继侧可以真的调这些 op
并拿到看起来合理的回答——这是唯一一种「不碰 DSH 也能端到端跑通」的方式。

`--ask` 与 `--ask-wait` 的区别正是这条修复能不能被验到的关键：

- **只有 `--ask`**：桩 `next()` 立刻返回 `'unavailable'`。那不是一次「桌面作答」，插件不会把它
  当作竞争结果，手机仍有机会赢。
- **`--ask` + `--ask-wait`**：桩 `next()` 注册一条 `pendingRemoteEvents` 记录并返回一个**永不
  resolve 的 Promise**，完全复刻真实宿主转发器的行为——桌面那侧在等一个不会有人回答的请求。
  此时从手机作答，就能在没有 DSH 的情况下验出「手机先答 → 插件把桌面那条 forwarded event
  结算掉」这条路径。

### 诊断日志（`debugLog`）：唯一能看到「处理器为什么不作为」的地方

打包后的 DSH **没有日志目录**，所以插件里的 `log.debug()` 等于扔进虚空。这就造成一整类故障
不可观测：**一个从未被调用的 waterfall 处理器，和一个被调用了但决定不作为的处理器，看起来
一模一样**。把 `debugLog` 指向一个文件即可打开：

```yaml
debugLog: 'D:\dsh-remote-bridge\plugin-debug.log'
```

打开后每行形如 `<ISO 时间> <内容>`。值得直接 grep 的行：

| 日志行 | 含义 |
|---|---|
| `seen approval/request session=… tool=…` | 审批 waterfall 接到了请求（提问是 `seen user-questions/request`） |
| `seen agent/created agent=…` | 看到一个 agent 生命周期（每个只应出现**一次**） |
| `skip approval/request: ready=false allowed=…` | 处理器跑了但主动不作为：链路没 ready，或该会话不在 `allowedSessions` 里 |
| `send approval.ask ask for session=…` | 已经把 ask 推给手机（提问是 `send question.ask`） |
| `race: won by phone` | 手机先提交，插件采用手机的结果 |
| `race: won by nobody (desktop fallback)` | 两边都没有可用结果，最终把桌面的原始值当作兜底 |
| `race: won by desktop` | 桌面先提交；**此时不会撤回桌面弹窗**（它本来就该在） |
| `desktop prompt withdrawn (approval/request)` | 手机赢下竞争后，插件成功把那台桌面的转发请求结算掉（提问时括号里是 `user-questions/request`） |
| `desktop prompt withdrawn after a retry (…)` | 同上，但那条 pending 记录是稍后才出现的（手机太快，转发器还没登记） |
| `desktop prompts cannot be withdrawn: …` | 这版 DSH 的内部面变了，撤回**不会生效** |
| `desktop withdraw: {"gateway":true,"pendingTable":0,"finishRemoteEvent":true,"cancelRemoteEvent":true}` | **启动自证**：撤回所依赖的宿主内部面还在（见下） |
| `bridge init deviceId=… debugLog=…` | 每一次插件被（重新）创建都会写一行，用来判断配置改动有没有生效 |

**`desktop withdraw:` 那行是启动自证**，在 `start(): attaching waterfalls` 之后写出：

```
desktop withdraw: {"gateway":true,"pendingTable":0,"finishRemoteEvent":true,"cancelRemoteEvent":true}
```

- `gateway:true` → 拿得到网关服务；
- `pendingTable` 是数字（哪怕是 `0`）→ 找得到那张 forwarded-event 表；
- `finishRemoteEvent:true` → 撤回这条路可用。

三者任一为 `false` / `null` 就说明这版 DSH 的内部面变了：撤回不会生效，桌面弹窗会留着。
这是**唯一的**「不制造一次真实审批就能知道」的判断方式，重启后先看这一行。

两个使用上的要点：

- **这份日志默认关着。** 平时不用打开；排错时才指向一个文件。
- **改 `cordis.patch.yml` 是活配置，几秒内生效**（会重新创建插件，日志里出现新的 `bridge init`）；
  **改 `src/` 源码必须重启 DSH**。宿主不监听插件文件，Node 的 ESM 缓存也不会因为停用/启用/
  重装而被清掉——所以「我改了代码怎么没变」几乎总是这个原因。

### 跟真实 harness 核对线形状

权威的 Remote 描述符（参数名、参数类型）编译在打包后的 `app.asar` 里。`app.asar` 是一个**文件**，
`rg`、`Get-Content`、`read` 都看不见它内部的路径，只有 Electron 的 Node（带 asar shim）能读。

| 方式 | 位置 | 何时用 |
|---|---|---|
| 权威描述符核对 | relay/ops 仓库里的 `scripts/inspect_descriptors.mjs --check` | 需要「就是这台机器上这份 DSH」的答案时 |
| 单元测试里的镜像表 | 本仓库 `test/ops.test.js` 的 `REMOTE_DESCRIPTORS` | 不需要 DSH、不需要网络，CI 里跑 |

为什么这事值得单独一节：**真实网关会按 Remote 声明的参数名逐个校验**，而桩上下文不校验。
所以一个写错的参数名可以通过全部本地测试、只在真实宿主上失败——历史上正是如此
（`session.list` 声明的是 `_request`，其余 session 方法声明 `request`）。`src/protocol.js` 的
`OP_TABLE` 里 `param` / `wires` 就是这份描述符的镜像，两处必须一起改。

### 跨语言端到端

跨语言 e2e 套件 `backend/tools/e2e_smoke.py` 属于中继仓库，但它**驱动的是本插件的模拟器**
（`tools/simulate.mjs`）。所以它需要一个插件 checkout：从拆分后的仓库跑时，用
`DSH_PLUGIN_DIR` 指向本目录（它默认会先找中继仓库同级的 `plugin/`，找不到就报错并提示设这个变量）。

---

## 它做了什么

### 方向表

| 方向 | 内容 |
|---|---|
| 中继 → 插件 | `welcome`、`bye`、`req`（白名单 op）、`cancel`、`sub` / `unsub`、`approval`、`ping` |
| 插件 → 中继 | `hello`、`res`、`stream`（仅 `session.follow`：`open` / `chunk` / `end` / `error`）、`evt`、`pong` |
| DSH → 插件 | `session/event`、`agent/status`、`api-session/{added,removed,activity}`、`agent/{created,disposed}` |
| 插件 → DSH | 两个 waterfall：`approval/request`、`user-questions/request`（`{ prepend: true }`）；手机先答时结算桌面的 forwarded event |

事件 topic、帧字段、错误码、闭码语义的完整定义见 [`docs/PROTOCOL.md`](docs/PROTOCOL.md)。

### 10 个白名单 op

除 `harness.info` 由插件本地回答外，全部映射到 `typertGateway` 的一个**确定**的
`namespace.method`。中继无法要求任意 namespace/method，插件也不转发白名单之外的任何东西。

| op | DSH Remote | wire 参数名 | 参数形状 | 流式 |
|---|---|---|---|---|
| `harness.info` | —（本地） | — | `{}` | 否 |
| `session.list` | `session.list` | `_request` | `{cursor?}` | 否 || `session.page` | `session.page` | `request` | `{address, throughSeq, beforeSeq?, maxMessages?, turnWindow?}` | 否 |
| `session.follow` | `session.follow` | `request` | `{address, assistantStream?, …}` | **是** |
| `session.prompt` | `session.prompt` | `request` | `{requestId, sessionId, mode, content[], clientTimeZone?}` | 否 |
| `session.cancel` | `session.cancel` | `request` | `{sessionId}` | 否 |
| `session.create` | `session.create` | `request` | `{workspaceId?, cwd?, agentPreset?}` | 否 |
| `session.selectModel` | `session.selectModel` | `request` | `{sessionId, provider, model, reasoningEffort?}` | 否 |
| `userQuestions.answer` | `userQuestions.answer` | `agentId`、`callId`、`answer` | 三个独立 wire 参数，`answer` 是 `AskUserQuestionAnswer`（**不叫** `request`） | 否 |
| `fileUploads.upload` | `fileUploads.upload` | `agentId`、`request` | `request` = `{data, name?}`，`data` 是**原始字节的 base64** | 否 |
| `model.catalog` | `session.modelCatalog` | —（无参数） | `{}` | 否 |

两个只属于本桥的约定，不在上表的 wire 形状里：

- `session.list` 额外接受 `{includeArchived: true}`：**只看不删**——把归档会话也列出来，同时仍然在
  `archivedSessionIds` 里报告归档集合，于是一次调用就能回答「有哪些」和「藏了哪些」。这个键在包装成
  `_request` 之前会被**丢掉**（宿主的 `session.list` 只声明 `{cursor?}` 且校验严格），App 从不发它。
- `session.list` 的返回里可能多一个 `archivedSessionIds`（被剔掉的 id），手机忽略未知字段。

`session.list` 会**顺带读一次** `workspace.follow`（不是转发的 op，是本桥自己为了归档集合打开的流，
只读第一帧就关）。它因此出现在「每个 op 都按真实描述符校验参数名」的那个用例里。


调用方传的是**请求对象本身**，包装成 Remote 声明的参数名由插件做（多 wire 的 op 传按
wire 名键控的映射，多余字段会被丢掉）。切换模型是**独立调用**：`session.prompt` 没有 model 参数。
图片不需要上传——`session.prompt` 的 `content[]` 直接接受内联 `{type:'image', …}`；
其它文件先 `fileUploads.upload` 换 `receiptId`，再发 `{type:'file', receiptId}`。

三条硬性约束：

- **手机只能到达上面这 10 个 op。** 其余一律以 `op_not_supported` 拒绝。
- **审批与提问永不自动批准。** 手机与桌面同时被问，谁先提交按谁的。
- **任何异常路径都交回桌面。** 超时、`cancel`、链路断开、处理器内部异常——全部调用 `next()`，
  把决定权还给 DSH 自己的应答器。手机不作答时桌面行为与没装这个插件时一致。
  `allowedSessions` 同时过滤 op 目标与审批/提问的转发。

---

## 模块

| 文件 | 职责 |
|---|---|
| `src/index.js` | Cordis 适配层：`name` / `inject` / `apply`，配置校验、启动与释放 |
| `src/config.js` | 配置解析与校验（profile `config:` + `DSH_REMOTE_BRIDGE_*`），默认值与来源表 |
| `src/protocol.js` | 协议常量：`PROTOCOL_VERSION`、帧编解码、**op 表**、topic、错误码、闭码、退避 |
| `src/link.js` | 出站 WSS 的传输面：拨号、`hello`、心跳、退避重连、终止性闭码、运行时 CA 信任 |
| `src/ops.js` | op → `typertGateway` 的映射、参数包装、`allowedSessions` 检查、错误归一化 |
| `src/events.js` | 订阅管理与事件扇出（有界队列 + 丢弃计数），绑定 DSH 事件面 |
| `src/approvals.js` | 两个 waterfall 的桥接：`prepend` 抢占、与桌面抢答、超时/取消/断链回落 |
| `src/desktop-withdraw.js` | 手机先答时结算桌面那条 forwarded event（宿主内部面，全部特性探测） |
| `src/debug-log.js` | 可选的诊断日志文件（`debugLog`），默认关闭 |
| `src/log.js` | 带 `[dsh-remote-bridge]` 前缀的分级控制台日志；测试用的内存 logger |
| `src/bridge.js` | 把传输、op 表、事件扇出、审批与撤回装成一个可释放的整体；帧分发 |
| `tools/simulate.mjs` | 用桩上下文把真实插件挂到真实中继上，脱离 DSH 联调/验收 |
| `tools/fake-ctx.mjs` | 桩 `ctx`（`typertGateway` / `on` / `effect`，可选共享注册表的 root）、WHATWG-WebSocket 替身、确定性定时器 |

`createBridge()` 只依赖 `ctx.typertGateway` 与 `ctx.on`，所以插件在 DSH 里、在模拟器里、在测试里
走的是**同一份代码路径**——没有「测试专用分支」。

---

## 排错

| 现象 | 原因与处理 |
|---|---|
| 日志里 `not starting: N configuration problem(s)` | 上面那 N 条必填/校验问题还没解决。逐条按提示补（三个必填键、URL 合法性、数值下限） |
| `the connector token was rejected`（闭码 `4401`） | 令牌被撤销或从未有效。在中继上重新签发。写进 profile patch 的话几秒内自动生效（活配置）；走环境变量的话要重启 DSH |
| `another DSH instance took over this device id`（闭码 `4001`） | 两台机器用了同一个 `deviceId`。改成唯一值；确实要让先来的抢回时才打开 `reconnectOnReplaced`（默认关，避免重连风暴） |
| `the relay speaks a different protocol version`（闭码 `4400`） | 插件与中继的线协议版本不匹配。两边同时升级；不要在版本不一致时靠放宽校验绕过 |
| 手机看不到任何事件 | 中继侧没有活跃订阅——**手机必须发 `sub`**（订阅是按手机连接建立的）。也可能链路根本没 ready，先确认日志里有 `connected to …` |
| `connected to …` 之后每隔一段时间重复出现 | 链路不稳。先看下一条；若中继把插件的 `ping` 当非法帧（旧中继只认单向心跳），会表现为**固定周期**重连 |
| op 返回 `remote_error` 且消息里有 `not found` | 这版 DSH 没有暴露该 Remote 命名空间（通常是 `session`）。确认这个 DSH 构建提供 `typertGateway`；插件会额外警告一次「does not expose the expected "session" Remote namespace」 |
| op 返回 `bad_args` 且提到缺少某个参数名 | 网关按参数名校验，而这份 `OP_TABLE` 与这台 DSH 的描述符不一致。用权威描述符核对（见「调试」），不要靠试名字 |
| 手机作答后桌面弹窗**留在那里** | 看诊断日志：有 `race: won by phone` 但**没有** `desktop prompt withdrawn (…)` → 撤回没找到那条 forwarded event（可能那版宿主把请求存在别处）。日志里直接说 `desktop prompts cannot be withdrawn` → 这版 DSH 的内部面变了。两种情况都按 `src/desktop-withdraw.js` 顶部注释里那几个源码位置重新定位，**不要猜** |
| 启动自证里 `finishRemoteEvent:false` 或 `pendingTable:null` | 同上：这台 DSH 的内部面形状已变，撤回**不会生效**（弹窗会留着）。其余功能不受影响 |
| 桌面的弹窗在手机作答后仍然留着，但日志里 `desktop prompt withdrawn` 出现过 | 那说明结算找错了对象。按上面两条处理 |
| 手机收到的事件都是两份 | **不应该发生**。历史上是因为在插件自己的 `ctx` 与 `ctx.root` 上各绑了一次；Cordis 只有一张全局 hook 表，两次绑定都会触发。手机端按 `seq` 去重只是掩盖了它。事件只允许绑一次 |
| `tlsCaFile` 设了但仍连不上 | 中继证书的签发 CA 没被信任。确认文件是可读的 PEM；Node 没有 `tls.setDefaultCACertificates()` 时插件会提示改用 `NODE_EXTRA_CA_CERTS` + 重启 |
| 改了源码没生效 | **源码变更必须重启 DSH**（宿主不监听插件文件，ESM 缓存也不会因启用/停用/重装而清掉）。只有 `cordis.patch.yml` 的配置是活配置 |

---

## 开发约定

- **零运行时依赖。** 只用 Node 内置能力与全局 `WebSocket`。为了一个配置校验库把 `link:` 安装
  搞复杂不值得；插件也不导出 Schemastery `Config`。
- **每个处理器都是防御性的。** DSH 事件与 waterfall 处理器里的任何异常都必须被就地吞掉并记一行
  ——它否则会逃进 harness 的事件追加路径，把宿主自己的流程弄坏。桩环境里有一条专门的用例。
- **事件只绑一次。** Cordis 只维护一张全局 hook 表（`EventsService` 只建在 root 上，`extend()`
  是原型继承），所以 `ctx`、`ctx.root`、`agent.ctx` 上的绑定会**全部触发**。在插件自己的 `ctx`
  上绑一次即可；两处绑定 = 每个事件推两遍。
- **waterfall 要 `prepend`。** waterfall 只把 `next` 交给第一个监听器，内置的远端转发器先注册
  且（桌面作答后）不调 `next()`，不抢到第一位就永远轮不到本插件。
- **认得的就格式化，认不出的原样透传。** 事件与 op 的结果都遵循这个原则：中继不解释
  `session/event` 的数据，插件也不改写它不理解的字段——一个悄悄改坏内容的东西比不处理更糟。
- **失败不比不做更糟。** 撤回桌面弹窗靠的是宿主未公开的内部面，所以每一步都特性探测；
  拿不到就退回「弹窗留着」并写一行日志，绝不因此让审批/提问本身失败。

---

## 许可

MIT。
