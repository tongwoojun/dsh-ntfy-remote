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
const { MAX_CATCHUP_SEC, createSubscriber, normalizeServer, publish } = await import(`./ntfy.js${VERSION}`)
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
   * 核对已开启桥接的会话是否仍然存在，把已被删除的会话的桥接主动断开。
   *
   * 为什么不能直接用 `session/disposed`：用户在界面里关掉会话时 agent 同样会被
   * 拆掉并触发该事件，但会话本身还在磁盘上。所以判定删除必须**同时**满足不在
   * 内存里、且不在持久化列表里。
   *
   * @returns {Promise<void>}
   */
  async sweepMissingSessions() {
    const bound = Object.keys(this.state.sessions)
    if (bound.length === 0) return
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

    let changed = false
    for (const sessionId of bound) {
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
    if (changed) this.resync()
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
   * 推送通知用的会话标签。
   *
   * @param {string} sessionId 会话 id
   * @returns {string}
   */
  labelFor(sessionId) {
    const cwd = this.state.sessions[sessionId]?.cwd
    const dir = typeof cwd === 'string' && cwd !== '' ? cwd.split(/[\\/]/).filter(Boolean).pop() : undefined
    const short = shortSessionId(sessionId)
    return dir === undefined ? `DSH · ${short}` : `DSH · ${dir} · ${short}`
  }

  /**
   * 按长度上限截断正文。
   *
   * @param {string} text 原文
   * @returns {string}
   */
  truncate(text) {
    const max = Number(this.config.defaults.maxMessageLength) || 3500
    const value = String(text ?? '')
    return value.length <= max ? value : `${value.slice(0, max)}\n…（已截断 ${value.length - max} 字）`
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
   * @param {string} sessionId 会话 id
   * @param {{title?: string, message: string, priority?: number, tags?: string[], actions?: object[], topic?: string, click?: string}} options 通知内容
   * @returns {Promise<{ok: boolean, id?: string | null, error?: string}>}
   */
  async notify(sessionId, options) {
    if (!this.isCurrent()) return { ok: false, error: 'stale' }
    const binding = this.state.sessions[sessionId]
    const server = this.serverFor(sessionId)
    if (server === null || binding === undefined) {
      log(`outbound: 会话 ${sessionId} 没有可用的服务器绑定，跳过推送`)
      return { ok: false, error: 'server-missing' }
    }
    const topic = options.topic ?? binding.topic
    const result = await publish(server, {
      topic,
      title: options.title,
      message: this.truncate(options.message),
      priority: options.priority,
      tags: [...new Set([...(options.tags ?? []), MARKER_TAG])],
      actions: options.actions,
      // 不设 click：通知本来就在会话话题里，点开就是该话题，直接打字即可。
      // 附带好处是摆脱了 ntfy:// 深链接的「Android 专有」限制。
      click: options.click,
    })
    if (result.ok) {
      this.rememberOwn(result.id)
      // 回环兜底：记住刚推送出去的正文（见 isOwnEcho）。
      this.rememberOwnText(sessionId, this.truncate(options.message))
    }
    return result
  }

  /**
   * 记住刚推送出去的正文，作为「自己回自己」的第二道兜底。
   *
   * @param {string} sessionId 会话 id
   * @param {string} text 已推送的正文
   */
  rememberOwnText(sessionId, text) {
    const list = this.recentOwn.get(sessionId) ?? []
    list.push(text)
    if (list.length > 3) list.splice(0, list.length - 3)
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
   * 发一条需要手机作答的通知，并等待回执。
   *
   * 超时、推送失败或请求被取消都返回 null，由调用方回落 DSH 原生交互。
   *
   * @param {string} sessionId 会话 id
   * @param {{title: string, message: string, kind: string, buttons?: {label: string, value: object}[], signal?: AbortSignal}} options 请求内容
   * @returns {Promise<object | null>} 回执内容，或 null 表示回落
   */
  async requestDecision(sessionId, options) {
    const requestId = randomUUID()
    const binding = this.state.sessions[sessionId]
    const server = this.serverFor(sessionId)
    if (server === null || binding === undefined) return null

    const buttons = options.buttons ?? []
    const usable = buttons.length > 0 && buttons.length <= MAX_ACTION_BUTTONS
    const actions = usable
      ? buttons.map((button) => ({
          action: 'http',
          label: button.label,
          url: `${normalizeServer(server.url)}/${binding.topic}`,
          method: 'POST',
          clear: false,
          body: JSON.stringify({ requestId, ...button.value }),
        }))
      : undefined

    const hint = usable ? '\n\n点按钮，或直接在本话题回复。' : '\n\n选项较多，请回复编号，或直接在本话题回复文字。'

    const sent = await this.notify(sessionId, {
      title: options.title,
      message: `${options.message}${hint}`,
      priority: 4,
      tags: [MARKER_TAG],
      actions,
    })
    if (!sent.ok) return null

    return await this.waitForDecision(requestId, sessionId, options.kind, options.signal)
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
        message: req.reason ?? `工具 ${toolName} 请求权限`,
        kind: 'approval',
        signal: req.signal,
        buttons: [
          { label: 'Approve', value: { approved: true } },
          { label: 'Deny', value: { approved: false } },
        ],
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
    if (questions.length === 0) return await next()

    try {
      const answers = []
      for (const question of questions) {
        const options = Array.isArray(question.options) ? question.options : []
        // 没有选项的提问无法在手机上作答（只能自由输入），交给 DSH 原生交互。
        if (options.length === 0) continue

        const useButtons = options.length <= MAX_ACTION_BUTTONS
        const lines = [question.question ?? '提问']
        options.forEach((option, index) => lines.push(`${index + 1}. ${option.label}`))
        const decision = await this.requestDecision(agent.id, {
          title: `${this.labelFor(agent.id)} · 提问`,
          message: lines.join('\n'),
          kind: 'question',
          buttons: useButtons ? options.map((option) => ({ label: option.label, value: { answer: option.label } })) : undefined,
        })
        if (decision === null) return await next()

        let answer = String(decision.answer ?? '').trim()
        if (!useButtons) {
          const index = Number(answer)
          if (Number.isInteger(index) && index >= 1 && index <= options.length) {
            answer = options[index - 1].label
          }
        }
        const matched = options.find((option) => option.label === answer)
        answers.push(matched === undefined ? { id: question.id, selected: [], custom: answer } : { id: question.id, selected: [matched.label] })
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
