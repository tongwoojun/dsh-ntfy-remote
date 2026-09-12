// 会话存在性核对的自测：**不需要网络**。
//
// 覆盖「会话被删除后主动断开桥接」这条逻辑，以及它的几个反向保护：
//   - 会话只是没打开（仍在持久化列表）→ 不能误删绑定
//   - 读持久化列表失败 → 宁可不动，也不能误删绑定
//   - 会话**已归档**（文件还在）→ 立刻清理，不等三次核对
//   - 读归档集合失败 → 同样不动绑定
//
// 用一个必然连不上的服务器地址（127.0.0.1:1），这样订阅器不会真的发消息；
// 它的重试退避与本测试无关，最后 stop() 收尾。
//
// 用法：node probe/sweep-check.mjs

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 必须在导入插件模块**之前**设置：log.js 在导入时就要决定日志与状态目录。
// 这里**无条件**覆盖（不沿用环境里的 DSH_HOME），否则测试会去写真实的 ~/.dsh，
// 在沙箱下会刷一堆 EPERM 噪音。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-ntfy-sweep-'))
const { Bridge } = await import('../bridge.js')

const SESSION = 'session-sweep-test-0000-0000-000000000000'

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

// ── 环境桩 ────────────────────────────────────────────────────────────────
/** 内存里活着的会话。 */
const live = new Set()
/** 持久化列表里存在的会话。 */
const persisted = new Set()
let listThrows = false
/** DSH 本体的归档集合；`null` 表示服务未就绪（读不到）。 */
let archived = []

const config = {
  servers: [{ id: 'srv_x', name: '测试', url: 'http://127.0.0.1:1', token: '' }],
  defaultServerId: 'srv_x',
  defaults: {
    notifyOnTurnEnd: true, notifyOnPending: true, notifyOnError: true,
    maxMessageLength: 3500, relayTimeoutSec: 180, phonePriority: true,
  },
}
const state = { sessions: {}, lastSeenTs: 0, processedIds: [], ownIds: [] }
const ctx = {
  get: (key) => {
    if (key === 'agents') return { get: (id) => (live.has(id) ? { id } : undefined) }
    if (key === 'workspaceRegistry') {
      if (archived === null) throw new Error('workspaceRegistry 未就绪')
      return { get archivedSessionIds() { return archived } }
    }
    if (key === 'sessionPersistence') {
      return {
        list: async () => {
          if (listThrows) throw new Error('持久化列表不可用')
          return [...persisted].map((id) => ({ id }))
        },
      }
    }
    return undefined
  },
}

const bridge = new Bridge(ctx, config, state)
// 不落盘。
bridge.saver = { schedule: () => {}, flush: () => {} }

console.log('开启桥接')
const enabled = bridge.enable(SESSION)
check('开启成功', enabled.ok === true, JSON.stringify(enabled))
check('产生了绑定', state.sessions[SESSION] !== undefined)
check('建立了订阅', bridge.subscribers.size === 1, String(bridge.subscribers.size))

console.log('\n会话仍持久化（只是没打开）→ 保留绑定')
persisted.add(SESSION)
live.delete(SESSION)
for (let i = 0; i < 5; i += 1) await bridge.sweepMissingSessions()
check('绑定未被误删', state.sessions[SESSION] !== undefined)
check('订阅仍在', bridge.subscribers.size === 1, String(bridge.subscribers.size))

console.log('\n会话活着（在内存里）→ 保留绑定')
persisted.delete(SESSION)
live.add(SESSION)
for (let i = 0; i < 5; i += 1) await bridge.sweepMissingSessions()
check('在内存的会话保留绑定', state.sessions[SESSION] !== undefined)

console.log('\n读持久化列表失败 → 不动绑定')
live.delete(SESSION)
persisted.delete(SESSION)
listThrows = true
for (let i = 0; i < 5; i += 1) await bridge.sweepMissingSessions()
check('读取失败时不清除绑定', state.sessions[SESSION] !== undefined)
listThrows = false

console.log('\n会话已删除（不活、也不在列表）→ 连续确认后断开')
await bridge.sweepMissingSessions()
check('第一次未达阈值', state.sessions[SESSION] !== undefined)
await bridge.sweepMissingSessions()
check('第二次未达阈值', state.sessions[SESSION] !== undefined)
await bridge.sweepMissingSessions()
check('第三次确认后清除绑定', state.sessions[SESSION] === undefined, JSON.stringify(state.sessions))
check('订阅随之停止', bridge.subscribers.size === 0, String(bridge.subscribers.size))

console.log('\n会话已归档（文件仍在）→ 立刻清理，不等三次核对')
persisted.clear()
live.clear()
archived = [SESSION]
bridge.enable(SESSION)
persisted.add(SESSION)
check('已重新开启且有绑定', state.sessions[SESSION] !== undefined)
await bridge.sweepMissingSessions()
check('一次核对即清理（归档是明确动作）', state.sessions[SESSION] === undefined, JSON.stringify(state.sessions))
check('订阅随之停止', bridge.subscribers.size === 0, String(bridge.subscribers.size))

console.log('\n读归档集合失败 → 不动绑定')
archived = null
bridge.enable(SESSION)
persisted.add(SESSION)
await bridge.sweepMissingSessions()
check('归档集合读不到时保留绑定', state.sessions[SESSION] !== undefined)
check('订阅仍在', bridge.subscribers.size > 0, String(bridge.subscribers.size))
archived = []

console.log('\nisSessionGone 直查')
check('不在任何地方 → true', (await bridge.isSessionGone('session-nope')) === true)
persisted.add('session-yes')
check('在持久化列表 → false', (await bridge.isSessionGone('session-yes')) === false)
listThrows = true
check('读取失败时按存在处理 → false', (await bridge.isSessionGone('session-nope')) === false)
listThrows = false

console.log('\nsession/disposed 触发的核对（防抖）')
persisted.clear()
live.clear()
bridge.enable(SESSION)
bridge.scheduleSweep()
check('防抖已排期', bridge.sweepDebounce !== null)
await new Promise((resolve) => setTimeout(resolve, 2600))
check('防抖到点后执行了核对（一次）', bridge.sweepDebounce === null)
check('一次核对不足以判定删除', state.sessions[SESSION] !== undefined)

bridge.stop()
check('stop 清理了定时器', bridge.sweepTimer === null && bridge.sweepDebounce === null)

console.log(failed === 0 ? '\n核对自测全部通过' : `\n${failed} 个用例失败`)
process.exit(failed === 0 ? 0 : 1)
