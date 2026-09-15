// ntfy 传输层：发布（一次 POST）+ 订阅（一条常驻 NDJSON 长连接）。
//
// 出站不需要常驻连接；入站必须常驻——这是 ntfy 的发布/订阅模型决定的，
// 没有「拉一条就走」的等价物（?poll=1 是缓存回放，不适合实时回复）。
//
// 多服务器：发布与订阅都接收一个服务器描述符 `{ url, token }`。每个服务器由
// Bridge 各建一个订阅器（见 bridge.js），因为一条连接只能连一个服务器。
//
// 版本透传：外壳用 ?v= 重新加载时，整张模块图都要重新求值（见 boot3.js）。

const VERSION = new URL(import.meta.url).search
const { describeError, log } = await import(`./log.js${VERSION}`)

const MIN_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 60_000
/** 重连补漏的时间上限：太久以前的回复没有意义，且回放会消耗服务器带宽配额。 */
const MAX_CATCHUP_SEC = 3_600

/**
 * ntfy 服务端 `message` 字段的硬上限（**字节**，不是字符）。
 *
 * 实测 ntfy.sh：4095 字节返回 200，4096 字节返回 HTTP 500（服务端 message-size-limit）。
 * 中文一个字 3 字节，所以单条上限换算下来只有约 1365 个汉字。发布前必须按字节
 * 分片（见 bridge.js 的 splitForNtfy），否则整条通知会被服务端拒收——而拒绝是
 * 静默的：publish 只返回 ok:false，调用方多半是 void，用户什么都收不到。
 *
 * 注意 title 不占这个额度（实测 4095 字节正文 + 300 字标题仍返回 200）。
 */
export const NTFY_MESSAGE_MAX_BYTES = 4095

/**
 * 判断一段正文按 UTF-8 编码有多少字节。
 *
 * @param {string} text 正文
 * @returns {number}
 */
function byteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf-8')
}

/**
 * 归一化服务器地址（去掉尾部斜杠，否则拼出的 URL 会多一道斜杠）。
 *
 * @param {string} url 服务器根地址
 * @returns {string}
 */
export function normalizeServer(url) {
  return String(url ?? '').replace(/\/+$/, '')
}

/**
 * 构造请求头；token 为空时不带 Authorization。
 *
 * @param {{token?: string}} server 服务器描述符
 * @param {boolean} json 是否带 JSON Content-Type
 * @returns {Record<string, string>}
 */
function headersFor(server, json) {
  const headers = {}
  if (json) headers['Content-Type'] = 'application/json'
  if (typeof server?.token === 'string' && server.token !== '') {
    headers.Authorization = `Bearer ${server.token}`
  }
  return headers
}

/**
 * 发布一条消息。
 *
 * 返回 ntfy 分配的 message id —— 这正是「记录自己发出去的消息」的依据。注意
 * 单靠 id 不可靠（见 bridge.js 的 MARKER_TAG 注释），所以消息里还会带固定标记。
 *
 * @param {{url: string, token?: string}} server 服务器描述符
 * @param {{topic: string, message: string, title?: string, priority?: number, tags?: string[], click?: string, actions?: object[], markdown?: boolean}} payload 消息内容
 * @returns {Promise<{ok: boolean, id?: string | null, status?: number, error?: string}>}
 */
export async function publish(server, payload) {
  const url = normalizeServer(server?.url)
  const message = String(payload.message ?? '')
  const size = byteLength(message)
  if (size > NTFY_MESSAGE_MAX_BYTES) {
    // 兜底防线：这是调用方的分片错误（splitForNtfy 的预算应该保证不会走到这里）。
    // 提前拦下比发出去吃一个语焉不详的 HTTP 500 更好定位。
    log(`ntfy: 正文 ${size} 字节超过上限 ${NTFY_MESSAGE_MAX_BYTES}，拒绝发送（分片有误）`)
    return { ok: false, error: 'message-too-large' }
  }

  const body = { topic: payload.topic, message }
  if (payload.title !== undefined) body.title = payload.title
  if (payload.priority !== undefined) body.priority = payload.priority
  if (payload.tags !== undefined) body.tags = payload.tags
  if (payload.click !== undefined) body.click = payload.click
  if (payload.actions !== undefined) body.actions = payload.actions
  // ntfy 默认按纯文本渲染；置 true 让客户端（安卓用 Markwon）把 markdown 渲染出来。
  // 服务端会在发布响应里回显 content_type: text/markdown 作为确认。
  if (payload.markdown !== undefined) body.markdown = payload.markdown
  // 同一个 sequence_id 再次发布，客户端会**替换**上一条通知（真机实测：通知栏与
  // 话题对话都收敛成一条）。必须走 JSON 字段——塞进 URL 路径的话 ntfy 不解析 JSON，
  // 整段 body 会被当成正文（实测踩过）。
  if (payload.sequenceId !== undefined) body.sequence_id = payload.sequenceId
  // 定时投递（死信开关）：到点才发；用同一个 sequence_id 再发 = 把投递时间往后推。
  if (payload.delay !== undefined) body.delay = payload.delay

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: headersFor(server, true),
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      log(`ntfy: 发布失败 HTTP ${response.status} ${text.slice(0, 200)}`)
      return { ok: false, status: response.status }
    }
    const data = await response.json().catch(() => null)
    return { ok: true, id: data?.id ?? null, status: response.status }
  } catch (error) {
    log(`ntfy: 发布异常 ${describeError(error)}`)
    return { ok: false, error: describeError(error) }
  }
}

