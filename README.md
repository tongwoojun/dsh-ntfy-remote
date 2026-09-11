# dsh-ntfy-remote

把**每个 DSH 会话桥接到一个 ntfy 话题**：任务完成、待审批、待提问推到手机，手机上的
回复直接注入正在运行的会话。手机端只是一个普通的 ntfy App，不需要公网入口、不需要
端口映射——插件主动向 ntfy 服务器建立长连接。

## 话题规则

**每个会话一个话题，出站与入站共用，直接用完整会话 id，不掺密钥**：

```
会话 session-81c90a63-c212-4a67-a7c4-1b84c1e1bb0a
  话题  dsh_session-81c90a63-c212-4a67-a7c4-1b84c1e1bb0a
        出站：插件把通知 POST 到它
        入站：插件也订阅它，手机在话题里打字即注入会话
```

长度：`dsh_`4 + 会话 id 44 = **48**，在 ntfy 的 64 上限内。

> **为什么没有密钥**：44 字符的会话 id 加上 `dsh_` 前缀再加一个 16 位密钥和分隔符就是
> **65 字符，已经超限**。所以话题名必须能从会话 id 直接推导。
> 安全后果见下面的[安全](#安全)一节。

单话题，而不是「出站话题 + `_response` 回复话题」两个：通知本身就落在会话话题里，
**点开通知就是该话题，直接打字即可回复**，不再依赖 `ntfy://` 深链接，因此 iOS 也能用。
代价是插件必然收到自己发出的通知，必须靠消息内容里的标记自我过滤，否则会「自己回自己」
形成无限回环（见下）。

- **出站**：一次 HTTP POST（`fetch`，不 fork curl）。
- **入站**：每个用到的服务器一条常驻 NDJSON 长连接
  （`GET /<话题>[,<话题>…]/json`，同一服务器上所有已开启会话的话题合并进同一条连接），
  服务器逐行推送。
- **自我过滤**（单话题下没有它就会无限回环）：
  1. 主防线：每条自己发布的消息都带 `dsh-ntfy-remote` 标签，按 tag 过滤，与时间无关；
  2. 次防线：发布响应里的 message id 记入 `ownIds`；
  3. 兜底：正文与最近推送过的正文（每会话保留 3 条）完全一致即判为回声。
  另外按 message id 去重（`processedIds`），避免重连补漏时重复处理同一条回复。
- 话题规则变化时，已有绑定会在重建索引时**自动按新规则重算**，不需要重新开启
  （旧绑定里遗留的 `responseTopic` 字段也会一并清掉）。

## 多服务器与会话绑定

- 服务器是**带名称的列表**（`{ id, name, url, token }`），可以加多个官方或自建实例。
- 会话在**首次开启**时选定一个服务器，**之后不可变更**；改绑返回 `server-immutable`。
- 唯一例外：绑定的服务器被删除后，绑定实际已失效，此时允许重新选择（界面标
  「服务器已失效，可重选」）。
- **删除保护**：仍有会话绑定的服务器不允许删除（返回 `server-in-use`），避免那些会话
  永久失去推送。
- **解绑退路**：绑定不可变是为了避免运行中改地址造成话题漂移，但服务器失联或地址填错时
  必须有一条明确的退路——否则会死锁（改绑被拒 → 想删服务器 → 删除又因存在绑定被拒）。
  因此**会话关闭状态下可以「解绑」**（状态页每行的「解绑」按钮，或
  `POST /session/unbind`），解绑后该会话可重新选择服务器。
- 每个用到的服务器各建一条订阅连接；话题集合或服务器配置变化时自动重连。

## 通知偏好：全局默认 + 逐会话覆盖

| 键 | 含义 |
|---|---|
| `notifyOnTurnEnd` | 回合正常结束时推送最终回复 |
| `notifyOnPending` | 待审批 / 待提问时推送高优先级通知，并接管作答 |
| `notifyOnError` | 回合以 error / max-tokens / blocked / interrupted 等异常结束时推送精简原因 |
| `phonePriority` | 该会话是否由手机接管审批与提问作答 |
| `relayTimeoutSec` | 等手机作答的秒数；超时回落 DSH 原生交互 |

`config.defaults.*` 是全局默认；`state.sessions[id].prefs.*` 只保存被单独改过的键。
取值一律走 `Bridge.pref(sessionId, key)`：**单会话覆盖优先，否则回落全局默认**。
`maxMessageLength` 只有全局值。用户自己在桌面点「停止」造成的取消
（`aborted: user / parent / disposed`）一律不推送，避免自己打扰自己。

## 界面

两处入口，内容与独立状态页一致：

1. **会话右上角**（`conversation.session.header.utilities`）：`● ntfy` 按钮，`order: -20`，
   排在「在本地打开」（open-in-app，`order: -10`）左边。样式复用框架的 `Button`
   primitive（`variant: outline`、`size: sm` = 28px 高 / 14px 胶囊圆角），与同排控件一致；
   primitives 不可用时退回自绘的同几何按钮。点开弹窗显示话题 key、链接、开关，以及
   **本会话通知偏好**（改过的项带蓝框，可一键「跟随全局默认」）。
2. **设置 → ntfy remote**（`settings.section`）：服务器增删改 + 会话表（话题、开关、
   逐会话偏好、解绑）+ 全局默认偏好。

客户端 bundle 改动后宿主会重新计算 rev 并分发新版本，**刷新页面即可**，不必重启 dsh web。
浏览器半边由 `node probe/client-check.mjs` 做桩冒烟测试（模块体执行、
导出、两个槽位注册、按钮排序与几何）。

## 安装

三种方式，任选其一；装完刷新页面（客户端 bundle 会自动换 rev），然后在 DSH 输入框里
敲 `/ntfy on`。前提：`pnpm` 在 PATH 上（`dsh plugin` 是它的转发器；缺失时会提示）。

### 1. DSH 插件：GitHub 直装（推荐）

```sh
dsh plugin --profile demo add github:tongwoojun/dsh-ntfy-remote
```

**不需要手改任何补丁文件。** `dsh plugin` 会在 profile 目录里跑 `pnpm add`，然后按
**安装后的状态**核对 `dsh.profile.bundles`：只要这个包声明了 `dsh.bundle.patch`
（本包的 `cordis.patch.yml` 就是），它就被自动追加进层栈：

```jsonc
// $DSH_HOME/profiles/demo/package.json
{
  "dependencies": { "dsh-ntfy-remote": "github:tongwoojun/dsh-ntfy-remote" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-ntfy-remote"] } }
}
```

生产环境建议**锁定 tag**，避免上游改动直接影响你：

```sh
dsh plugin --profile demo add github:tongwoojun/dsh-ntfy-remote#v1.0.0
```

升级 / 卸载：

```sh
dsh plugin --profile demo update dsh-ntfy-remote
dsh plugin --profile demo remove dsh-ntfy-remote   # 会自动从 bundles 里移除
```

> **profile 名换成你自己的**（`web`、`headless`……）。先建的 profile 用 `dsh plugin`
> 会自动初始化一个 base-backed profile。`web` 模板是 `patchReload: live`（改配置即时生效），
> 其它随附模板只在启动时应用补丁，需重启。

> 本包**没有构建步骤**（纯 ESM，客户端 bundle 是手写的），所以 git 安装不会触发 pnpm 的
> `prepare` 构建拦截，也不需要 `allowBuilds` 白名单。

### 2. npm

```sh
# 直接装进 profile（同样自动加入 bundles）
dsh plugin --profile demo add dsh-ntfy-remote

# 或作为普通依赖装进你自己的工程
npm i dsh-ntfy-remote
```

### 3. 本地路径（开发）

```sh
dsh plugin --profile demo add /绝对路径/dsh-ntfy-remote
```

pnpm 以 `link:` 方式链接，改完源码热重载即时生效（见下面的外壳说明）。

### 手动挂载（可选）

不想用 CLI 时，也可以直接往 profile 的补丁层插一条，按**包名**引用本包
（仓库自带 `cordis.patch.yml` 就是这么写的）：

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- insert:
    - id: dsh-ntfy-remote
      name: dsh-ntfy-remote
```

不装包、只想快速试一下，则写 `boot3.js` 的**绝对路径**：

```yaml
- insert:
    - id: dsh-ntfy-remote
      name: '/绝对路径/dsh-ntfy-remote/boot3.js'
```

补丁文件被 DSH 监视（profile 的 `patchReload: live`），**改动即时挂载，不需要重启
dsh web**。注意：只有增删条目这类**有效配置变化**才会触发重载，改注释不会。

### 为什么需要一个外壳（boot3.js）

1. **Node 会按 URL 缓存 ESM 模块**。实测：即使 `patchReload` 触发了重新挂载，`import`
   命中的仍是缓存里的旧代码——**连入口文件自身也一样**。所以入口文件名一旦挂上就不再
   改动（`boot.js` → `boot2.js` → `boot3.js` 每次都是这个原因），实现全部放在 `main.js`，
   由外壳用 `?v=<时间戳>` 动态加载，并把版本号通过 `import.meta.url` 的查询串**透传给
   整张模块图**。
2. **cordis 不调用 `apply` 的返回值作为清理函数**。实测：入口从补丁里移除后，返回的
   disposer 没有被执行，`fs.watch` 仍在后台跑。清理必须走 `ctx.effect()`。
3. **fiber 卸载后再往同一个 ctx 注册监听会抛错**。热重载必须先用 `ctx.effect` 拿到的
   disposer 清理旧实例。

外壳还维护一个进程内**世代号**：热重载会让同一进程里先后存在多个 Bridge 实例，只有
最新一代能订阅与推送，旧实例静默退场。

### 为什么运行时零 `@deepseek-ai/*` import

插件文件位于 DSH 源码仓库内，一旦 `import '@deepseek-ai/dsh-session'`，Node 会从仓库的
`node_modules` 解析到**源码版本**，而真正在运行的是全局安装的**构建产物**。两份实例并存
会让 branded 类型、`instanceof`、service key 出错。因此只用 `node:` 内置模块 + `ctx`
对象，DSH 的类型只写进 JSDoc。

### DSH 事件接线的两个坑

1. **`approval/request` 必须用 `{ prepend: true, global: true }` 注册。**
   `dsh-user-approval` 的分发是 `ctx.waterfall(scopeTarget(req.agent, ...), 'approval/request', ...)`，
   带**作用域过滤**；插件自己的 ctx 不在该 agent 的作用域链里，默认**完全收不到**事件。
   实测：会话日志里有 `approval/asked` / `approval/decided` 审计事件、网页端也答了，
   而插件的监听一次都没被调用。`global: true` 跳过该过滤。
   另外链上已存在 Web UI 的**终结型 answerer**（不调用 `next()`），所以还要 `prepend: true`
   让本插件先跑，未开启桥接时再 `next()` 交回，网页端行为不变。
2. **清理必须走 `ctx.effect()`**，见上。`ctx.on` 返回的 disposer 也要显式调用，否则热重载
   会让同名命令重复注册而抛错。

## 数据与日志

全部落在 `$DSH_HOME/dsh-ntfy-remote/`（默认 `~/.dsh`，可用环境变量 `DSH_HOME` 覆盖）：

| 文件 | 内容 |
|---|---|
| `config.json` | 服务器列表、`defaultServerId`、**全局默认偏好**（用户可改） |
| `state.json` | 已开启的会话、服务器绑定、话题、**逐会话偏好覆盖**、去重集合 |
| `plugin.log` | 插件日志（每行带 pid），排查挂载与推送问题的唯一可靠通道 |

两个 JSON 都用「临时文件 + rename」原子写入，`dsh web` 任意时刻被 Ctrl-C 也不会留下
半截 JSON；`state.json` 的写入合并 800ms 内的多次改动，避免每条 ntfy 消息都落盘。

## 命令

**DSH 输入框（`/ntfy`）**

| 命令 | 作用 |
|---|---|
| `/ntfy on` | 用默认服务器开启本会话桥接 |
| `/ntfy on <服务器名>` | 用指定服务器开启（**仅首次有效**，之后绑定不可变） |
| `/ntfy off` | 关闭桥接（保留服务器绑定与偏好覆盖） |
| `/ntfy key` | 只看话题 |
| `/ntfy status` | 绑定服务器、话题、偏好及其来源 |
| `/ntfy servers` | 列出服务器（★ 标默认） |
| `/ntfy test` | 发一条测试通知 |

**手机上（在话题里发文本）**

| 指令 | 作用 |
|---|---|
| `/stop` | 中止当前回合（`agent.cancel({kind:'user'})`） |
| `/status` / `/key` | 桥接开关、会话是否在内存、服务器、话题与订阅地址（两者输出相同） |
| `/help` | 帮助 |

其余文本一律作为用户消息注入会话。审批 / 提问待决时，自由文本会优先结算该会话**唯一**
的待决请求；有多个待决请求时不猜，按普通消息放行。

## HTTP 接口与状态页

浏览器打开 `http://127.0.0.1:<port>/dsh-ntfy-remote` 即可管理，不需要任何前端构建。
状态页里每个会话都给出**话题的 HTTP 链接**（新标签页打开 ntfy 网页版）和 `ntfy://` 手机
跳转链接（可选快捷方式，Android 专有），并可**逐个会话**调整通知偏好（改过的键会高亮，
可一键「跟随默认」）。同一组路由也是 Web UI 客户端（`lib/client.js`）的数据来源。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/dsh-ntfy-remote` | 状态页 |
| GET | `/dsh-ntfy-remote/status` | 状态 JSON（含生效偏好与「哪些键被覆盖」） |
| POST | `/dsh-ntfy-remote/toggle` | `{ sessionId, enabled, serverId? }` |
| POST | `/dsh-ntfy-remote/session/prefs` | `{ sessionId, key, value }`，`value: null` 恢复默认 |
| POST | `/dsh-ntfy-remote/session/unbind` | `{ sessionId }`，清除服务器绑定（仅关闭状态可用） |
| POST | `/dsh-ntfy-remote/server/add` | `{ name, url, token }` |
| POST | `/dsh-ntfy-remote/server/update` | `{ id, name?, url?, token? }`，`token` 不传即不改 |
| POST | `/dsh-ntfy-remote/server/delete` | `{ id }`，有绑定时 409；只剩一个服务器时也拒绝 |
| POST | `/dsh-ntfy-remote/config` | 全局默认偏好（含 `maxMessageLength`）/ `defaultServerId` |

## 安全

> **话题名可以从会话 id 直接推导出来。** 以前话题里含一个随机密钥，话题名本身就是一道
> 密码；现在没有这道密码了（44 字符的会话 id 加前缀再加密钥会超出 ntfy 的 64 字符上限）。
> 会话 id 不是机密——它出现在界面、日志、状态页、截图里。

具体风险：知道某个会话 id 的人可以往 `dsh_<会话id>` 发布消息，而插件会把非自己发布的
消息当作**用户指令**注入会话（`agent.followup`），等同于获得操作该 agent 的入口。插件
只能过滤「自己发的」消息（标签 + id + 正文回声），**无法分辨其余消息是不是你本人**。

因此：

- **必须依赖 ntfy 服务端的访问控制**：自建 ntfy 并为话题配置 ACL / 只允许你的账号读写。
- 用公共 ntfy.sh 时，至少注册账号并使用 access token + 保留话题前缀，让陌生账号无法发布。
- ntfy 的消息 JSON **不含发布者身份**，插件无法分辨「是不是你本人」，只能靠服务端控制。
- 会话 id 也不要随意外传（截图、日志、分享状态页）。
- 注入的消息仍走 DSH 的 sandbox / 权限策略，不会绕过权限；但「手机指令当用户指令」本身
  就是权限入口。

## 已知限制

- **同一 `DSH_HOME` 下不要同时跑多个 dsh 实例**：它们会读到同一份 `state.json` 并各自
  订阅同一话题，同一条回复可能被处理两次。重启（旧进程退出、新进程接管）没有问题。
- **不再依赖 `ntfy://` 深链接**：通知就发在会话话题里，点开即落在该话题，iOS 也能直接
  回复。状态页与 Web UI 里仍保留 `ntfy://` 跳转链接（仅 Android 有效），只是快捷方式。
- **插件会收到自己发出的通知**：靠 `dsh-ntfy-remote` 标签过滤；若服务端剥掉 tag，则由
  `ownIds` 与「正文与最近推送一致」两道兜底拦截。
- **审批 / 提问中转会接管原生交互**：`phonePriority` 为真时，开启桥接的会话在手机上等待
  作答，DSH Web 界面不再显示该提问；超时（`relayTimeoutSec`）后回落原生链。
- **冷会话无法注入**：会话不在内存中时（例如只存在于磁盘），插件只能提示先打开它。
  目前不自动 `resume`，以免与 Web UI 争抢会话写所有权。
- **会话被删除时会自动断开桥接**：不清理的话会留下订阅该话题的僵尸连接，话题列表越攒
  越长，最终连订阅 URL 都会超长。判定删除的条件是**同时**满足「不在内存里」且「不在
  持久化列表里」——不能拿 `session/disposed` 当删除信号，用户只是关掉会话时 agent 同样
  会被销毁，会话本身还在磁盘上。因此：`session/disposed` 触发一次带防抖的即时核对，
  另有 120 秒定期扫描兜底；连续 3 次核对都找不到才清理绑定；**读不到持久化列表时不动
  任何绑定**（误删会让用户莫名其妙失去推送）。手机发来消息时若发现会话已不存在，也会
  立刻断开并回一条说明。
- 所有插件发出的通知都带 `dsh-ntfy-remote` 标签（自我过滤用），手机上会显示成一行小字。
- 长文本按 `maxMessageLength` 截断，暂不支持附件发送全文。
- 子 agent（subagent）的回合不推送，避免刷屏。

## 开发与测试

```sh
# 纯函数自测（不联网）
node probe/unit-check.mjs

# ntfy 往返探针（联网，话题随机）
node probe/ntfy-probe.mjs [server]

# Bridge 集成测试（真实 ntfy + 假 ctx，不碰宿主）
DSH_HOME=$(mktemp -d) node probe/bridge-it.mjs [server]

# 客户端 bundle 冒烟（桩执行，不打开浏览器）
node probe/client-check.mjs

# 会话存在性核对自测（不需要网络）
node probe/sweep-check.mjs
```

> **集成测试会真的往 ntfy 发消息。** 公共 ntfy.sh 按 visitor 限流——实测短时间重复运行会
> 返回 `HTTP 429 limit reached: too many requests`。测试识别到 429 会以**退出码 2** 报告
> 「被限流跳过」，而不是伪装成断言失败；被限流时审批/提问用例会连带失败（通知发不出去，
> 插件按设计回落原生链）。要反复跑请对自建 ntfy 运行，或等几分钟让配额回补。

集成测试覆盖：话题规则与旧绑定自愈、多服务器订阅与路由、**绑定不可变性**、未绑定服务器
的事件被忽略、**偏好分层**（继承 / 覆盖 / 清除 / 不串会话）、**解绑退路**、
**会话删除后的桥接清理**（含「只是没打开」与「读列表失败」两个反向保护）、`followup` 注入与回复提取、
自我消息过滤（含发布响应与订阅流之间的竞态）、重复消息去重、文本指令、审批按钮回执、
提问答案映射、超时回落原生链、非目标工具放行。

## 发布（维护者）

```sh
# 1) 打 tag 并推送 —— GitHub 直装靠 tag 锁定版本
git tag v1.0.0 && git push origin main --tags

# 2) 发布到 npm（本机 registry 常是镜像，登录与发布都指定官方源）
npm login --registry https://registry.npmjs.org/
npm publish --registry https://registry.npmjs.org/
```

发布前自查：

```sh
npm pack --dry-run    # 确认 files 列表包含 boot3.js / lib/client.js / cordis.patch.yml
```

- `package.json` 的 `private` 必须为假（本包已去掉），否则 `npm publish` 直接拒绝。
- `publishConfig.registry` 已写死官方源；本机 `npm config` 指向 npmmirror 这类镜像时，
  镜像**不接受发布**，必须显式指定官方源。
- 版本号与 git tag 保持一致，`github:...#v1.0.0` 才对得上。
- `dsh.bundle.patch` 与 `exports["./client"]` 是 DSH 发现服务端与浏览器两个半边的入口，别删。
- 本包无构建产物，`files` 里列的就是源码本身，改动后无需任何打包步骤。

## 已验证 / 待验证

已在**真机 + 真实宿主**上验证：

- 热挂载、自热重载、卸载清理；配置自动迁移（单服务器 → 多服务器、散落偏好 → `defaults`）
- **安装链路**：在临时 `DSH_HOME` 下实测 `dsh plugin --profile <p> add` 的三条路径
  （git 规格 `git+file://…#main`，等价 `github:`、npm tarball、本地路径）都能装成，
  且都被自动追加进 `dsh.profile.bundles`
- 出站通知：回合结束、错误 / 中断
- 手机在会话话题里回复即注入会话（单话题，不需要切到回复话题）；审批 / 提问按钮回执同样走它
- **审批中转**：真实 `approval/request` 被拦截 → 推送手机 → 手机作答 → 返回 `allowed-once`，
  且未回落网页端
- **提问中转**：真实 `ask_user_question` 被 `tools/execute` 拦截
- 多服务器：新增 / 编辑 / 删除、绑定保护、改绑拒绝、**解绑退路**（开启时拒绝、关闭后可解绑、
  解绑后可重选服务器）
- 每会话偏好覆盖、话题 HTTP 链接
- 超时回落原生链、自我消息过滤、重复消息去重

待验证：子 agent 回合不推送（过滤条件已写在代码里，尚未在真实 subagent 回合上跑过）。
