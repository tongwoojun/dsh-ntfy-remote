// HTTP 路由自测：用假 ctx 直接调用注册进来的 handler —— 不联网、不碰宿主。
//
// 为什么单独一个文件：`bridge-it.mjs` 测的是 Bridge 类本身；参数校验、错误码、
// 「偏好写入策略」（与默认一致即不写覆盖）这些只存在于路由层，以前只能手动 curl 验，
// 很容易漏（`relayTimeoutSec` 收下 0 / `"abc"` 就是这么漏过去的）。
//
// 用法：DSH_HOME=$(mktemp -d) node probe/routes-check.mjs

import { Readable } from 'node:stream'
import { Bridge } from '../bridge.js'
import { PREFIX, registerRoutes } from '../routes.js'

let failed = 0
/** 记录一条断言结果。 */
function check(label, ok, detail = '') {
  if (ok) {
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail === '' ? '' : `\n       ${detail}`}`)
  }
}

const SESSION = 'session-bbbbbbbb-1111-2222-3333-444444444444'
const OTHER = 'session-cccccccc-1111-2222-3333-444444444444'

// ── 假 ctx：只提供路由与 Bridge 用到的服务 ─────────────────────────────
const agents = new Map()
/** @type {Map<string, Function>} path → handler */
const routes = new Map()
const ctx = {
  webServer: {
    register: ({ path, handler }) => {
      routes.set(path, handler)
      return () => routes.delete(path)
    },
  },
  get: (key) => {
    if (key === 'agents') return { get: (id) => agents.get(id), list: () => [...agents.values()] }
    if (key === 'sessionPersistence') return { list: async () => [{ id: SESSION }] }
    return undefined
  },
}

const config = {
  servers: [{ id: 'srv_a', name: '服务器A', url: 'https://ntfy.sh', token: '' }],
  defaultServerId: 'srv_a',
  defaults: {
    notifyOnTurnEnd: true,
    notifyOnPending: true,
    notifyOnError: true,
    maxMessageLength: 3500,
    relayTimeoutSec: 180,
    phonePriority: true,
  },
}
const state = { sessions: {}, lastSeenTs: 0, processedIds: [], ownIds: [] }

const bridge = new Bridge(ctx, config, state)
// 本测试只走 HTTP 层：换掉 resync 与落盘，避免真去订阅 ntfy。
bridge.resync = () => {}
bridge.saver = { schedule: () => {}, flush: () => {} }
registerRoutes(ctx, bridge)
bridge.enable(SESSION, { cwd: '/tmp/dsh-ntfy-remote-routes' })

/**
 * 调一个已注册的路由。
 *
 * @param {string} path 去掉前缀后的路径
 * @param {any} [body] JSON 请求体（GET 传 undefined）
 * @param {string} [method] HTTP 方法
 * @returns {Promise<{status: number, json: any, raw: string}>}
 */
async function call(path, body, method = 'POST') {
  const handler = routes.get(PREFIX + path)
  if (handler === undefined) throw new Error(`没有注册路由 ${path}`)
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
  req.method = method
  const chunks = []
  const res = {
    status: 0,
    writeHead(status) {
      this.status = status
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(String(chunk))
    },
  }
  await Promise.resolve(handler(req, res))
  const raw = chunks.join('')
  let json = null
  try {
    json = raw === '' ? null : JSON.parse(raw)
  } catch {
    json = null
  }
  return { status: res.status, json, raw }
}

/** 本会话当前的覆盖集合。 */
const overrides = () => Object.keys(state.sessions[SESSION].prefs ?? {})

console.log('状态与页面')
const statusRes = await call('/status', undefined, 'GET')
check('GET /status → 200 且 ok', statusRes.status === 200 && statusRes.json.ok === true)
check('status 带 defaults 与 5 个 prefKeys', statusRes.json?.defaults?.relayTimeoutSec === 180 && statusRes.json.prefKeys.length === 5)
check('status 列出已绑定会话', statusRes.json.sessions.some((s) => s.id === SESSION && s.enabled === true))
const pageRes = await call('', undefined, 'GET')
check('GET / → 状态页 HTML', pageRes.status === 200 && pageRes.raw.includes('Ntfy Remote'))
// 会话标签（通知标题 + 状态页会话名）中间那段用**绑定的服务器名**，不是工作目录名。
check('会话标签用绑定的服务器名',
  statusRes.json.sessions.find((s) => s.id === SESSION)?.label === `DSH · 服务器A · ${SESSION.slice('session-'.length, 'session-'.length + 8)}`,
  JSON.stringify(statusRes.json.sessions.find((s) => s.id === SESSION)?.label))

console.log('参数校验（都应被拒绝，且不落盘）')
const rejections = [
  ['缺 sessionId', '/session/prefs', { key: 'notifyOnTurnEnd', value: false }, 400, 'bad-session-or-key'],
  ['非法 key', '/session/prefs', { sessionId: SESSION, key: 'nope', value: true }, 400, 'bad-session-or-key'],
  ['未绑定会话', '/session/prefs', { sessionId: OTHER, key: 'notifyOnTurnEnd', value: false }, 404, 'session-not-bound'],
  ['布尔键收字符串', '/session/prefs', { sessionId: SESSION, key: 'notifyOnTurnEnd', value: 'yes' }, 400, 'bad-value'],
  ['布尔键收数字', '/session/prefs', { sessionId: SESSION, key: 'phonePriority', value: 1 }, 400, 'bad-value'],
  ['超时收 0（输入框清空）', '/session/prefs', { sessionId: SESSION, key: 'relayTimeoutSec', value: 0 }, 400, 'bad-value'],
  ['超时收负数', '/session/prefs', { sessionId: SESSION, key: 'relayTimeoutSec', value: -100 }, 400, 'bad-value'],
  ['超时收字符串', '/session/prefs', { sessionId: SESSION, key: 'relayTimeoutSec', value: 'abc' }, 400, 'bad-value'],
  ['超时收布尔', '/session/prefs', { sessionId: SESSION, key: 'relayTimeoutSec', value: true }, 400, 'bad-value'],
  ['超时收 4.9（低于下限）', '/session/prefs', { sessionId: SESSION, key: 'relayTimeoutSec', value: 4.9 }, 400, 'bad-value'],
  ['toggle 缺 sessionId', '/toggle', {}, 400, 'missing-sessionId'],
  ['服务器缺名称/地址', '/server/add', { name: '', url: '' }, 400, 'missing-name-or-url'],
  ['服务器不存在（更新）', '/server/update', { id: 'srv_nope' }, 404, 'server-not-found'],
  ['服务器不存在（删除）', '/server/delete', { id: 'srv_nope' }, 404, 'server-not-found'],
]
for (const [label, path, body, code, error] of rejections) {
  const res = await call(path, body)
  check(`${label} → ${code} ${error}`, res.status === code && res.json?.error === error, `实际 ${res.status} ${JSON.stringify(res.json)}`)
}
check('被拒的值没有写进 state.json', overrides().length === 0, JSON.stringify(overrides()))

console.log('偏好写入：覆盖 / 取整 / 与默认一致即不写覆盖 / 清除')
let res = await call('/session/prefs', { sessionId: SESSION, key: 'relayTimeoutSec', value: 30.7 })
check('超时 30.7 → 存 30（取整）', res.status === 200 && res.json.value === 30 && state.sessions[SESSION].prefs.relayTimeoutSec === 30, JSON.stringify(res.json))
res = await call('/session/prefs', { sessionId: SESSION, key: 'notifyOnPending', value: false })
check('布尔键可写入', res.status === 200 && state.sessions[SESSION].prefs.notifyOnPending === false)
check('overrides 记录两个键', JSON.stringify(overrides().sort()) === JSON.stringify(['notifyOnPending', 'relayTimeoutSec']), JSON.stringify(overrides()))
res = await call('/session/prefs', { sessionId: SESSION, key: 'relayTimeoutSec', value: 180 })
check('写回默认值 180 → 不产生覆盖', res.status === 200 && res.json.value === null && state.sessions[SESSION].prefs.relayTimeoutSec === undefined, JSON.stringify(res.json))
res = await call('/session/prefs', { sessionId: SESSION, key: 'notifyOnPending', value: true })
check('布尔键写回默认 true → 不产生覆盖', res.status === 200 && state.sessions[SESSION].prefs.notifyOnPending === undefined, JSON.stringify(res.json))
check('overrides 已清空', overrides().length === 0, JSON.stringify(overrides()))
await call('/session/prefs', { sessionId: SESSION, key: 'notifyOnError', value: false })
res = await call('/session/prefs', { sessionId: SESSION, key: 'notifyOnError', value: null })
check('value:null 仍能清除覆盖', res.status === 200 && overrides().length === 0, JSON.stringify(overrides()))

console.log('服务器保护与全局默认边界')
res = await call('/server/add', { name: '临时', url: 'http://127.0.0.1:9/' })
const tempId = res.json?.server?.id
check('新增服务器返回 id 且 URL 去掉尾斜杠', res.status === 200 && res.json.server.url === 'http://127.0.0.1:9', JSON.stringify(res.json))
res = await call('/server/delete', { id: 'srv_a' })
check('删除仍被会话绑定的服务器 → 409 server-in-use', res.status === 409 && res.json.error === 'server-in-use', JSON.stringify(res.json))
res = await call('/server/delete', { id: tempId })
check('删除未绑定的服务器 → 200', res.status === 200, JSON.stringify(res.json))
res = await call('/server/delete', { id: 'srv_a' })
check('只剩一个服务器 → 409 last-server', res.status === 409 && res.json.error === 'last-server', JSON.stringify(res.json))
await call('/config', { relayTimeoutSec: 3, maxMessageLength: 50 })
check('全局超时 <5 被忽略', config.defaults.relayTimeoutSec === 180, String(config.defaults.relayTimeoutSec))
check('全局正文上限 <100 被忽略', config.defaults.maxMessageLength === 3500, String(config.defaults.maxMessageLength))
await call('/config', { relayTimeoutSec: 45, maxMessageLength: 500 })
check('全局超时 45 / 正文上限 500 生效', config.defaults.relayTimeoutSec === 45 && config.defaults.maxMessageLength === 500)

console.log('「删除记录」（forget）：只删插件里的记录，不动 DSH 会话')
res = await call('/session/forget', {})
check('缺 sessionId → 400 missing-sessionId', res.status === 400 && res.json.error === 'missing-sessionId', JSON.stringify(res.json))
res = await call('/session/forget', { sessionId: 'session-not-recorded-0000-0000-000000000000' })
check('没有记录时也返回 200，但 removed=false', res.status === 200 && res.json.removed === false, JSON.stringify(res.json))
await call('/session/prefs', { sessionId: SESSION, key: 'notifyOnError', value: false })
check('先造一条记录（含覆盖）', state.sessions[SESSION]?.prefs?.notifyOnError === false)
const beforeForget = (await call('/status', undefined, 'GET')).json.sessions.find((s) => s.id === SESSION)
check('有记录的行带 recorded=true（界面据此列出）', beforeForget?.recorded === true, JSON.stringify(beforeForget))
res = await call('/session/forget', { sessionId: SESSION })
check('删除记录 → removed=true', res.status === 200 && res.json.removed === true, JSON.stringify(res.json))
check('绑定、开关、偏好一起消失', state.sessions[SESSION] === undefined, JSON.stringify(state.sessions))
const afterForget = (await call('/status', undefined, 'GET')).json.sessions.find((s) => s.id === SESSION)
check('删除后 recorded 不再是 true', afterForget?.recorded !== true, JSON.stringify(afterForget))

console.log(failed === 0 ? '\n路由自测全部通过' : `\n${failed} 个用例失败`)
process.exit(failed === 0 ? 0 : 1)
