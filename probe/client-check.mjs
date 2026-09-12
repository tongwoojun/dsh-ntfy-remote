// 客户端 bundle 冒烟测试：不打开浏览器，用桩执行 lib/client.js，验证
//   1. factory 能执行完（模块体没有运行时错误）
//   2. 导出 name / inject / apply
//   3. apply(ctx) 会把两个槽位都注册上，且设置页标签为 Ntfy Remote
//
// 这一步能在刷新浏览器之前抓到语法以外的运行时问题（例如引用了不存在的变量）。
//
// 用法：node probe/client-check.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '../lib/client.js'), 'utf-8')

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

// ── 桩：__ModuleLoader__ 与 react ────────────────────────────────────────
let factory = null
const window = {
  __ModuleLoader__: {
    load: (spec) => { factory = spec.factory },
  },
}
const react = {
  createElement: (tag, props, ...children) => ({ tag, props, children }),
  Fragment: 'Fragment',
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (initial) => ({ current: initial }),
}
/** 假的 UI primitives：Button 只用于断言「用的是同一个组件」。 */
function PrimitiveButton() {}
const primitives = { Button: PrimitiveButton }
const require = (id) => {
  if (id === 'react') return react
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error('未预期的外部模块：' + id)
}

console.log('加载 bundle')
try {
  // eslint-disable-next-line no-new-func
  new Function('window', 'require', source)(window, require)
  check('模块体执行成功', true)
} catch (error) {
  check('模块体执行成功', false, String(error && error.stack ? error.stack.split('\n')[0] : error))
}

check('调用了 __ModuleLoader__.load', factory !== null)
if (factory === null) {
  console.log('\n无法继续：factory 未注册')
  process.exit(1)
}

let mod = null
try {
  mod = factory(require)
  check('factory 执行成功', true)
} catch (error) {
  check('factory 执行成功', false, String(error && error.message ? error.message : error))
  process.exit(1)
}

console.log('导出')
check('name', mod.name === 'dsh-ntfy-remote/client', `实际 ${mod.name}`)
check('inject 含 slots', Array.isArray(mod.inject) && mod.inject.includes('slots'))
check('apply 是函数', typeof mod.apply === 'function')

console.log('槽位注册')
const registrations = []
const injects = []
const ctx = {
  slots: {
    inject: (name, callback) => { injects.push(name); callback() },
    // 组件是 register(spec, Component) 的第二个参数，不是 spec 字段。
    register: (spec, component) => { registrations.push({ ...spec, component }); return () => {} },
  },
}
try {
  mod.apply(ctx)
  check('apply(ctx) 执行成功', true)
} catch (error) {
  check('apply(ctx) 执行成功', false, String(error && error.message ? error.message : error))
}

check('声明了两个槽位注入', injects.length === 2, `实际 ${JSON.stringify(injects)}`)
const header = registrations.find((r) => r.name === 'conversation.session.header.utilities')
const settings = registrations.find((r) => r.name === 'settings.section')
check('注册了会话头部按钮', header !== undefined && header.id === 'dsh-ntfy-remote-header')
// 列表槽按 priority→order 升序渲染；open-in-app（「在本地打开」）是 order -10，
// 因此必须小于它才能排在左边。
check('按钮排在「在本地打开」左边（order < -10）',
  header !== undefined && typeof header.order === 'number' && header.order < -10,
  header === undefined ? '' : `实际 order=${header.order}`)
check('注册了设置页', settings !== undefined && settings.id === 'dsh-ntfy-remote')
check('设置页标签为 Ntfy Remote', settings !== undefined && settings.label() === 'Ntfy Remote',
  settings === undefined ? '' : `实际 ${JSON.stringify(settings.label())}`)
check('每个槽位都带了组件函数', registrations.length === 2 && registrations.every((r) => typeof r.component === 'function'),
  JSON.stringify(registrations.map((r) => [r.name, typeof r.component])))

console.log('触发按钮的几何')
let trigger = null
try {
  const tree = header.component({ sessionId: 'session-test' })
  trigger = tree && tree.children ? tree.children[0] : null
  check('渲染成功', trigger !== null && trigger !== undefined)
} catch (error) {
  check('渲染成功', false, String(error && error.message ? error.message : error))
}
check('使用 primitives 的 Button（与「在本地打开」同一个组件）',
  trigger !== null && trigger !== undefined && trigger.tag === PrimitiveButton,
  trigger === null || trigger === undefined ? '' : `实际 tag=${typeof trigger.tag === 'function' ? trigger.tag.name : String(trigger.tag)}`)
check('size=sm（28px 高 / 14px 胶囊圆角）',
  trigger !== null && trigger !== undefined && trigger.props && trigger.props.size === 'sm',
  trigger && trigger.props ? JSON.stringify(trigger.props.size) : '')
