// dsh-ntfy-remote — 浏览器半边。
//
// 两处界面，内容与宿主自带的独立状态页 /dsh-ntfy-remote 保持一致：
//   1. 会话头部右上角（conversation.session.header.utilities）：ntfy 按钮，点开看话题
//      key、链接与开关。
//   2. 设置里的一页（settings.section）：服务器增删改 + 会话表（含逐会话偏好覆盖与
//      开关）+ 全局默认通知偏好。
//
// 这个文件是**手写的** lazy-CJS factory bundle，不使用仓库的 tsdown 预设（那套预设
// 依赖仓库内部模块，仓库外无法直接引用）。格式与 @deepseek-ai/dsh-client-modules
// 期望的一致：外层调用 window.__ModuleLoader__.load({ id, factory })，factory 内部用
// 注入的 require 解析外部模块，最后返回 module.exports。
//
// 发现路径：宿主按入口文件（boot3.js）所在目录向上找最近的 package.json，读它的
// dsh.client 与 exports["./client"]，因此本文件必须位于 package.json 同目录的
// lib/client.js。（实测确认它已被编入启动图，combo URL 为
// /plugins/??dsh-ntfy-remote/client.js&rev=…；宿主会在文件变化后重新计算 rev 并分发。）
//
// 只用 react（模块表基线），样式全部内联，数据走宿主注册的同源路由 /dsh-ntfy-remote/*。

