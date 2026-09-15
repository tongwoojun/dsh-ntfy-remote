// Bridge 集成测试：真实 ntfy + 假 ctx，不需要 dsh 宿主。
//
// 覆盖「插件与 DSH 接线之外」的全部逻辑：多服务器订阅、话题路由、过滤自己发布的
// 消息、去重、文本指令、无活会话时的提示、有活会话时的 followup 注入与回复回推、
// 服务器绑定不可变性，以及审批 / 提问中转（按钮回执、超时回落原生链）。
//
// 用法：DSH_HOME=$(mktemp -d) node probe/bridge-it.mjs [server]
//   DSH_HOME 指向临时目录，避免污染真实的状态与配置。

import { Bridge } from '../bridge.js'
import { createSubscriber, publish as rawPublish } from '../ntfy.js'

/**
 * 发布包装：命中 ntfy.sh 免费版的发布速率限制（HTTP 429）时立刻中止并明确报告为
 * 「被限流跳过」，而不是伪装成断言失败。公共服务器按 visitor 限流，短时间内重复
 * 跑集成测试很容易触发；要反复跑请换自建服务器。
 *
 * @param {object} server 服务器描述符
 * @param {object} payload 消息
 * @returns {Promise<object>}
 */
async function publish(server, payload) {
  const result = await rawPublish(server, payload)
  if (result.status === 429) {
    console.log('\n⚠️  ntfy.sh 返回 429：免费版发布速率已用尽（按 visitor 限流）。')
    console.log('    集成测试需要真发消息；短时间内重复运行必然触发。请等几分钟再跑，')
    console.log('    或改用自建 ntfy： node probe/bridge-it.mjs https://your-ntfy')
    process.exit(2)
  }
  return result
}

const url = (process.argv[2] ?? 'https://ntfy.sh').replace(/\/+$/, '')
/**
 * 可选的访问 token（第三个参数）：自建服务器常开鉴权，发布、订阅、以及**动作按钮
 * 回传**都要带。用自建服务器跑可以躲开 ntfy.sh 免费的按 visitor 限流（429），
 * 反复跑不会被卡住。
 */
const token = process.argv[3] ?? ''
const SESSION = 'session-aaaaaaaa-1111-2222-3333-444444444444'
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

// ── 假 ctx：只提供 Bridge 用到的 agents 注册表 ────────────────────────────
const liveAgents = new Map()
const followupCalls = []
/** 假的持久化列表：T16/T17 用它模拟「会话被删除 / 只是没打开」。 */
const persistedIds = new Set([SESSION])
const ctx = {
  get: (key) => {
    if (key === 'agents') return { get: (id) => liveAgents.get(id) }
    if (key === 'sessionPersistence') return { list: async () => [...persistedIds].map((id) => ({ id })) }
    return undefined
  },
}

const SERVER_A = { id: 'srv_a', name: '服务器A', url, token }
const SERVER_B = { id: 'srv_b', name: '服务器B', url, token }

const config = {
  servers: [SERVER_A, SERVER_B],
  defaultServerId: SERVER_A.id,
  defaults: {
    notifyOnTurnEnd: true,
    notifyOnPending: true,
    notifyOnError: true,
    maxMessageLength: 4000,
    relayTimeoutSec: 30,
    phonePriority: true,
  },
}
const state = { sessions: {}, lastSeenTs: 0, processedIds: [], ownIds: [] }

const bridge = new Bridge(ctx, config, state)
const enabled = bridge.enable(SESSION, { cwd: '/tmp/dsh-ntfy-remote-it' })
const info = enabled.info
bridge.saver = { schedule: () => {}, flush: () => {} }

console.log(`server = ${url}${token === '' ? '' : '（带 token）'}`)
console.log(`out    = ${info.topic}`)
console.log(`resp   = ${info.topic}`)

// ── 另开一条订阅，观察插件发布的一切（含它自己的通知）────────────────────
/** @type {object[]} */
const seen = []
const observer = createSubscriber({
  getServer: () => ({ url, token, name: '观察者' }),
  getTopics: () => [info.topic],
  getSince: () => 0,
  onEvent: (event) => seen.push(event),
})
observer.start()
bridge.start()

/** 等观察流里出现满足条件的消息。 */
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = seen.find(predicate)
    if (hit !== undefined) return hit
    await delay(200)
  }
  console.log(`  （等待超时：${label}）`)
  return null
}

