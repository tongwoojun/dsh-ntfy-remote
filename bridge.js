// 会话 ↔ ntfy 话题的桥接核心。
//
// 职责：
//   - 维护「哪些会话开着桥接、绑定哪个服务器、话题是什么」
//   - 每个用到的服务器各建一条常驻 NDJSON 订阅（出站话题 + 回复话题）
//   - 出站：回合结束 / 回合异常 → 推送；待审批 / 待提问 → 高优先级推送并接管作答
//   - 入站：手机文本 → 文本指令，或 agent.followup 注入会话并把回复推回
//
// 服务器绑定规则（按产品要求）：会话在**首次开启**时选定一个服务器，之后不可变更。
// 唯一的例外是原服务器已被删除——此时绑定实际已失效，允许重新选择（见 enable）。
//
// 时序要点（都踩过）：
//   - 插件订阅出站话题，所以服务器会把我们自己发的通知原样推回来。只靠「记录发布
//     响应里的 id」不可靠：发布响应与订阅流的送达顺序没有保证（集成测试稳定复现）。
//     因此每条自己发布的消息都带 MARKER_TAG，按 tag 过滤，与时间无关。
//   - 手机续聊那一轮的 turn/end 不能再推一次，否则用户收到重复通知；用 inflight 抑制。

import { randomUUID } from 'node:crypto'

// 版本透传：外壳用 ?v= 重新加载时，整张模块图都要重新求值（见 boot3.js）。
const VERSION = new URL(import.meta.url).search
const { createStateSaver, findServer, rememberId } = await import(`./config.js${VERSION}`)
const { describeError, log } = await import(`./log.js${VERSION}`)
const { MAX_CATCHUP_SEC, NTFY_MESSAGE_MAX_BYTES, createSubscriber, normalizeServer, publish } = await import(`./ntfy.js${VERSION}`)
const { parseNtfyMessage, shortSessionId, topicFor, topicUrl } = await import(`./topics.js${VERSION}`)

/** 核对「已开启桥接的会话是否还存在」的周期。 */
const SWEEP_INTERVAL_MS = 120_000

/** 连续多少次核对都找不到，才判定会话已被删除（防止持久化短暂不可用误删绑定）。 */
const SWEEP_MISS_THRESHOLD = 3

/** session/disposed 之后的抖动窗口：同一批销毁只触发一次核对。 */
const SWEEP_DEBOUNCE_MS = 2_000

/** 每个会话缓存的最近 assistant 文本上限（只保留最新一条，上限仅作防御）。 */
const ASSISTANT_CACHE_LIMIT = 200

/** ntfy 单条通知最多允许的按钮数；超过会直接 HTTP 400。 */
const MAX_ACTION_BUTTONS = 3

/**
 * 单条正文的默认字节预算。
 *
 * ntfy 的硬上限是 4095 字节（4096 会被 HTTP 500 拒收，见 ntfy.js 的
 * NTFY_MESSAGE_MAX_BYTES）。这里留约 95 字节余量：切点落在代码围栏内时还要
 * 补一个 "```" 并重开围栏，贴着悬崖走容易翻车。
 */
const DEFAULT_CHUNK_BYTES = 4000

/** 分片预算的绝对下限；配置被填成 1 之类时不至于切出成千上万条。 */
const MIN_CHUNK_BYTES = 256

/**
 * 围栏修复给单片追加的最大字节数。
 *
 * 切点落在代码块内时，上一片要补 "\n```"（4 字节），下一片要重开 "```lang\n"
 * （最多 7 字节）。所以真正的可用预算必须比 ntfy 硬上限低这么多——否则用户把
 * 上限设成 4095 时，补完围栏的那一片又会越过 4096 被拒收。
 */
const FENCE_REPAIR_BYTES = 16

/**
 * 多条消息之间的最小发送间隔（毫秒）。
 *
 * ntfy 的消息 `time` 只精确到**秒**，而客户端是按时间排序的。同一秒内连发多条时，
 * 排序退化成一个不稳定的次序——真机实测三条分片在手机上显示的先后是 1、3、2，
 * 用户看到的就是「内容全乱了」。拉开 1.1 秒保证相邻两条落在不同的秒上，顺序才稳定
 * （间隔 ≥1s 必然跨越秒边界）。代价：一次分片推送多花几秒。
 */
const PUBLISH_GAP_MS = 1_100

/**
 * 每个会话记住的「自己刚推出去的正文」条数，用于回声兜底。
 *
 * 必须大于一次推送的最大分片数：只记第一条的话，其余分片被服务器原样推回来时
 * 认不出是自己发的。主防线仍是 MARKER_TAG，这里只是第二道。
 */
const OWN_TEXT_MEMORY = 12

/**
 * 手机 `/stop` 之后的静默窗口：这段时间内该会话的中断推送一律压掉。
 *
 * 手机上取消会产生一个没有嵌套原因（`reason.reason` 缺失）的 `aborted`，
 * `isUserInitiatedCancel()` 认不出来，不压就会推一条「回合中断：unknown」。
 * 加时间窗是为了防止一次没等到 `turn/end` 的取消，吞掉之后真正的异常中断。
 */
const CANCEL_QUIET_MS = 60_000

/**
 * 进程内「当前有效实例」的世代号。
 *
 * 开发期外壳会热重载，同一个进程里可能先后存在多个 Bridge 实例；旧实例的
 * 长连接与推送必须静默失效，否则会出现重复通知和重复会话注入。用 Symbol.for
 * 保证跨模块实例共享同一把钥匙。
 */
const GENERATION_KEY = Symbol.for('dsh-ntfy-remote.generation')

/**
 * 所有由本插件发布的消息都带这个 tag。
 *
 * 为什么不能只靠「记录自己发布的 message id」：发布响应与订阅流的送达顺序
 * 没有保证，订阅流可能先到，那条消息就会被误当成用户输入（集成测试实测复现）。
 * tag 写在消息里，与时间无关，是可靠的自我过滤依据。
 */
const MARKER_TAG = 'dsh-ntfy-remote'

/**
 * 从会话事件里提取某次续聊的回复。
 *
 * 只看 `seq >= boundarySeq` 的事件：boundarySeq 是注入前的日志长度，
 * 这样不会把注入之前的旧回复当成本次结果。
 *
 * @param {readonly {seq: number, type: string, data?: any}[]} events 会话事件
 * @param {number} boundarySeq 注入前的 seq
 * @returns {{reply: string | null, reasonKind: string | null}}
 */
export function extractReply(events, boundarySeq) {
  let reply = null
  let reasonKind = null
  for (const event of events) {
    if (typeof event?.seq === 'number' && event.seq < boundarySeq) continue
    if (event.type === 'turn/end') {
      reasonKind = event.data?.reason?.kind ?? null
      continue
    }
    if (event.type === 'assistant/message') {
      const text = (event.data?.message?.content ?? [])
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('')
      if (text !== '') reply = text
    }
  }
  return { reply, reasonKind }
}

/**
 * 把回合结束原因写成人话。
 *
 * @param {{kind?: string, error?: {message?: string}, reason?: {kind?: string, reason?: string}}} reason 回合结束原因
 * @returns {string}
 */
export function describeTurnEnd(reason) {
  const kind = reason?.kind ?? 'unknown'
  if (kind === 'error') return `回合失败：${reason?.error?.message ?? '模型调用出错'}`
  if (kind === 'max-tokens') return '回合中断：达到输出上限'
  if (kind === 'blocked') return '回合中断：被策略拦截'
  if (kind === 'interrupted') return '回合中断：进程中断后收尾'
  if (kind === 'aborted') {
    const cause = reason?.reason?.kind ?? 'unknown'
    if (cause === 'hook') return `回合中断：${reason?.reason?.reason ?? 'hook 取消'}`
    return `回合中断：${cause}`
  }
  return `回合结束：${kind}`
}

/**
 * 取消类原因意味着**用户自己**在桌面点了停止，不需要再推送打扰。
 *
 * @param {{kind?: string, reason?: {kind?: string}}} reason 回合结束原因
 * @returns {boolean}
 */
function isUserInitiatedCancel(reason) {
  if (reason?.kind !== 'aborted') return false
  const cause = reason?.reason?.kind
  return cause === 'user' || cause === 'parent' || cause === 'disposed'
}

/**
 * 拆开一条作答文本。逗号（中英文）、顿号、分号、空白都算分隔符。
 *
 * @param {string} text 作答文本
 * @returns {string[]} 片段列表
 */
