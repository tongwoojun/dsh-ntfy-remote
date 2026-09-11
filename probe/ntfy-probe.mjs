// ntfy 往返探针 —— 独立于插件，验证「发布一次 POST」+「订阅一条 NDJSON 长连接」
// 在当前网络下真的能跑通。不改动任何状态，话题随机，内容为无意义的探针字符串。
//
// 用法：node probe/ntfy-probe.mjs [server]
//   默认 server = https://ntfy.sh

const server = (process.argv[2] ?? 'https://ntfy.sh').replace(/\/+$/, '')
const topic = `dsh-ntfy-remote-probe-${Math.random().toString(36).slice(2, 12)}`

console.log(`server = ${server}`)
console.log(`topic  = ${topic}`)

const controller = new AbortController()
const overall = setTimeout(() => {
  console.error('FAILED: 总超时 25s')
  controller.abort()
  process.exit(1)
}, 25_000)

let published = false
let got = false

try {
  // 先建立订阅，避免"发布早于订阅"的竞态：ntfy 的实时订阅不会回放缓存。
  const sub = await fetch(`${server}/${topic}/json`, { signal: controller.signal })
  console.log(`subscribe HTTP ${sub.status} ${sub.headers.get('content-type') ?? ''}`)
  if (!sub.ok || sub.body === null) throw new Error('订阅失败')

  const reader = sub.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (!got) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        console.log(`  (非 JSON 行，跳过) ${line.slice(0, 80)}`)
        continue
      }
      console.log(`  event=${event.event} id=${event.id ?? '-'} msg=${event.message ?? '-'}`)

      // 连接一建立就发布，确保消息不会早于订阅。
      if (event.event === 'open' && !published) {
        published = true
        const res = await fetch(server, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ topic, title: 'probe', message: 'hello from dsh-ntfy-remote' }),
        })
        const body = await res.text()
        console.log(`  publish HTTP ${res.status} ${body.trim()}`)
      }

      if (event.event === 'message' && typeof event.message === 'string') got = true
    }
  }
} catch (error) {
  if (controller.signal.aborted) {
    console.error('FAILED: 连接被中断（网络或服务器不可达）')
  } else {
    console.error(`FAILED: ${String(error)}`)
  }
  clearTimeout(overall)
  process.exit(1)
}

clearTimeout(overall)
controller.abort()
console.log(got ? 'ROUND TRIP OK' : 'FAILED: 未收到自己发布的消息')
process.exit(got ? 0 : 1)
