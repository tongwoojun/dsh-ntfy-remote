// 话题命名。
//
// 规则（按产品要求）：**每个会话一个话题，直接用完整会话 id，不掺密钥**。
//   session-81c90a63-c212-4a67-a7c4-1b84c1e1bb0a
//     → dsh_session-81c90a63-c212-4a67-a7c4-1b84c1e1bb0a
//
// 单话题（双向）：插件往它推送通知，也订阅它接收回复。不再有 `_response` 话题——
// 通知本身就在这个话题里，点开即可打字，不需要深链接，iOS 也能用。
//
// 代价：插件会收到自己发出的通知，必须靠消息里的固定标记过滤（见 bridge.js 的
// MARKER_TAG），否则会把自己的通知当成用户输入而形成无限回环。
//
// 长度：`dsh_` 4 + 会话 id 44 = 48，在 ntfy 的 64 上限内。
// 注意：加一个 16 位密钥就是 65，**已超限**，所以话题名必然可从会话 id 推导，
// 安全上必须依赖 ntfy 服务端的访问控制。详见 README。
//
// 版本透传：外壳用 ?v= 重新加载时，整张模块图都要重新求值（见 boot3.js）。

/** ntfy 话题字符集与长度限制。 */
const TOPIC_RE = /^[-_A-Za-z0-9]{1,64}$/

/** 话题前缀。 */
const TOPIC_PREFIX = 'dsh'

/** 会话短 id 的长度（仅用于界面标签，不进入话题名）。 */
const SHORT_ID_LENGTH = 8

/**
 * 校验并返回话题名；不合法直接抛错（配置错误要吵，不能静默发到错地方）。
 *
 * @param {string} topic 话题名
 * @returns {string}
 */
export function assertTopic(topic) {
  if (typeof topic !== 'string' || !TOPIC_RE.test(topic)) {
    throw new Error(`非法 ntfy 话题名: ${JSON.stringify(topic)}`)
  }
  return topic
}

/**
 * 取会话短 id：`session-913ed2d1-...` → `913ed2d1`。仅用于界面标签。
 *
 * @param {string} sessionId 会话 id
 * @returns {string}
 */
export function shortSessionId(sessionId) {
  const text = String(sessionId ?? '')
  const bare = text.startsWith('session-') ? text.slice('session-'.length) : text
  return bare.slice(0, SHORT_ID_LENGTH)
}

/**
 * 某会话的话题（出站推送与入站回复共用同一个）。
 *
 * @param {string} sessionId 会话 id
 * @returns {string}
 */
export function topicFor(sessionId) {
  return assertTopic(`${TOPIC_PREFIX}_${sessionId}`)
}

/**
 * 话题在 ntfy Web 版里的地址（可点开查看）。
 *
 * @param {string} serverUrl 服务器根地址
 * @param {string} topic 话题名
 * @returns {string}
 */
export function topicUrl(serverUrl, topic) {
  return `${String(serverUrl ?? '').replace(/\/+$/, '')}/${topic}`
}

/**
 * 把 ntfy 消息正文解析成结构化内容。
 *
 * 按钮回执是 JSON 对象（如 `{requestId, approved}`）；纯数字自由文本
 * （如 `3`）必须保持字符串，否则 `JSON.parse('3')` 会把它变成数字而丢失。
 *
 * @param {string} raw ntfy 事件的 message 字段
 * @returns {object | string}
 */
export function parseNtfyMessage(raw) {
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : raw
  } catch {
    // 绝大多数手机回复都是普通文本，不是 JSON；原样返回才是正确语义。
    return raw
  }
}
