// 纯函数自测：不接触宿主、不联网，只验证解析、命名与提取逻辑。
// 用法：node probe/unit-check.mjs

import { extractReply, describeTurnEnd, deepLink, splitForNtfy, buildQuestionParts, buildActionButtons, isDecisionPayload, isEmptyReplySentinel, Bridge, clampHeartbeatSec, heartbeatTimings, formatDuration, buildStatusMessage } from '../bridge.js'
import { NTFY_MESSAGE_MAX_BYTES } from '../ntfy.js'
import { parseNtfyMessage, shortSessionId, topicFor, topicUrl } from '../topics.js'
import { qrMatrix, qrSvg, MAX_VERSION } from '../qr.js'

let failed = 0

/**
 * 断言两个值相等。
 *
 * @param {string} label 用例名
 * @param {unknown} actual 实际值
 * @param {unknown} expected 期望值
 */
function eq(label, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) {
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}\n       actual   = ${a}\n       expected = ${b}`)
  }
}

/**
 * 断言调用会抛错。
 *
 * @param {string} label 用例名
 * @param {() => unknown} fn 待调用函数
 */
function throws(label, fn) {
  try {
    fn()
    failed += 1
    console.log(`  FAIL ${label}（未抛错）`)
  } catch {
    console.log(`  ok   ${label}`)
  }
}

const FULL = 'session-81c90a63-c212-4a67-a7c4-1b84c1e1bb0a'

console.log('话题命名（单话题，完整会话 id，不含密钥）')
eq('话题', topicFor(FULL), 'dsh_session-81c90a63-c212-4a67-a7c4-1b84c1e1bb0a')
eq('话题长度', topicFor(FULL).length, 48)
eq('不超过 ntfy 上限 64', topicFor(FULL).length <= 64, true)
eq('短 id 仍用于界面标签', shortSessionId(FULL), '81c90a63')
eq('topicUrl 去尾部斜杠', topicUrl('https://ntfy.sh/', 'dsh_x'), 'https://ntfy.sh/dsh_x')
throws('含空格的话题名被拒绝', () => topicFor('session-bad id'))

console.log('parseNtfyMessage')
eq('纯数字保持字符串', parseNtfyMessage('3'), '3')
eq('普通文本原样', parseNtfyMessage('继续'), '继续')
eq('JSON 对象解析', parseNtfyMessage('{"requestId":"a","approved":true}'), { requestId: 'a', approved: true })
eq('JSON null 按文本', parseNtfyMessage('null'), 'null')

console.log('extractReply')
const events = [
  { seq: 0, type: 'user/message', data: {} },
  { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '旧回复' }] } } },
  { seq: 2, type: 'turn/end', data: { reason: { kind: 'completed' } } },
  { seq: 3, type: 'user/message', data: {} },
  { seq: 4, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '新回复' }] } } },
  { seq: 5, type: 'turn/end', data: { reason: { kind: 'completed' } } },
]
eq('只取边界之后的回复', extractReply(events, 3), { reply: '新回复', reasonKind: 'completed' })
eq('边界之后无回复', extractReply(events, 6), { reply: null, reasonKind: null })
eq(
  '多段文本拼接',
  extractReply([{ seq: 0, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'A' }, { type: 'tool_use' }, { type: 'text', text: 'B' }] } } }], 0),
  { reply: 'AB', reasonKind: null },
)

console.log('describeTurnEnd')
eq('错误', describeTurnEnd({ kind: 'error', error: { message: '限额用尽' } }), '回合失败：限额用尽')
eq('输出上限', describeTurnEnd({ kind: 'max-tokens' }), '回合中断：达到输出上限')
eq('用户取消', describeTurnEnd({ kind: 'aborted', reason: { kind: 'user' } }), '回合中断：user')
eq('hook 取消带原因', describeTurnEnd({ kind: 'aborted', reason: { kind: 'hook', reason: '超时' } }), '回合中断：超时')

console.log('deepLink')
eq('去协议拼深链接', deepLink('https://ntfy.sh', 'dsh_a_b'), 'ntfy://ntfy.sh/dsh_a_b')
eq('自建端口', deepLink('http://192.168.1.9:8080', 'dsh_a_b'), 'ntfy://192.168.1.9:8080/dsh_a_b')

// ── QR 编码器 ────────────────────────────────────────────────────────────
//
// 正确性靠**金标准矩阵**钉死，不靠「看起来像二维码」：下面的 v1 / v2 矩阵是拿
// qrcode@1.5.4 逐位对齐过的（开发期还比过版本 1–10 × 8 个掩码共 152 组，并让
// jsQR 真解过一遍）。金标准落进仓库后，以后改编码器只要有一位不对就会红。
//
// 金标准矩阵来源：`qrcode@1.5.4` 强制单段字节模式（`[{data, mode:'byte'}]`）+
// 同一掩码；v1 用自动掩码（掩码 2），v2 用强制掩码 3。v7 用 FNV-1a 摘要，
// 因为它的作用是覆盖「版本信息 + 多块纠错 + 多个对齐图案」这条高版本路径。

/** 把模块矩阵压成每行一个 '0'/'1' 字符串，便于对比与贴进用例。 */
const rows = (matrix) => matrix.modules.map((row) => row.join(''))
const GOLDEN_V1 = [
  '111111100111001111111', '100000100011001000001', '101110101000101011101',
  '101110101111101011101', '101110101000101011101', '100000101110101000001',
  '111111101010101111111', '000000001010100000000', '101111100110001111100',
  '001001011000011111111', '111101111001101000110', '000011011101010011101',
  '101001100100111010011', '000000001111010111101', '111111100011100100010',
  '100000101010010011101', '101110101111001011011', '101110101100010110000',
  '101110101010101101100', '100000100111110110100', '111111101010011111010',
]
const GOLDEN_V2_MASK3 = [
  '1111111010100100101111111', '1000001010000010101000001', '1011101001010101101011101',
  '1011101010101011101011101', '1011101000101101101011101', '1000001000000010101000001',
  '1111111010101010101111111', '0000000010010000100000000', '1011011100000010101001011',
  '0010010101110000100100000', '1000011100001010100010100', '1001100000001111001001100',
  '0001111010110000011110111', '0010000011010111001110101', '0100011110101010101111110',
  '1011110000001101011111000', '0010111100010001111111101', '0000000010101100100010001',
  '1111111011111000101011111', '1000001010101001100010010', '1011101000111100111110010',
  '1011101011101110101010111', '1011101010011100011111110', '1000001001100001011010100',
  '1111111011001010000111111',
]

/** FNV-1a 32 位摘要：钉住整个矩阵，又不用在用例里铺 45 行。 */
function fnv1a(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

console.log('qrMatrix：版本选择与边界')
eq('支持到 v10', MAX_VERSION, 10)
eq('14 字节 → v1', qrMatrix('x'.repeat(14)).version, 1)
eq('15 字节 → v2', qrMatrix('x'.repeat(15)).version, 2)
eq('62 字节 → v4', qrMatrix('x'.repeat(62)).version, 4)
eq('106 字节 → v6', qrMatrix('x'.repeat(106)).version, 6)
eq('107 字节 → v7（开始带版本信息）', qrMatrix('x'.repeat(107)).version, 7)
eq('213 字节 → v10（上限）', qrMatrix('x'.repeat(213)).version, 10)
eq('214 字节 → null（超出支持范围）', qrMatrix('x'.repeat(214)), null)
eq('边长 = 版本 × 4 + 17', qrMatrix('x'.repeat(14)).size, 21)
eq('v10 边长', qrMatrix('x'.repeat(213)).size, 57)

console.log('qrMatrix：掩码')
for (const mask of [0, 1, 2, 3, 4, 5, 6, 7]) {
  eq(`强制掩码 ${mask} 被采纳`, qrMatrix('ntfy://ntfy.sh/dsh_a', { mask }).mask, mask)
}
eq('自动掩码落在 0–7', [0, 1, 2, 3, 4, 5, 6, 7].includes(qrMatrix('ntfy://ntfy.sh/dsh_a').mask), true)

console.log('qrMatrix：金标准矩阵')
eq('v1 整矩阵（ntfy://ntfy.sh，自动掩码）', rows(qrMatrix('ntfy://ntfy.sh')), GOLDEN_V1)
eq('v2 整矩阵（ntfy://ntfy.sh/dsh_a，强制掩码 3）', rows(qrMatrix('ntfy://ntfy.sh/dsh_a', { mask: 3 })), GOLDEN_V2_MASK3)
eq('v7 整矩阵摘要', fnv1a(rows(qrMatrix('x'.repeat(107))).join('')), '272ba69b')

console.log('qrMatrix：结构不变量')
const sample = qrMatrix('ntfy://ntfy.sh/dsh_session-81c90a63')
const s = sample.size
eq('三个定位图案的角都是暗的', [
  sample.modules[0][0], sample.modules[0][s - 1], sample.modules[s - 1][0],
], [1, 1, 1])
eq('定位图案中心是暗的', sample.modules[3][3], 1)
eq('定时图案第 6 行黑白相间', sample.modules[6].slice(8, s - 8).every((v, i) => v === (i % 2 === 0 ? 1 : 0)), true)
eq('定时图案第 6 列黑白相间', sample.modules.slice(8, s - 8).every((row, i) => row[6] === (i % 2 === 0 ? 1 : 0)), true)
eq('暗模块恒亮', sample.modules[s - 8][8], 1)

console.log('qrSvg')
const svg = qrSvg('ntfy://ntfy.sh/dsh_a')
eq('是 SVG', svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), true)
eq('有 viewBox', svg.includes('viewBox="0 0 33 33"'), true) // v2 边长 25 + 两侧各 4 个静区
eq('白底 + 黑模块', svg.includes('<rect') && svg.includes('<path d="M'), true)
eq('含 crispEdges（避免缩放发虚）', svg.includes('shape-rendering="crispEdges"'), true)
eq('不把深链接写进 SVG 正文', svg.includes('ntfy://'), false)
eq('同样输入产出同样 SVG', svg === qrSvg('ntfy://ntfy.sh/dsh_a'), true)
eq('pixelSize 落到宽高', qrSvg('ntfy://ntfy.sh/dsh_a', { pixelSize: 200 }).includes('width="200" height="200"'), true)
eq('超长返回 null', qrSvg('x'.repeat(214)), null)

// ── 分片：ntfy 的 message 字段是 4095 **字节**上限，超了整条被拒收 ──
// 这几条钉住「按字节而不是按字符切」和「切了不丢内容」，两者都踩过坑。
console.log('splitForNtfy：按字节分片')
const bytes = (text) => Buffer.byteLength(text, 'utf-8')

eq('空串仍返回一条', splitForNtfy(''), [''])
eq('短文本不切', splitForNtfy('短消息', 4000), ['短消息'])
eq('刚好卡在预算上不切', splitForNtfy('中'.repeat(100), 300).length, 1)

const longZh = Array.from({ length: 300 }, (_, i) => `## 第 ${i} 节\n\n这是第 ${i} 节的中文正文，用于占用字节预算。`).join('\n')
const zhParts = splitForNtfy(longZh, 4000)
eq('长中文被切成多条', zhParts.length > 1, true)
eq('每片都不超ntfy硬上限', zhParts.every((p) => bytes(p) <= NTFY_MESSAGE_MAX_BYTES), true)
eq('按换行拼接无损', zhParts.join('\n') === longZh, true)

