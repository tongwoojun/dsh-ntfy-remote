// 宿主侧 HTTP 路由：服务器管理、会话开关、**每会话偏好**与话题查询。
//
//   GET  /dsh-ntfy-remote                自包含状态页（无框架、无构建）
//   GET  /dsh-ntfy-remote/status         状态 JSON
//   GET  /dsh-ntfy-remote/session/qr     ?sessionId=… 该会话话题的二维码（SVG）
//   POST /dsh-ntfy-remote/toggle         { sessionId, enabled, serverId? }
//   POST /dsh-ntfy-remote/session/prefs  { sessionId, key, value }   value=null 表示恢复默认；
//                                        值按 key 校验类型/范围，与全局默认一致时等同于恢复默认
//   POST /dsh-ntfy-remote/session/unbind { sessionId }              清除服务器绑定（仅关闭状态可用）
//   POST /dsh-ntfy-remote/session/forget { sessionId }              删掉本插件里该会话的记录（不碰 DSH 会话）
//   POST /dsh-ntfy-remote/server/add     { name, url, token }
//   POST /dsh-ntfy-remote/server/update  { id, name?, url?, token? }
//   POST /dsh-ntfy-remote/server/delete  { id }                     有绑定时拒绝
//   POST /dsh-ntfy-remote/config         { 全局默认偏好 / defaultServerId }
//
// 版本透传：外壳用 ?v= 重新加载时，整张模块图都要重新求值（见 boot3.js）。

const VERSION = new URL(import.meta.url).search
const { describeError, log } = await import(`./log.js${VERSION}`)
const { PREF_KEYS, newServerId, normalizeServer, saveConfig } = await import(`./config.js${VERSION}`)
const { deepLink, clampHeartbeatSec } = await import(`./bridge.js${VERSION}`)
const { topicUrl } = await import(`./topics.js${VERSION}`)
const { qrSvg } = await import(`./qr.js${VERSION}`)

/** 路由前缀。 */
export const PREFIX = '/dsh-ntfy-remote'

/** 请求体大小上限。 */
const MAX_BODY_BYTES = 64 * 1024

/**
 * 读取并解析 JSON 请求体。
 *
 * @param {import('node:http').IncomingMessage} req 请求
 * @returns {Promise<any>}
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > MAX_BODY_BYTES) {
        req.destroy()
        reject(new Error('请求体过大'))
      }
    })
    req.on('end', () => {
      if (data.trim() === '') return resolve({})
      try {
        resolve(JSON.parse(data))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/**
 * 发送 JSON 响应。
 *
 * @param {import('node:http').ServerResponse} res 响应
 * @param {number} status HTTP 状态码
 * @param {unknown} body 响应体
 */
function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

/**
 * 汇总当前状态。
 *
 * @param {object} ctx cordis 上下文
 * @param {import('./bridge.js').Bridge} bridge 桥接实例
 * @returns {object}
 */
function snapshot(ctx, bridge) {
  const agents = ctx.get('agents')
  const live = new Set()
  for (const agent of agents?.list?.() ?? []) live.add(agent.id)

  const ids = new Set([...live, ...Object.keys(bridge.state.sessions)])
  const sessions = [...ids].map((id) => {
    const info = bridge.state.sessions[id]
    const server = bridge.serverFor(id)
    const topic = info?.topic ?? null
    // 生效偏好（单会话覆盖优先）与「哪些键被单独覆盖」分开返回，界面才能标出差异。
    const prefs = {}
    for (const key of PREF_KEYS) prefs[key] = bridge.pref(id, key)
    return {
      id,
      label: bridge.labelFor(id),
      live: live.has(id),
      // 有没有「记录」（绑定 / 开关 / 偏好）。界面只列有记录的行 —— 活着但没开过桥接的
      // 会话列进去也没有可管的东西，反而让「删除」看起来该对每行都有。
      recorded: info !== undefined,
      enabled: info?.enabled === true,
      serverId: info?.serverId ?? null,
      serverName: server?.name ?? null,
      serverMissing: info?.serverId !== undefined && server === null,
      topic,
      topicUrl: server === null || topic === null ? null : topicUrl(server.url, topic),
      // 仍留在 /status JSON 里供外部脚本使用；界面上一律不显示——通知本身就落在话题里，
      // 点开即回复，ntfy:// 深链接是多余的（见 README「不依赖 ntfy:// 深链接」）。
      deepLink: server === null || topic === null ? null : deepLink(server.url, topic),
      prefs,
      overrides: Object.keys(info?.prefs ?? {}),
    }
  })
  sessions.sort((a, b) => (a.enabled === b.enabled ? a.id.localeCompare(b.id) : a.enabled ? -1 : 1))

  return {
    servers: bridge.config.servers.map((s) => ({
      id: s.id,
      name: s.name,
      url: s.url,
      tokenSet: s.token !== '',
      boundSessions: bridge.bindingsForServer(s.id),
    })),
    defaultServerId: bridge.config.defaultServerId,
    defaults: bridge.config.defaults,
    prefKeys: PREF_KEYS,
    enabledCount: bridge.enabledCount(),
    sessions,
  }
}