/** 从一条通知的按钮 body 里取出 requestId。 */
function requestIdOf(event) {
  const body = event?.actions?.[0]?.body
  return typeof body === 'string' ? JSON.parse(body).requestId : undefined
}

await delay(2500)

console.log('\nT1 首次开启固定服务器绑定')
check('绑定到默认服务器', info.serverId === SERVER_A.id, `实际 ${info.serverId}`)
const again = bridge.enable(SESSION)
check('重复开启不改绑定', again.ok === true && again.info.serverId === SERVER_A.id)
const switched = bridge.enable(SESSION, { serverId: SERVER_B.id })
check('拒绝改绑到别的服务器', switched.ok === false && switched.error === 'server-immutable')

// 等插件与观察者两条订阅真正连通：反复发 /status（纯文本指令，不会注入会话）直到
// 收到回复。否则首次发布可能早于订阅建立而丢失，造成随机失败。
let ready = false
for (let attempt = 0; attempt < 6 && !ready; attempt += 1) {
  await publish(SERVER_A, { topic: info.topic, message: '/status' })
  ready = (await waitFor((e) => typeof e.message === 'string' && e.message.includes('桥接：'), 2500, 'ready')) !== null
  if (!ready) await delay(1200)
}
console.log(`\n（订阅就绪：${ready}）`)
seen.length = 0

console.log('\nT2 无活会话时的文本')
await publish(SERVER_A, { topic: info.topic, message: '你好，这是一条测试' })
const t2 = await waitFor((e) => typeof e.message === 'string' && e.message.includes('不在运行中'), 12_000, 'T2')
check('插件提示会话不在运行中', t2 !== null)

console.log('\nT3 文本指令 /help')
seen.length = 0
await publish(SERVER_A, { topic: info.topic, message: '/help' })
check('插件返回帮助文本', (await waitFor((e) => typeof e.message === 'string' && e.message.includes('/stop'), 12_000, 'T3')) !== null)

console.log('\nT4 活会话：注入 + 回复提取')
seen.length = 0
const boundary = 42
liveAgents.set(SESSION, {
  id: SESSION,
  session: {
    seq: boundary,
    snapshotEvents: () => [
      { seq: boundary + 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '这是模型的回复' }] } } },
      { seq: boundary + 2, type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ],
  },
  followup: (message) => followupCalls.push(message),
  whenIdle: async () => {},
})
await publish(SERVER_A, { topic: info.topic, message: '继续，帮我看看' })
const t4 = await waitFor((e) => typeof e.message === 'string' && e.message.includes('这是模型的回复'), 12_000, 'T4')
check('调用了 agent.followup', followupCalls.length === 1, `实际 ${followupCalls.length} 次`)
check('注入为 user 来源的纯文本', followupCalls[0]?.source?.kind === 'user' && followupCalls[0]?.content?.[0]?.text === '继续，帮我看看')
check('把模型回复推回原话题', t4 !== null)

console.log('\nT5 自己发布的消息不会被当成用户输入')
const beforeT5 = followupCalls.length
await bridge.notify(SESSION, { title: '测试通知', message: '这条是插件自己发的', topic: info.topic })
await delay(3000)
check('未因自己的通知触发注入', followupCalls.length === beforeT5, `followup 次数 ${beforeT5} → ${followupCalls.length}`)

console.log('\nT6 重复消息只处理一次')
const dupText = `重复测试-${Date.now()}`
const dupResult = await publish(SERVER_A, { topic: info.topic, message: dupText })
await delay(1800)
seen.length = 0
await bridge.handleInbound(SERVER_A.id, { id: dupResult.id, time: Math.floor(Date.now() / 1000), topic: info.topic, message: dupText })
await delay(1000)
check('已处理过的消息被去重', seen.length === 0, `实际收到 ${seen.length} 条`)

console.log('\nT7 审批中转：按钮回执 → rejected')
seen.length = 0
let nextCalledT7 = false
const approvalPromise = bridge.handleApproval(
  { agent: { id: SESSION }, toolName: 'bash', reason: '需要执行一条命令' },
  async () => { nextCalledT7 = true; return 'unavailable' },
)
const approvalNotice = await waitFor((e) => e.actions?.[0]?.body !== undefined, 12_000, '审批通知')
check('推送了带按钮的审批通知', approvalNotice !== null)
check('通知带自我标记 tag', Array.isArray(approvalNotice?.tags) && approvalNotice.tags.includes('dsh-ntfy-remote'))
const approvalId = requestIdOf(approvalNotice)
check('按钮 body 带 requestId', typeof approvalId === 'string' && approvalId.length > 0)
await publish(SERVER_A, { topic: info.topic, message: JSON.stringify({ requestId: approvalId, approved: false }) })
const approvalOutcome = await approvalPromise
check('按回执返回 rejected', approvalOutcome === 'rejected', `实际 ${JSON.stringify(approvalOutcome)}`)
check('未回落原生链', nextCalledT7 === false)