function splitAnswerTokens(text) {
  return String(text ?? '')
    .split(/[,，、;；\s]+/)
    .map((token) => token.trim())
    .filter((token) => token !== '')
}

/**
 * 把一个作答片段映射回选项标签：编号（1 起）与标签原文都能命中。
 *
 * @param {string} token 单个作答片段
 * @param {{label: string}[]} options 选项列表
 * @returns {string | undefined} 命中的标签
 */
function matchOption(token, options) {
  const index = Number(token)
  if (Number.isInteger(index) && index >= 1 && index <= options.length) return options[index - 1].label
  return options.find((option) => option.label === token)?.label
}

/**
 * 生成手机 App 可点的跳转深链接。
 *
 * 注意：`ntfy://` 深链接是 Android 专有；iOS 上点通知不会切话题。
 *
 * @param {string} serverUrl 服务器根地址
 * @param {string} topic 话题
 * @returns {string}
 */
export function deepLink(serverUrl, topic) {
  const host = normalizeServer(serverUrl).replace(/^https?:\/\//, '')
  return `ntfy://${host}/${topic}`
}

/**
 * 一段正文按 UTF-8 编码的字节数。
 *
 * 分片一律以字节为准，不以字符为准：ntfy 的 message 上限是 4095 **字节**，
 * 而一个汉字 3 字节、一个 emoji 最多 4 字节，按字符切会严重超发。
 *
 * @param {string} text 正文
 * @returns {number}
 */
function byteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf-8')
}

/**
 * 返回「前 limitBytes 字节」对应的字符下标，保证切点落在字符边界上。
 *
 * 不能用 `slice(0, n)` 代替：n 是字节数，按字符下标切会把多字节字符劈成
 * 半个，拼出乱码，甚至让 ntfy 拒收。
 *
 * @param {string} text 原文
 * @param {number} limitBytes 字节预算
 * @returns {number} 安全的字符下标（至少 1，避免死循环）
 */
function cutIndexAtBytes(text, limitBytes) {
  let bytes = 0
  let index = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf-8')
    if (bytes + size > limitBytes) break
    bytes += size
    index += char.length
  }
  return index === 0 ? 1 : index
}

/**
 * 按字节预算粗切正文：优先切在行边界，单行超预算才硬切。
 *
 * @param {string} text 原文
 * @param {number} budget 单条字节预算
 * @returns {string[]}
 */
function rawChunks(text, budget) {
  const out = []
  let lines = []
  let used = 0

  const flush = () => {
    if (lines.length === 0) return
    const piece = lines.join('\n')
    lines = []
    used = 0
    // 只装着空行的片没有意义（正文以换行开头时会出现），丢掉免得白发一条空消息。
    if (piece !== '') out.push(piece)
  }

  for (const line of text.split('\n')) {
    const cost = (lines.length === 0 ? 0 : 1) + byteLength(line)
    if (used + cost <= budget) {
      lines.push(line)
      used += cost
      continue
    }
    flush()
    if (byteLength(line) <= budget) {
      lines.push(line)
      used = byteLength(line)
      continue
    }
    // 单行本身就超预算（长段落、压缩过的 JSON、超长代码行）：按字节硬切。
    let rest = line
    while (byteLength(rest) > budget) {
      const cut = cutIndexAtBytes(rest, budget)
      out.push(rest.slice(0, cut))
      rest = rest.slice(cut)
    }
    if (rest !== '') {
      lines.push(rest)
      used = byteLength(rest)
    }
  }
  flush()
  return out.length === 0 ? [''] : out
}

/** markdown 代码围栏（``` 或 ~~~），允许最多 3 个前导空格。 */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/

/**
 * 读过一段文本后，围栏的新状态。
 *
 * @param {string | null} open 进入时的围栏开标记（如 ```js）；null 表示不在围栏内
 * @param {string} text 文本
 * @returns {string | null} 读完后的围栏状态
 */
function advanceFence(open, text) {
  let state = open
  for (const line of text.split('\n')) {
    if (FENCE_RE.exec(line) === null) continue
    state = state === null ? line.trim() : null
  }
  return state
}

/**
 * 把 markdown 正文按字节预算切成多条待发消息。
 *
 * 存在的理由：ntfy 的 message 字段有 4095 字节硬上限，超了整条会被服务端拒收，
 * 而拒收是静默的（publish 只返回 ok:false，调用方多半是 void）。旧实现按
 * **字符**截断到 3500，中文折算 10500 字节，长回复整条丢失——这里改成按字节分片，
 * 内容不丢，只是多几条。
 *
 * 切完还要修围栏：切点落在 ``` 代码块内部时，md 渲染会从切点开始烂掉（后面
 * 全进了代码块）。所以给上一片补一个闭合围栏、给下一片重新打开围栏。预算留了
 * 余量，补这几字节不会顶到 ntfy 硬上限。
 *
 * @param {string} text 原文（markdown）
 * @param {number} [limitBytes] 单条字节预算；缺省用 DEFAULT_CHUNK_BYTES
 * @returns {string[]} 分片结果，至少一条；未超预算时原样返回单条
 */
export function splitForNtfy(text, limitBytes = DEFAULT_CHUNK_BYTES) {
  const value = String(text ?? '')
  if (value === '') return ['']

  const raw = Number(limitBytes)
  const budget = Math.max(
    MIN_CHUNK_BYTES,
    Math.min(
      Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_CHUNK_BYTES,
      NTFY_MESSAGE_MAX_BYTES - FENCE_REPAIR_BYTES,
    ),
  )
  if (byteLength(value) <= budget) return [value]

  const pieces = rawChunks(value, budget)

  // 先按**原始**分片推进围栏状态。必须用未修改的 pieces：第一处补上的闭合
  // 围栏会改变后续所有边界的判定，就地边改边算会一路错下去。
  const fenceAfter = []
  let open = null
  for (const piece of pieces) {
    open = advanceFence(open, piece)
    fenceAfter.push(open)
  }

  for (let i = 0; i < pieces.length - 1; i++) {
    const fence = fenceAfter[i]
    if (fence === null) continue
    pieces[i] = `${pieces[i]}\n\`\`\``
    pieces[i + 1] = `${fence}\n${pieces[i + 1]}`
  }
  return pieces
}

/**
 * 构造 ntfy 动作按钮。
 *
 * 服务器启用鉴权时，按钮必须自带 Authorization 头：ntfy 的动作按钮是**手机直接**
 * 向服务器发 POST，不走插件的 HTTP 客户端，所以 token 得写进动作定义里。少了它，
 * 在自建（开了 auth）的服务器上点按钮一律 HTTP 403——实测踩过：作者自己的阿里云
 * 服务器 tokenSet=true，两个按钮点下去都是 403，只能退回手打编号。
 *
 * @param {{url: string, token?: string}} server 服务器描述符
 * @param {string} topic 话题
 * @param {string} requestId 待决请求 id
 * @param {{label: string, value: object}[]} buttons 按钮定义
 * @returns {object[]} ntfy actions 数组
 */
export function buildActionButtons(server, topic, requestId, buttons) {
  const headers = typeof server?.token === 'string' && server.token !== ''
    ? { Authorization: `Bearer ${server.token}` }
    : undefined
  return buttons.map((button) => ({
    action: 'http',
    label: button.label,
    url: `${normalizeServer(server.url)}/${topic}`,
    method: 'POST',
    clear: false,
    headers,
    body: JSON.stringify({ requestId, ...button.value }),
  }))
}

/**
 * 把一道提问组装成待发消息列表。
 *
 * 一条通知装不下的内容一律分条，不截断。选项按 ntfy 动作按钮的上限（3 个）
 * 分组，每组一条消息、各带各组自己的按钮；所有按钮共用同一个 requestId，
 * 因此点哪一条上的按钮都能结算同一个待决请求。
 *
 * 内容取舍对齐桌面端（dsh-client-ui-user-questions 的渲染）：header、question、
 * detail、以及每个选项的 label **和 description** 都要带上。description 尤其不能
 * 省——标签常常只是「方案 A」这类短语，真正的取舍写在描述里，缺了等于让人闭眼选。
 * detail 是计划模式下的被审阅正文（dsh-plan-mode 把整份 plan 塞在这里），
 * 缺了就成了「拿空白批准计划」。
 *
 * @param {{question?: string, header?: string, detail?: string, multi_select?: boolean}} question 提问
 * @param {{label?: string, description?: string}[]} options 选项
 * @param {{index: number, total: number}} position 第几问 / 共几问（均 0 起 / 总数）
 * @returns {{message: string, buttons?: {label: string, value: object}[]}[]}
 */
