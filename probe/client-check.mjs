// 客户端 bundle 冒烟测试：不打开浏览器，用桩执行 lib/client.js，验证
//   1. factory 能执行完（模块体没有运行时错误）
//   2. 导出 name / inject / apply
//   3. apply(ctx) 会把两个槽位都注册上，且设置页标签为 ntfy remote
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
check('设置页标签为 ntfy remote', settings !== undefined && settings.label() === 'ntfy remote',
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

console.log(failed === 0 ? '\n客户端冒烟测试全部通过' : `\n${failed} 个用例失败`)
process.exit(failed === 0 ? 0 : 1)