console.log('\nT8 提问中转：按钮回执 → answers 契约')
seen.length = 0
const questionPromise = bridge.handleAskUserQuestion(
  { name: 'ask_user_question', agent: { id: SESSION }, arguments: { questions: [{ id: 'q1', question: '选哪个方案？', options: [{ label: '方案甲' }, { label: '方案乙' }] }] } },
  async () => ({ isError: false, value: null, content: [] }),
)
const questionNotice = await waitFor((e) => e.actions?.[0]?.body !== undefined, 12_000, '提问通知')
const questionId = requestIdOf(questionNotice)
check('推送了带选项按钮的提问', questionNotice !== null && typeof questionId === 'string')
await publish(SERVER_A, { topic: info.topic, message: JSON.stringify({ requestId: questionId, answer: '方案乙' }) })
const questionResult = await questionPromise
check('返回提问工具的规范结果', questionResult?.isError === false && typeof questionResult?.value === 'object')
check('答案映射为 selected 标签', questionResult?.value?.answers?.[0]?.selected?.[0] === '方案乙', `实际 ${JSON.stringify(questionResult?.value)}`)
check('结果带 JSON 文本内容块', typeof questionResult?.content?.[0]?.text === 'string')

console.log('\nT8b 多选提问：编号列表作答 → 多个 selected')
seen.length = 0
let multiFellBack = false
const multiPromise = bridge.handleAskUserQuestion(
  {
    name: 'ask_user_question',
    agent: { id: SESSION },
    arguments: {
      questions: [{ id: 'q3', question: '要开哪几项？', multi_select: true, options: [{ label: '甲项' }, { label: '乙项' }, { label: '丙项' }] }],
    },
  },
  async () => { multiFellBack = true; return { isError: false, value: null, content: [] } },
)
const multiNotice = await waitFor((e) => typeof e.message === 'string' && e.message.includes('多选：回复编号'), 12_000, '多选提问通知')
check('多选提问不下发按钮（并给出多选提示）', multiNotice !== null && (multiNotice.actions ?? []).length === 0, `actions=${JSON.stringify(multiNotice?.actions)}`)
await publish(SERVER_A, { topic: info.topic, message: '1,3' })
const multiResult = await multiPromise
check('多个编号映射为多个标签', JSON.stringify(multiResult?.value?.answers?.[0]?.selected) === JSON.stringify(['甲项', '丙项']), `实际 ${JSON.stringify(multiResult?.value)}`)
check('多选未回落原生链', multiFellBack === false)
seen.length = 0

console.log('\nT8c 提问内容完整性：描述 / header / 计划正文都要真发出去')
// 旧的实现只发 question + label，option.description、header、detail 全丢，而且
// 超过 3 个选项就退化成「回复编号」。这里逐项钉住「桌面端看得到的，手机上也看得到」。
seen.length = 0
const richOptions = [
  { label: '方案甲', description: '会删除数据，不可恢复。' },
  { label: '方案乙', description: '只做备份，不动原数据。' },
  { label: '方案丙', description: '什么都不做。' },
  { label: '方案丁', description: '第四个选项，用来验证跨组编号。' },
]
const richPromise = bridge.handleAskUserQuestion(
  {
    name: 'ask_user_question',
    agent: { id: SESSION },
    arguments: {
      questions: [{
        id: 'q4',
        header: '选择模式',
        question: '要执行哪个方案？',
        detail: '## 计划\n\n1. 备份\n2. 执行',
        options: richOptions,
      }],
    },
  },
  async () => ({ isError: false, value: null, content: [] }),
)
await waitFor((e) => typeof e.message === 'string' && e.message.includes('方案丁'), 12_000, 'T8c 第二组选项')
await delay(800)
const batch = seen.filter((e) => Array.isArray(e.tags) && e.tags.includes('dsh-ntfy-remote'))
const batchText = batch.map((e) => e.message).join('\n')