export function buildQuestionParts(question, options, position) {
  const multi = question.multi_select === true
  const head = []

  const header = typeof question.header === 'string' ? question.header.trim() : ''
  if (header !== '') head.push(`**${header}**`)
  head.push(String(question.question ?? '提问'))

  const labels = [multi ? '多选' : '单选']
  if (position.total > 1) labels.unshift(`第 ${position.index + 1}/${position.total} 问`)
  head.push(`（${labels.join(' · ')}）`)

  // detail 可能很长（整份计划），单独成段后交给分片器按字节切。
  const detail = typeof question.detail === 'string' ? question.detail.trim() : ''
  if (detail !== '') head.push('', detail)

  const parts = [{ message: head.join('\n') }]

  // 编号跨组连续；matchOption 按整份 options 的数字下标还原，所以分组不影响作答。
  for (let start = 0; start < options.length; start += MAX_ACTION_BUTTONS) {
    const items = options.slice(start, start + MAX_ACTION_BUTTONS)
    const lines = items.map((option, offset) => {
      const text = `${start + offset + 1}. ${String(option?.label ?? '')}`
      const description = typeof option?.description === 'string' ? option.description.trim() : ''
      // 缩进 3 格：md 里算上一项的续行，渲染出来就贴在标签下面。
      return description === '' ? text : `${text}\n   ${description}`
    })
    const last = start + MAX_ACTION_BUTTONS >= options.length
    if (last) {
      lines.push('', multi
        ? '多选：回复编号或标签，逗号分隔（例如 1,3）；也可以直接打字。'
        : '点按钮，或回复编号 / 标签；也可以直接打字。')
    }
    parts.push({
      message: lines.join('\n'),
      // 多选不能用按钮：按钮是无状态的单次回执，点第二个只会多出一条回执，
      // 表达不了「选中的集合」。所以多选一律走编号 / 标签文本作答。
      buttons: multi
        ? undefined
        : items.map((option) => ({ label: String(option?.label ?? ''), value: { answer: option?.label } })),
    })
  }

  return parts
}

/** 会话 ↔ ntfy 话题桥接。 */
export class Bridge {
  /**
   * @param {object} ctx cordis 上下文
   * @param {typeof import('./config.js').DEFAULT_CONFIG} config 配置
   * @param {object} state 插件状态
   * @param {number} [generation] 本实例的世代号；省略表示永不过期
   */
  constructor(ctx, config, state, generation = 0) {
    this.ctx = ctx
    this.config = config
    this.state = state
    this.generation = generation
    /** @type {Map<string, string>} sessionId → 最近一条 assistant 文本 */
    this.lastAssistant = new Map()
    /** @type {Map<string, {sessionId: string, kind: string, finish: (value: any) => void}>} requestId → 待决请求 */
    this.pending = new Map()
    /** @type {Set<string>} 正在被手机发起的续聊驱动的会话 */
    this.inflight = new Set()
    /** @type {Map<string, number>} sessionId → 手机最近一次 /stop 的时刻（用于压掉随之而来的中断推送） */
    this.phoneCancels = new Map()
    /** @type {Map<string, {sessionId: string, serverId: string}>} 话题 → 归属 */
    this.topicIndex = new Map()
    /** @type {Map<string, string[]>} sessionId → 最近推送过的正文，用于回环兜底 */
    this.recentOwn = new Map()
    /** @type {Map<string, number>} sessionId → 连续核对不到的次数 */
    this.missingSweeps = new Map()
    this.sweepTimer = null
    this.sweepDebounce = null
    /** @type {Map<string, string[]>} serverId → 该服务器要订阅的话题 */
    this.serverTopics = new Map()
    /** @type {Map<string, {start: Function, stop: Function, restart: Function}>} serverId → 订阅器 */
    this.subscribers = new Map()
    this.saver = createStateSaver(() => this.state)
    this.reindex()
  }

  /** 启动定期核对。没有已开启的会话时它什么也不做。 */
  startSweeper() {
    if (this.sweepTimer !== null) return
    this.sweepTimer = setInterval(() => {
      void this.sweepMissingSessions().catch((error) => log(`sweep: 异常 ${describeError(error)}`))
    }, SWEEP_INTERVAL_MS)
    this.sweepTimer.unref?.()
  }

  /** session/disposed 之后安排一次核对（会话可能只是被关掉，也可能被删了）。 */
  scheduleSweep() {
    if (this.sweepDebounce !== null) clearTimeout(this.sweepDebounce)
    this.sweepDebounce = setTimeout(() => {
      this.sweepDebounce = null
      void this.sweepMissingSessions().catch((error) => log(`sweep: 异常 ${describeError(error)}`))
    }, SWEEP_DEBOUNCE_MS)
    this.sweepDebounce.unref?.()
  }