// 单行超长（无换行可切）走硬切路径：切点必须落在字符边界上。
const oneLine = '中文'.repeat(3000)
const oneParts = splitForNtfy(oneLine, 4000)
eq('单行超长也会被切', oneParts.length > 1, true)
eq('每片都不超预算', oneParts.every((p) => bytes(p) <= 4000), true)
eq('去空白后内容无损', oneParts.join('').replace(/\s/g, '') === oneLine.replace(/\s/g, ''), true)

// 4 字节字符（emoji）最容易被按字节硬切劈成半个，劈了就出乱码。
const emoji = '🙂'.repeat(1500)
const emojiParts = splitForNtfy(emoji, 4000)
eq('emoji 每片不超预算', emojiParts.every((p) => bytes(p) <= 4000), true)
eq('emoji 未被切碎（无替换字符）', emojiParts.some((p) => p.includes('\uFFFD')), false)
eq('emoji 拼接无损', emojiParts.join('') === emoji, true)

// 切点落在 ``` 代码块内时，必须给上一片补闭合围栏、下一片重开，否则渲染从切点烂掉。
console.log('splitForNtfy：跨片代码围栏')
const fenced = '前言\n\n```js\n' + 'const x = 1 // 中文注释占字节\n'.repeat(400) + '```\n\n结尾'
const fenceParts = splitForNtfy(fenced, 4000)
const fencesPer = (p) => (p.match(/^ {0,3}(?:`{3,}|~{3,})/gm) ?? []).length
eq('围栏内容被切成多条', fenceParts.length > 1, true)
eq('每片围栏开闭配对（偶数）', fenceParts.every((p) => fencesPer(p) % 2 === 0), true)
eq('上一片补了闭合围栏', fenceParts[0].endsWith('```'), true)

// 预算顶到 ntfy 硬上限时，围栏修复要补的那几字节必须已经预留；否则补完就 4099 字节，
// 又会被服务端拒收——这正是「修好一个又埋一个」的经典写法。
const maxBudgetParts = splitForNtfy(fenced, NTFY_MESSAGE_MAX_BYTES)
eq('预算给到 4095 也不越界（已预留围栏修复字节）',
  maxBudgetParts.every((p) => bytes(p) <= NTFY_MESSAGE_MAX_BYTES),
  true)

// ── 提问组装：桌面端能看到的内容，手机上一样都不能少 ──
// 旧的实现只发 question + label，描述、header、计划正文全丢，等于让人闭眼选。
console.log('buildQuestionParts：内容完整性与选项分组')
const options = [
  { label: '方案 A', description: '会删除数据，不可恢复。' },
  { label: '方案 B', description: '只做备份，不动原数据。' },
  { label: '方案 C', description: '什么都不做。' },
  { label: '方案 D', description: '第四个选项。' },
]
const question = {
  id: 'q1',
  header: '选择模式',
  question: '要执行哪个方案？',
  detail: '## 计划\n\n1. 备份\n2. 执行\n\n```sh\nrun --dry\n```',
  options,
}
const qParts = buildQuestionParts(question, options, { index: 0, total: 2 })
const qText = qParts.map((p) => p.message).join('\n')

eq('带上了 header', qText.includes('**选择模式**'), true)
eq('带上了问题正文', qText.includes('要执行哪个方案？'), true)
eq('带上了 detail（计划正文）', qText.includes('## 计划') && qText.includes('run --dry'), true)
eq('每个选项的 label 都在', options.every((o) => qText.includes(o.label)), true)
eq('每个选项的 description 都在', options.every((o) => qText.includes(o.description)), true)
eq('标注了单选', qText.includes('单选'), true)
eq('标注了第几问', qText.includes('第 1/2 问'), true)
eq('选项超过 3 个时拆成多条', qParts.length, 3) // 1 条头 + 2 组选项
eq('编号跨组连续', qParts[2].message.startsWith('4. '), true)
eq('每组按钮不超过 ntfy 上限', qParts.slice(1).every((p) => (p.buttons ?? []).length <= 3), true)
eq('第一组 3 个按钮', qParts[1].buttons.length, 3)
eq('第二组 2 个按钮', qParts[2].buttons.length, 1)

// 多选改成「切换 + 提交」：ntfy 按钮是无状态单次回执，直接点选表达不了集合，
// 所以每个选项按钮切换选中状态（桥接侧累积），最后一个「提交」收尾。
const multiParts = buildQuestionParts({ question: '选哪些？', multi_select: true }, options, { index: 0, total: 1 })
const multiButtons = multiParts.slice(1).flatMap((p) => p.buttons ?? [])
eq('多选每个选项都有一个切换按钮',
  options.every((o) => multiButtons.some((b) => b.label === o.label && b.value.toggle === o.label)), true)
eq('多选恰好一个提交按钮',
  multiButtons.filter((b) => b.value.submit === true).length, 1)
eq('提交按钮标签固定', multiButtons.find((b) => b.value.submit === true).label, '提交')
eq('多选按钮里不夹带 answer（避免被当成单选结算）',
  multiButtons.some((b) => b.value.answer !== undefined), false)
eq('每组按钮都不超过 ntfy 上限',
  multiParts.slice(1).every((p) => (p.buttons ?? []).length <= 3), true)
eq('多选给出作答说明', multiParts[multiParts.length - 1].message.includes('点「提交」'), true)
eq('单问不写第几问', multiParts.map((p) => p.message).join('\n').includes('第 1/1 问'), false)

// 用户报的「多选时消息不全」：多选 + 选项超过 3 个 + 每条都带描述，是最容易漏的组合。
console.log('buildQuestionParts：多选 + 超 3 选项 + 描述（用户报的不全 bug）')
const multiRich = [
  { label: '甲项', description: '甲的说明文字。' },
  { label: '乙项', description: '乙的说明文字。' },
  { label: '丙项', description: '丙的说明文字。' },
  { label: '丁项', description: '丁的说明文字。' },
  { label: '戊项', description: '戊的说明文字。' },
]
const multiParts5 = buildQuestionParts({ question: '要开哪几项？', multi_select: true }, multiRich, { index: 0, total: 1 })
const multi5Text = multiParts5.map((p) => p.message).join('\n')
eq('多选 5 个选项拆成 3 条', multiParts5.length, 3)
eq('多选时每个标签都在', multiRich.every((o) => multi5Text.includes(o.label)), true)
eq('多选时每条描述都在', multiRich.every((o) => multi5Text.includes(o.description)), true)
eq('多选编号跨组连续', multiParts5[2].message.startsWith('4. '), true)
eq('多选每个选项都有切换按钮',
  multiRich.every((o) => multiParts5.slice(1).flatMap((p) => p.buttons ?? []).some((b) => b.value.toggle === o.label)), true)
eq('多选恰好一个提交按钮',
  multiParts5.slice(1).flatMap((p) => p.buttons ?? []).filter((b) => b.value.submit === true).length, 1)
eq('多选作答说明只出现一次', multi5Text.split('点「提交」').length - 1, 1)

// 超长提问正文（例如嵌入一整段代码的计划）在**发送前**才按字节拆条，
// buildQuestionParts 只负责内容组装，拆条由 requestDecision 调 splitForNtfy 完成。
console.log('buildQuestionParts：超长正文交由分片器拆条（含代码围栏）')
const longQuestion = '以下是长说明：' + '这是一段用于占用字节预算的中文内容。'.repeat(120)
  + '\n\n```js\n' + 'const value = computeSomething(1)\n'.repeat(160) + '```\n'
const headMessage = buildQuestionParts({ question: longQuestion }, [{ label: '收到' }], { index: 0, total: 1 })[0].message
const headChunks = splitForNtfy(headMessage, 4000)
eq('超长提问确实被拆成多条', headChunks.length > 1, true)
eq('每片都在 ntfy 硬上限内', headChunks.every((p) => bytes(p) <= NTFY_MESSAGE_MAX_BYTES), true)
eq('跨片代码围栏开闭配对',
  headChunks.every((p) => ((p.match(/^ {0,3}(?:`{3,}|~{3,})/gm) ?? []).length % 2 === 0)), true)
// 有超长单行时走硬切，硬切不插换行；有跨片代码块时又会**故意**补围栏标记行。
// 所以「内容不丢」的准确口径是：忽略空白、且剔除围栏标记行之后完全一致。
const stripFences = (text) => text.split('\n').filter((line) => !/^ {0,3}(?:`{3,}|~{3,})/.test(line)).join('')
eq('长正文内容无损（忽略空白与围栏标记行）',
  stripFences(headChunks.join('')).replace(/\s/g, '') === stripFences(headMessage).replace(/\s/g, ''), true)

// ntfy 的动作按钮是**手机直接**向服务器发 POST，不走插件的 HTTP 客户端，所以服务器
// 开了 auth 时 token 必须写进动作本身。少了它，自建服务器上点按钮一律 HTTP 403
// ——真机实测踩过（作者自己的阿里云服务器 tokenSet=true，两个按钮点下去都 403）。
console.log('buildActionButtons：按钮必须带上服务器 token')
const tokenedActions = buildActionButtons(
  { url: 'http://139.224.17.177:8080/', token: 'tk_secret' }, 'dsh_x', 'req-1',
  [{ label: 'Approve', value: { approved: true } }],
)
eq('带 token 时写入 Authorization 头', tokenedActions[0].headers?.Authorization, 'Bearer tk_secret')
eq('按钮 URL 去掉尾部斜杠', tokenedActions[0].url, 'http://139.224.17.177:8080/dsh_x')
eq('按钮方法为 POST', tokenedActions[0].method, 'POST')
eq('按钮类型为 http', tokenedActions[0].action, 'http')
eq('按钮 body 带 requestId', JSON.parse(tokenedActions[0].body).requestId, 'req-1')
eq('按钮 body 带选项值', JSON.parse(tokenedActions[0].body).approved, true)

const plainActions = buildActionButtons({ url: 'https://ntfy.sh', token: '' }, 'dsh_x', 'req-2', [{ label: 'A', value: { answer: 'A' } }])
eq('无 token 时不写 headers（不能凭空造一个头）', plainActions[0].headers, undefined)
eq('无 token 时按钮照常可用', plainActions[0].url, 'https://ntfy.sh/dsh_x')

// ntfy 的动作按钮是**无状态的单次回执**，多选靠桥接侧累积选中集合：点选项按钮
// 只改集合、不结算；点「提交」才结算。这里直接驱动 settlePending 的三种载荷，
// 不联网就能钉死「切换 / 再点取消 / 提交」的语义。
console.log('Bridge.settlePending：多选切换 / 取消 / 提交（不联网）')
const pendingBridge = new Bridge(
  { get: () => undefined },
  { servers: [], defaultServerId: '', defaults: {} },
  { sessions: {}, lastSeenTs: 0, processedIds: [], ownIds: [] },
)
let outcome = null
pendingBridge.pending.set('req-m', {
  sessionId: 'session-none', kind: 'question', selected: new Set(),
  finish: (value) => { outcome = value; pendingBridge.pending.delete('req-m') },
})
const toggle = (label) => pendingBridge.settlePending('req-m', { requestId: 'req-m', toggle: label })
toggle('甲项')
toggle('丙项')
toggle('甲项')                                     // 再点一次 = 取消
eq('切换过程中不结算请求', outcome, null)
eq('取消后只剩丙项', [...pendingBridge.pending.get('req-m').selected], ['丙项'])
eq('提交返回累积的选中集合',
  (pendingBridge.settlePending('req-m', { requestId: 'req-m', submit: true }), outcome?.selected), ['丙项'])
eq('提交后待决请求被移除', pendingBridge.pending.has('req-m'), false)
eq('未知 requestId 的回执不被认领', pendingBridge.settlePending('req-x', { toggle: '甲项' }), false)
// 下拉/单选回执仍走原来的一次性结算，不能被新逻辑带偏。
pendingBridge.pending.set('req-s', {
  sessionId: 'session-none', kind: 'approval', selected: new Set(),
  finish: (value) => { outcome = value; pendingBridge.pending.delete('req-s') },
})
eq('普通回执仍然一次结算',
  (pendingBridge.settlePending('req-s', { requestId: 'req-s', approved: true }), outcome?.approved), true)

// 过期回执必须被丢弃，不能当成用户消息注入会话：真机实测点旧通知上的按钮，
// 那条 {"requestId":…,"toggle":…} 会被原样当成聊天内容发给模型。
console.log('isDecisionPayload：区分结构化回执与用户文本')
eq('单选按钮回执 {requestId, answer}', isDecisionPayload({ requestId: 'r', answer: '甲' }), true)
eq('审批回执 {requestId, approved}', isDecisionPayload({ requestId: 'r', approved: true }), true)
eq('多选切换 {requestId, toggle}', isDecisionPayload({ requestId: 'r', toggle: '甲' }), true)
eq('提交 {requestId, submit:true}', isDecisionPayload({ requestId: 'r', submit: true }), true)
eq('submit:false 也算回执（字段在就算）', isDecisionPayload({ requestId: 'r', submit: false }), true)
eq('带 requestId 但无决策字段 → 不算回执', isDecisionPayload({ requestId: 'r', note: '随便' }), false)
eq('没有 requestId → 不算回执', isDecisionPayload({ answer: '甲' }), false)
eq('空 requestId → 不算回执', isDecisionPayload({ requestId: '', answer: '甲' }), false)
eq('纯文本 → 不算回执', isDecisionPayload('你好'), false)
eq('null → 不算回执', isDecisionPayload(null), false)

// ── 回合心跳：只有一个可配置时间，另外两个按固定倍数推导 ──
console.log('回合心跳：间隔钳制与派生时间')
eq('缺省用默认 20', clampHeartbeatSec(undefined), 20)
eq('空串走默认（不能靠 Number()，它是 0）', clampHeartbeatSec(''), 20)
eq('null 走默认', clampHeartbeatSec(null), 20)
eq('非数字走默认', clampHeartbeatSec('abc'), 20)
eq('下限钳到 5', clampHeartbeatSec(1), 5)
eq('上限钳到 300', clampHeartbeatSec(9999), 300)
eq('死信超时 = 3×心跳', heartbeatTimings(20).watchdogSec, 60)
eq('卡住阈值 = 9×心跳', heartbeatTimings(20).stuckSec, 180)
eq('派生时间跟着心跳走', JSON.stringify(heartbeatTimings(60)), JSON.stringify({ intervalSec: 60, watchdogSec: 180, stuckSec: 540 }))
eq('卡住阈值恒大于死信超时（否则永远来不及报）', heartbeatTimings(5).stuckSec > heartbeatTimings(5).watchdogSec, true)
eq('死信超时 ≥ ntfy 定时消息的最小 delay', heartbeatTimings(5).watchdogSec >= 10, true)

console.log('回合心跳：时长格式化')
eq('不足一分', formatDuration(45), '45 秒')
eq('整分不写秒', formatDuration(180), '3 分')
eq('分加秒', formatDuration(80), '1 分 20 秒')
eq('零', formatDuration(0), '0 秒')

console.log('回合心跳：四种状态的标题与正文')
const hbRunning = buildStatusMessage({ phase: 'running', elapsedSec: 80, progressAgeSec: 12 })
eq('🟢 思考中', hbRunning.title, '🟢 DSH 思考中 · 1 分 20 秒')
eq('正文带最近一次输出', hbRunning.body.includes('最近一次输出：12 秒前'), true)

const hbStuck = buildStatusMessage({ phase: 'stuck', elapsedSec: 190, progressAgeSec: 185 })
eq('🟠 疑似卡住', hbStuck.title, '🟠 DSH 疑似卡住 · 3 分 10 秒')
eq('卡住时提示可点「停止」', hbStuck.body.includes('「停止」按钮'), true)

const hbDone = buildStatusMessage({ phase: 'done', elapsedSec: 200 })
eq('✅ 已完成', hbDone.title, '✅ DSH 已完成 · 3 分 20 秒')
eq('完成正文报总时长', hbDone.body.includes('本轮用时 3 分 20 秒'), true)

const hbLost = buildStatusMessage({ phase: 'lost', elapsedSec: 80, watchdogSec: 60, lastTitle: '🟢 DSH 思考中 · 1 分 20 秒' })
eq('🔴 心跳已停止（标题不缀时长，否则读成"停了 1 分 20 秒"）', hbLost.title, '🔴 DSH 心跳已停止')
eq('告警正文带冻结前的最后状态', hbLost.body.includes('最后状态：🟢 DSH 思考中 · 1 分 20 秒'), true)

// 中止必须与"正常完成"分开显示：显示「✅ 已完成」会误导，而且它还要顺带承担
// 「已收到你的中止请求」这句回执（见 runTextCommand('stop') 里为什么不另推一条）。
const hbCancelled = buildStatusMessage({ phase: 'cancelled', elapsedSec: 95 })
eq('⏹ 已中止（不是「已完成」）', hbCancelled.title, '⏹ DSH 已中止 · 1 分 35 秒')
eq('中止正文写明是被中止的', hbCancelled.body.includes('被中止'), true)
eq('已完成与已中止的标题不同', hbDone.title !== hbCancelled.title, true)
// 注意要用码点迭代：emoji 是代理对，title[0] 只拿到高位代理，🟢🟠🔴 会撞在一起。
eq('五种状态用五种不同符号',
  new Set([hbRunning, hbStuck, hbDone, hbCancelled, hbLost].map((m) => [...m.title][0])).size, 5)

// ── 区分「手机发起」与「网页/桌面发起」 ──
// 手机发来的文本一律走 executeTurn（标记 inflight）；网页发起的没有这个标记。
// 不需要解析消息的 source，虽然它确实也带 rpcId 可事后区分。
console.log('手机回合 vs 网页回合：区分与逐会话开关')
const turnBridge = new Bridge(
  { get: () => undefined },
  { servers: [], defaultServerId: '', defaults: { notifyOnWebTurn: true } },
  { sessions: { s1: { enabled: true, prefs: {} } }, lastSeenTs: 0, processedIds: [], ownIds: [] },
)
turnBridge.saver = { schedule: () => {}, flush: () => {} }
eq('默认：网页发起也推送', turnBridge.notifyWebTurn('s1'), true)
eq('inflight 为空 → 不是手机回合', turnBridge.isPhoneTurn('s1'), false)
turnBridge.inflight.set('s1', 'm1')
eq('inflight 有 → 是手机回合', turnBridge.isPhoneTurn('s1'), true)
turnBridge.inflight.delete('s1')
turnBridge.setPref('s1', 'notifyOnWebTurn', false)
eq('逐会话关掉后 → 网页发起不推送', turnBridge.notifyWebTurn('s1'), false)
turnBridge.setPref('s1', 'notifyOnWebTurn', undefined)
eq('清掉覆盖后回到默认（推送）', turnBridge.notifyWebTurn('s1'), true)
// 缺省方向必须是「推送」：这个键是后加的，旧配置里没有它，不能因此把通知全掐掉。
const legacyBridge = new Bridge(
  { get: () => undefined },
  { servers: [], defaultServerId: '', defaults: {} },
  { sessions: { s1: { enabled: true, prefs: {} } }, lastSeenTs: 0, processedIds: [], ownIds: [] },
)
eq('配置里没有该键 → 仍然推送（不是静默关闭）', legacyBridge.notifyWebTurn('s1'), true)

// ── ntfy 空回复哨兵 ──
// 安卓端在通知上点「回复」但什么都不输入时，会发来正文正好是 triggered 的消息；
// 它的字段与普通消息完全一致（无 tag、priority 同样是 3），只能按字面量认。
// 不处理的话它会当成用户输入注入会话，并打断正在跑的回合。
console.log('空回复哨兵：只吞完全相等的那一个')
eq('原样', isEmptyReplySentinel('triggered'), true)
eq('大小写不敏感', isEmptyReplySentinel('TRIGGERED'), true)
eq('首尾空白不算内容', isEmptyReplySentinel('  triggered  '), true)
eq('带标点就不吞', isEmptyReplySentinel('triggered!'), false)
eq('是别的词就不吞', isEmptyReplySentinel('trigger'), false)
eq('句子里含它不吞', isEmptyReplySentinel('triggered 了这个 bug'), false)
eq('中文不吞', isEmptyReplySentinel('你好'), false)
eq('空串不吞（另有空值处理）', isEmptyReplySentinel(''), false)
eq('null 不吞', isEmptyReplySentinel(null), false)

// ── 撤回：ntfy 上那条消息 ↔ 注入出来的 DSH 消息 ──
// 用户在 App 里删掉自己发的消息时，ntfy 广播 message_delete。实测（ntfy 2.x 自建）：
// 消息带 sequence_id 时它就是原值；没带（手机手打的普通消息都是这种）时，ntfy 会把
// **被删消息自己的 id** 填进 sequence_id；而事件里的 id 是删除事件自己的新 id。
// 所以对号必须用 sequence_id。
console.log('撤回：对号、取消与表大小上限')
const recallCancels = []
const recallBridge = new Bridge(
  {
    get: (key) => (key === 'agents'
      ? { get: (id) => (id === 's1' ? { cancel: (arg) => recallCancels.push(arg) } : undefined) }
      : undefined),
  },
  { servers: [], defaultServerId: '', defaults: {} },
  { sessions: { s1: { enabled: true, prefs: {} } }, lastSeenTs: 0, processedIds: [], ownIds: [] },
)
recallBridge.saver = { schedule: () => {}, flush: () => {} }

// ① 那一轮还在跑 → 标记 retracted 并中止
recallBridge.phoneInjects.set('msg-1', { sessionId: 's1', messageId: 'dsh-1', retracted: false })
recallBridge.inflight.set('s1', 'dsh-1')
recallBridge.handleDelete('srv_a', { id: 'delete-event-id', sequence_id: 'msg-1' })
eq('撤回把对应的一轮标记为 retracted', recallBridge.phoneInjects.get('msg-1').retracted, true)
eq('撤回顺带中止仍在跑的那一轮', recallCancels.length, 1)
eq('中止用 user 来源（与 /stop 一致）', JSON.stringify(recallCancels[0]), JSON.stringify({ kind: 'user' }))
eq('撤回写入了 /stop 静默窗口（压掉随后的 unknown 中断）', recallBridge.phoneCancels.has('s1'), true)

// ② 那一轮已经跑完（inflight 里不是它）→ 只标记，不再 cancel
recallBridge.phoneInjects.set('msg-2', { sessionId: 's1', messageId: 'dsh-2', retracted: false })
recallBridge.inflight.set('s1', 'dsh-other')
recallBridge.handleDelete('srv_a', { sequence_id: 'msg-2' })
eq('已跑完的一轮仍标记 retracted', recallBridge.phoneInjects.get('msg-2').retracted, true)
eq('已跑完的一轮不再 cancel', recallCancels.length, 1)
recallBridge.inflight.delete('s1')

// ③ 对不上的撤回不能抛错：插件自己推的通知（状态通知、撤销的死信开关）也会广播删除
let recallThrew = false
try { recallBridge.handleDelete('srv_a', { sequence_id: 'not-mine' }) } catch { recallThrew = true }
eq('对不上的撤回不抛错', recallThrew, false)
recallThrew = false
try { recallBridge.handleDelete('srv_a', {}) } catch { recallThrew = true }
eq('连 sequence_id 都没有也不抛错', recallThrew, false)

// ④ 万一服务端只给了 id，也要能对上（两个字段取其一）
recallBridge.phoneInjects.set('msg-3', { sessionId: 's1', messageId: 'dsh-3', retracted: false })
recallBridge.handleDelete('srv_a', { id: 'msg-3' })
eq('没有 sequence_id 时退回用 id 对号', recallBridge.phoneInjects.get('msg-3').retracted, true)

// ⑤ 表必须封顶：常驻进程里它只增不减
for (let i = 0; i < 500; i += 1) {
  recallBridge.phoneInjects.set(`bulk-${i}`, { sessionId: 's1', messageId: `m-${i}`, retracted: false })
}
recallBridge.pruneInjects()
eq('phoneInjects 被裁到上限以内', recallBridge.phoneInjects.size <= 200, true)
eq('裁掉的是最旧的记录（最新的还在）', recallBridge.phoneInjects.has('bulk-499'), true)
eq('最旧的记录已被裁掉', recallBridge.phoneInjects.has('bulk-0'), false)

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 个用例失败`)
process.exit(failed === 0 ? 0 : 1)
