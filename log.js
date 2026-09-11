// 日志：插件跑在 dsh web 进程内部，stdout 未必可见，因此统一写日志文件。
// 这是挂载验证与问题排查的唯一可靠通道。

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** DSH 状态根目录；与 dsh 自身所用的一致。 */
export const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/** 本插件的数据目录（配置、状态、日志、话题密钥都在这里）。 */
export const DATA_DIR = join(DSH_HOME, 'dsh-ntfy-remote')

/** 插件日志文件。 */
export const LOG_FILE = join(DATA_DIR, 'plugin.log')

/**
 * 追加一行日志。
 *
 * @param {string} line 日志正文
 */
export function log(line) {
  // 带 pid：开发期可能同时跑多个 dsh 实例，它们共用同一个日志文件。
  const entry = `${new Date().toISOString()} [pid ${process.pid}] ${line}\n`
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true })
    appendFileSync(LOG_FILE, entry)
  } catch (error) {
    // 只可能是目录或权限问题；日志失败不能影响宿主，把原因交给宿主进程日志。
    process.stderr.write(`[dsh-ntfy-remote] 日志写入失败: ${String(error)}\n`)
  }
}

/**
 * 把任意抛出物收敛成一行可读文本（日志里不写堆栈，避免刷屏）。
 *
 * @param {unknown} error 捕获到的错误
 * @returns {string} 单行描述
 */
export function describeError(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}
