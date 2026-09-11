// dsh-ntfy-remote — 宿主挂载的稳定外壳（开发期自热重载）。
//
// 三条实测教训（都踩过）：
//   1. 宿主挂载的入口文件本身也被 Node 的 ESM 缓存锁住：profile 的 patchReload
//      触发了重新挂载，import 命中的仍是缓存里的旧代码。所以入口文件名一旦挂上
//      就不再改动，实现全部放在 main.js，由这里按 ?v= 动态加载。
//   2. cordis **不会**调用 apply 的返回值作为清理函数，只有 ctx.effect() 注册的
//      disposer 会在 fiber 卸载时执行。因此 fs.watch、定时器、子实例都必须走
//      ctx.effect，否则插件卸载后仍在后台跑（实测：入口移除后 watch 依然存活）。
//   3. fiber 卸载后再往同一个 ctx 注册监听会抛错。热重载必须靠 ctx.effect 拿到
//      的旧实例来清理，而不是复用同一个 ctx 反复注册。
//
// v3：inject 增加 `webServer`，供宿主侧 HTTP 路由（Web UI 与状态页）使用。此前
// 的 boot2.js 已停止使用；入口文件名变更意味着需要重新挂载一次补丁（此后实现
// 改动仍是自热重载）。
//
// 版本号通过 import.meta.url 的查询串向下透传，整张模块图都会重新求值。
//
// 硬约束：纯 ESM .js、运行时零 @deepseek-ai/* import（详见 README）。

import { watch } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-ntfy-remote'

/** 依赖的服务：命令注册、agent 注册表、工具与审批瀑布、宿主 Web 服务器。 */
export const inject = ['commands', 'agents', 'tools', 'approval', 'webServer']

const HERE = dirname(fileURLToPath(import.meta.url))

/** 源文件改动合并成一次重载的等待时间。 */
const DEBOUNCE_MS = 300

/**
 * 外壳入口：加载实现、监听源文件、卸载时收尾。
 *
 * @param {object} ctx cordis 上下文
 */
export function apply(ctx) {
  const state = { dispose: null, timer: null, reloading: false, queued: false, stopped: false }

  /** 重新加载实现：先卸载上一版，再按新版本号导入。 */
  const reload = async () => {
    if (state.stopped) return
    if (state.reloading) {
      state.queued = true
      return
    }
    state.reloading = true
    try {
      if (typeof state.dispose === 'function') state.dispose()
      state.dispose = null
      const module = await import(`./main.js?v=${Date.now()}`)
      const dispose = module.apply(ctx)
      state.dispose = typeof dispose === 'function' ? dispose : null
    } catch (error) {
      // 实现加载失败绝不能拖垮宿主：写 stderr，等下一次改动再试。
      process.stderr.write(`[dsh-ntfy-remote] 重载失败: ${String(error)}\n`)
    } finally {
      state.reloading = false
      if (state.queued) {
        state.queued = false
        void reload()
      }
    }
  }

  void reload()

  const watcher = watch(HERE, { persistent: false }, (_event, filename) => {
    if (typeof filename === 'string' && !filename.endsWith('.js')) return
    if (state.timer !== null) clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      state.timer = null
      void reload()
    }, DEBOUNCE_MS)
  })

  // 清理必须走 ctx.effect：cordis 不调用 apply 的返回值。
  ctx.effect(() => () => {
    state.stopped = true
    if (state.timer !== null) clearTimeout(state.timer)
    watcher.close()
    if (typeof state.dispose === 'function') state.dispose()
  })
}