window.__ModuleLoader__.load({
  id: 'dsh-ntfy-remote',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = require('react')

    // UI primitives 属于模块表基线（PLATFORM_MODULES），可直接 require。
    // 万一不可用就退回自绘按钮，绝不让整个客户端插件因为一个 require 失败而失效。
    var PrimitiveButton = null
    try {
      var primitives = require('@deepseek-ai/dsh-client-ui-primitives')
      if (primitives && typeof primitives.Button === 'function') PrimitiveButton = primitives.Button
    } catch (error) {
      PrimitiveButton = null
    }

    const name = 'dsh-ntfy-remote/client'
    /** 需要的客户端服务：槽位注册。 */
    const inject = ['slots']

    const STATUS_ROUTE = '/dsh-ntfy-remote/status'
    const QR_ROUTE = '/dsh-ntfy-remote/session/qr'
    const TOGGLE_ROUTE = '/dsh-ntfy-remote/toggle'
    const CONFIG_ROUTE = '/dsh-ntfy-remote/config'
    const SERVER_ADD_ROUTE = '/dsh-ntfy-remote/server/add'
    const SERVER_UPDATE_ROUTE = '/dsh-ntfy-remote/server/update'
    const SERVER_DELETE_ROUTE = '/dsh-ntfy-remote/server/delete'
    const UNBIND_ROUTE = '/dsh-ntfy-remote/session/unbind'
    const FORGET_ROUTE = '/dsh-ntfy-remote/session/forget'
    const PREFS_ROUTE = '/dsh-ntfy-remote/session/prefs'

    /**
     * 逐会话可覆盖的布尔偏好 → 显示名 + 一句说明。
     *
     * 键的顺序就是界面上的顺序。说明既是可见文案（控件下方那行灰字），也是悬停
     * `title`——用户第一次看到「回合 / 待决 / 错误 / 手机优先」这种缩写时不用猜。
     */
    const PREF_ITEMS = {
      notifyOnTurnEnd: {
        label: '回合结束推送',
        hint: '本回合正常跑完时，把最终回复整段推到手机。',
      },
      notifyOnPending: {
        label: '审批 / 提问推送',
        hint: '需要你审批或回答时推一条高优先级通知，并等手机作答。',
      },
      notifyOnError: {
        label: '错误 / 中断推送',
        hint: '模型报错、达到输出上限、被策略拦截时推精简原因；你自己在桌面点「停止」不推。',
      },
      phonePriority: {
        label: '手机优先接管作答',
        hint: '待决的审批 / 提问由手机来答（网页端不再显示该弹窗）；关掉后仍会推送，但作答回到网页端。',
      },
      notifyOnWebTurn: {
        label: '网页发起的回合也推送',
        hint: '关掉后只有从手机发起的回合才会通知手机——回复与状态心跳都不发。'
          + '适合「人就在电脑前，别再来打扰我」的会话；代价是「在电脑上发起长任务、走开后手机收结果」也没了。',
      },
    }

    /**
     * 「作答超时」是什么：头部弹窗、设置页会话卡、全局默认三处共用。
     *
     * 它只影响**手机作答**这条链路：审批 / 提问推到手机后，桥接最多等这么久手机的回执
     * （点按钮、回复编号或直接打字）。超时（或推送失败）就回落 DSH 原生交互——本地弹窗
     * 一直还在继续等，请求不会因为超时而丢失，只是这次不再由手机来答。
     */
    const TIMEOUT_LABEL = '作答超时'
    const TIMEOUT_HINT = '作答超时：审批 / 提问推到手机后，最多等这么久你的回复；'
      + '超时自动回落 DSH 原生交互，本地弹窗继续等，请求不会丢。出厂默认 180 秒。'

    /**
     * 「心跳间隔」说明。
     *
     * 必须一并讲清另外两个时间是**推导**出来的，否则用户会到处找那两项：
     * 死信超时 = 3×，卡住阈值 = 9×。
     */
    const HEARTBEAT_LABEL = '心跳间隔'
    const HEARTBEAT_HINT = '回合心跳间隔：回合进行中，每这么多秒原地更新一次手机上的状态通知'
      + '（同一条，不刷屏；秒数停住就说明 DSH 出问题了）。'
      + '死信超时与「疑似卡住」阈值由它推导：分别是 3 倍与 9 倍。范围 5~300 秒，默认 20。'

    /**
     * ntfy App 下载地址：弹窗最下面给还没装 App 的人一个入口。
     *
     * Android 用官方 GitHub Release 的 play 版 APK 直链（版本号固定），不走 Google Play——
     * 国内手机上 Play 商店经常不可用。
     */
    const APP_IOS_URL = 'https://apps.apple.com/cn/app/ntfy/id1625396347'
    const APP_ANDROID_URL = 'https://github.com/binwiederhier/ntfy-android/releases/download/v1.25.2/ntfy-1.25.2-play-release.apk'

    /**
     * 调用宿主路由；失败抛出带 error 码的异常。
     *
     * @param {string} path 路由
     * @param {object} [body] POST 正文；省略即 GET
     * @returns {Promise<object>}
     */
    async function api(path, body) {
      const response = await fetch(path, body === undefined ? {} : {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await response.json().catch(() => null)
      if (data === null || data.ok !== true) {
        throw new Error((data && data.error) || 'HTTP ' + response.status)
      }
      return data
    }

    /** 内联样式复用。 */
    const S = {
      // 兜底：与「在本地打开」同一套几何（header 控件行 28px、胶囊 14px、细边、
      // 11px 字），这样即使 primitives 不可用，两个框看起来仍是一对。
      btn: {
        display: 'inline-flex', alignItems: 'center', gap: 5, boxSizing: 'border-box',
        height: 28, padding: '0 10px',
        border: '0.5px solid var(--dsw-alias-border-l4, #d5d5d5)', borderRadius: 14,
        background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 11,
        lineHeight: '16px', cursor: 'pointer', whiteSpace: 'nowrap',
      },
      dot: (on) => ({ width: 8, height: 8, borderRadius: '50%', background: on ? '#2e7d32' : '#bdbdbd' }),
      backdrop: {
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 9999,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      },
      card: {
        width: 480, maxWidth: '92vw', maxHeight: '80vh', overflow: 'auto',
        background: 'var(--dsh-surface, #fff)', color: 'inherit', border: '1px solid var(--dsh-border, #ddd)',
        borderRadius: 10, boxShadow: '0 12px 40px rgba(0,0,0,.22)', padding: 18,
        fontSize: 13, lineHeight: 1.7, textAlign: 'left',
      },
      h: { fontSize: 14, fontWeight: 600, margin: '0 0 10px' },
      h2: { fontSize: 13, fontWeight: 600, margin: '20px 0 8px', opacity: 0.75 },
      row: { margin: '6px 0', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      label: { color: '#888', minWidth: 64 },
      code: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11,
        background: 'rgba(127,127,127,.12)', padding: '1px 5px', borderRadius: 3, wordBreak: 'break-all',
      },
      actions: { display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' },
      primary: {
        padding: '5px 14px', border: '1px solid #2e7d32', background: '#2e7d32', color: '#fff',
        borderRadius: 6, cursor: 'pointer', font: 'inherit',
      },
      plain: {
        padding: '4px 10px', border: '1px solid var(--dsh-border, #ccc)', background: 'transparent',
        color: 'inherit', borderRadius: 6, cursor: 'pointer', font: 'inherit', fontSize: 12,
      },
      input: {
        padding: '5px 8px', border: '1px solid var(--dsh-border, #ccc)', borderRadius: 5,
        background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 12,
      },
      err: { color: '#b3261e', marginTop: 10 },
      muted: { color: '#999' },
      // 话题行上的小按钮（「网页打开」与「复制」）共用同一套几何：`<a>` 与 `<button>`
      // 默认外观差很多（蓝色下划线 vs 边框按钮），这里统一成一样的小胶囊边框。
      smallBtn: {
        display: 'inline-flex', alignItems: 'center', boxSizing: 'border-box',
        padding: '1px 8px', border: '1px solid var(--dsh-border, #ccc)', borderRadius: 6,
        background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 11,
        lineHeight: '16px', cursor: 'pointer', textDecoration: 'none', whiteSpace: 'nowrap',
      },
      cardRow: {
        border: '1px solid var(--dsh-border, #e5e5e5)', borderRadius: 8, padding: '10px 12px', marginBottom: 8,
      },
    }

    /**
     * 元素简写，避免满屏 createElement。
     *
     * @param {string|any} tag 标签或组件
     * @param {object | null} props 属性
     * @param {...any} children 子节点
     * @returns {import('react').ReactElement}
     */
    const el = (tag, props, ...children) => react.createElement(tag, props, ...children)

    /** 小圆角标签。 */
    const chip = (text, extra) => el('span', {
      style: {
        fontSize: 11, padding: '1px 6px', borderRadius: 99,
        background: 'rgba(127,127,127,.15)', color: 'inherit', ...extra,
      },
    }, text)

    /**
     * 话题「网页打开」链接：在浏览器新标签页里打开话题页（ntfy Web）。
     *
     * 样式与旁边的「复制」按钮完全一致（同一个小胶囊），不再是默认的蓝色下划线链接；
     * 完整 URL 放在 `title` 里，悬停可见。
     *
     * @param {string} url 地址
     * @returns {import('react').ReactElement}
     */
    const openLink = (url) => el('a', {
      href: url, target: '_blank', rel: 'noreferrer', title: url, style: S.smallBtn,
    }, '网页打开')

    /**
     * 弹窗最下面的 ntfy App 下载入口：iOS 走 App Store，Android 走官方 APK 直链。
     *
     * 两个链接复用「网页打开」那套小按钮样式，完整地址放在悬停 `title` 里，不把两条长
     * URL 铺在弹窗里。
     *
     * @returns {import('react').ReactElement}
     */
    const appDownloadRow = () => el('div', { key: 'apps', style: { marginTop: 12 } },
      el('div', { style: { ...S.muted, fontSize: 11, marginBottom: 5 } }, 'ntfy App 下载地址：'),
      el('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
        el('a', { href: APP_IOS_URL, target: '_blank', rel: 'noreferrer', title: APP_IOS_URL, style: S.smallBtn }, 'iOS'),
        el('a', { href: APP_ANDROID_URL, target: '_blank', rel: 'noreferrer', title: APP_ANDROID_URL, style: S.smallBtn }, 'Android')))

    /**
     * 「扫码添加到手机话题」：一张二维码，内容是该会话的 `ntfy://服务器/话题` 深链接。
     *
     * 图像由宿主路由 `GET /dsh-ntfy-remote/session/qr?sessionId=…` 现算——编码器只有
     * 宿主侧那一份（qr.js），客户端 bundle 不背几百行算法，将来独立状态页要用也
     * 是同一实现。这里只负责摆位置，不在浏览器里做编码。
     *
     * @param {string} sessionId 会话 id
     * @returns {import('react').ReactElement}
     */
    const qrBlock = (sessionId) => el('div', { key: 'qr', style: { marginTop: 12 } },
      el('div', { style: { fontSize: 12, fontWeight: 600, opacity: 0.75, marginBottom: 6 } }, '扫码添加到手机话题'),
      el('div', { style: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' } },
        el('img', {
          src: QR_ROUTE + '?sessionId=' + encodeURIComponent(sessionId),
          alt: '扫码添加到手机话题',
          width: 152,
          height: 152,
          style: {
            width: 152, height: 152, padding: 6, borderRadius: 6,
            background: '#fff', border: '1px solid var(--dsh-border, #e5e5e5)',
          },
        }),
        el('div', { style: { ...S.muted, fontSize: 11, lineHeight: 1.6, maxWidth: 210 } },
          '用手机 ntfy App 扫码即可订阅本会话话题；二维码内容就是该会话在所选服务器上的订阅深链接。')))

    /**
     * 复制文本到剪贴板。
     *
     * 优先 async clipboard API：localhost 与 https 都是安全上下文，可用。局域网 IP 上的
     * 明文 http（`http://192.168.x.x:3080`）不是安全上下文，`navigator.clipboard` 可能是
     * undefined，退回隐藏 textarea + `document.execCommand('copy')`——已废弃，但仍是唯一
     * 不要求安全上下文的方案。两条路都失败才返回 false，由调用方显示「复制失败」。
     *
     * @param {string} text 待复制文本
     * @returns {Promise<boolean>} 是否复制成功
     */
    async function copyText(text) {
      try {
        if (window.navigator && window.navigator.clipboard && typeof window.navigator.clipboard.writeText === 'function') {
          await window.navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        // 被权限或非安全上下文拒绝；继续走 execCommand 兜底，两条都失败才算失败。
      }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        // 不能 display:none，否则 select() 选不中；移出视口即可。
        area.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(area)
        return ok
      } catch {
        return false
      }
    }

    /**
     * 「复制」小按钮：点一下复制给定文本，1.5 秒内就地显示结果，随后自动恢复。
     *
     * @param {{text: string, label?: string, title?: string}} props text 必填
     * @returns {import('react').ReactElement}
     */
    function CopyButton(props) {
      const [state, setState] = react.useState('idle')
      const text = props.text
      const onClick = () => {
        copyText(text).then((ok) => {
          setState(ok ? 'ok' : 'fail')
          setTimeout(() => setState('idle'), 1500)
        })
      }
      const style = state === 'ok'
        ? { ...S.smallBtn, color: '#2e7d32', borderColor: '#a5d6a7' }
        : S.smallBtn
      return el('button', {
        type: 'button',
        style,
        title: props.title ?? '复制到剪贴板',
        onClick,
      }, state === 'ok' ? '已复制' : state === 'fail' ? '复制失败' : (props.label ?? '复制'))
    }

    // ───────────────────────── 会话头部按钮 ─────────────────────────

    /** 会话头部按钮：状态点 + 「ntfy」，点开是弹窗，可就地配置服务器、状态与偏好。 */
    function NtfyHeaderButton(props) {
      const sessionId = props.sessionId
      const [data, setData] = react.useState(null)
      const [selectedServer, setSelectedServer] = react.useState('')
      const [open, setOpen] = react.useState(false)
      const [busy, setBusy] = react.useState(false)
      const [error, setError] = react.useState('')

      const reload = react.useCallback(() => {
        let alive = true
        api(STATUS_ROUTE)
          .then((payload) => {
            if (!alive) return
            setData(payload)
            const me = (payload.sessions || []).find((item) => item.id === sessionId) ?? null
            // 预选：已绑定就用绑定值，否则用全局默认，再否则用第一个。
            // 用函数式更新，避免 4 秒轮询把用户刚选的服务器冲掉。
            setSelectedServer((prev) => (prev !== ''
              ? prev
              : (me && me.serverId) || payload.defaultServerId || ((payload.servers[0] || {}).id) || ''))
          })
          .catch((cause) => {
            if (alive) setError(String(cause && cause.message ? cause.message : cause))
          })
        return () => { alive = false }
      }, [sessionId])

      react.useEffect(() => reload(), [reload])
      react.useEffect(() => {
        if (!open) return undefined
        const timer = setInterval(() => reload(), 4000)
        return () => clearInterval(timer)
      }, [open, reload])

      const servers = data === null ? [] : data.servers
      const info = data === null ? null : ((data.sessions || []).find((item) => item.id === sessionId) ?? null)
      const enabled = !!(info && info.enabled)
      /** 已绑定且服务器仍存在时才禁止改服务器（绑定不可变）。 */
      const boundAlive = !!(info && info.serverId && !info.serverMissing)

      const run = async (fn) => {
        if (busy) return
        setBusy(true)
        setError('')
        try {
          await fn()
          await reload()
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause))
        } finally {
          setBusy(false)
        }
      }

      const toggle = () => run(() => api(TOGGLE_ROUTE, {
        sessionId,
        enabled: !enabled,
        // 已绑定时不必传服务器（后端也会拒绝改绑）；未绑定时用下拉里选中的。
        serverId: boundAlive ? undefined : (selectedServer === '' ? undefined : selectedServer),
      }))

      const savePref = (key, value) => run(() => api(PREFS_ROUTE, { sessionId, key, value }))

      const resetPrefs = () => run(async () => {
        for (const key of info.overrides) await api(PREFS_ROUTE, { sessionId, key, value: null })
      })

      const unbind = () => {
        if (!window.confirm('解除该会话的服务器绑定？话题会重新分配，手机需要重新订阅。')) return
        run(async () => {
          await api(UNBIND_ROUTE, { sessionId })
          setSelectedServer('')
        })
      }

      const dot = (on) => el('span', { style: S.dot(on) })

      /** 一行「标签 + 值 + 若干附加控件」，附加控件按传入顺序排在值右边。 */
      const line = (label, value, ...extra) =>
        el('div', { style: S.row }, el('span', { style: S.label }, label), el('span', null, value), ...extra)

      const serverRow = el('div', { key: 'server', style: S.row },
        el('span', { style: S.label }, '服务器'),
        boundAlive
          ? el('span', null, info.serverName || info.serverId)
          : el('select', {
              value: selectedServer,
              disabled: busy,
              style: { ...S.input, minWidth: 210 },
              onChange: (event) => setSelectedServer(event.target.value),
            }, ...servers.map((sv) => el('option', { key: sv.id, value: sv.id }, sv.name + ' — ' + sv.url))),
        boundAlive ? chip('已绑定，不可变更') : chip('首次开启即固定'),
        boundAlive && !enabled
          ? el('button', { type: 'button', style: { ...S.plain, padding: '2px 8px' }, disabled: busy, onClick: unbind }, '解绑')
          : null)

      // 状态只读：开关在弹窗底部的「开启桥接 / 关闭桥接」按钮上。
      const statusRow = el('div', { key: 'status', style: S.row },
        el('span', { style: S.label }, '状态'),
        dot(enabled),
        el('span', null, enabled ? '已开启' : '已关闭'))

      const body = [
        el('div', { key: 'h', style: S.h }, 'Ntfy Remote'),
        servers.length === 0
          ? el('div', { key: 'noserver', style: S.err }, '还没有配置服务器，请先到「设置 → Ntfy Remote」添加一个。')
          : null,
        servers.length > 0 ? serverRow : null,
        servers.length > 0 ? statusRow : null,
        !info && servers.length > 0
          ? el('div', { key: 'none', style: S.muted }, '这个会话还没开启过桥接。选好服务器后点「开启」。')
          : null,
        info && info.serverMissing
          ? el('div', { key: 'missing', style: S.err }, '原先绑定的服务器已被删除，重新开启会绑定上面选中的服务器。')
          : null,
        info && info.topic
          ? line('话题', el('code', { style: S.code }, info.topic),
              info.topicUrl ? openLink(info.topicUrl) : null,
              el(CopyButton, { key: 'copy', text: info.topic, title: '复制话题名（手机 ntfy App 订阅用）' }))
          : null,
        // 有话题、且服务器还在（deepLink 非空）才画码：服务器被删时画出来也扫不出东西。
        info && info.topic && info.deepLink ? qrBlock(sessionId) : null,
        info ? el('div', { key: 'prefs' }, prefBlock(info, busy, savePref, resetPrefs)) : null,
        appDownloadRow(),
        error ? el('div', { key: 'err', style: S.err }, error) : null,
        el('div', { key: 'act', style: S.actions },
          el('button', { type: 'button', style: S.plain, onClick: () => setOpen(false) }, '关闭'),
          servers.length > 0
            ? el('button', { type: 'button', style: S.primary, disabled: busy, onClick: toggle },
                busy ? '处理中…' : enabled ? '关闭桥接' : '开启桥接')
            : null),
      ]

      const dialog = open
        ? el('div', { style: S.backdrop, onClick: () => setOpen(false) },
            el('div', { style: S.card, onClick: (event) => event.stopPropagation() }, ...body))
        : null

      const title = enabled ? 'Ntfy Remote 桥接已开启' : 'Ntfy Remote 桥接已关闭'
      const onClick = () => { setOpen(true); reload() }
      // size 'sm' = 28px 高 / 14px 胶囊，与「在本地打开」同高同圆角；outline 提供
      // 同样的细边，hover/active 由 primitives 负责。
      const trigger = PrimitiveButton !== null
        ? el(PrimitiveButton, {
            variant: 'outline', size: 'sm', title, onClick,
            style: { fontSize: 11, gap: 5, borderColor: 'var(--dsw-alias-border-l4)' },
          }, dot(enabled), 'ntfy')
        : el('button', { type: 'button', style: S.btn, title, onClick }, dot(enabled), 'ntfy')

      return el(react.Fragment, null, trigger, dialog)
    }

    // ───────────────────────── 设置页 ─────────────────────────

    /**
     * 逐会话偏好控件：勾选即写覆盖，带蓝框表示「已单独设置」。
     *
     * @param {object} it 会话状态项（需含 id / prefs / overrides）
     * @param {boolean} busy 是否正在提交
     * @param {(key: string, value: any) => void} commit 提交一项偏好
     * @returns {import('react').ReactElement[]}
     */
    function prefControls(it, busy, commit) {
      const nodes = Object.keys(PREF_ITEMS).map((key) => {
        const overridden = it.overrides.includes(key)
        const item = PREF_ITEMS[key]
        return el('div', {
          key,
          title: item.hint,
          style: {
            padding: '0 4px', borderRadius: 4, maxWidth: 420,
            outline: overridden ? '2px solid #90caf9' : 'none',
          },
        },
          el('label', {
            style: { display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 12, cursor: 'pointer' },
          },
            el('input', {
              type: 'checkbox', checked: it.prefs[key] === true, disabled: busy,
              onChange: (event) => commit(key, event.target.checked),
            }),
            item.label),
          // 说明直接写在控件下面：用户不用悬停、也不用猜「回合 / 待决」是什么意思。
          el('div', { style: { ...S.muted, fontSize: 11, lineHeight: 1.5, paddingLeft: 20 } }, item.hint))
      })
      const timeoutOverridden = it.overrides.includes('relayTimeoutSec')
      nodes.push(el('div', {
        // key 带上当前值：值变化后强制重挂载，避免非受控输入框显示旧值。
        key: 'relayTimeoutSec-' + String(it.prefs.relayTimeoutSec),
        title: TIMEOUT_HINT,
        style: {
          padding: '0 4px', borderRadius: 4, maxWidth: 420,
          outline: timeoutOverridden ? '2px solid #90caf9' : 'none',
        },
      },
        el('label', {
          style: { display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 12, cursor: 'pointer' },
        },
          el('span', null, TIMEOUT_LABEL),
          el('input', {
            type: 'number', min: 5, defaultValue: String(it.prefs.relayTimeoutSec), disabled: busy,
            title: TIMEOUT_HINT, 'aria-label': TIMEOUT_LABEL + '（秒）',
            style: { ...S.input, width: 70, padding: '2px 6px' },
            onBlur: (event) => commit('relayTimeoutSec', Number(event.target.value)),
          }),
          el('span', null, '秒')),
        el('div', { style: { ...S.muted, fontSize: 11, lineHeight: 1.5, paddingLeft: 20 } }, TIMEOUT_HINT)))
      return nodes
    }

    /**
     * 完整的「本会话通知偏好」块：标题 + 控件 + 恢复默认。头部弹窗与设置页共用。
     *
     * @param {object} it 会话状态项
     * @param {boolean} busy 是否正在提交
     * @param {(key: string, value: any) => void} commit 提交一项偏好
     * @param {() => void} reset 恢复跟随全局默认
     * @returns {import('react').ReactElement}
     */
    function prefBlock(it, busy, commit, reset) {
      return el('div', { style: { marginTop: 12 } },
        el('div', { style: { fontSize: 12, fontWeight: 600, opacity: 0.75, marginBottom: 6 } }, '本会话通知偏好'),
        el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '10px 18px', alignItems: 'flex-start', fontSize: 12 } },
          ...prefControls(it, busy, commit)),
        it.overrides.length > 0
          ? el('button', {
              type: 'button', style: { ...S.plain, marginTop: 6, padding: '2px 8px' }, disabled: busy,
              onClick: reset,
            }, '跟随全局默认')
          : null)
    }

    /** 设置里的一页：与独立状态页同构（服务器 + 会话 + 全局默认偏好）。 */
    function SettingsSection() {
      const [status, setStatus] = react.useState(null)
      const [draft, setDraft] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [note, setNote] = react.useState('')
      const [error, setError] = react.useState('')

      const load = react.useCallback(async () => {
        try {
          const data = await api(STATUS_ROUTE)
          setStatus(data)
          setDraft({
            servers: data.servers.map((s) => ({ id: s.id, name: s.name, url: s.url, token: '', tokenSet: s.tokenSet })),
            defaults: { ...data.defaults },
            defaultServerId: data.defaultServerId,
            fresh: { name: '', url: '', token: '' },
          })
          setError('')
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause))
        }
      }, [])

      react.useEffect(() => { load() }, [load])

      const run = async (fn, okText) => {
        if (busy) return
        setBusy(true)
        setError('')
        setNote('')
        try {
          await fn()
          setNote(okText)
          await load()
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause))
        } finally {
          setBusy(false)
        }
      }

      if (draft === null) return el('div', { style: S.muted }, error || '加载中…')

      /** 设置页里的偏好提交回调（每个会话一份）。 */
      const commitPref = (sessionId) => (key, value) => run(
        () => api(PREFS_ROUTE, { sessionId, key, value }),
        '偏好已保存',
      )

      const patchServer = (id, field, value) => setDraft((prev) => ({
        ...prev,
        servers: prev.servers.map((s) => (s.id === id ? { ...s, [field]: value } : s)),
      }))
      const patchFresh = (field, value) => setDraft((prev) => ({ ...prev, fresh: { ...prev.fresh, [field]: value } }))
      const patchDefault = (field, value) => setDraft((prev) => ({ ...prev, defaults: { ...prev.defaults, [field]: value } }))

      // —— 服务器 ——
      const serverRows = draft.servers.map((sv) => {
        const bound = (status.servers.find((x) => x.id === sv.id) || {}).boundSessions || 0
        return el('div', { key: sv.id, style: S.row },
          el('input', { style: { ...S.input, width: 120 }, value: sv.name, placeholder: '名称', onChange: (e) => patchServer(sv.id, 'name', e.target.value) }),
          el('input', { style: { ...S.input, width: 250 }, value: sv.url, placeholder: 'https://ntfy.example.com', onChange: (e) => patchServer(sv.id, 'url', e.target.value) }),
          el('input', {
            style: { ...S.input, width: 170 }, value: sv.token,
            placeholder: sv.tokenSet ? 'token 已设置（留空不改）' : 'token（可空）',
            onChange: (e) => patchServer(sv.id, 'token', e.target.value),
          }),
          sv.id === draft.defaultServerId ? chip('默认') : null,
          chip('绑定 ' + bound),
          el('button', {
            type: 'button', style: S.plain, disabled: busy,
            onClick: () => run(() => {
              const body = { id: sv.id, name: sv.name, url: sv.url }
              if (sv.token !== '') body.token = sv.token
              return api(SERVER_UPDATE_ROUTE, body)
            }, '服务器已保存'),
          }, '保存'),
          sv.id === draft.defaultServerId ? null : el('button', {
            type: 'button', style: S.plain, disabled: busy,
            onClick: () => run(() => api(CONFIG_ROUTE, { defaultServerId: sv.id }), '已设为默认'),
          }, '设为默认'),
          el('button', {
            type: 'button', style: { ...S.plain, color: '#b3261e' }, disabled: busy,
            onClick: () => {
              if (!window.confirm('删除服务器「' + sv.name + '」？仍有会话绑定时会被拒绝。')) return
              run(() => api(SERVER_DELETE_ROUTE, { id: sv.id }), '服务器已删除')
            },
          }, '删除'))
      })

      // —— 会话 ——
      // 只列有记录的会话（开过桥接：有绑定 / 开关 / 偏好）。活着但从没开过桥接的会话
      // 列在这里没有可管的东西，也让人以为「删除」该对每行都有；那些会话在它自己的
      // ● ntfy 弹窗里开启。
      const recordedSessions = status.sessions.filter((it) => it.recorded)
      const sessionCards = recordedSessions.map((it) => {
        const head = el('div', { key: 'head', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          el('span', { style: { fontWeight: 600 } }, it.label),
          chip(it.live ? '运行中' : '不在内存'),
          it.overrides.length > 0 ? chip('已自定义偏好', { background: '#e3f2fd', color: '#1565c0' }) : null,
          el('span', { style: { marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' } },
            el('span', { style: S.muted }, it.serverMissing ? '服务器已失效' : it.serverName || '未绑定'),
            el('button', {
              type: 'button', disabled: busy,
              style: it.enabled ? { ...S.plain, background: '#e8f5e9', borderColor: '#a5d6a7' } : S.plain,
              onClick: () => run(
                () => api(TOGGLE_ROUTE, { sessionId: it.id, enabled: !it.enabled }),
                it.enabled ? '已关闭' : '已开启',
              ),
            }, it.enabled ? '已开启' : '开启'),
            it.serverId && !it.enabled ? el('button', {
              type: 'button', style: S.plain, disabled: busy,
              onClick: () => {
                if (!window.confirm('解除该会话的服务器绑定？话题会重新分配，手机需要重新订阅。')) return
                run(() => api(UNBIND_ROUTE, { sessionId: it.id }), '已解绑')
              },
            }, '解绑') : null,
            (it.serverId || it.enabled) ? el('button', {
              type: 'button', style: S.plain, disabled: busy,
              title: '只删除 Ntfy Remote 里这条记录（绑定、开关、偏好），不会删除 DSH 会话',
              onClick: () => {
                if (!window.confirm('从 Ntfy Remote 中删除该会话的记录？不会删除 DSH 会话本身，之后可以重新开启。')) return
                run(() => api(FORGET_ROUTE, { sessionId: it.id }), '已删除')
              },
            }, '删除') : null))

        const topicLine = it.topic
          ? el('div', { key: 'topic', style: S.row },
              el('span', { style: S.label }, '话题'),
              el('code', { style: S.code }, it.topic),
              it.topicUrl ? openLink(it.topicUrl) : null,
              el(CopyButton, { key: 'copy', text: it.topic, title: '复制话题名（手机 ntfy App 订阅用）' }))
          : null

        const prefLine = el('div', { key: 'pref' },
          prefBlock(it, busy, commitPref(it.id), () => run(async () => {
            for (const key of it.overrides) await api(PREFS_ROUTE, { sessionId: it.id, key, value: null })
          }, '已恢复跟随全局默认')))

        return el('div', { key: it.id, style: S.cardRow },
          head,
          el('div', { key: 'id', style: { ...S.muted, fontSize: 11, marginTop: 4 } }, it.id),
          topicLine,
          prefLine)
      })

      // —— 全局默认偏好 ——
      const defaults = draft.defaults
      const checkbox = (key, text) => el('label', {
        key, style: { display: 'inline-flex', gap: 4, alignItems: 'center', marginRight: 12 },
      },
        el('input', { type: 'checkbox', checked: defaults[key] === true, onChange: (e) => patchDefault(key, e.target.checked) }),
        text)

      return el('div', null,
        el('div', { style: S.h }, 'Ntfy Remote'),
        el('div', { style: S.muted },
          '与 http://127.0.0.1:3080/dsh-ntfy-remote 内容一致：服务器、会话开关与逐会话偏好、全局默认偏好。'),

        el('div', { style: S.h2 }, '服务器（' + draft.servers.length + '）'),
        ...serverRows,
        el('div', { style: S.row },
          el('input', { style: { ...S.input, width: 120 }, value: draft.fresh.name, placeholder: '名称，如 自建', onChange: (e) => patchFresh('name', e.target.value) }),
          el('input', { style: { ...S.input, width: 250 }, value: draft.fresh.url, placeholder: 'https://ntfy.example.com', onChange: (e) => patchFresh('url', e.target.value) }),
          el('input', { style: { ...S.input, width: 170 }, value: draft.fresh.token, placeholder: 'token（可空）', onChange: (e) => patchFresh('token', e.target.value) }),
          el('button', {
            type: 'button', style: S.primary, disabled: busy,
            onClick: () => run(() => api(SERVER_ADD_ROUTE, draft.fresh), '服务器已新增'),
          }, '新增服务器')),

        el('div', { style: S.h2 }, '会话记录（已开启 ' + status.enabledCount + ' / 共 ' + recordedSessions.length + '）'),
        recordedSessions.length === 0
          ? el('div', { style: S.muted }, '还没有会话记录。打开一个会话，用右上角的 ● ntfy 弹窗开启桥接即可。')
          : null,
        recordedSessions.length !== status.sessions.length
          ? el('div', { style: { ...S.muted, marginTop: 2, marginBottom: 8 } },
              '只列出开过桥接的会话；其它会话在它自己的 ● ntfy 弹窗里开启。')
          : null,
        ...sessionCards,

        el('div', { style: S.h2 }, '全局默认通知偏好（未单独设置过的会话跟随这里）'),
        el('div', { style: S.row },
          checkbox('notifyOnTurnEnd', '回合结束推送'),
          checkbox('notifyOnPending', '审批/提问推送'),
          checkbox('notifyOnError', '错误/中断推送'),
          checkbox('phonePriority', '手机优先接管作答'),
          checkbox('notifyOnWebTurn', '网页发起的回合也推送')),
        el('div', { style: S.row },
          el('span', { title: TIMEOUT_HINT }, TIMEOUT_LABEL),
          el('input', {
            type: 'number', min: 5, value: String(defaults.relayTimeoutSec),
            title: TIMEOUT_HINT, 'aria-label': TIMEOUT_LABEL + '（秒）',
            style: { ...S.input, width: 90 },
            onChange: (e) => patchDefault('relayTimeoutSec', Number(e.target.value)),
          }),
          el('span', null, '秒')),
        el('div', { style: { ...S.muted, fontSize: 11, marginTop: 2, lineHeight: 1.5 } }, TIMEOUT_HINT),
        el('div', { style: S.row },
          el('span', { title: HEARTBEAT_HINT }, HEARTBEAT_LABEL),
          el('input', {
            type: 'number', min: 5, max: 300, value: String(defaults.heartbeatSec),
            title: HEARTBEAT_HINT, 'aria-label': HEARTBEAT_LABEL + '（秒）',
            style: { ...S.input, width: 90 },
            onChange: (e) => patchDefault('heartbeatSec', Number(e.target.value)),
          }),
          el('span', null, '秒')),
        el('div', { style: { ...S.muted, fontSize: 11, marginTop: 2, lineHeight: 1.5 } }, HEARTBEAT_HINT),
        el('div', { style: S.actions },
          el('button', { type: 'button', style: S.primary, disabled: busy, onClick: () => run(() => api(CONFIG_ROUTE, defaults), '默认偏好已保存') }, '保存默认偏好')),

        note ? el('div', { style: { color: '#2e7d32', marginTop: 10 } }, note) : null,
        error ? el('div', { style: S.err }, error) : null)
    }

    /**
     * 客户端插件入口：注册会话头部按钮与设置页。
     *
     * @param {object} ctx 客户端 cordis 上下文
     */
    function apply(ctx) {
      ctx.slots.inject('conversation.session.header.utilities', () => {
        const dispose = ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'dsh-ntfy-remote-header',
          // 列表槽按 priority→order 升序渲染，-20 让它排在 open-in-app（order -10，
          // 「在本地打开」）的左边。
          order: -20,
        }, NtfyHeaderButton)
        return () => dispose()
      })

      ctx.slots.inject('settings.section', () => {
        const dispose = ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-ntfy-remote',
          order: 60,
          label: () => 'Ntfy Remote',
        }, SettingsSection)
        return () => dispose()
      })
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