  /**
   * 判断会话是否已经不存在（既不活、也不在持久化列表里）。
   *
   * 读不到列表时按「存在」处理：误判成删除会无故断开用户的桥接。
   *
   * @param {string} sessionId 会话 id
   * @returns {Promise<boolean>}
   */
  async isSessionGone(sessionId) {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined || typeof persistence.list !== 'function') return false
    try {
      const headers = await persistence.list()
      return headers.every((header) => header.id !== sessionId)
    } catch (error) {
      log(`sweep: 会话存在性检查失败，按存在处理 ${describeError(error)}`)
      return false
    }
  }

  /**
   * 读 DSH 本体的归档集合（`workspaceRegistry.archivedSessionIds`）。
   *
   * 服务不在、状态未就绪、字段形状不对一律返回 null，调用方据此**不动作** ——
   * 宁可多留一会儿绑定，也不要误删用户的推送。
   *
   * @returns {Set<string> | null}
   */
  archivedSessions() {
    try {
      const registry = this.ctx.get('workspaceRegistry')
      const ids = registry?.archivedSessionIds
      if (!Array.isArray(ids)) {
        // 只有「取不到」时才打：将来 DSH 改了服务名或字段形状，这一行就是线索，
        // 否则功能会静默失效（归档过的会话一直留在列表里）。
        log(`sweep: 归档集合不可用（registry=${registry === undefined ? '取不到' : typeof registry}，ids=${typeof ids}），跳过归档核对`)
        return null
      }
      return new Set(ids)
    } catch (error) {
      log(`sweep: 读取归档集合失败，跳过归档核对 ${describeError(error)}`)
      return null
    }
  }

  /**
   * 核对已开启桥接的会话是否仍然存在，把已被删除的会话的桥接主动断开。
   *
   * 两种信号：
   *   1. **已归档**（DSH 本体的 `archivedSessionIds`）—— 明确的用户动作、持久状态，
   *      命中立刻清理，不等三次核对。归档不删文件，所以「不在持久化列表」那条路
   *      永远抓不到它。
   *   2. **已删除** —— 不在内存、也不在持久化列表。这个判定可能是瞬时的读取问题，
   *      所以要求**连续三次**核对都这样才清理。
   *
   * 为什么不能直接用 `session/disposed`：用户在界面里关掉会话时 agent 同样会被
   * 拆掉并触发该事件，但会话本身还在磁盘上、也可能只是被归档。
   *
   * @returns {Promise<void>}
   */
  async sweepMissingSessions() {
    const bound = Object.keys(this.state.sessions)
    if (bound.length === 0) return

    let changed = false
    try {
      const archived = this.archivedSessions()
      if (archived !== null) {
        for (const sessionId of bound) {
          if (!archived.has(sessionId)) continue
          delete this.state.sessions[sessionId]
          this.missingSweeps.delete(sessionId)
          changed = true
          log(`bridge: 会话 ${sessionId} 已归档，已断开桥接并移除记录`)
        }
      }

      const persistence = this.ctx.get('sessionPersistence')
      if (persistence === undefined || typeof persistence.list !== 'function') return

      let headers
      try {
        headers = await persistence.list()
      } catch (error) {
        // 读不到列表时宁可不动：误删绑定会让用户莫名其妙地失去推送。
        log(`sweep: 读取持久化列表失败，跳过本轮 ${describeError(error)}`)
        return
      }
      const persisted = new Set(headers.map((header) => header.id))
      const agents = this.ctx.get('agents')

      for (const sessionId of Object.keys(this.state.sessions)) {
        const live = agents?.get?.(sessionId) !== undefined
        if (live || persisted.has(sessionId)) {
          this.missingSweeps.delete(sessionId)
          continue
        }
        const misses = (this.missingSweeps.get(sessionId) ?? 0) + 1
        this.missingSweeps.set(sessionId, misses)
        if (misses < SWEEP_MISS_THRESHOLD) continue
        delete this.state.sessions[sessionId]
        this.missingSweeps.delete(sessionId)
        changed = true
        log(`bridge: 会话 ${sessionId} 已不存在（连续 ${misses} 次核对均未找到），已断开桥接并清除绑定`)
      }
    } finally {
      if (changed) this.resync()
    }
  }

  /**
   * 本实例是否仍是进程内最新的那一代。
   *
   * @returns {boolean}
   */
  isCurrent() {
    return this.generation === 0 || globalThis[GENERATION_KEY] === this.generation
  }

  /** 启动：按服务器建立订阅，并启动会话存在性核对。 */
  start() {
    this.syncSubscribers()
    this.startSweeper()
    log(`bridge: 已启动，已开启会话 ${this.enabledCount()} 个，服务器 ${this.subscribers.size} 个`)
  }

  /** 停止全部订阅、核对定时器并落盘状态。 */
  stop() {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
    if (this.sweepDebounce !== null) {
      clearTimeout(this.sweepDebounce)
      this.sweepDebounce = null
    }
    for (const subscriber of this.subscribers.values()) subscriber.stop()
    this.subscribers.clear()
    this.saver.flush()
    log('bridge: 已停止')
  }

  /** 已开启桥接的会话数量。 */
  enabledCount() {
    return Object.values(this.state.sessions).filter((info) => info?.enabled === true).length
  }

  /**
   * 统计绑定到某服务器的会话数（含已关闭但绑定的），用于删除服务器的保护。
   *
   * @param {string} serverId 服务器 id
   * @returns {number}
   */
  bindingsForServer(serverId) {
    return Object.values(this.state.sessions).filter((info) => info?.serverId === serverId).length
  }

  /** 由状态重建「话题 → 归属」与「服务器 → 话题」两张索引。 */
  reindex() {
    this.topicIndex.clear()
    this.serverTopics.clear()
    for (const [sessionId, info] of Object.entries(this.state.sessions)) {
      if (info === null || typeof info !== 'object') continue
      // 话题规则可能变过（例如从「短 id + 密钥」改成「完整会话 id」）：每次都按当前
      // 规则重算，让旧绑定自愈，不需要用户重新开启。
      try {
        info.topic = topicFor(sessionId)
        delete info.responseTopic
      } catch (error) {
        log(`bridge: 会话 ${sessionId} 生成话题名失败，跳过：${describeError(error)}`)
        continue
      }
      if (info.enabled !== true) continue
      const serverId = info.serverId
      if (typeof serverId !== 'string' || serverId === '') continue
      // 单话题：出站推送与入站回复共用同一个，订阅一条即可。
      this.topicIndex.set(info.topic, { sessionId, serverId })
      const topics = this.serverTopics.get(serverId) ?? []
      topics.push(info.topic)
      this.serverTopics.set(serverId, topics)
    }
  }

  /** 按需要为各服务器建立/重启/停止订阅。 */
  syncSubscribers() {
    const wanted = new Set(this.serverTopics.keys())
    for (const [serverId, subscriber] of [...this.subscribers]) {
      if (wanted.has(serverId)) continue
      subscriber.stop()
      this.subscribers.delete(serverId)
      log(`bridge: 已停止服务器 ${serverId} 的订阅`)
    }
    for (const serverId of wanted) {
      const existing = this.subscribers.get(serverId)
      if (existing !== undefined) {
        // 话题集合可能变了；重启最省心，连接代价很低。
        existing.restart()
        continue
      }
      const subscriber = createSubscriber({
        getServer: () => {
          const server = findServer(this.config, serverId)
          return server === null ? null : { url: server.url, token: server.token, name: server.name }
        },
        // 非当前世代的实例不订阅任何话题，静默退场。
        getTopics: () => (this.isCurrent() ? (this.serverTopics.get(serverId) ?? []) : []),
        getSince: () => this.currentSince(),
        onEvent: (event) => {
          void this.handleInbound(serverId, event).catch((error) => {
            log(`inbound: 处理失败 ${describeError(error)}`)
          })
        },
        onStatus: (status) => log(`ntfy[${serverId}]: ${status}`),
      })
      subscriber.start()
      this.subscribers.set(serverId, subscriber)
    }
  }

  /** 开关或绑定变化后重建索引、落盘并同步订阅。 */
  resync() {
    this.reindex()
    this.saver.schedule()
    this.syncSubscribers()
  }

  /**
   * 重连补漏的起点：至少是上次收到消息的时间，但不超过 1 小时前。
   *
   * @returns {number} Unix 秒；0 表示只收实时消息
   */
  currentSince() {
    const seen = Number(this.state.lastSeenTs) || 0
    if (seen <= 0) return 0
    const floor = Math.floor(Date.now() / 1000) - MAX_CATCHUP_SEC
    return seen > floor ? seen : floor
  }

  /**
   * 是否已为该会话开启桥接。
   *
   * @param {string} sessionId 会话 id
   * @returns {boolean}
   */
  isEnabled(sessionId) {
    return this.state.sessions[sessionId]?.enabled === true
  }

  /**
   * 取某会话的**生效偏好**：单会话覆盖优先，否则回落到全局默认。
   *
   * @param {string} sessionId 会话 id
   * @param {string} key 偏好键
   * @returns {any}
   */
  pref(sessionId, key) {
    const override = this.state.sessions[sessionId]?.prefs?.[key]
    return override === undefined ? this.config.defaults[key] : override
  }

  /**
   * 设置或清除某会话的偏好覆盖。传 undefined 表示「恢复跟随全局默认」。
   *
   * @param {string} sessionId 会话 id
   * @param {string} key 偏好键
   * @param {any} value 覆盖值，或 undefined 表示清除
   * @returns {boolean} 会话是否存在
   */
  setPref(sessionId, key, value) {
    const info = this.state.sessions[sessionId]
    if (info === undefined) return false
    const prefs = { ...(info.prefs ?? {}) }
    if (value === undefined) delete prefs[key]
    else prefs[key] = value
    info.prefs = prefs
    this.saver.schedule()
    return true
  }

  /**
   * 取会话绑定的服务器；未绑定或服务器已删除返回 null。
   *
   * @param {string} sessionId 会话 id
   * @returns {{id: string, name: string, url: string, token: string} | null}
   */
  serverFor(sessionId) {
    const binding = this.state.sessions[sessionId]
    if (binding === undefined) return null
    return findServer(this.config, binding.serverId)
  }

  /**
   * 开启某个会话的桥接，并在首次开启时固定服务器绑定。
   *
   * 绑定规则：一旦该会话有过 serverId，就不允许改到别的服务器——除非原服务器
   * 已从配置里删除（此时绑定已失效，允许重新选择）。
   *
   * @param {string} sessionId 会话 id
   * @param {{serverId?: string, cwd?: string}} [options] 选项
   * @returns {{ok: true, info: object} | {ok: false, error: string, serverId?: string}}
   */
  enable(sessionId, options = {}) {
    const existing = this.state.sessions[sessionId]
    const bound = existing?.serverId
    const boundAlive = bound !== undefined && findServer(this.config, bound) !== null

    if (boundAlive && options.serverId !== undefined && options.serverId !== '' && options.serverId !== bound) {
      return { ok: false, error: 'server-immutable', serverId: bound }
    }

    const chosen = boundAlive ? bound : options.serverId ?? this.config.defaultServerId
    if (findServer(this.config, chosen) === null) {
      return { ok: false, error: 'server-not-found' }
    }

    const info = {
      enabled: true,
      // 原服务器还在就继续用它；已失效则接受新选择。
      serverId: chosen,
      // 话题由会话 id 直接推导（见 topics.js），出站与入站共用。
      topic: topicFor(sessionId),
      cwd: options.cwd ?? existing?.cwd,
      enabledAt: existing?.enabledAt ?? Date.now(),
      // 单会话偏好覆盖：沿用已有值，不要因为重新开启被清掉。
      prefs: existing?.prefs,
    }
    this.state.sessions[sessionId] = info
    this.resync()
    const server = findServer(this.config, chosen)
    log(`bridge: 开启 ${sessionId} → ${server?.name}(${server?.url}) / ${info.topic}`)
    return { ok: true, info }
  }

  /**
   * 解绑：清除会话的服务器绑定与话题，让它能重新选择服务器。
   *
   * 只在会话**已关闭**时允许。绑定不可变本是为了避免运行中改地址造成话题漂移，
   * 但服务器失联（或填错地址）时必须有一条明确的退路，否则会话会永久卡死：
   * 改绑被拒 → 想删服务器 → 删除又因存在绑定被拒，形成死锁。
   *
   * @param {string} sessionId 会话 id
   * @returns {{ok: true} | {ok: false, error: string}}
   */
  unbind(sessionId) {
    const info = this.state.sessions[sessionId]
    if (info === undefined) return { ok: false, error: 'not-bound' }
    if (info.enabled === true) return { ok: false, error: 'still-enabled' }
    delete this.state.sessions[sessionId]
    this.resync()
    log(`bridge: 已解绑 ${sessionId}`)
    return { ok: true }
  }

  /**
   * 忘掉一个会话：移除它在插件里的**全部记录**（服务器绑定、开关、偏好覆盖）。
   *
   * 与 `unbind` 的区别：`unbind` 是「换服务器」的退路，只在会话已关闭时可用；
   * `forget` 是「这个插件不再管它了」，随时可用，**不碰 DSH 的会话本身** ——
   * 会话文件、消息历史都在，想再用就在那个会话里重新 `/ntfy on`。
   *
   * @param {string} sessionId 会话 id
   * @returns {boolean} 之前是否有记录
   */
  forget(sessionId) {
    if (this.state.sessions[sessionId] === undefined) return false
    delete this.state.sessions[sessionId]
    this.missingSweeps.delete(sessionId)
    this.lastAssistant.delete(sessionId)
    this.recentOwn.delete(sessionId)
    this.resync()
    log(`bridge: 已移除会话 ${sessionId} 的记录`)
    return true
  }

  /**
   * 关闭某个会话的桥接。绑定保留，重新开启时仍用同一个服务器。
   *
   * @param {string} sessionId 会话 id
   * @returns {boolean} 之前是否开着
   */
  disable(sessionId) {
    const info = this.state.sessions[sessionId]
    if (info === undefined) return false
    info.enabled = false
    this.resync()
    log(`bridge: 关闭 ${sessionId}`)
    return true
  }

  /**
   * 推送通知用的会话标签，也是状态页会话列表里的显示名。
   *
   * 形如 `DSH · <服务器名> · <会话短 id>`：中间那段优先取该会话**绑定的 ntfy 服务器名**，
   * 这样通知标题和会话列表一眼就能看出走的是哪个服务器（同一个工作目录下的多个会话，
   * 用目录名会完全同名，反而分不清）。没有绑定时退回工作目录名，再没有就只剩短 id。
   *
   * @param {string} sessionId 会话 id
   * @returns {string}
   */
  labelFor(sessionId) {
    const server = this.serverFor(sessionId)
    const cwd = this.state.sessions[sessionId]?.cwd
    const dir = typeof cwd === 'string' && cwd !== '' ? cwd.split(/[\\/]/).filter(Boolean).pop() : undefined
    const short = shortSessionId(sessionId)
    const name = server === null ? undefined : server.name
    const middle = name === undefined || name === '' ? dir : name
    return middle === undefined ? `DSH · ${short}` : `DSH · ${middle} · ${short}`
  }

  /**
   * 单条正文的字节预算。
   *
   * **固定值，不再暴露给用户**：ntfy 的硬上限是 4095 字节，超出的部分会自动分片
   * 续发、内容不丢，所以「一条装多少」没有可调价值。它只会变成一个容易填错的坑——
   * 单位是字节而不是字，一个汉字占 3 字节，填 3500 看着像 3500 字，实际只有
   * 1165 个汉字。留成方法只是给测试一个替换点。
   *
   * @returns {number}
   */
  chunkBytes() {
    return DEFAULT_CHUNK_BYTES
  }

  /**
   * 按顺序发一批已切好的消息。
   *
   * 「只有第一条响铃」是刻意的：一次提问拆成 4 条时，让手机震 4 次比少几条更烦。
   * 后续片一律 priority 1（min，静音），标题带 (k/n) 让用户知道还有后续。
   * 标题后缀只在多于一条时加，单条的老行为完全不变。
   *
   * 某一条失败**不中断整批**：已经送达的按钮仍然能结算同一个 requestId，半批
   * 内容也比什么都没有强。只要有一条成功就认为这批可用。失败逐条写日志——
   * 旧实现正是「失败只写日志、调用方又是 void」，才让长中文通知静默消失。
   *
   * @param {string} sessionId 会话 id
   * @param {{url: string, token?: string}} server 服务器描述符
   * @param {{message: string, actions?: object[]}[]} messages 待发消息（已分片）
   * @param {{title?: string, topic?: string, priority?: number, tags?: string[], click?: string}} base 公共字段
   * @returns {Promise<{ok: boolean, sent: number, id: string | null, error?: string}>}
   */
  async sendMessages(sessionId, server, messages, base) {
    const total = messages.length
    let sent = 0
    let headId = null
    let error

    // **倒着发**。ntfy 客户端把最新的消息显示在最上面，所以按内容顺序 1、2、3 发出去，
    // 用户在手机上从上往下读到的就是 3、2、1（真机实测确认）。倒序发送让最新的一条
    // 正好是内容的第一条，从上往下读才是 1、2、3。
    //   显示（最新在上）  内容 1  ← 内容 2  ← 内容 3
    //   发送顺序          内容 3  → 内容 2  → 内容 1
    // 响铃仍挂在**内容第一条**（最后发出）上：等所有分片都到齐了再震一下，
    // 用户点开就能从头读到尾，而不会先看到结尾。
    for (let k = 0; k < total; k++) {
      const i = total - 1 - k
      // 相邻两条之间拉开一拍：ntfy 的时间戳只到秒，同秒连发会被客户端乱序（见 PUBLISH_GAP_MS）。
      if (k > 0) await new Promise((resolve) => setTimeout(resolve, PUBLISH_GAP_MS))
      const item = messages[i]
      let actions = item.actions
      if (Array.isArray(actions) && actions.length > MAX_ACTION_BUTTONS) {
        log(`outbound: 按钮 ${actions.length} 个超过 ntfy 上限 ${MAX_ACTION_BUTTONS}，已省略`)
        actions = undefined
      }
      const result = await publish(server, {
        topic: base.topic,
        // 标题里的序号是**内容序号**（1/N 是开头那块），与发送先后无关。
        title: total > 1 && base.title !== undefined ? `${base.title} (${i + 1}/${total})` : base.title,
        message: item.message,
        // 内容第一条用调用方给的优先级（可能是 undefined，即默认正常优先级），其余静音。
        priority: i === 0 ? base.priority : 1,
        tags: base.tags,
        actions,
        click: base.click,
        markdown: true,
      })
      if (result.ok) {
        sent += 1
        if (i === 0) headId = result.id ?? null
        this.rememberOwn(result.id)
        // 每一片都要记：回声兜底按正文比对，只记第一片会让其余片被当成用户输入。
        this.rememberOwnText(sessionId, item.message)
      } else {
        error = result.error ?? `HTTP ${result.status}`
        log(`outbound: 内容第 ${i + 1}/${total} 条推送失败 ${error}`)
      }
    }

    return sent > 0
      ? { ok: true, sent, id: headId }
      : { ok: false, sent: 0, id: null, error: error ?? 'publish-failed' }
  }

  /**
   * 缓存某会话最近的 assistant 文本，供回合结束推送使用。
   *
   * @param {string} sessionId 会话 id
   * @param {{content?: {type?: string, text?: string}[]}} message assistant 消息
   */
  rememberAssistant(sessionId, message) {
    const text = (message?.content ?? [])
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
    if (text === '') return
    this.lastAssistant.set(sessionId, text)
    if (this.lastAssistant.size > ASSISTANT_CACHE_LIMIT) {
      const oldest = this.lastAssistant.keys().next().value
      this.lastAssistant.delete(oldest)
    }
  }

  /**
   * 记录一条我们自己发布的消息 id（次要过滤手段，主手段是 MARKER_TAG）。
   *
   * @param {string | null | undefined} id 发布响应里的 message id
   */
  rememberOwn(id) {
    if (typeof id !== 'string' || id === '') return
    rememberId(this.state.ownIds, id)
    this.saver.schedule()
  }

  /**
   * 发布一条通知到该会话绑定的服务器。
   *
   * 正文超过单条字节预算时自动分片发多条，**不再截断**——ntfy 的超长消息是
   * 整条拒收而不是截断，旧实现的「按字符截断」会让长中文回复静默丢失。
   *
   * @param {string} sessionId 会话 id
   * @param {{title?: string, message: string, priority?: number, tags?: string[], actions?: object[], topic?: string, click?: string}} options 通知内容
   * @returns {Promise<{ok: boolean, sent?: number, id?: string | null, error?: string}>}
   */
  async notify(sessionId, options) {
    if (!this.isCurrent()) return { ok: false, error: 'stale' }
    const binding = this.state.sessions[sessionId]
    const server = this.serverFor(sessionId)
    if (server === null || binding === undefined) {
      log(`outbound: 会话 ${sessionId} 没有可用的服务器绑定，跳过推送`)
      return { ok: false, error: 'server-missing' }
    }
    const chunks = splitForNtfy(options.message, this.chunkBytes())
    const messages = chunks.map((message, index) => ({
      message,
      // 动作按钮只挂在第一条上：按钮是「对这条通知的动作」，跟着续片没有意义。
      actions: index === 0 ? options.actions : undefined,
    }))
    return await this.sendMessages(sessionId, server, messages, {
      topic: options.topic ?? binding.topic,
      title: options.title,
      priority: options.priority,
      tags: [...new Set([...(options.tags ?? []), MARKER_TAG])],
      // 不设 click：通知本来就在会话话题里，点开就是该话题，直接打字即可。
      // 附带好处是摆脱了 ntfy:// 深链接的「Android 专有」限制。
      click: options.click,
    })
  }

  /**
   * 记住刚推送出去的正文，作为「自己回自己」的第二道兜底。
   *
   * 一次推送可能分很多片（见 sendMessages），所以名单长度必须盖得住分片数，
   * 否则后面几片穿过去会被当成用户输入。
   *
   * @param {string} sessionId 会话 id
   * @param {string} text 已推送的正文
   */
  rememberOwnText(sessionId, text) {
    const list = this.recentOwn.get(sessionId) ?? []
    list.push(text)
    if (list.length > OWN_TEXT_MEMORY) list.splice(0, list.length - OWN_TEXT_MEMORY)
    this.recentOwn.set(sessionId, list)
  }

  /**
   * 判断一条入站正文是不是我们自己刚推出去的回声。
   *
   * 单话题下插件必然收到自己发的通知（服务器会原样推回）。主防线是消息里的
   * MARKER_TAG；这里是第二道防线：正文与最近推送过的完全一致即判定为回声。
   * 两道防线都失效会导致「自己回自己」的无限循环，所以不省。
   *
   * @param {string} sessionId 会话 id
   * @param {string} text 入站正文
   * @returns {boolean}
   */
  isOwnEcho(sessionId, text) {
    const list = this.recentOwn.get(sessionId)
    return list !== undefined && list.includes(text)
  }

  /**
   * 消费「手机刚发起过 /stop」的标记：命中就跳过这一次中断推送。
   *
   * 标记用掉即删；超过 {@link CANCEL_QUIET_MS} 的陈旧标记直接丢弃，否则一次没等到
   * `turn/end` 的取消会吞掉之后真正的异常中断。
   *
   * @param {string} sessionId 会话 id
   * @returns {boolean} 是否压掉这次推送
   */
  consumePhoneCancel(sessionId) {
    const at = this.phoneCancels.get(sessionId)
    if (at === undefined) return false
    this.phoneCancels.delete(sessionId)
    if (Date.now() - at > CANCEL_QUIET_MS) return false
    log(`outbound: 跳过手机 /stop 引发的中断推送 session=${sessionId}`)
    return true
  }

  /**
   * 处理一条 DSH 会话事件。
   *
   * @param {{id: string, header?: {parentSession?: string, origin?: string, cwd?: string}}} session 会话
   * @param {{type: string, data?: any}} event 事件
   */
  onSessionEvent(session, event) {
    if (!this.isCurrent()) return
    if (event?.type === 'assistant/message') {
      this.rememberAssistant(session.id, event.data?.message)
      return
    }
    if (event?.type !== 'turn/end') return

    const sessionId = session.id
    if (!this.isEnabled(sessionId)) return
    // 子 agent 的回合也会触发 turn/end；一并推送会把手机刷爆。
    if (session.header?.parentSession !== undefined || session.header?.origin === 'subagent') return
    // 手机续聊那一轮的回复由 executeTurn 推回，这里不能再推一次。
    if (this.inflight.has(sessionId)) return

    const reason = event.data?.reason
    if (reason?.kind === 'completed') {
      if (this.pref(sessionId, 'notifyOnTurnEnd') !== true) return
      const text = this.lastAssistant.get(sessionId)
      void this.notify(sessionId, {
        title: this.labelFor(sessionId),
        message: text === undefined ? '（本轮没有文本输出）' : text,
      }).catch((error) => log(`outbound: 回合推送失败 ${describeError(error)}`))
      return
    }

    if (isUserInitiatedCancel(reason)) return
    if (this.consumePhoneCancel(sessionId)) return
    if (this.pref(sessionId, 'notifyOnError') !== true) return
    void this.notify(sessionId, {
      title: `${this.labelFor(sessionId)} · 中断`,
      message: describeTurnEnd(reason),
      priority: 4,
    }).catch((error) => log(`outbound: 异常推送失败 ${describeError(error)}`))
  }

  /**
   * 处理一条 ntfy 入站消息。
   *
   * 顺序：过滤自己的消息 → 过滤重复 → 结构化回执（按钮）→ 自由文本回答待决请求
   * → 文本指令 → 注入会话。
   *
   * @param {string} serverId 消息来自哪个服务器
   * @param {{id: string, time: number, topic: string, message: string, tags?: string[]}} event ntfy 事件
   */
  async handleInbound(serverId, event) {
    const entry = this.topicIndex.get(event.topic)
    if (entry === undefined || entry.serverId !== serverId) return
    // 主防线：与时间无关的标记过滤（见 MARKER_TAG 注释）。
    if (Array.isArray(event.tags) && event.tags.includes(MARKER_TAG)) return
    // 第二道防线：正文与刚推送出去的通知完全一致。
    if (this.isOwnEcho(entry.sessionId, event.message)) {
      log(`inbound: 命中自我回声兜底，已忽略 session=${entry.sessionId}`)
      return
    }
    if (this.state.ownIds.includes(event.id)) return
    if (this.state.processedIds.includes(event.id)) return

    rememberId(this.state.processedIds, event.id)
    this.state.lastSeenTs = Math.max(Number(this.state.lastSeenTs) || 0, Number(event.time) || 0)
    this.saver.schedule()

    const payload = parseNtfyMessage(event.message)
    if (payload !== null && typeof payload === 'object') {
      if (typeof payload.requestId === 'string' && this.settlePending(payload.requestId, payload)) return
    }

    const text = typeof payload === 'string' ? payload : String(payload.answer ?? payload.text ?? event.message)
    if (this.settlePendingByText(entry.sessionId, text)) return
    await this.handleUserText(entry.sessionId, text, event.topic)
  }

  /**
   * 用结构化回执（按钮点击）结算一个待决请求。
   *
   * @param {string} requestId 请求 id
   * @param {object} payload 回执内容
   * @returns {boolean} 是否命中
   */
  settlePending(requestId, payload) {
    const pending = this.pending.get(requestId)
    if (pending === undefined) return false
    pending.finish(payload)
    return true
  }

  /**
   * 用自由文本结算该会话唯一待决的请求。
   *
   * 有多个待决请求时不敢猜（可能答错问题），放行成普通消息。
   *
   * @param {string} sessionId 会话 id
   * @param {string} text 用户文本
   * @returns {boolean} 是否命中
   */
  settlePendingByText(sessionId, text) {
    const matches = [...this.pending.values()].filter((item) => item.sessionId === sessionId)
    if (matches.length !== 1) return false
    matches[0].finish({ answer: text })
    return true
  }

  /**
   * 发一条或多条需要手机作答的通知，并等待回执。
   *
   * 超时、推送失败或请求被取消都返回 null，由调用方回落 DSH 原生交互。
   *
   * @param {string} sessionId 会话 id
   * @param {{title: string, kind: string, parts: {message: string, buttons?: {label: string, value: object}[]}[], signal?: AbortSignal}} options 请求内容
   * @returns {Promise<object | null>} 回执内容，或 null 表示回落
   */
  async requestDecision(sessionId, options) {
    const requestId = randomUUID()
    const binding = this.state.sessions[sessionId]
    const server = this.serverFor(sessionId)
    if (server === null || binding === undefined) return null

    // 把 parts 展开成待发消息：每条正文各自按字节分片；按钮只挂在该 part 的
    // 最后一片上（切出来的续片是纯正文，没有可点的东西）。
    const messages = []
    for (const part of options.parts) {
      const chunks = splitForNtfy(part.message, this.chunkBytes())
      const buttons = Array.isArray(part.buttons) ? part.buttons : []
      const usable = buttons.length > 0 && buttons.length <= MAX_ACTION_BUTTONS
      const actions = usable ? buildActionButtons(server, binding.topic, requestId, buttons) : undefined
      chunks.forEach((message, index) => {
        const isLast = index === chunks.length - 1
        messages.push({ message, actions: isLast ? actions : undefined })
      })
    }
    if (messages.length === 0) return null

    // **先挂上待决请求，再发消息。**
    //
    // 分片之间有 1.1 秒间隔，而按钮挂在**内容最后一块**上——倒序发送时它恰好是
    // 最先送达的那一条。用户完全可能在剩余分片还在路上时就点了按钮。如果像以前
    // 那样等 sendMessages 全部发完才登记，这条回执会被 settlePending 漏掉、当成
    // 普通消息注入会话，而请求继续空等到超时再回落原生（集成测试稳定复现：
    // 只收到 1 条分片、答案是 null）。
    const decision = this.waitForDecision(requestId, sessionId, options.kind, options.signal)

    const sent = await this.sendMessages(sessionId, server, messages, {
      topic: binding.topic,
      title: options.title,
      priority: 4,
      tags: [MARKER_TAG],
    })
    if (!sent.ok) {
      // 一条都没发出去：撤掉等待，免得白挂一个到超时的请求。
      this.cancelDecision(requestId)
      return null
    }

    return await decision
  }

  /**
   * 撤销一个尚未结算的待决请求（等同超时）。
   *
   * @param {string} requestId 请求 id
   */
  cancelDecision(requestId) {
    const pending = this.pending.get(requestId)
    if (pending === undefined) return
    pending.finish(null)
  }

  /**
   * 等待一个待决请求被结算。
   *
   * @param {string} requestId 请求 id
   * @param {string} sessionId 会话 id
   * @param {string} kind 请求类型（日志用）
   * @param {AbortSignal} [signal] 请求自身的取消信号
   * @returns {Promise<object | null>}
   */
  waitForDecision(requestId, sessionId, kind, signal) {
    const timeoutMs = Math.max(5, Number(this.pref(sessionId, 'relayTimeoutSec')) || 180) * 1000
    return new Promise((resolve) => {
      const finish = (value) => {
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', onAbort)
        this.pending.delete(requestId)
        resolve(value)
      }
      const onAbort = () => finish(null)
      const timer = setTimeout(() => {
        log(`relay: ${kind} 请求超时（${timeoutMs / 1000}s），回落原生交互`)
        finish(null)
      }, timeoutMs)

      this.pending.set(requestId, { sessionId, kind, finish })

      if (signal?.aborted === true) {
        finish(null)
        return
      }
      signal?.addEventListener?.('abort', onAbort, { once: true })
      log(`relay: 等待手机作答 kind=${kind} session=${sessionId}`)
    })
  }

  /**
   * 拦截审批请求：手机上 Approve/Deny，超时回落原生审批链。
   *
   * @param {{agent?: {id: string}, toolName?: string, reason?: string, signal?: AbortSignal}} req 审批请求
   * @param {() => Promise<string>} next 交给原生链
   * @returns {Promise<string>} ApprovalOutcome
   */
  async handleApproval(req, next) {
    const agent = req?.agent
    log(`approval: 收到审批请求 session=${agent?.id ?? '(无 agent)'} tool=${req?.toolName ?? '?'} enabled=${agent === undefined ? '-' : this.isEnabled(agent.id)}`)
    if (agent === undefined || !this.isEnabled(agent.id)) return await next()
    if (this.pref(agent.id, 'notifyOnPending') !== true || this.pref(agent.id, 'phonePriority') !== true) {
      log('approval: 该会话未开启手机优先，回落原生链')
      return await next()
    }

    const toolName = req.toolName ?? '未知工具'
    try {
      const decision = await this.requestDecision(agent.id, {
        title: `${this.labelFor(agent.id)} · 权限请求`,
        kind: 'approval',
        signal: req.signal,
        parts: [{
          message: req.reason ?? `工具 ${toolName} 请求权限`,
          buttons: [
            { label: 'Approve', value: { approved: true } },
            { label: 'Deny', value: { approved: false } },
          ],
        }],
      })
      if (decision === null) return await next()
      if (decision.approved === false) return 'rejected'
      if (decision.approved === true) return 'allowed-once'
      const text = String(decision.answer ?? '').trim()
      return /^(y|yes|ok|approve|allow|1|是|同意|允许)$/i.test(text) ? 'allowed-once' : 'rejected'
    } catch (error) {
      log(`relay: 审批处理失败，回落原生 ${describeError(error)}`)
      return await next()
    }
  }

  /**
   * 拦截 `ask_user_question`：手机点选或文字作答，超时回落原生提问。
   *
   * @param {{name: string, arguments?: any, agent?: {id: string}}} exec 工具调用
   * @param {() => Promise<any>} next 交给原生工具
   * @returns {Promise<any>} 工具结果
   */
  async handleAskUserQuestion(exec, next) {
    if (exec?.name !== 'ask_user_question') return await next()
    const agent = exec.agent
    log(`question: 收到提问 session=${agent?.id ?? '(无 agent)'} enabled=${agent === undefined ? '-' : this.isEnabled(agent.id)}`)
    if (agent === undefined || !this.isEnabled(agent.id)) return await next()
    if (this.pref(agent.id, 'notifyOnPending') !== true || this.pref(agent.id, 'phonePriority') !== true) return await next()

    const questions = Array.isArray(exec.arguments?.questions) ? exec.arguments.questions : []
    // 没有选项的提问无法在手机上作答（只能自由输入），不进这一轮，交给 DSH 原生交互。
    // 先滤出来是为了让「第 k/n 问」的 n 反映真正会问几道，而不是含被跳过的那些。
    const askable = questions.filter((question) => Array.isArray(question.options) && question.options.length > 0)
    if (askable.length === 0) return await next()

    try {
      const answers = []
      for (const [index, question] of askable.entries()) {
        const options = question.options
        const multi = question.multi_select === true

        const decision = await this.requestDecision(agent.id, {
          title: `${this.labelFor(agent.id)} · 提问`,
          kind: 'question',
          parts: buildQuestionParts(question, options, { index, total: askable.length }),
        })
        if (decision === null) return await next()

        const answer = String(decision.answer ?? '').trim()
        if (multi) {
          const selected = []
          for (const token of splitAnswerTokens(answer)) {
            const label = matchOption(token, options)
            if (label !== undefined && !selected.includes(label)) selected.push(label)
          }
          answers.push(selected.length === 0 ? { id: question.id, selected: [], custom: answer } : { id: question.id, selected })
          continue
        }

        // 单选：编号与标签都要能还原。现在单选一律带按钮，但用户照样可能直接回
        // 编号，所以不能再像旧实现那样「有按钮就只按标签精确匹配」——那样回
        // 「1」会落成 custom，答案就变了味。
        const label = matchOption(answer, options)
        answers.push(label === undefined ? { id: question.id, selected: [], custom: answer } : { id: question.id, selected: [label] })
      }

      if (answers.length === 0) return await next()
      const value = { answers }
      return { isError: false, value, content: [{ type: 'text', text: JSON.stringify(value) }] }
    } catch (error) {
      log(`relay: 提问处理失败，回落原生 ${describeError(error)}`)
      return await next()
    }
  }

  /**
   * 处理手机发来的文本：先识别文本指令，否则作为用户消息注入会话。
   *
   * @param {string} sessionId 会话 id
   * @param {string} rawText 原始文本
   */
  async handleUserText(sessionId, rawText) {
    const text = String(rawText ?? '').trim()
    if (text === '') return

    const command = /^\/([a-z][a-z0-9_-]*)\s*([\s\S]*)$/i.exec(text)
    if (command !== null) {
      const [, name, argument] = command
      const handled = await this.runTextCommand(sessionId, name.toLowerCase(), argument.trim())
      if (handled) return
    }

    const agents = this.ctx.get('agents')
    const agent = agents?.get?.(sessionId)
    if (agent === undefined || agent === null) {
      // 区分「只是没打开」和「已经被删掉」：后者要立刻断开桥接，否则会一直留着
      // 一条订阅这个会话话题的僵尸连接。
      const gone = await this.isSessionGone(sessionId)
      await this.notify(sessionId, {
        title: this.labelFor(sessionId),
        message: gone
          ? '这个会话已经被删除了，桥接已断开。'
          : '这个会话当前不在运行中，无法注入消息。请先在 DSH 里打开它。',
      })
      if (gone) {
        delete this.state.sessions[sessionId]
        this.missingSweeps.delete(sessionId)
        this.resync()
      }
      return
    }
    await this.executeTurn(agent, text)
  }

  /**
   * 执行一轮手机发起的续聊：注入消息 → 等回合结束 → 把回复推回原话题。
   *
   * @param {{id: string, session: any, followup: (message: object) => void, whenIdle: () => Promise<void>}} agent 目标 agent
   * @param {string} text 用户消息
   */
  async executeTurn(agent, text) {
    const session = agent.session
    const boundarySeq = typeof session?.seq === 'number' ? session.seq : 0
    this.inflight.add(agent.id)
    try {
      agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      })
      await agent.whenIdle()

      let events = []
      try {
        events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents(boundarySeq) : (session.events ?? [])
      } catch (error) {
        log(`inbound: 读取会话事件失败 ${describeError(error)}`)
      }
      const { reply, reasonKind } = extractReply(events, boundarySeq)

      if (reply !== null) {
        await this.notify(agent.id, { title: this.labelFor(agent.id), message: reply })
      } else if (this.consumePhoneCancel(agent.id)) {
        // 手机自己发的 /stop：这一轮不再回推一条中断通知。
      } else if (reasonKind !== null && reasonKind !== 'completed') {
        await this.notify(agent.id, {
          title: `${this.labelFor(agent.id)} · 中断`,
          message: describeTurnEnd({ kind: reasonKind }),
          priority: 4,
        })
      } else {
        await this.notify(agent.id, { title: this.labelFor(agent.id), message: '（本轮没有文本输出）' })
      }
    } catch (error) {
      log(`inbound: 续聊失败 ${describeError(error)}`)
      await this.notify(agent.id, {
        title: `${this.labelFor(agent.id)} · 失败`,
        message: `续聊失败：${describeError(error)}`,
        priority: 4,
      }).catch(() => {})
    } finally {
      this.inflight.delete(agent.id)
    }
  }

  /**
   * 执行手机发来的文本指令。返回 true 表示已处理，不再当作聊天内容。
   *
   * @param {string} sessionId 会话 id
   * @param {string} name 指令名（不含斜杠）
   * @param {string} argument 指令参数
   * @returns {Promise<boolean>}
   */
  async runTextCommand(sessionId, name, argument) {
    if (name === 'help') {
      await this.notify(sessionId, {
        title: this.labelFor(sessionId),
        message: ['可用指令：', '/stop — 中止当前回合', '/status — 查看会话与桥接状态', '/key — 显示本会话话题', '/help — 显示本帮助'].join('\n'),
      })
      return true
    }
    if (name === 'status' || name === 'key') {
      const binding = this.state.sessions[sessionId]
      const server = this.serverFor(sessionId)
      const agents = this.ctx.get('agents')
      const live = agents?.get?.(sessionId) !== undefined
      const lines = [
        `桥接：${this.isEnabled(sessionId) ? '已开启' : '已关闭'}`,
        `会话：${live ? '运行中' : '不在内存中'}`,
        `服务器：${server === null ? '（已失效）' : `${server.name} — ${server.url}`}`,
        `话题：${binding?.topic ?? '(未分配)'}`,
      ]
      if (server !== null && binding?.topic !== undefined) {
        lines.push(`订阅地址：${topicUrl(server.url, binding.topic)}`)
      }
      await this.notify(sessionId, { title: this.labelFor(sessionId), message: lines.join('\n') })
      return true
    }
    if (name === 'stop') {
      const agents = this.ctx.get('agents')
      const agent = agents?.get?.(sessionId)
      if (agent === undefined || agent === null) {
        await this.notify(sessionId, { title: this.labelFor(sessionId), message: '会话不在运行中，无需中止。' })
        return true
      }
      // 记下这次取消是手机发起的：它产生的 aborted 没有嵌套原因，压掉那条「回合中断：unknown」。
      this.phoneCancels.set(sessionId, Date.now())
      agent.cancel({ kind: 'user' })
      await this.notify(sessionId, { title: this.labelFor(sessionId), message: '已请求中止当前回合。' })
      return true
    }
    return false
  }

  /**
   * 处理 DSH 里的 `/ntfy` 命令。
   *
   * 用法：`/ntfy on [服务器名]`、`/ntfy off`、`/ntfy key`、`/ntfy status`、
   * `/ntfy servers`、`/ntfy test`。首次 `on` 时可用服务器名指定绑定，之后不可变更。
   *
   * @param {{agent: {id: string, session?: {header?: {cwd?: string}}}, rawInput: string}} invocation 命令调用
   * @returns {{kind: 'success' | 'error', text: string}}
   */
  handleCommand(invocation) {
    const sessionId = invocation.agent.id
    const raw = String(invocation.rawInput ?? '').trim()
    const [verb = '', ...rest] = raw.split(/\s+/)
    const argument = rest.join(' ').trim()
    const cwd = invocation.agent.session?.header?.cwd

    if (verb === 'on') {
      let serverId
      if (argument !== '') {
        const named = this.config.servers.find((item) => item.name.toLowerCase() === argument.toLowerCase())
        if (named === undefined) {
          return { kind: 'error', text: `找不到服务器「${argument}」。可用：${this.config.servers.map((s) => s.name).join('、')}` }
        }
        serverId = named.id
      }
      const result = this.enable(sessionId, { serverId, cwd })
      if (!result.ok) {
        if (result.error === 'server-immutable') {
          const bound = findServer(this.config, result.serverId)
          return { kind: 'error', text: `本会话已绑定服务器「${bound?.name ?? result.serverId}」，绑定后不可变更。` }
        }
        return { kind: 'error', text: `开启失败：${result.error}` }
      }
      const server = findServer(this.config, result.info.serverId)
      return {
        kind: 'success',
        text: [
          `已开启 ntfy 桥接。`,
          `服务器：${server?.name} — ${server?.url}`,
          `话题：${result.info.topic}`,
          `手机订阅：${server === null ? '(服务器缺失)' : topicUrl(server.url, result.info.topic)}`,
        ].join('\n'),
      }
    }
    if (verb === 'off') {
      const was = this.disable(sessionId)
      return { kind: 'success', text: was ? '已关闭 ntfy 桥接（服务器绑定保留）。' : '这个会话本来就没开启桥接。' }
    }
    if (verb === 'key') {
      const binding = this.state.sessions[sessionId]
      if (binding === undefined) return { kind: 'success', text: '本会话尚未开启过桥接。' }
      const server = this.serverFor(sessionId)
      return {
        kind: 'success',
        text: `话题：${binding.topic}\n订阅地址：${server === null ? '(服务器缺失)' : topicUrl(server.url, binding.topic)}`,
      }
    }
    if (verb === 'servers') {
      return {
        kind: 'success',
        text: this.config.servers
          .map((s) => `${s.id === this.config.defaultServerId ? '★ ' : '  '}${s.name} — ${s.url}${s.token === '' ? '' : '（带 token）'}`)
          .join('\n'),
      }
    }
    if (verb === 'test') {
      void this.notify(sessionId, { title: this.labelFor(sessionId), message: '这是一条来自 dsh-ntfy-remote 的测试消息。' })
      return { kind: 'success', text: '已发送测试消息，请查看手机。' }
    }
    if (verb === '' || verb === 'status') {
      const binding = this.state.sessions[sessionId]
      const server = this.serverFor(sessionId)
      return {
        kind: 'success',
        text: [
          `桥接：${this.isEnabled(sessionId) ? '已开启' : '已关闭'}`,
          `绑定服务器：${server === null ? '（未绑定 / 已失效）' : `${server.name} — ${server.url}`}`,
          `话题：${binding?.topic ?? '(未分配)'}`,
          `服务器总数：${this.config.servers.length}`,
          `已开启会话数：${this.enabledCount()}`,
          `作答超时：${this.pref(sessionId, 'relayTimeoutSec')}s · 手机优先：${this.pref(sessionId, 'phonePriority') ? '是' : '否'}` + (binding?.prefs && Object.keys(binding.prefs).length > 0 ? '（本会话有单独设置）' : '（跟随全局默认）'),
          '',
          '用法：/ntfy on [服务器名] | off | key | status | servers | test',
        ].join('\n'),
      }
    }
    return { kind: 'error', text: `未知参数「${verb}」。用法：/ntfy on [服务器名] | off | key | status | servers | test` }
  }
}