/**
 * 按 sequence id 删除一条通知。
 *
 * ntfy 的 `DELETE /<topic>/<sequence_id>` 会向订阅者发一条 `message_delete` 事件，
 * 客户端据此把那条通知从**通知栏和本地库**里移除（真机实测：6 条一次清掉）。
 * 也用来**取消尚未投递的定时消息**——死信开关正常收尾时就靠它，否则告警会在
 * 回合结束后突然响起来。
 *
 * @param {{url: string, token?: string}} server 服务器描述符
 * @param {string} topic 话题
 * @param {string} sequenceId 序列 id
 * @returns {Promise<{ok: boolean, status?: number, error?: string}>}
 */
export async function removeMessage(server, topic, sequenceId) {
  const url = `${normalizeServer(server?.url)}/${topic}/${sequenceId}`
  try {
    const response = await fetch(url, { method: 'DELETE', headers: headersFor(server, false) })
    if (!response.ok) {
      log(`ntfy: 删除通知失败 HTTP ${response.status}（topic=${topic} seq=${sequenceId}）`)
      return { ok: false, status: response.status }
    }
    return { ok: true, status: response.status }
  } catch (error) {
    log(`ntfy: 删除通知异常 ${describeError(error)}`)
    return { ok: false, error: describeError(error) }
  }
}

/**
 * 可中止的 sleep；restart() 会打断等待中的退避，立即重连。
 *
 * @param {number} ms 毫秒
 * @param {AbortSignal} signal 中止信号
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 创建一个针对**单个服务器**的可重连、可重配话题的订阅器。
 *
 * @param {object} options 选项
 * @param {() => {url: string, token?: string}} options.getServer 当前服务器描述符（每轮重读，改配置后 restart 即生效）
 * @param {() => string[]} options.getTopics 当前要订阅的话题集合
 * @param {() => number} options.getSince 起始补漏时间点（Unix 秒，0 表示只收实时）
 * @param {(event: {id: string, time: number, topic: string, message: string, title?: string, tags?: string[]}) => void} options.onEvent 收到消息
 * @param {(status: string) => void} [options.onStatus] 连接状态变化（仅用于日志）
 * @returns {{start: () => void, stop: () => void, restart: () => void}}
 */
export function createSubscriber({ getServer, getTopics, getSince, onEvent, onStatus = () => {} }) {
  let stopped = false
  let generation = 0
  let controller = new AbortController()
  let attempt = 0
  let lastStatus = null

  /**
   * 只在状态真正变化时上报，避免空闲/重连时每轮刷屏。
   *
   * @param {string} status 状态描述
   */
  const report = (status) => {
    if (status === lastStatus) return
    lastStatus = status
    onStatus(status)
  }

  /** 读一条 NDJSON 流，逐行解析；连接结束或被中止时返回。 */
  async function readStream(url, signal) {
    const response = await fetch(url, { headers: headersFor(getServer(), false), signal })
    if (!response.ok || response.body === null) {
      throw new Error(`订阅失败 HTTP ${response.status}`)
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim() === '') continue
        let event
        try {
          event = JSON.parse(line)
        } catch {
          // 半行或服务端心跳的非 JSON 内容；按行缓冲会在下一轮补齐。
          continue
        }
        // open / keepalive 等事件没有 message 字段，跳过。
        // 放行两种事件：message（普通消息）与 message_delete（撤回）。
        // 后者是「用户在 App 里删掉了自己发的消息」的**唯一**信号——ntfy 把它广播给
        // 所有订阅者，`sequence_id` 就是被删消息的 id。划掉通知栏不算，那纯属本地行为。
        if (event.event === 'message_delete') {
          onEvent(event)
          continue
        }
        if (event.event !== 'message' || typeof event.message !== 'string') continue
        onEvent(event)
      }
    }
  }

  /** 主循环：连接 → 断线 → 退避 → 重连，直到 stop() 或 restart()。 */
  async function loop(myGeneration, signal) {
    while (!stopped && myGeneration === generation) {
      const server = getServer()
      const topics = getTopics()
      if (server === null || topics.length === 0) {
        report('idle: 没有待订阅的话题')
        try {
          await sleep(2_000, signal)
        } catch {
          return
        }
        continue
      }

      const since = getSince()
      const query = since > 0 ? `?since=${since}` : ''
      const url = `${normalizeServer(server.url)}/${topics.join(',')}/json${query}`
      try {
        report(`connecting: ${server.name ?? server.url} 的 ${topics.length} 个话题${query}`)
        await readStream(url, signal)
        report('stream ended')
      } catch (error) {
        if (stopped || myGeneration !== generation) return
        report(`error: ${describeError(error)}`)
      }

      if (stopped || myGeneration !== generation) return
      attempt += 1
      const delay = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** Math.min(attempt, 6))
      report(`reconnecting in ${delay}ms`)
      try {
        await sleep(delay, signal)
      } catch {
        return
      }
    }
  }

  return {
    start() {
      stopped = false
      attempt = 0
      controller = new AbortController()
      const myGeneration = ++generation
      void loop(myGeneration, controller.signal).catch((error) => {
        log(`ntfy: 订阅循环异常退出 ${describeError(error)}`)
      })
    },
    stop() {
      stopped = true
      generation += 1
      controller.abort()
    },
    restart() {
      generation += 1
      controller.abort()
      controller = new AbortController()
      const myGeneration = generation
      attempt = 0
      void loop(myGeneration, controller.signal).catch((error) => {
        log(`ntfy: 订阅循环异常退出 ${describeError(error)}`)
      })
    },
  }
}

export { MAX_CATCHUP_SEC }
