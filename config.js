// 配置与状态持久化。
//
// 配置（用户可改）：config.json —— 多服务器列表 + **全局默认偏好**
// 状态（插件自己维护）：state.json —— 已开启的会话、绑定的服务器、**每会话偏好覆盖**、
//                                 去重集合
//
// 偏好分两层：`config.defaults.*` 是全局默认，`state.sessions[id].prefs.*` 是单会话
// 覆盖（只存被改过的键）。取值一律走 Bridge.pref()，不要在别处直接读 config。
//
// 两个文件都用「临时文件 + rename」原子写入：dsh web 可能在任意时刻被 Ctrl-C，
// 半截 JSON 会让下次启动直接失败。
//
// 版本透传：外壳用 ?v= 重新加载时，整张模块图都要重新求值（见 boot3.js）。

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const VERSION = new URL(import.meta.url).search
const { DATA_DIR, describeError, log } = await import(`./log.js${VERSION}`)

const CONFIG_FILE = join(DATA_DIR, 'config.json')
const STATE_FILE = join(DATA_DIR, 'state.json')

/** 去重集合的上限，防止无限增长。 */
const ID_MEMORY_LIMIT = 500

/** 首次运行自动创建的服务器。 */
const FIRST_SERVER = { name: '官方 ntfy.sh', url: 'https://ntfy.sh', token: '' }

/** 可被单会话覆盖的偏好键。 */
export const PREF_KEYS = ['notifyOnTurnEnd', 'notifyOnPending', 'notifyOnError', 'phonePriority', 'relayTimeoutSec']

/** 全局默认偏好。 */
export const DEFAULT_PREFS = {
  notifyOnTurnEnd: true,
  notifyOnPending: true,
  notifyOnError: true,
  maxMessageLength: 3500,
  relayTimeoutSec: 180,
  phonePriority: true,
}

/** 配置默认值；用户不写 config.json 也能直接跑。 */
export const DEFAULT_CONFIG = {
  /** 服务器列表，每项 `{ id, name, url, token }`。 */
  servers: [],
  /** 新会话首次开启时默认选中的服务器 id。 */
  defaultServerId: '',
  /** 全局默认偏好；单会话可在 state.sessions[id].prefs 里覆盖。 */
  defaults: { ...DEFAULT_PREFS },
}

/**
 * 读取 JSON 文件；不存在或损坏都返回 null，由调用方决定默认值。
 *
 * @param {string} file 绝对路径
 * @returns {any | null}
 */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    // 文件不存在（首次启动）或内容损坏；两种情况下都应由调用方使用默认值，
    // 这里没有别的错误来源。
    return null
  }
}

/**
 * 原子写 JSON。
 *
 * @param {string} file 绝对路径
 * @param {unknown} value 待写入的值
 */
