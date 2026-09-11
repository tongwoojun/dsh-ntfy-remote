// dsh-ntfy-remote — 真实实现入口。
//
// 本文件不直接被宿主挂载；宿主挂载的是 boot.js 外壳，外壳按版本号动态
// import 本文件。因此这里必须用「版本透传」的方式导入同级模块，否则外壳
// 拿到的是新版本、同级模块却仍命中 Node 的 ESM 缓存（旧代码）。
//
// 关键约束：外壳重载时会用**同一个 ctx** 再次调用 apply。ctx 上注册的监听与
// 命令不会因为上一次 apply 结束而消失，所以 apply 必须自己收集所有注销函数
// 并在卸载时逆序执行——否则第二次 register('ntfy') 会因重名直接抛错（实测踩到）。
//
// 硬约束：纯 ESM、运行时零 @deepseek-ai/* import（详见 boot.js 注释）。

const VERSION = new URL(import.meta.url).search

const { Bridge } = await import(`./bridge.js${VERSION}`)
const { loadConfig, loadState } = await import(`./config.js${VERSION}`)
const { describeError, log } = await import(`./log.js${VERSION}`)
const { registerRoutes } = await import(`./routes.js${VERSION}`)

export const name = 'dsh-ntfy-remote'

/** 依赖的服务：命令注册、agent 注册表、工具与审批瀑布。 */
export const inject = ['commands', 'agents', 'tools', 'approval']

/**
 * 本实例的世代号。热重载会让同一进程里先后存在多个实例，只有最新一代可以
 * 推送与订阅；旧实例凭这个号码静默退场（见 bridge.js 的 isCurrent）。
 */
const GENERATION_KEY = Symbol.for('dsh-ntfy-remote.generation')
const generation = (globalThis[GENERATION_KEY] = (globalThis[GENERATION_KEY] ?? 0) + 1)

/**
 * 插件入口。
 *
 * @param {object} ctx cordis 上下文
 * @returns {() => void} 卸载函数（由 boot.js 外壳在重载或宿主卸载时调用）
 */
export function apply(ctx) {
  let config
  let state
  try {
    config = loadConfig()
    state = loadState()
  } catch (error) {
    // 配置或状态损坏时不能让宿主加载失败：记日志并放弃挂载本次功能。
    log(`启动失败：配置/状态不可用 ${describeError(error)}`)
    return () => {}
  }

  const bridge = new Bridge(ctx, config, state, generation)
  /** 本次加载登记的所有注销函数，卸载时逆序执行。 */
  const disposers = []
  const own = (disposer) => {
    if (typeof disposer === 'function') disposers.push(disposer)
  }

  // 会话事件流：缓存 assistant 输出、回合结束时推送。
  own(
    ctx.on('session/event', (session, event) => {
      try {
        bridge.onSessionEvent(session, event)
      } catch (error) {
        log(`session/event 处理失败 ${describeError(error)}`)
      }
    }),
  )

  // 需要手机作答的两条瀑布：返回结果即接管，调用 next() 即回落原生交互。
  //
  // `approval/request` 必须 prepend + global：
  //   - dsh-user-approval 用 scopeTarget(req.agent, ...) 做**作用域过滤**分发，插件
  //     自己的 ctx 不在该 agent 的作用域链里，默认收不到。实测：会话日志里有
  //     approval/asked 审计事件、网页端也答了，而本插件的监听完全没被调用。
  //     `global: true` 明确跳过该过滤。
  //   - 链上已存在 Web UI 的终结型 answerer（它不会调用 next()），`prepend: true`
  //     让本插件的 answerer 先跑；未开启桥接时再 next() 交回，网页端行为不变。
  own(
    ctx.on('approval/request', (request, next) => bridge.handleApproval(request, next), {
      prepend: true,
      global: true,
    }),
  )
  // `tools/execute` 实测在默认注册下就能收到（真实宿主里的 ask_user_question 已被
  // 拦截），这里同样显式声明 global，避免作用域过滤在其它组合下把它挡掉。
  own(ctx.on('tools/execute', (exec, next) => bridge.handleAskUserQuestion(exec, next), { global: true }))

  // 桌面端开关：/ntfy on | off | key | status | test
  try {
    own(
      ctx.commands.register({
        name: 'ntfy',
        description: '手机桥接：开启/关闭本会话的 ntfy 推送与手机回复',
        input: { hint: 'on | off | key | status | test' },
        handler: (invocation) => bridge.handleCommand(invocation),
      }),
    )
  } catch (error) {
    // 同名命令已存在（上一次加载未清理干净）时不让整次加载失败。
    log(`命令注册失败，/ntfy 本次不可用：${describeError(error)}`)
  }

  // 会话被销毁时安排一次存在性核对。注意 dispose ≠ 删除：只是关掉会话也会触发，
  // 真正的判定在 Bridge.sweepMissingSessions 里按持久化列表做。
  own(ctx.on('session/disposed', () => bridge.scheduleSweep(), { global: true }))

  // 宿主侧 HTTP 路由：自包含状态页与（后续的）Web UI 客户端共用同一套接口。
  own(registerRoutes(ctx, bridge))

  bridge.start()
  log(`plugin loaded (full) servers=${config.servers.length} enabledSessions=${bridge.enabledCount()} phonePriority=${config.defaults.phonePriority}`)

  return () => {
    bridge.stop()
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch (error) {
        log(`注销失败 ${describeError(error)}`)
      }
    }
  }
}