check('4 个选项拆成了多条', batch.length >= 3, `实际 ${batch.length} 条`)
check('每个选项的 description 都发出去了',
  richOptions.every((o) => batchText.includes(o.description)),
  `实际正文：${batchText.slice(0, 300)}`)
check('header 发出去了', batchText.includes('**选择模式**'))
check('计划正文（detail）发出去了', batchText.includes('## 计划'))
check('标注了题型与第几问', batchText.includes('单选'))
check('每个选项都有编号', richOptions.every((o, i) => batchText.includes(`${i + 1}. ${o.label}`)))
check('正文声明为 markdown（content_type）',
  batch.length > 0 && batch.every((e) => e.content_type === 'text/markdown'),
  `实际 ${JSON.stringify(batch.map((e) => e.content_type))}`)
check('只有第一条响铃（priority 4）', batch.filter((e) => e.priority === 4).length === 1,
  `实际 ${JSON.stringify(batch.map((e) => e.priority))}`)
check('后续条一律静音（priority 1）', batch.slice(1).every((e) => e.priority === 1),
  `实际 ${JSON.stringify(batch.map((e) => e.priority))}`)
check('多条时标题带 (k/n)',
  batch.length > 1 && batch.every((e, i) => typeof e.title === 'string' && e.title.includes(`(${i + 1}/${batch.length})`)),
  `实际 ${JSON.stringify(batch.map((e) => e.title))}`)

// 单选即使带按钮，直接回编号也必须还原成标签（旧实现此处会落成 custom）。
await publish(SERVER_A, { topic: info.topic, message: '4' })
const richResult = await richPromise
check('回编号也能命中跨组选项',
  richResult?.value?.answers?.[0]?.selected?.[0] === '方案丁',
  `实际 ${JSON.stringify(richResult?.value)}`)
seen.length = 0

console.log('\nT8d 多选提问：选项描述与跨组编号都不能丢（用户报的不全 bug）')
// 多选走的是「不给按钮」那条分支，和单选分组的代码路径不同，描述最容易在这里被漏掉。
// 内容里带 T8D 标记：上一组用例（T8c）的消息可能延迟到达，而它们是**带按钮**的单选，
// 混进来会把「多选不带按钮」直接判失败。按标记过滤，跨用例互不污染。
seen.length = 0
const multiRichOptions = [
  { label: 'T8D-甲项', description: 'T8D 甲项的取舍说明。' },
  { label: 'T8D-乙项', description: 'T8D 乙项的取舍说明。' },
  { label: 'T8D-丙项', description: 'T8D 丙项的取舍说明。' },
  { label: 'T8D-丁项', description: 'T8D 丁项的取舍说明。' },
]
let multiRichFellBack = false
const multiRichPromise = bridge.handleAskUserQuestion(
  {
    name: 'ask_user_question',
    agent: { id: SESSION },
    arguments: {
      questions: [{ id: 'q5', header: '多选项', question: '要开哪几项？T8D', multi_select: true, options: multiRichOptions }],
    },
  },
  async () => { multiRichFellBack = true; return { isError: false, value: null, content: [] } },
)
await waitFor((e) => typeof e.message === 'string' && e.message.includes('T8D-丁项'), 12_000, 'T8d 第二组选项')
await delay(800)
const multiBatch = seen.filter((e) => Array.isArray(e.tags) && e.tags.includes('dsh-ntfy-remote')
  && typeof e.message === 'string' && e.message.includes('T8D'))
const multiBatchText = multiBatch.map((e) => e.message).join('\n')
check('多选 4 个选项拆成了多条', multiBatch.length >= 3, `实际 ${multiBatch.length} 条`)
check('多选时不带按钮', multiBatch.every((e) => (e.actions ?? []).length === 0))
check('多选每个选项的 label 都发出去了',
  multiRichOptions.every((o) => multiBatchText.includes(o.label)))
check('多选每条 description 都发出去了（这就是报的 bug）',
  multiRichOptions.every((o) => multiBatchText.includes(o.description)),
  `实际正文：${multiBatchText.slice(0, 300)}`)
check('多选正文声明为 markdown', multiBatch.every((e) => e.content_type === 'text/markdown'))
check('多选编号跨组连续', multiBatchText.includes('4. T8D-丁项'))
await publish(SERVER_A, { topic: info.topic, message: '1, 4' })
const multiRichResult = await multiRichPromise
check('多选编号跨组映射为两个标签',
  JSON.stringify(multiRichResult?.value?.answers?.[0]?.selected) === JSON.stringify(['T8D-甲项', 'T8D-丁项']),
  `实际 ${JSON.stringify(multiRichResult?.value)}`)