check('variant=outline（同样的细边）',
  trigger !== null && trigger !== undefined && trigger.props && trigger.props.variant === 'outline',
  trigger && trigger.props ? JSON.stringify(trigger.props.variant) : '')

// ── 话题复制按钮 ────────────────────────────────────────────────────────
//
// 上面的桩把 useState 压成常量、把函数组件当成不展开的节点，弹窗（open=false）根本
// 渲染不出来。这一段换一个「真跑 hooks + 会展开函数组件」的 react 桩，重新实例化一次
// factory，点开弹窗，找到话题行上的 CopyButton，验证它复制的是话题名并就地回显「已复制」。

console.log('话题复制按钮')
const TOPIC = 'dsh_session-test'
const statusPayload = {
  ok: true,
  servers: [{ id: 'srv_1', name: '官方 ntfy.sh', url: 'https://ntfy.sh' }],
  defaultServerId: 'srv_1',
  sessions: [{
    id: 'session-test', label: '测试会话', enabled: true, live: true,
    serverId: 'srv_1', serverName: '官方 ntfy.sh', serverMissing: false,
    topic: TOPIC, topicUrl: 'https://ntfy.sh/' + TOPIC, deepLink: 'ntfy://ntfy.sh/' + TOPIC,
    prefs: { notifyOnTurnEnd: true, notifyOnPending: true, notifyOnError: true, phonePriority: true, relayTimeoutSec: 180 },
    overrides: [],
  }],
}
const realFetch = globalThis.fetch
globalThis.fetch = async () => ({ json: async () => statusPayload })
let copied = null
window.navigator = { clipboard: { writeText: async (text) => { copied = text } } }
const COPY_TITLE = '复制话题名（手机 ntfy App 订阅用）'

let hookStates = []
let hookIndex = 0
let dirty = false
const react2 = {
  createElement: (tag, props, ...children) => ({ tag, props: props ?? {}, children }),
  Fragment: 'Fragment',
  useState: (initial) => {
    const i = hookIndex++
    if (hookStates.length <= i) hookStates[i] = typeof initial === 'function' ? initial() : initial
    return [hookStates[i], (value) => {
      hookStates[i] = typeof value === 'function' ? value(hookStates[i]) : value
      dirty = true
    }]
  },
  // 不跑副作用：唯一的 effect 是 4 秒轮询，测试里不需要。
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (initial) => ({ current: initial }),
}
// primitives 的 Button 在这里要展开成真实节点，否则根节点的第一个子节点会消失。
const primitives2 = { Button: (props) => react2.createElement('button', props, ...(props.children ?? [])) }
const require2 = (id) => {
  if (id === 'react') return react2
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives2
  throw new Error('未预期的外部模块：' + id)
}

/** 递归收集命中 match（标签字符串或谓词）的元素。 */
function collect(node, match, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const item of node) collect(item, match, out); return out }
  if (typeof match === 'function' ? match(node) : node.tag === match) out.push(node)
  if (Array.isArray(node.children)) for (const child of node.children) collect(child, match, out)
  return out
}

/** 展开函数组件（把 tag 为函数的节点替换成它 render 出来的节点）。 */
function expand(node) {
  if (node === null || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node.tag === 'function') return expand(node.tag({ ...node.props, children: node.children }))
  return { ...node, children: (node.children ?? []).map(expand) }
}