/**
 * 会话话题的 `ntfy://` 深链接；未绑定、服务器已删除或还没有话题时返回 null。
 *
 * 与 `snapshot()` 里那个 `deepLink` 字段同一套判定，二维码路由复用它，避免两处
 * 各写一遍「什么时候算可订阅」。
 *
 * @param {import('./bridge.js').Bridge} bridge 桥接实例
 * @param {string} sessionId 会话 id
 * @returns {string | null}
 */
function sessionDeepLink(bridge, sessionId) {
  const topic = bridge.state.sessions[sessionId]?.topic ?? null
  const server = bridge.serverFor(sessionId)
  if (topic === null || server === null) return null
  return deepLink(server.url, topic)
}

/**
 * 注册全部路由。
 *
 * @param {object} ctx cordis 上下文
 * @param {import('./bridge.js').Bridge} bridge 桥接实例
 * @returns {() => void} 注销函数
 */
export function registerRoutes(ctx, bridge) {
  const disposers = []
  const own = (disposer) => {
    if (typeof disposer === 'function') disposers.push(disposer)
  }
  const route = (path, handler) => {
    own(ctx.webServer.register({ kind: 'exact', path: `${PREFIX}${path}`, handler }))
  }
  const post = (path, handler) =>
    route(path, async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
      try {
        const result = await handler(await readJsonBody(req))
        sendJson(res, result.status ?? 200, { ok: result.ok !== false, ...result.body })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: describeError(error) })
      }
    })

  route('', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(statusPage())
  })
  route('/status', (req, res) => {
    try {
      sendJson(res, 200, { ok: true, ...snapshot(ctx, bridge) })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: describeError(error) })
    }
  })

  // 会话话题的二维码：`<img>` 直接引用，内容就是 `ntfy://服务器/话题`，手机扫码即订阅。
  // 只认 sessionId、不认任意文本——否则这个端点就成了「把任何东西渲染成二维码」的公开
  // 工具，既没必要也容易被拿去当跳板。
  route('/session/qr', (req, res) => {
    const sessionId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('sessionId') ?? ''
    const link = sessionId === '' ? null : sessionDeepLink(bridge, sessionId)
    const svg = link === null ? null : qrSvg(link)
    if (svg === null) {
      // 链接本身来自我们自己的数据，超长只可能是配置出了怪服务器地址，按 500 报。
      if (link === null) return sendJson(res, 404, { ok: false, error: 'no-topic' })
      return sendJson(res, 500, { ok: false, error: 'qr-encode-failed' })
    }
    res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(svg)
  })

  post('/toggle', async (body) => {
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    if (sessionId === '') return { ok: false, status: 400, body: { error: 'missing-sessionId' } }
    if (body.enabled === true) {
      const agent = ctx.get('agents')?.get?.(sessionId)
      const result = bridge.enable(sessionId, {
        serverId: typeof body.serverId === 'string' && body.serverId !== '' ? body.serverId : undefined,
        cwd: agent?.session?.header?.cwd ?? bridge.state.sessions[sessionId]?.cwd,
      })
      if (!result.ok) return { ok: false, status: 409, body: { error: result.error, serverId: result.serverId } }
      return { body: { enabled: true, ...result.info } }
    }
    bridge.disable(sessionId)
    return { body: { enabled: false } }
  })

  post('/session/prefs', async (body) => {
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    const key = typeof body.key === 'string' ? body.key : ''
    if (sessionId === '' || !PREF_KEYS.includes(key)) return { ok: false, status: 400, body: { error: 'bad-session-or-key' } }

    // 值校验：布尔键只收布尔，超时只收 >= 5 的有限数字。`/config`（全局默认）本来就校验，
    // 这里不校验就会出现「界面显示 0 秒、实际按 180 秒算」这种显示与行为脱节，也会把
    // `"abc"` / `true` 这类垃圾写进 state.json。输入框失焦即提交，所以清空数字框
    // （浏览器提交 0）就能踩到。
    let value
    if (body.value === null) {
      value = undefined
    } else if (key === 'relayTimeoutSec') {
      if (!Number.isFinite(body.value) || body.value < 5) return { ok: false, status: 400, body: { error: 'bad-value' } }
      value = Math.floor(body.value)
    } else {
      if (typeof body.value !== 'boolean') return { ok: false, status: 400, body: { error: 'bad-value' } }
      value = body.value
    }

    // 与全局默认一致就没什么可覆盖的：当作恢复默认。否则 `overrides` 里会堆出
    // 一堆「值等于默认」的项，界面标蓝框却看不出差别。
    const redundant = value !== undefined && value === bridge.config.defaults[key]
    if (bridge.setPref(sessionId, key, redundant ? undefined : value) !== true) {
      return { ok: false, status: 404, body: { error: 'session-not-bound' } }
    }
    const stored = redundant || value === undefined ? null : value
    log(`routes: 会话 ${sessionId} 的 ${key} → ${JSON.stringify(stored)}${redundant ? '（与默认一致，未写覆盖）' : ''}`)
    return { body: { sessionId, key, value: stored } }
  })

  post('/session/unbind', async (body) => {
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    if (sessionId === '') return { ok: false, status: 400, body: { error: 'missing-sessionId' } }
    const result = bridge.unbind(sessionId)
    if (!result.ok) return { ok: false, status: 409, body: { error: result.error } }
    log(`routes: 会话 ${sessionId} 已解绑服务器`)
    return { body: { sessionId } }
  })

  post('/session/forget', async (body) => {
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    if (sessionId === '') return { ok: false, status: 400, body: { error: 'missing-sessionId' } }
    const removed = bridge.forget(sessionId)
    log(`routes: 会话 ${sessionId} 的记录已删除（删除前${removed ? '有' : '无'}记录）`)
    return { body: { sessionId, removed } }
  })

  post('/server/add', async (body) => {
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const url = typeof body.url === 'string' ? body.url.trim() : ''
    if (name === '' || url === '') return { ok: false, status: 400, body: { error: 'missing-name-or-url' } }
    const server = normalizeServer({ id: newServerId(), name, url, token: typeof body.token === 'string' ? body.token.trim() : '' })
    bridge.config.servers.push(server)
    saveConfig(bridge.config)
    log(`routes: 新增服务器 ${server.name} — ${server.url}`)
    return { body: { server: { id: server.id, name: server.name, url: server.url } } }
  })

  post('/server/update', async (body) => {
    const server = bridge.config.servers.find((item) => item.id === body.id)
    if (server === undefined) return { ok: false, status: 404, body: { error: 'server-not-found' } }
    if (typeof body.name === 'string' && body.name.trim() !== '') server.name = body.name.trim()
    if (typeof body.url === 'string' && body.url.trim() !== '') server.url = body.url.trim().replace(/\/+$/, '')
    // token 不传表示保持不变；传空字符串表示清空。
    if (typeof body.token === 'string') server.token = body.token.trim()
    saveConfig(bridge.config)
    bridge.resync()
    log(`routes: 更新服务器 ${server.name} — ${server.url}`)
    return { body: { server: { id: server.id, name: server.name, url: server.url } } }
  })

  post('/server/delete', async (body) => {
    const server = bridge.config.servers.find((item) => item.id === body.id)
    if (server === undefined) return { ok: false, status: 404, body: { error: 'server-not-found' } }
    if (bridge.config.servers.length <= 1) return { ok: false, status: 409, body: { error: 'last-server' } }
    // 绑定保护：还有会话绑着它就不允许删，否则那些会话会永久失去推送。
    const bound = bridge.bindingsForServer(server.id)
    if (bound > 0) return { ok: false, status: 409, body: { error: 'server-in-use', boundSessions: bound } }
    bridge.config.servers = bridge.config.servers.filter((item) => item.id !== server.id)
    if (bridge.config.defaultServerId === server.id) bridge.config.defaultServerId = bridge.config.servers[0].id
    saveConfig(bridge.config)
    bridge.resync()
    log(`routes: 删除服务器 ${server.name}`)
    return { body: { deleted: server.id } }
  })

  post('/config', async (body) => {
    const config = bridge.config
    for (const key of ['notifyOnTurnEnd', 'notifyOnPending', 'notifyOnError', 'phonePriority', 'notifyOnWebTurn']) {
      if (typeof body[key] === 'boolean') config.defaults[key] = body[key]
    }
    if (Number.isFinite(body.relayTimeoutSec) && body.relayTimeoutSec >= 5) config.defaults.relayTimeoutSec = Math.floor(body.relayTimeoutSec)
    // 心跳间隔：钳到允许范围（见 bridge.js 的 clampHeartbeatSec）。死信超时与卡住阈值
    // 都由它推导，所以这里只存这一个值。
    if (body.heartbeatSec !== undefined) config.defaults.heartbeatSec = clampHeartbeatSec(body.heartbeatSec)
    if (typeof body.defaultServerId === 'string' && config.servers.some((s) => s.id === body.defaultServerId)) {
      config.defaultServerId = body.defaultServerId
    }
    saveConfig(config)
    log('routes: 全局默认偏好已更新')
    return { body: {} }
  })

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch (error) {
        log(`routes: 注销失败 ${describeError(error)}`)
      }
    }
  }
}