check('多选未回落原生链', multiRichFellBack === false)
seen.length = 0

console.log('\nT9 提问超时回落原生链')
seen.length = 0
bridge.config.defaults.relayTimeoutSec = 5
let nextCalledT9 = false
const timeoutResult = await bridge.handleAskUserQuestion(
  { name: 'ask_user_question', agent: { id: SESSION }, arguments: { questions: [{ id: 'q2', question: '超时用例', options: [{ label: '甲' }] }] } },
  async () => { nextCalledT9 = true; return { isError: false, value: { answers: [{ id: 'q2', selected: ['甲'] }] }, content: [] } },
)
check('超时后回落原生链', nextCalledT9 === true)
check('回落时返回原生结果', timeoutResult?.value?.answers?.[0]?.selected?.[0] === '甲')
bridge.config.defaults.relayTimeoutSec = config.defaults.relayTimeoutSec

console.log('\nT10 其它工具与非绑定服务器不受影响')
let nextCalledT10 = false
await bridge.handleAskUserQuestion({ name: 'bash', agent: { id: SESSION }, arguments: {} }, async () => {
  nextCalledT10 = true
  return { isError: false, value: null, content: [] }
})
check('其它工具直接放行', nextCalledT10 === true)
// 来自未绑定服务器的同话题消息（不同 serverId）不应被处理。
seen.length = 0
const beforeT10 = followupCalls.length
await bridge.handleInbound(SERVER_B.id, { id: 'fake-id-t10', time: Math.floor(Date.now() / 1000), topic: info.topic, message: '不应被处理' })
await delay(800)
check('未绑定服务器的事件被忽略', followupCalls.length === beforeT10)

console.log('\nT11 关闭后再开启仍绑定同一服务器')
bridge.disable(SESSION)
const reopened = bridge.enable(SESSION)
check('重新开启保持原绑定', reopened.ok === true && reopened.info.serverId === SERVER_A.id)
check('话题保持不变', reopened.info.topic === info.topic)

console.log('\nT12 会话偏好分层（单会话覆盖优先于全局默认）')
check('默认继承全局', bridge.pref(SESSION, 'notifyOnTurnEnd') === true)
check('覆盖后生效', bridge.setPref(SESSION, 'notifyOnTurnEnd', false) === true && bridge.pref(SESSION, 'notifyOnTurnEnd') === false)
check('只影响该会话', bridge.pref('session-other', 'notifyOnTurnEnd') === true)
bridge.setPref(SESSION, 'relayTimeoutSec', 12)
check('数值型覆盖生效', bridge.pref(SESSION, 'relayTimeoutSec') === 12)
bridge.setPref(SESSION, 'notifyOnTurnEnd', undefined)
check('清除覆盖后回落默认', bridge.pref(SESSION, 'notifyOnTurnEnd') === true)
check('清除只针对指定键', bridge.pref(SESSION, 'relayTimeoutSec') === 12)
check('未绑定的会话无法设置偏好', bridge.setPref('session-unknown', 'notifyOnTurnEnd', false) === false)

console.log('\nT13 话题规则 = dsh_<完整会话 id>（单话题，无 _response）')
check('话题名', info.topic === `dsh_${SESSION}`, `实际 ${info.topic}`)
check('话题长度在 ntfy 上限内', info.topic.length <= 64)
check('不再有 responseTopic 字段', state.sessions[SESSION].responseTopic === undefined)
// 旧绑定（短 id / 带密钥的旧话题）应在 reindex 时自愈。
state.sessions[SESSION].topic = 'dsh_978c4357327a3904_shortid'
bridge.reindex()
check('旧话题在 reindex 时自愈', state.sessions[SESSION].topic === `dsh_${SESSION}`)

console.log('\nT14 回环兜底：正文与刚推送的通知完全一致时忽略')
const echoText = `回声测试-${Date.now()}`
const beforeT14 = followupCalls.length
await bridge.notify(SESSION, { title: '回声', message: echoText })
await delay(300)
// 模拟标记过滤失效：不带 MARKER_TAG 地重发同一段正文（等价于服务器回声）。
await publish(SERVER_A, { topic: info.topic, message: echoText })
await delay(1800)
check('完全一致的回声被兜底拦下', followupCalls.length === beforeT14, `followup 次数 ${beforeT14} → ${followupCalls.length}`)
// 换一段新文本应当照常处理，证明兜底没有误伤正常消息。
await publish(SERVER_A, { topic: info.topic, message: '这段是新内容' })
await delay(1800)
check('新内容照常注入（兜底没误伤）', followupCalls.length === beforeT14 + 1, `实际 ${followupCalls.length}`)