function writeJson(file, value) {
  mkdirSync(DATA_DIR, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameSync(tmp, file)
}

/**
 * 生成服务器 id。只含 [0-9a-z_]，可直接拼进 URL 而不需要转义。
 *
 * @returns {string}
 */
export function newServerId() {
  return `srv_${randomBytes(4).toString('hex')}`
}

/**
 * 按 id 取服务器；找不到返回 null（配置被改坏，或服务器已被删除）。
 *
 * @param {{servers: {id: string}[]}} config 配置
 * @param {string} serverId 服务器 id
 * @returns {{id: string, name: string, url: string, token: string} | null}
 */
export function findServer(config, serverId) {
  if (typeof serverId !== 'string' || serverId === '') return null
  return config.servers.find((item) => item.id === serverId) ?? null
}

/**
 * 归一化一条服务器记录：补默认值、去掉尾部斜杠。
 *
 * @param {any} raw 原始记录
 * @returns {{id: string, name: string, url: string, token: string}}
 */
export function normalizeServer(raw) {
  return {
    id: typeof raw?.id === 'string' && raw.id !== '' ? raw.id : newServerId(),
    name: typeof raw?.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : '未命名',
    url: typeof raw?.url === 'string' && raw.url.trim() !== '' ? raw.url.trim().replace(/\/+$/, '') : 'https://ntfy.sh',
    token: typeof raw?.token === 'string' ? raw.token : '',
  }
}

/**
 * 读取配置，补齐默认值，并保证 servers / defaults 存在。
 *
 * 兼容两种旧结构并自动迁移：
 *   - 单服务器（顶层 `server` + `token`）→ 一条命名服务器
 *   - 顶层散落的偏好（`notifyOnTurnEnd` 等）→ `defaults.*`
 *
 * @returns {typeof DEFAULT_CONFIG}
 */
export function loadConfig() {
  const raw = readJson(CONFIG_FILE)
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const config = { ...DEFAULT_CONFIG, ...source }

  let dirty = false
  let servers = Array.isArray(source.servers) ? source.servers.map(normalizeServer) : []
  if (servers.length === 0) {
    const legacyUrl = typeof source.server === 'string' && source.server.trim() !== '' ? source.server : FIRST_SERVER.url
    const legacyToken = typeof source.token === 'string' ? source.token : ''
    servers = [normalizeServer({ name: FIRST_SERVER.name, url: legacyUrl, token: legacyToken })]
    dirty = true
  }
  config.servers = servers
  const ids = new Set(servers.map((item) => item.id))
  config.defaultServerId = ids.has(source.defaultServerId) ? source.defaultServerId : servers[0].id

  // 偏好迁移：旧的顶层字段优先于新结构里的 defaults。
  const defaults = { ...DEFAULT_PREFS, ...(source.defaults !== null && typeof source.defaults === 'object' ? source.defaults : {}) }
  for (const key of Object.keys(DEFAULT_PREFS)) {
    if (source[key] !== undefined) defaults[key] = source[key]
  }
  config.defaults = defaults

  // 丢掉所有已被取代的旧字段，避免两套配置并存造成误解。
  for (const key of ['server', 'token', 'topicSecret', ...Object.keys(DEFAULT_PREFS)]) {
    if (key in config) {
      delete config[key]
      dirty = true
    }
  }

  if (dirty) {
    writeJson(CONFIG_FILE, config)
    log(`config: 已归一化（${servers.length} 个服务器，defaultServerId=${config.defaultServerId}）`)
  }
  return config
}

/**
 * 写回配置。
 *
 * @param {typeof DEFAULT_CONFIG} config 完整配置对象
 */
export function saveConfig(config) {
  writeJson(CONFIG_FILE, config)
}

/** 状态初始值。 */
function defaultState() {
  return { sessions: {}, lastSeenTs: 0, processedIds: [], ownIds: [] }
}

/**
 * 读取插件状态。
 *
 * `sessions[id]` 形如
 * `{ enabled, serverId, topic, cwd, enabledAt, prefs }`：
 * `serverId` 首次开启时确定、之后不可变更；`prefs` 只保存被单独改过的偏好键。
 *
 * @returns {{sessions: Record<string, any>, lastSeenTs: number, processedIds: string[], ownIds: string[]}}
 */
export function loadState() {
  const raw = readJson(STATE_FILE)
  const state = { ...defaultState(), ...(raw !== null && typeof raw === 'object' ? raw : {}) }
  for (const key of ['processedIds', 'ownIds']) {
    if (!Array.isArray(state[key])) state[key] = []
  }
  if (state.sessions === null || typeof state.sessions !== 'object') state.sessions = {}
  return state
}

/**
 * 把一条消息 id 记入某个去重集合（有上限，超出丢弃最旧的）。
 *
 * @param {string[]} list 目标集合（原地修改）
 * @param {string} id 消息 id
 */
export function rememberId(list, id) {
  if (typeof id !== 'string' || id === '') return
  if (list.includes(id)) return
  list.push(id)
  if (list.length > ID_MEMORY_LIMIT) list.splice(0, list.length - ID_MEMORY_LIMIT)
}

/**
 * 创建一个「合并短时间内的多次改动、只写一次盘」的保存器。
 *
 * 每条 ntfy 消息都要更新去重集合，逐条落盘既慢也无必要。
 *
 * @param {() => object} snapshot 返回当前完整状态
 * @returns {{schedule: () => void, flush: () => void}}
 */
export function createStateSaver(snapshot) {
  let timer = null
  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    try {
      writeJson(STATE_FILE, snapshot())
    } catch (error) {
      log(`state: 保存失败 ${describeError(error)}`)
    }
  }
  return {
    schedule() {
      if (timer !== null) return
      timer = setTimeout(() => {
        timer = null
        flush()
      }, 800)
      // 不要因为一个待写的状态文件阻止进程退出。
      timer.unref?.()
    },
    flush,
  }
}

export { CONFIG_FILE, STATE_FILE }