/**
 * 自包含状态页：不依赖前端模块系统、不依赖构建。
 *
 * @returns {string} 完整 HTML
 */
function statusPage() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ntfy Remote — dsh-ntfy-remote</title>
<style>
 body{font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:24px;background:#fafafa;color:#222}
 h1{font-size:16px;margin:0 0 4px} h2{font-size:13px;margin:24px 0 8px;color:#666;font-weight:600}
 .sub{color:#888;margin-bottom:16px}
 table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #e5e5e5;border-radius:6px;overflow:hidden}
 th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #f0f0f0;vertical-align:top}
 th{background:#f7f7f7;font-weight:600;color:#555;font-size:12px}
 tr:last-child td{border-bottom:0}
 code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f4f4f4;padding:1px 5px;border-radius:3px}
 a{color:#1565c0}
 button{font:inherit;padding:4px 10px;border:1px solid #ccc;background:#fff;border-radius:5px;cursor:pointer}
 button.on{background:#e8f5e9;border-color:#a5d6a7}
 button.danger{color:#b3261e}
 input,select{font:inherit;padding:5px 8px;border:1px solid #ccc;border-radius:5px;background:#fff}
 input{width:240px}
 input[type=checkbox]{width:auto;padding:0}
 .row{display:flex;gap:8px;align-items:center;margin:6px 0;flex-wrap:wrap}
 .prefs{display:flex;gap:10px 18px;align-items:flex-start;flex-wrap:wrap;font-size:12px}
 .pref{max-width:420px}
 .mini{display:inline-flex;align-items:center;box-sizing:border-box;padding:1px 8px;border:1px solid #ccc;border-radius:6px;background:#fff;color:inherit;font:inherit;font-size:11px;line-height:16px;cursor:pointer;text-decoration:none;white-space:nowrap}
 .prefs label{display:inline-flex;gap:4px;align-items:center;white-space:nowrap}
 .muted{color:#999} .ok{color:#2e7d32} .err{color:#b3261e}
 .tag{font-size:11px;padding:1px 6px;border-radius:99px;background:#eee;color:#666}
 .warn{background:#fff3e0;color:#b26a00}
 .ov{background:#e3f2fd;color:#1565c0}
</style></head><body>
<h1>Ntfy Remote</h1>
<div class="sub">每个 DSH 会话一个 ntfy 话题 · 手机推送与回复 · 偏好可逐会话覆盖</div>
<div id="app">加载中…</div>
<script>
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
// 「作答超时」(relayTimeoutSec) 是什么：会话偏好与全局默认两处共用一句说明。
const TIMEOUT_HINT = '作答超时：审批 / 提问推到手机后，最多等这么久你的回复；超时自动回落 DSH 原生交互，本地弹窗继续等，请求不会丢。出厂默认 180 秒。'
// 心跳间隔说明。另外两个时间由它推导，写清楚免得用户到处找。
const HEARTBEAT_HINT = '回合心跳间隔（秒）：回合进行中，每这么多秒原地更新一次手机上的状态通知（同一条，不刷屏）。死信超时与「疑似卡住」阈值由它推导：分别是 3 倍与 9 倍。范围 5~300，默认 20。'
// 复制话题名：优先 async clipboard（localhost / https 是安全上下文），局域网明文 http
// 不是安全上下文，退回隐藏 textarea + execCommand。
async function copyText(text) {
  try {
    if (window.navigator && window.navigator.clipboard && typeof window.navigator.clipboard.writeText === 'function') {
      await window.navigator.clipboard.writeText(text)
      return true
    }
  } catch (e) { /* 继续走 execCommand 兜底 */ }
  try {
    const area = document.createElement('textarea')
    area.value = text; area.setAttribute('readonly', '')
    area.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0'
    document.body.appendChild(area); area.select()
    const ok = document.execCommand('copy'); document.body.removeChild(area); return ok
  } catch (e) { return false }
}
async function api(path, body) {
  const res = await fetch('/dsh-ntfy-remote' + path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({ ok: false, error: 'bad-json' }))
  if (!data.ok) throw new Error(data.error ?? ('HTTP ' + res.status))
  return data
}
function note(msg, cls) { const el = document.getElementById('note'); el.textContent = msg || ''; el.className = cls || 'muted' }
function link(url) { return url ? '<a class="mini" href="' + esc(url) + '" target="_blank" rel="noreferrer" title="' + esc(url) + '">网页打开</a>' : '<span class="muted">—</span>' }

async function render() {
  let s
  try { s = await api('/status') } catch (e) { document.getElementById('app').textContent = '加载失败：' + e.message; return }
  const app = document.getElementById('app'); app.innerHTML = ''

  // ── 服务器 ──
  app.insertAdjacentHTML('beforeend', '<h2>服务器（' + s.servers.length + '）</h2>')
  const servers = document.createElement('div')
  for (const sv of s.servers) {
    const row = document.createElement('div'); row.className = 'row'
    row.innerHTML = '<input data-f="name" value="' + esc(sv.name) + '">' +
      '<input data-f="url" value="' + esc(sv.url) + '" style="width:280px">' +
      '<input data-f="token" placeholder="' + (sv.tokenSet ? 'token 已设置（留空不改）' : 'token（可空）') + '" style="width:200px">' +
      '<span class="tag">' + (sv.id === s.defaultServerId ? '默认' : '—') + '</span>' +
      '<span class="tag">绑定 ' + sv.boundSessions + '</span>'
    const save = document.createElement('button'); save.textContent = '保存'
    save.onclick = async () => {
      const get = (f) => row.querySelector('[data-f="' + f + '"]').value
      try { await api('/server/update', { id: sv.id, name: get('name'), url: get('url'), token: get('token') }); note('已保存', 'ok'); render() }
      catch (e) { note(e.message, 'err') }
    }
    const def = document.createElement('button'); def.textContent = '设为默认'
    def.onclick = async () => { try { await api('/config', { defaultServerId: sv.id }); render() } catch (e) { note(e.message, 'err') } }
    const del = document.createElement('button'); del.textContent = '删除'; del.className = 'danger'
    del.onclick = async () => { try { await api('/server/delete', { id: sv.id }); note('已删除', 'ok'); render() } catch (e) { note(e.message, 'err') } }
    row.append(save, def, del)
    servers.appendChild(row)
  }
  const add = document.createElement('div'); add.className = 'row'
  add.innerHTML = '<input id="new-name" placeholder="名称，如 自建">' +
    '<input id="new-url" placeholder="https://ntfy.example.com" style="width:280px">' +
    '<input id="new-token" placeholder="token（可空）" style="width:200px">'
  const addBtn = document.createElement('button'); addBtn.textContent = '新增服务器'
  addBtn.onclick = async () => {
    try {
      await api('/server/add', { name: document.getElementById('new-name').value, url: document.getElementById('new-url').value, token: document.getElementById('new-token').value })
      note('已新增', 'ok'); render()
    } catch (e) { note(e.message, 'err') }
  }
  add.appendChild(addBtn); servers.appendChild(add)
  app.appendChild(servers)

  // ── 会话 ──
  // 只列有记录的会话；其余活着的会话在它自己的 ● ntfy 弹窗里开启。
  const recorded = s.sessions.filter((it) => it.recorded)
  app.insertAdjacentHTML('beforeend', '<h2>会话记录（已开启 ' + s.enabledCount + ' / 共 ' + recorded.length + '）</h2>')
  if (recorded.length !== s.sessions.length) {
    app.insertAdjacentHTML('beforeend',
      '<div class="muted" style="margin:-4px 0 8px">只列出开过桥接的会话；其它会话在它自己的 <code>● ntfy</code> 弹窗里开启。</div>')
  }
  const table = document.createElement('table')
  table.innerHTML = '<thead><tr><th style="min-width:220px">会话</th><th>服务器</th><th style="min-width:300px">话题 / 链接</th>' +
    '<th style="min-width:260px">本会话通知偏好</th><th>开关</th></tr></thead><tbody></tbody>'
  const tbody = table.querySelector('tbody')
  for (const it of recorded) {
    const tr = document.createElement('tr')
    const serverCell = it.serverId
      ? (it.serverMissing ? '<span class="tag warn">服务器已失效，可重选</span>' : esc(it.serverName || it.serverId))
      : '<select data-role="pick"><option value="">（选择服务器）</option>' +
        s.servers.map((sv) => '<option value="' + esc(sv.id) + '">' + esc(sv.name) + '</option>').join('') + '</select>'
    const topicCell = it.topic
      ? '<div>话题：<code>' + esc(it.topic) + '</code> ' + link(it.topicUrl) + '</div>'
      : '<span class="muted">未开启</span>'
    tr.innerHTML = '<td><div>' + esc(it.label) + ' <span class="tag">' + (it.live ? '运行中' : '不在内存') + '</span>' +
      (it.overrides.length ? ' <span class="tag ov">已自定义偏好</span>' : '') + '</div>' +
      '<div class="muted"><code>' + esc(it.id) + '</code></div></td>' +
      '<td>' + serverCell + '</td><td>' + topicCell + '</td><td></td><td></td>'

    // 话题复制按钮：跟在「打开」链接后面，点了直接复制话题名。
    if (it.topic) {
      const copyBtn = document.createElement('button')
      copyBtn.textContent = '复制'
      copyBtn.title = '复制话题名（手机 ntfy App 订阅用）'
      copyBtn.className = 'mini'
      copyBtn.style.marginLeft = '6px'
      copyBtn.onclick = async () => {
        const ok = await copyText(it.topic)
        copyBtn.textContent = ok ? '已复制' : '复制失败'
        setTimeout(() => { copyBtn.textContent = '复制' }, 1500)
      }
      tr.children[2].querySelector('div').appendChild(copyBtn)
    }

    // 偏好控件：勾选即写覆盖，带「跟随默认」按钮清除全部覆盖；每项下面写清是什么。
    const prefsCell = tr.children[3]
    const box = document.createElement('div'); box.className = 'prefs'
    const defs = {
      notifyOnTurnEnd: { label: '回合结束推送', hint: '本回合正常跑完时，把最终回复整段推到手机。' },
      notifyOnPending: { label: '审批 / 提问推送', hint: '需要你审批或回答时推一条高优先级通知，并等手机作答。' },
      notifyOnError: { label: '错误 / 中断推送', hint: '模型报错、达到输出上限、被策略拦截时推精简原因；你自己在桌面点「停止」不推。' },
      phonePriority: { label: '手机优先接管作答', hint: '待决的审批 / 提问由手机来答（网页端不再显示该弹窗）；关掉后仍会推送，但作答回到网页端。' },
      notifyOnWebTurn: { label: '网页发起的回合也推送', hint: '关掉后，只有在手机上发起的回合才会推送到手机——回复与状态心跳都不发。适合"人就在电脑前，别再来打扰我"的会话；代价是「在电脑上发起长任务、走开后手机收结果」也会一起没有。默认开。' },
    }
    for (const key of Object.keys(defs)) {
      const item = defs[key]
      const block = document.createElement('div')
      block.className = 'pref'
      block.title = item.hint
      if (it.overrides.includes(key)) block.style.outline = '2px solid #90caf9'
      const label = document.createElement('label')
      const cb = document.createElement('input')
      cb.type = 'checkbox'; cb.checked = it.prefs[key] === true
      cb.onchange = async () => {
        try { await api('/session/prefs', { sessionId: it.id, key, value: cb.checked }); note('已保存', 'ok'); render() }
        catch (e) { note(e.message, 'err') }
      }
      label.append(cb, document.createTextNode(item.label))
      const hint = document.createElement('div')
      hint.className = 'muted'
      hint.style.cssText = 'font-size:11px;line-height:1.5;padding-left:18px'
      hint.textContent = item.hint
      block.append(label, hint)
      box.appendChild(block)
    }
    const tBlock = document.createElement('div')
    tBlock.className = 'pref'
    tBlock.title = TIMEOUT_HINT
    if (it.overrides.includes('relayTimeoutSec')) tBlock.style.outline = '2px solid #90caf9'
    const tLabel = document.createElement('label')
    const tInput = document.createElement('input')
    tInput.type = 'number'; tInput.min = '5'; tInput.value = String(it.prefs.relayTimeoutSec); tInput.style.width = '70px'; tInput.style.padding = '3px 6px'
    tInput.onchange = async () => {
      try { await api('/session/prefs', { sessionId: it.id, key: 'relayTimeoutSec', value: Number(tInput.value) }); note('已保存', 'ok'); render() }
      catch (e) { note(e.message, 'err') }
    }
    tLabel.append(document.createTextNode('作答超时'), tInput, document.createTextNode('秒'))
    tLabel.title = TIMEOUT_HINT
    tInput.title = TIMEOUT_HINT
    tInput.setAttribute('aria-label', '作答超时（秒）')
    const tHint = document.createElement('div')
    tHint.className = 'muted'
    tHint.style.cssText = 'font-size:11px;line-height:1.5;padding-left:20px'
    tHint.textContent = TIMEOUT_HINT
    tBlock.append(tLabel, tHint)
    box.appendChild(tBlock)
    prefsCell.appendChild(box)
    if (it.overrides.length) {
      const reset = document.createElement('button')
      reset.textContent = '跟随默认'
      reset.style.marginTop = '4px'
      reset.onclick = async () => {
        try {
          for (const key of it.overrides) await api('/session/prefs', { sessionId: it.id, key, value: null })
          note('已恢复跟随全局默认', 'ok'); render()
        } catch (e) { note(e.message, 'err') }
      }
      prefsCell.appendChild(reset)
    }

    const btn = document.createElement('button')
    btn.textContent = it.enabled ? '已开启' : '开启'
    if (it.enabled) btn.className = 'on'
    btn.onclick = async () => {
      btn.disabled = true
      try {
        const pick = tr.querySelector('[data-role="pick"]')
        await api('/toggle', { sessionId: it.id, enabled: !it.enabled, serverId: pick ? pick.value : undefined })
        render()
      } catch (e) { note(e.message, 'err'); btn.disabled = false }
    }
    const toggleCell = tr.children[4]
    toggleCell.appendChild(btn)
    // 绑定不可变，但服务器失联/填错时需要退路：关闭状态下允许解绑。
    if (it.serverId && !it.enabled) {
      const unbind = document.createElement('button')
      unbind.textContent = '解绑'
      unbind.style.marginLeft = '6px'
      unbind.title = '清除服务器绑定，之后可重新选择（仅在关闭状态下可用）'
      unbind.onclick = async () => {
        if (!window.confirm('解除该会话的服务器绑定？话题会重新分配，手机需要重新订阅。')) return
        try { await api('/session/unbind', { sessionId: it.id }); note('已解绑', 'ok'); render() }
        catch (e) { note(e.message, 'err') }
      }
      toggleCell.appendChild(unbind)
    }
    // 「删除」：只删本插件里这条会话的记录（绑定 / 开关 / 偏好），不碰 DSH 会话本身。
    if (it.serverId || it.enabled) {
      const forget = document.createElement('button')
      forget.textContent = '删除'
      forget.style.marginLeft = '6px'
      forget.title = '只删除 Ntfy Remote 里这条记录（绑定、开关、偏好），不会删除 DSH 会话'
      forget.onclick = async () => {
        if (!window.confirm('从 Ntfy Remote 中删除该会话的记录？不会删除 DSH 会话本身，之后可以重新开启。')) return
        try { await api('/session/forget', { sessionId: it.id }); note('已删除', 'ok'); render() }
        catch (e) { note(e.message, 'err') }
      }
      toggleCell.appendChild(forget)
    }
    tbody.appendChild(tr)
  }
  app.appendChild(table)

  // ── 全局默认偏好 ──
  const d = s.defaults
  app.insertAdjacentHTML('beforeend', '<h2>全局默认偏好（未单独设置过的会话跟随这里）</h2>' +
    '<div class="row"><label><input type="checkbox" id="d-turn" ' + (d.notifyOnTurnEnd ? 'checked' : '') + '> 回合结束推送</label>' +
    '<label><input type="checkbox" id="d-pending" ' + (d.notifyOnPending ? 'checked' : '') + '> 审批/提问推送</label>' +
    '<label><input type="checkbox" id="d-error" ' + (d.notifyOnError ? 'checked' : '') + '> 错误/中断推送</label>' +
    '<label><input type="checkbox" id="d-phone" ' + (d.phonePriority ? 'checked' : '') + '> 手机优先接管作答</label></div>' +
    '<label><input type="checkbox" id="d-web" ' + (d.notifyOnWebTurn ? 'checked' : '') + '> 网页发起的回合也推送</label></div>' +
    '<div class="row">作答超时 <input id="d-timeout" type="number" min="5" value="' + d.relayTimeoutSec + '" style="width:90px" title="' + esc(TIMEOUT_HINT) + '"> 秒' +
    ' 心跳间隔 <input id="d-hb" type="number" min="5" max="300" value="' + d.heartbeatSec + '" style="width:90px" title="' + esc(HEARTBEAT_HINT) + '"> 秒</div>' +
    '<div class="muted" style="font-size:11px;line-height:1.5">' + esc(HEARTBEAT_HINT) + '</div>' +
    '<div class="muted" style="font-size:11px;line-height:1.5">' + esc(TIMEOUT_HINT) + '</div>' +
    '<div class="row"><button id="d-save">保存默认</button></div>')
  document.getElementById('d-save').onclick = async () => {
    try {
      await api('/config', {
        notifyOnTurnEnd: document.getElementById('d-turn').checked,
        notifyOnPending: document.getElementById('d-pending').checked,
        notifyOnError: document.getElementById('d-error').checked,
        phonePriority: document.getElementById('d-phone').checked,
        notifyOnWebTurn: document.getElementById('d-web').checked,
        relayTimeoutSec: Number(document.getElementById('d-timeout').value),
        heartbeatSec: Number(document.getElementById('d-hb').value),
      })
      note('默认已保存', 'ok'); render()
    } catch (e) { note(e.message, 'err') }
  }
}
render()
</script>
<p id="note" class="muted"></p>
</body></html>`
}
