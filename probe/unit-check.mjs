// 纯函数自测：不接触宿主、不联网，只验证解析、命名与提取逻辑。
// 用法：node probe/unit-check.mjs

import { extractReply, describeTurnEnd, deepLink } from '../bridge.js'
import { parseNtfyMessage, shortSessionId, topicFor, topicUrl } from '../topics.js'

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

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 个用例失败`)
process.exit(failed === 0 ? 0 : 1)