console.log('\nT15 解绑退路：仅在会话已关闭时可用（不改地址就删服务器会死锁）')
bridge.enable(SESSION)
const refused = bridge.unbind(SESSION)
check('开启状态下拒绝解绑', refused.ok === false && refused.error === 'still-enabled', JSON.stringify(refused))
bridge.disable(SESSION)
check('关闭后可以解绑', bridge.unbind(SESSION).ok === true)
check('解绑后绑定被清除', state.sessions[SESSION] === undefined)
const rebound = bridge.enable(SESSION, { serverId: SERVER_B.id })
check('解绑后可重新选择服务器', rebound.ok === true && rebound.info.serverId === SERVER_B.id, JSON.stringify(rebound))

console.log('\nT16 会话被删除后主动断开桥接（不留僵尸订阅）')
// 模拟：会话不在内存、也不在持久化列表里。
liveAgents.delete(SESSION)
persistedIds.delete(SESSION)
bridge.enable(SESSION, { serverId: SERVER_B.id })
check('删除前确实有订阅', bridge.subscribers.size > 0, String(bridge.subscribers.size))
await bridge.sweepMissingSessions()
check('未达阈值不误删', state.sessions[SESSION] !== undefined)
await bridge.sweepMissingSessions()
await bridge.sweepMissingSessions()
check('连续缺失后清除绑定', state.sessions[SESSION] === undefined, JSON.stringify(state.sessions))
check('订阅随之停止', bridge.subscribers.size === 0, String(bridge.subscribers.size))

console.log('\nT17 只是没打开（仍在持久化列表）不会误删绑定')
persistedIds.add(SESSION)
bridge.enable(SESSION)
for (let i = 0; i < 4; i += 1) await bridge.sweepMissingSessions()
check('会话仍持久化时保留绑定', state.sessions[SESSION] !== undefined, JSON.stringify(state.sessions))
check('仍然订阅着', bridge.subscribers.size > 0, String(bridge.subscribers.size))

console.log('\nT18 持久化读取失败时不动绑定（宁可留着也不误删）')
const originalGet = ctx.get
ctx.get = (key) => (key === 'sessionPersistence'
  ? { list: async () => { throw new Error('boom') } }
  : originalGet(key))
for (let i = 0; i < 4; i += 1) await bridge.sweepMissingSessions()
check('读取失败不清除绑定', state.sessions[SESSION] !== undefined)
ctx.get = originalGet

console.log('\nT19 手机 /stop：压掉随之而来的「回合中断：unknown」')
const cancelCalls = []
liveAgents.set(SESSION, {
  id: SESSION,
  session: { seq: 0, snapshotEvents: () => [] },
  followup: () => {},
  whenIdle: async () => {},
  cancel: (options) => cancelCalls.push(options),
})
// T16/T17 重建过订阅，先等入站通道真正连通（与 T1 相同就绪探测），否则 /stop 会丢在
// 连接建立之前，看起来像功能失败。
let stopReady = false
for (let attempt = 0; attempt < 6 && !stopReady; attempt += 1) {
  await publish(SERVER_A, { topic: info.topic, message: '/status' })
  stopReady = (await waitFor((e) => typeof e.message === 'string' && e.message.includes('桥接：'), 2500, 'T19 ready')) !== null
  if (!stopReady) await delay(1200)
}
seen.length = 0
await publish(SERVER_A, { topic: info.topic, message: '/stop' })
const stopNotice = await waitFor((e) => typeof e.message === 'string' && e.message.includes('已请求中止当前回合'), 12_000, 'T19 /stop')
check('收到「已请求中止当前回合。」', stopNotice !== null)
check('调用 agent.cancel({ kind: user })', cancelCalls.length === 1 && cancelCalls[0]?.kind === 'user', JSON.stringify(cancelCalls))
await delay(1200)
seen.length = 0
// 手机发起的取消产生的是「没有嵌套原因」的 aborted，isUserInitiatedCancel() 认不出来。
bridge.onSessionEvent({ id: SESSION }, { type: 'turn/end', data: { reason: { kind: 'aborted' } } })
await delay(1500)
check('未推送「回合中断：unknown」', seen.length === 0, `实际 ${seen.length} 条：${seen.map((e) => e.message).join(' / ')}`)
// 静默只吃一次：随后的真实中断必须照常推送。
bridge.onSessionEvent({ id: SESSION }, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } })
check('静默只吃一次，真实中断照常推送', (await waitFor((e) => typeof e.message === 'string' && e.message.includes('输出上限'), 12_000, 'T19b')) !== null)