let header2 = null
try {
  const mod2 = factory(require2)
  mod2.apply({
    slots: {
      inject: (name, callback) => callback(),
      register: (spec, component) => {
        if (spec.name === 'conversation.session.header.utilities') header2 = { ...spec, component }
        return () => {}
      },
    },
  })
  check('第二次实例化成功', header2 !== null)
} catch (error) {
  check('第二次实例化成功', false, String(error && error.message ? error.message : error))
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
/** 最近一次未展开的元素树：函数组件（CopyButton）只在展开前可见。 */
let lastRaw = null
/** 反复渲染到没有 setState 排队为止；hook 状态与展开顺序跨渲染保持一致。 */
function renderFull() {
  let guard = 0
  let out = null
  do {
    dirty = false
    hookIndex = 0
    lastRaw = header2.component({ sessionId: 'session-test' })
    out = expand(lastRaw)
  } while (dirty && guard++ < 10)
  return out
}

if (header2 !== null) {
  try {
    const first = renderFull()
    first.children[0].props.onClick() // 打开弹窗 → setOpen + 拉一次 /status
    await tick()
    const tree2 = renderFull()
    const isCopyTag = (node) => typeof node.tag === 'function' && node.tag.name === 'CopyButton'
    const copyEls = collect(lastRaw, isCopyTag)
    check('弹窗话题行有复制按钮', copyEls.length === 1, `实际 ${copyEls.length}`)
    check('复制按钮绑的是话题名', copyEls.length === 1 && copyEls[0].props.text === TOPIC,
      copyEls.length === 1 ? `实际 ${JSON.stringify(copyEls[0].props.text)}` : '')

    const findCopyBtn = (node) => collect(node, 'button').find((n) => n.props.title === COPY_TITLE)
    const before = findCopyBtn(tree2)
    check('复制按钮已渲染出来', before !== undefined)
    check('初始文案为「复制」', before !== undefined && before.children[0] === '复制',
      before === undefined ? '' : `实际 ${JSON.stringify(before.children[0])}`)

    // 「打开」改成「网页打开」，并且与「复制」共用同一套小按钮样式（样式对象同一引用）。
    const openEls = collect(tree2, 'a').filter((n) => n.children[0] === '网页打开')
    check('话题行有「网页打开」链接', openEls.length === 1, `实际 ${openEls.length}`)
    check('「网页打开」指向话题 URL 且新标签打开',
      openEls.length === 1 && openEls[0].props.href === statusPayload.sessions[0].topicUrl
        && openEls[0].props.target === '_blank')
    check('「网页打开」与「复制」样式一致',
      openEls.length === 1 && before !== undefined && openEls[0].props.style === before.props.style)

    // 弹窗最下面的 ntfy App 下载入口：两条外链，地址必须精确。
    const appLinks = collect(tree2, 'a').filter((n) => n.children[0] === 'iOS' || n.children[0] === 'Android')
    check('弹窗底部有 ntfy App 下载链接（iOS + Android）', appLinks.length === 2, `实际 ${appLinks.length}`)
    check('iOS 链接指向 App Store',
      appLinks.find((n) => n.children[0] === 'iOS')?.props.href === 'https://apps.apple.com/app/ntfy/id1625396347',
      JSON.stringify(appLinks.find((n) => n.children[0] === 'iOS')?.props.href))
    check('Android 链接指向官方 APK 直链',
      appLinks.find((n) => n.children[0] === 'Android')?.props.href
        === 'https://github.com/binwiederhier/ntfy-android/releases/download/v1.25.2/ntfy-1.25.2-play-release.apk',
      JSON.stringify(appLinks.find((n) => n.children[0] === 'Android')?.props.href))
    if (before !== undefined) {
      before.props.onClick()
      await tick()
      check('写入剪贴板的内容是话题名', copied === TOPIC, `实际 ${JSON.stringify(copied)}`)
      const after = findCopyBtn(renderFull())
      check('点后回显「已复制」', after !== undefined && after.children[0] === '已复制',
        after === undefined ? '' : `实际 ${JSON.stringify(after.children[0])}`)
    }

    // 四项偏好的说明必须**可见**（写在控件下面），不能只藏在 title 里。
    const words = []
    const walkText = (node) => {
      if (typeof node === 'string') { words.push(node); return }
      if (node === null || typeof node !== 'object') return
      if (Array.isArray(node)) { for (const item of node) walkText(item); return }
      for (const child of node.children ?? []) walkText(child)
    }
    walkText(tree2)
    const allText = words.join('｜')
    const PREF_TEXT = [
      ['回合结束推送', '本回合正常跑完时，把最终回复整段推到手机。'],
      ['审批 / 提问推送', '需要你审批或回答时推一条高优先级通知，并等手机作答。'],
      ['错误 / 中断推送', '模型报错、达到输出上限、被策略拦截时推精简原因；你自己在桌面点「停止」不推。'],
      ['手机优先接管作答', '待决的审批 / 提问由手机来答（网页端不再显示该弹窗）；关掉后仍会推送，但作答回到网页端。'],
    ]
    for (const [label, hint] of PREF_TEXT) {
      check(`偏好可见说明：${label}`, allText.includes(label) && allText.includes(hint))
    }

    // 「手机跳转 ntfy://…」已按用户反馈去掉：status 里仍带着 deepLink，但界面不该渲染它。
    check('话题行不再显示「手机跳转」', !allText.includes('手机跳转'))
    check('不再渲染 ntfy:// 深链接', !allText.includes('ntfy://'))
    // 底部那段「手机 ntfy App 订阅这个话题…」长提示也已去掉。
    check('弹窗不再显示订阅 / 回复长提示', !allText.includes('点通知即落在本话题'))
    // 取而代之的是 App 下载入口（可见标题 + 两个链接）。
    check('弹窗底部可见「ntfy App 下载地址」', allText.includes('ntfy App 下载地址：'))
  } catch (error) {
    check('复制按钮行为验证', false, String(error && error.message ? error.message : error))
  } finally {
    globalThis.fetch = realFetch
  }
}

console.log(failed === 0 ? '\n客户端冒烟测试全部通过' : `\n${failed} 个用例失败`)
process.exit(failed === 0 ? 0 : 1)