console.log('\nT20 四个开关各自单独生效（逐项隔离，不互相掩护）')
const turnEnd = (kind) => bridge.onSessionEvent({ id: SESSION }, { type: 'turn/end', data: { reason: { kind } } })

// ① notifyOnTurnEnd：关掉后回合结束不推，恢复后照推。
bridge.lastAssistant.set(SESSION, 'T20-回合结束文本')
bridge.setPref(SESSION, 'notifyOnTurnEnd', false)
seen.length = 0
turnEnd('completed')
await delay(1500)
check('notifyOnTurnEnd=false → 回合结束不推送', seen.length === 0, `实际 ${seen.length} 条`)
bridge.setPref(SESSION, 'notifyOnTurnEnd', undefined)
seen.length = 0
turnEnd('completed')
check('恢复默认 → 回合结束照常推送', (await waitFor((e) => typeof e.message === 'string' && e.message.includes('T20-回合结束文本'), 12_000, 'T20a')) !== null)

// ② notifyOnError：只关这一项，max-tokens 的中断不该推。
bridge.setPref(SESSION, 'notifyOnError', false)
seen.length = 0
turnEnd('max-tokens')
await delay(1500)
check('notifyOnError=false → 中断不推送', seen.length === 0, `实际 ${seen.length} 条`)
bridge.setPref(SESSION, 'notifyOnError', undefined)
seen.length = 0
turnEnd('max-tokens')
check('恢复默认 → 中断照常推送', (await waitFor((e) => typeof e.message === 'string' && e.message.includes('输出上限'), 12_000, 'T20b')) !== null)

// ③ notifyOnPending=false（phonePriority 仍为真）→ 提问必须放行给原生链。
bridge.setPref(SESSION, 'notifyOnPending', false)
seen.length = 0
let nextPendingOff = false
const pendingOff = await bridge.handleAskUserQuestion(
  { name: 'ask_user_question', agent: { id: SESSION }, arguments: { questions: [{ id: 'q20a', question: '只关待决推送', options: [{ label: '甲' }] }] } },
  async () => { nextPendingOff = true; return { isError: false, value: { answers: [{ id: 'q20a', selected: ['甲'] }] }, content: [] } },
)
await delay(1000)
check('notifyOnPending=false → 提问回落原生链', nextPendingOff === true && pendingOff?.value?.answers?.[0]?.selected?.[0] === '甲')
check('且手机端没有推送', seen.length === 0, `实际 ${seen.length} 条`)
bridge.setPref(SESSION, 'notifyOnPending', undefined)

// ④ phonePriority=false（notifyOnPending 仍为真）→ 同样放行给原生链。
bridge.setPref(SESSION, 'phonePriority', false)
seen.length = 0
let nextPhoneOff = false
const phoneOff = await bridge.handleAskUserQuestion(
  { name: 'ask_user_question', agent: { id: SESSION }, arguments: { questions: [{ id: 'q20b', question: '只关手机优先', options: [{ label: '乙' }] }] } },
  async () => { nextPhoneOff = true; return { isError: false, value: { answers: [{ id: 'q20b', selected: ['乙'] }] }, content: [] } },
)
await delay(1000)
check('phonePriority=false → 提问回落原生链', nextPhoneOff === true && phoneOff?.value?.answers?.[0]?.selected?.[0] === '乙')
check('且手机端没有推送', seen.length === 0, `实际 ${seen.length} 条`)
bridge.setPref(SESSION, 'phonePriority', undefined)
check('四项覆盖已清回默认', Object.keys(state.sessions[SESSION].prefs ?? {}).length === 0, JSON.stringify(state.sessions[SESSION].prefs))

bridge.stop()
observer.stop()

console.log(failed === 0 ? '\n集成测试全部通过' : `\n${failed} 个用例失败`)
process.exit(failed === 0 ? 0 : 1)
