// 大肥鱼 AI 房管 · 设置页面板
// 只依赖 react；所有请求走 /dafeiyu-moderator/api，统一带 x-dafeiyu: 1。
window.__ModuleLoader__.load({
  id: '@local/dafeiyu-moderator',
  factory(require) {
    const React = require('react')
    const { useEffect, useRef, useState } = React
    const h = React.createElement

    const API = '/dafeiyu-moderator/api'

    const C = {
      text: 'var(--dsw-alias-label-primary, #e8e8ee)',
      sub: 'var(--dsw-alias-label-secondary, #b8b8c4)',
      faint: 'var(--dsw-alias-label-tertiary, #8d8d9c)',
      border: 'var(--dsw-alias-border-primary, rgba(255,255,255,.12))',
      bg: 'var(--dsw-alias-bg-secondary, #191920)',
      input: 'var(--dsw-alias-bg-primary, #101016)',
      accent: 'var(--dsw-alias-brand-primary, #6aa9ff)',
      danger: 'var(--dsw-alias-state-error-primary, #ff6b6b)',
      ok: 'var(--dsw-alias-state-success-primary, #59d18b)',
    }

    const S = {
      card: { border: `1px solid ${C.border}`, borderRadius: '10px', padding: '14px', background: C.bg, marginBottom: '12px' },
      title: { fontSize: '13px', fontWeight: 700, color: C.text, marginBottom: '8px' },
      headRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' },
      row: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(168px,1fr))', gap: '8px' },
      group: { fontSize: '11px', fontWeight: 600, color: C.accent, margin: '12px 0 6px' },
      input: { background: C.input, color: C.text, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '7px 9px', fontSize: '12px', outline: 'none', boxSizing: 'border-box' },
      btn: { border: `1px solid ${C.border}`, background: 'transparent', color: C.text, borderRadius: '6px', padding: '6px 10px', fontSize: '12px', cursor: 'pointer' },
      primary: { border: `1px solid ${C.accent}`, background: C.accent, color: '#08111f', borderRadius: '6px', padding: '6px 10px', fontSize: '12px', cursor: 'pointer', fontWeight: 600 },
      small: { color: C.faint, fontSize: '11px', lineHeight: 1.7 },
      code: { color: C.sub, fontSize: '11px', wordBreak: 'break-all', lineHeight: 1.6 },
      banner: { border: `1px solid ${C.accent}`, background: 'rgba(106,169,255,.12)', color: C.text, borderRadius: '8px', padding: '8px 10px', fontSize: '12px', marginBottom: '12px', fontWeight: 600 },
      stat: { border: `1px solid ${C.border}`, borderRadius: '8px', padding: '6px 10px', minWidth: '72px' },
      statValue: { fontSize: '16px', fontWeight: 700, color: C.text, lineHeight: 1.25 },
      statLabel: { fontSize: '10px', color: C.faint, marginTop: '1px' },
      list: { border: `1px solid ${C.border}`, borderRadius: '8px', padding: '6px 8px', maxHeight: '280px', overflow: 'auto' },
      line: { display: 'flex', gap: '8px', alignItems: 'baseline', padding: '3px 0', borderBottom: `1px dashed ${C.border}`, fontSize: '12px', color: C.text, wordBreak: 'break-all' },
      tag: { fontSize: '10px', lineHeight: '14px', padding: '0 5px', borderRadius: '4px', borderStyle: 'solid', borderWidth: '1px', whiteSpace: 'nowrap', flex: 'none' },
    }

    // ---------------- 基础工具 ----------------
    async function api(path, options = {}) {
      const init = {
        method: options.method || 'GET',
        headers: { 'content-type': 'application/json', 'x-dafeiyu': '1' },
        cache: 'no-store',
      }
      if (options.body !== undefined) init.body = JSON.stringify(options.body)
      let response
      try {
        response = await fetch(`${API}${path}`, init)
      } catch (error) {
        throw new Error('连不上房管后端：插件可能没启动，或者刚重启还没就绪，稍等一下再试')
      }
      const raw = await response.text().catch(() => '')
      let data = null
      if (raw) {
        try { data = JSON.parse(raw) } catch (error) { data = null }
      }
      if (!data || typeof data !== 'object') throw new Error(`接口 ${path} 没返回 JSON（HTTP ${response.status}）`)
      if (!response.ok || data.ok === false) throw new Error(String(data.error || `HTTP ${response.status}`))
      return data
    }

    function clone(value) {
      try { return JSON.parse(JSON.stringify(value)) } catch (error) { return value }
    }

    function pad2(value) { return String(value).padStart(2, '0') }

    function toMs(value) {
      if (value === null || value === undefined || value === '') return 0
      const num = Number(value)
      if (Number.isFinite(num) && num > 0) return num < 1e11 ? num * 1000 : num
      const parsed = new Date(value)
      const time = parsed.getTime()
      return Number.isFinite(time) ? time : 0
    }

    function fmtTime(value) {
      const ms = toMs(value)
      if (!ms) return '—'
      const date = new Date(ms)
      return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
    }

    function fmtDateTime(value) {
      const ms = toMs(value)
      if (!ms) return '还没有'
      const date = new Date(ms)
      return `${date.getMonth() + 1}月${date.getDate()}日 ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
    }

    function toNumber(value, fallback) {
      const fallbackValue = fallback === undefined ? 0 : fallback
      if (value === '' || value === null || value === undefined) return fallbackValue
      const num = Number(value)
      return Number.isFinite(num) ? num : fallbackValue
    }

    function toBool(value) {
      return value === true || value === 1 || value === '1' || value === 'true'
    }

    function setIn(source, path, value) {
      const next = clone(source)
      const keys = String(path).split('.')
      let cursor = next && typeof next === 'object' ? next : {}
      const root = cursor
      for (let index = 0; index < keys.length - 1; index += 1) {
        const key = keys[index]
        if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {}
        cursor = cursor[key]
      }
      cursor[keys[keys.length - 1]] = value
      return root
    }

    function buildPatch(source) {
      const next = source && typeof source === 'object' ? source : {}
      const persona = next.persona && typeof next.persona === 'object' ? next.persona : {}
      const speak = next.speak && typeof next.speak === 'object' ? next.speak : {}
      const moderation = next.moderation && typeof next.moderation === 'object' ? next.moderation : {}
      const muteOn = moderation.muteOn && typeof moderation.muteOn === 'object' ? moderation.muteOn : {}
      const vision = next.vision && typeof next.vision === 'object' ? next.vision : {}
      const asr = next.asr && typeof next.asr === 'object' ? next.asr : {}
      const llm = next.llm && typeof next.llm === 'object' ? next.llm : {}
      const quietHours = next.quietHours && typeof next.quietHours === 'object' ? next.quietHours : {}
      const words = (value) => (Array.isArray(value) ? value.map((item) => String(item)) : [])
      return {
        roomId: toNumber(next.roomId, 0),
        enabled: toBool(next.enabled),
        dryRun: toBool(next.dryRun),
        cookieFile: String(next.cookieFile || ''),
        pythonPath: String(next.pythonPath || ''),
        ffmpegPath: String(next.ffmpegPath || ''),
        persona: {
          name: String(persona.name || '').trim(),
          species: String(persona.species || '').trim(),
          look: String(persona.look || '').trim(),
          origin: String(persona.origin || '').trim(),
          selfCall: String(persona.selfCall || '').trim(),
          masterName: String(persona.masterName || '').trim() || '主人',
          callAnchor: toBool(persona.callAnchor),
          tone: String(persona.tone || '').trim(),
          catchphrases: words(persona.catchphrases),
          extra: String(persona.extra || '').trim(),
        },
        llm: { effort: ['off', 'low', 'medium', 'high'].includes(String(llm.effort || '')) ? String(llm.effort) : 'low' },
        speak: {
          enabled: toBool(speak.enabled),
          maxPerMinute: toNumber(speak.maxPerMinute, 4),
          minGapSec: toNumber(speak.minGapSec, 15),
          maxChars: toNumber(speak.maxChars, 20),
          replyToAnchor: toBool(speak.replyToAnchor),
          reactToGift: toBool(speak.reactToGift),
          greetEnter: toBool(speak.greetEnter),
          chatIntervalSec: toNumber(speak.chatIntervalSec, 75),
          quietAfterSec: toNumber(speak.quietAfterSec, 180),
        },
        moderation: {
          enabled: toBool(moderation.enabled),
          warnBeforeMute: toNumber(moderation.warnBeforeMute, 2),
          windowMin: toNumber(moderation.windowMin, 30),
          muteMinutes: toNumber(moderation.muteMinutes, 5),
          autoUnban: toBool(moderation.autoUnban),
          maxMutesPerHour: toNumber(moderation.maxMutesPerHour, 5),
          whitelist: words(moderation.whitelist),
          extraWords: words(moderation.extraWords),
          muteOn: {
            spam: toBool(muteOn.spam),
            ad: toBool(muteOn.ad),
            insult: toBool(muteOn.insult),
            harassment: toBool(muteOn.harassment),
            spoiler: toBool(muteOn.spoiler),
          },
        },
        vision: {
          enabled: toBool(vision.enabled),
          intervalMin: toNumber(vision.intervalMin, 8),
          maxPerHour: toNumber(vision.maxPerHour, 6),
        },
        asr: {
          enabled: toBool(asr.enabled),
          modelDir: String(asr.modelDir || ''),
          language: String(asr.language || 'zh'),
          gapSec: toNumber(asr.gapSec, 1.2),
          maxPerMinute: toNumber(asr.maxPerMinute, 30),
          reactToName: toBool(asr.reactToName),
        },
        quietHours: {
          enabled: toBool(quietHours.enabled),
          start: String(quietHours.start || '03:00'),
          end: String(quietHours.end || '07:00'),
        },
      }
    }

    // ---------------- 小组件 ----------------
    function Card({ title, right, children }) {
      return h('div', { style: S.card },
        h('div', { style: S.headRow },
          h('div', { style: { fontSize: '13px', fontWeight: 700, color: C.text } }, title),
          right || null),
        children)
    }

    function Btn({ children, onClick, primary, danger, disabled }) {
      const base = primary ? S.primary : S.btn
      const style = danger ? { ...S.btn, color: C.danger, borderColor: C.danger } : base
      return h('button', {
        type: 'button',
        onClick,
        disabled,
        style: { ...style, opacity: disabled ? 0.45 : 1, cursor: disabled ? 'not-allowed' : 'pointer' },
      }, children)
    }

    function Field({ label, hint, children }) {
      return h('label', { style: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', color: C.sub, minWidth: 0 } },
        h('span', null, label),
        children,
        hint ? h('span', { style: { color: C.faint, fontSize: '10px' } }, hint) : null)
    }

    function TextField({ label, value, onChange, placeholder, maxLength, hint }) {
      return h(Field, { label, hint },
        h('input', {
          style: S.input,
          value: value === undefined || value === null ? '' : String(value),
          placeholder: placeholder || '',
          maxLength,
          onChange: (event) => onChange(event.target.value),
        }))
    }

    function NumberField({ label, value, onChange, min, max, step, hint }) {
      return h(Field, { label, hint },
        h('input', {
          type: 'number',
          style: S.input,
          min,
          max,
          step: step === undefined ? 1 : step,
          value: value === undefined || value === null ? '' : String(value),
          onChange: (event) => {
            const raw = event.target.value
            if (raw === '') { onChange(''); return }
            const num = Number(raw)
            if (Number.isFinite(num)) onChange(num)
          },
        }))
    }

    function SelectField({ label, value, options, onChange, hint }) {
      return h(Field, { label, hint },
        h('select', {
          style: { ...S.input, height: '28px' },
          value: value === undefined || value === null ? '' : String(value),
          onChange: (event) => onChange(event.target.value),
        }, (options || []).map((item) => h('option', { key: item.value, value: item.value }, item.label))))
    }

    function Check({ label, checked, onChange }) {      return h('label', {
        style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: checked ? C.text : C.sub, cursor: 'pointer', minHeight: '26px' },
      },
        h('input', { type: 'checkbox', checked: checked === true, onChange: (event) => onChange(event.target.checked) }),
        label)
    }

    function Pill({ ok, children }) {
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '5px', color: ok ? C.ok : C.faint, fontSize: '11px' } },
        h('span', { style: { width: '7px', height: '7px', borderRadius: '50%', background: ok ? C.ok : C.faint, display: 'inline-block' } }),
        children)
    }

    function Stat({ label, value, color }) {
      return h('div', { style: S.stat },
        h('div', { style: { ...S.statValue, color: color || C.text } }, String(value === undefined || value === null ? 0 : value)),
        h('div', { style: S.statLabel }, label))
    }

    function Tag({ color, children }) {
      return h('span', { style: { ...S.tag, color, borderColor: color } }, children)
    }

    function describeEvent(event) {
      if (!event || typeof event !== 'object') return { label: '消息', color: C.sub, text: '（空消息）', body: C.sub }
      const type = event.type ? String(event.type) : 'danmaku'
      if (type === 'gift') {
        const num = Number(event.num) || 0
        return { label: '礼物', color: C.accent, text: `${event.giftName || '礼物'}${num > 1 ? ` ×${num}` : ''}`, body: C.text }
      }
      if (type === 'sc') return { label: '醒目留言', color: C.ok, text: event.text || '（没读到内容）', body: C.text }
      if (type === 'enter') return { label: '进场', color: C.faint, text: event.note || '进入直播间', body: C.sub }
      if (type === 'follow') return { label: '关注', color: C.accent, text: '关注了直播间', body: C.sub }
      if (type === 'live') {
        const liveStatus = Number(event.liveStatus)
        const label = liveStatus === 2 ? '下播' : '开播'
        const text = event.note || (liveStatus === 1 ? '开播了' : liveStatus === 2 ? '下播了' : '直播状态变了')
        return { label, color: liveStatus === 2 ? C.faint : C.ok, text, body: C.sub }
      }
      if (type === 'view') return { label: '人气', color: C.faint, text: `${Number(event.viewers) || 0} 人在看`, body: C.sub }
      if (type === 'speech') {
        const dur = Number(event.dur) || 0
        return { label: '主播说', color: C.ok, text: `${event.text || ''}${dur ? `（${dur.toFixed(1)}s）` : ''}`, body: C.sub }
      }
      if (type === 'system') return { label: '系统', color: C.sub, text: event.note || event.text || '系统消息', body: C.sub }
      // 弹幕：正文里开头的「@某人」单独拎出来高亮，一眼能看出在回谁 / 在提醒谁
      const raw = String(event.text || '')
      const at = raw.match(/^@(\S+)[:：]?\s*(.*)$/)
      if (at) return { label: '弹幕', color: C.text, text: at[2] || '（空）', mention: `@${at[1]}`, body: C.text }
      return { label: '弹幕', color: C.text, text: raw, body: C.text }
    }

    function actionMeta(kind) {
      const map = {
        say: { label: '说话', color: C.sub },
        warn: { label: '提醒', color: C.accent },
        mute: { label: '禁言', color: C.danger },
        unban: { label: '解禁', color: C.ok },
        skip: { label: '跳过', color: C.faint },
        snapshot: { label: '截图', color: C.faint },
      }
      if (map[kind]) return map[kind]
      return { label: kind ? String(kind) : '动作', color: C.sub }
    }

    // ---------------- 主面板 ----------------
    function ConsolePage() {
      const [status, setStatus] = useState(null)
      const [config, setConfig] = useState(null)
      const [form, setForm] = useState(null)
      const [events, setEvents] = useState([])
      const [eventsAt, setEventsAt] = useState(0)
      const [freshCount, setFreshCount] = useState(0)
      const [paused, setPaused] = useState(false)
      const [actions, setActions] = useState([])
      const [actionsAt, setActionsAt] = useState(0)
      const [users, setUsers] = useState([])
      const [usersAt, setUsersAt] = useState(0)
      const [shot, setShot] = useState(null)
      const [shotDesc, setShotDesc] = useState('')
      const [shotTick, setShotTick] = useState(() => Date.now())
      const [shotError, setShotError] = useState('')
      const [shotFailed, setShotFailed] = useState(false)
      const [review, setReview] = useState('')
      const [sayText, setSayText] = useState('')
      const [uid, setUid] = useState('')
      const [name, setName] = useState('')
      const [reason, setReason] = useState('')
      const [minutes, setMinutes] = useState('5')
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState('')
      const [error, setError] = useState('')
      const [netError, setNetError] = useState('')
      const [auth, setAuth] = useState(null)
      const [qr, setQr] = useState(null)
      const [qrAt, setQrAt] = useState(0)
      const [authBusy, setAuthBusy] = useState('')
      const [authNote, setAuthNote] = useState('')
      const formLoadedRef = useRef(false)
      const lastEventTsRef = useRef(0)

      const message = (value) => String((value && value.message) || value || '未知错误')

      function applyStatus(payload) {
        if (!payload || typeof payload !== 'object') return
        if (payload.status && typeof payload.status === 'object') setStatus(payload.status)
        if (payload.config && typeof payload.config === 'object') {
          setConfig(payload.config)
          if (!formLoadedRef.current) {
            setForm(clone(payload.config))
            formLoadedRef.current = true
          }
        }
      }

      // ---- 轮询：状态 3 秒 ----
      async function pullStatus() {
        try {
          const result = await api('/status')
          applyStatus(result)
          setNetError('')
        } catch (err) { setNetError(message(err)) }
      }

      // ---- 轮询：事件 3 秒 ----
      async function pullEvents() {
        try {
          const result = await api('/events?limit=100')
          const list = Array.isArray(result.events) ? result.events : []
          let top = 0
          for (let index = 0; index < list.length; index += 1) {
            const ts = toMs(list[index] && list[index].ts)
            if (ts > top) top = ts
          }
          if (lastEventTsRef.current > 0) {
            let fresh = 0
            for (let index = 0; index < list.length; index += 1) {
              if (toMs(list[index] && list[index].ts) > lastEventTsRef.current) fresh += 1
            }
            setFreshCount(fresh)
          } else {
            setFreshCount(0)
          }
          lastEventTsRef.current = top
          setEvents(list)
          setEventsAt(Date.now())
          setNetError('')
        } catch (err) { setNetError(message(err)) }
      }

      // ---- 轮询：动作 + 用户档案 8 秒 ----
      async function pullActions() {
        try {
          const result = await api('/actions?limit=60')
          setActions(Array.isArray(result.actions) ? result.actions : [])
          setActionsAt(Date.now())
          setNetError('')
        } catch (err) { setNetError(message(err)) }
        try {
          const result = await api('/ledger?limit=50')
          setUsers(Array.isArray(result.users) ? result.users : [])
          setUsersAt(Date.now())
          setNetError('')
        } catch (err) { setNetError(message(err)) }
      }

      async function pullShot(describe) {
        try {
          const result = await api(describe ? '/snapshot?describe=1' : '/snapshot')
          setShot(result.snapshot && typeof result.snapshot === 'object' ? result.snapshot : null)
          setShotDesc(result.description ? String(result.description) : '')
          setShotFailed(false)
          setShotTick(Date.now())
          setShotError('')
        } catch (err) { setShotError(message(err)) }
      }

      // ---- 登录：状态 + 扫码 ----
      async function pullAuth() {
        try {
          const result = await api('/auth/status')
          if (result && result.auth && typeof result.auth === 'object') setAuth(result.auth)
        } catch (err) { /* 侧车没起来时 status 里已经带错误，这里不刷屏 */ }
      }

      async function startLogin() {
        setAuthBusy('qr')
        setAuthNote('')
        try {
          const result = await api('/auth/qr')
          if (!result || result.ok === false) throw new Error((result && result.error) || '生成二维码失败')
          setQr(result.qr || null)
          setQrAt(Date.now())
          setAuthNote((result.qr && result.qr.note) || '拿手机 B 站扫一下，扫完在手机上点确认')
          pullAuth()
        } catch (err) {
          setAuthNote(message(err))
        } finally {
          setAuthBusy('')
        }
      }

      async function pollLogin(key) {
        try {
          const result = await api(`/auth/poll?key=${encodeURIComponent(key || '')}`)
          if (!result || result.ok === false) throw new Error((result && result.error) || '查扫码状态失败')
          const state = (result.auth && result.auth.state) || ''
          if (state === 'ok') {
            setQr(null)
            setAuthNote(`登录成功：${(result.auth.user && result.auth.user.uname) || ''}`)
            pullAuth()
          } else if (state === 'expired') {
            setQr(null)
            setAuthNote('二维码过期了，再点一次「生成二维码」')
          } else if (state === 'scanned') {
            setAuthNote('扫到了，等你在手机上确认')
          } else {
            setAuthNote('还没扫，码在你手机上的 B 站扫一扫里')
          }
        } catch (err) {
          setAuthNote(message(err))
        }
      }

      async function logoutLogin() {
        setAuthBusy('logout')
        try {
          const result = await api('/auth/logout', { method: 'POST', body: {} })
          if (!result || result.ok === false) throw new Error((result && result.error) || '退出登录失败')
          setQr(null)
          setAuthNote('已退出登录，本机凭证已删除')
          pullAuth()
        } catch (err) {
          setAuthNote(message(err))
        } finally {
          setAuthBusy('')
        }
      }

      useEffect(() => {
        pullStatus()
        const timer = setInterval(pullStatus, 3000)
        return () => { clearInterval(timer) }
      }, [])

      useEffect(() => {
        pullAuth()
        const timer = setInterval(pullAuth, 8000)
        return () => { clearInterval(timer) }
      }, [])

      useEffect(() => {
        if (!qr || !qr.key) return undefined
        const timer = setInterval(() => { pollLogin(qr.key) }, 2500)
        return () => { clearInterval(timer) }
      }, [qr])

      useEffect(() => {
        if (paused) return undefined
        pullEvents()
        const timer = setInterval(pullEvents, 3000)
        return () => { clearInterval(timer) }
      }, [paused])

      useEffect(() => {
        pullActions()
        const timer = setInterval(pullActions, 8000)
        return () => { clearInterval(timer) }
      }, [])

      useEffect(() => {
        pullShot(false)
        return undefined
      }, [])

      async function run(key, task) {
        setBusy(key)
        setError('')
        setNotice('')
        try {
          const text = await task()
          if (text) setNotice(String(text))
          await pullStatus()
          await pullActions()
        } catch (err) {
          setError(message(err))
        } finally {
          setBusy('')
        }
      }

      function setField(path, value) {
        setForm((previous) => setIn(previous || {}, path, value))
      }

      async function saveConfig() {
        if (!form) return
        await run('save', async () => {
          const result = await api('/config', { method: 'POST', body: { patch: buildPatch(form) } })
          if (result.config && typeof result.config === 'object') {
            setConfig(result.config)
            setForm(clone(result.config))
            formLoadedRef.current = true
          }
          return '配置已保存'
        })
      }

      async function toggleRun(start) {
        await run(start ? 'start' : 'stop', async () => {
          const result = await api(start ? '/start' : '/stop', { method: 'POST', body: {} })
          applyStatus({ status: result.status })
          const next = result.status && typeof result.status === 'object' ? result.status : {}
          if (start) {
            return next.running ? '已开工，AI 房管开始盯着直播间了' : '开工指令发出去了，但引擎还没跑起来，看下面的错误'
          }
          return next.running ? '收工指令发出去了，但引擎还在跑，稍等几秒' : '已收工'
        })
      }

      async function toggleSpeak() {
        const pausedNow = speakPaused
        const nextEnabled = pausedNow
        await run('speak', async () => {
          const result = await api('/speak', { method: 'POST', body: { enabled: nextEnabled } })
          if (result.speak && typeof result.speak === 'object') {
            setStatus((previous) => (previous ? { ...previous, speak: result.speak } : previous))
          }
          if (result.speak && result.speak.pausedUntil) return '机器人先安静一会儿（暂停说话）'
          return nextEnabled ? '机器人恢复说话' : '机器人暂停说话'
        })
      }

      function readUid() {
        const value = Number(String(uid).trim())
        if (!Number.isFinite(value) || value <= 0) return 0
        return Math.floor(value)
      }

      async function sendDanmaku() {
        const text = String(sayText || '').trim()
        if (!text) { setError('先写点想发的内容'); return }
        await run('say', async () => {
          await api('/say', { method: 'POST', body: { text } })
          setSayText('')
          return '弹幕已发'
        })
      }

      async function doWarn() {
        const id = readUid()
        if (!id) { setError('先填要提醒的 UID（一串数字）'); return }
        await run('warn', async () => {
          await api('/warn', {
            method: 'POST',
            body: {
              uid: id,
              name: String(name || '').trim() || undefined,
              reason: String(reason || '').trim() || undefined,
            },
          })
          return `已提醒 UID ${id}`
        })
      }

      async function doMute() {
        const id = readUid()
        if (!id) { setError('先填要禁言的 UID（一串数字）'); return }
        const minutesParam = toNumber(minutes, 0)
        await run('mute', async () => {
          await api('/mute', {
            method: 'POST',
            body: {
              uid: id,
              name: String(name || '').trim() || undefined,
              minutes: minutesParam > 0 ? Math.min(minutesParam, 1440) : undefined,
              reason: String(reason || '').trim() || undefined,
            },
          })
          return `已禁言 UID ${id}${minutesParam > 0 ? ` ${minutesParam} 分钟` : ''}`
        })
      }

      async function doUnban() {
        const id = readUid()
        if (!id) { setError('先填要解禁的 UID（一串数字）'); return }
        await run('unban', async () => {
          await api('/unban', { method: 'POST', body: { uid: id } })
          return `已尝试解禁 UID ${id}`
        })
      }

      async function refreshShot(describe) {
        setBusy(describe ? 'describe' : 'shot')
        setError('')
        setShotError('')
        try {
          await pullShot(describe)
        } finally {
          setBusy('')
        }
      }

      async function makeReview() {
        await run('review', async () => {
          const result = await api('/review', { method: 'POST', body: { minutes: 60 } })
          const reviewData = result.review && typeof result.review === 'object' ? result.review : {}
          const text = String(reviewData.text || '').trim()
          let stats = ''
          if (reviewData.stats && typeof reviewData.stats === 'object') {
            stats = Object.keys(reviewData.stats).map((key) => `${key} ${reviewData.stats[key]}`).join(' · ')
          }
          setReview([text || '这次复盘没读到文字。', stats ? `统计：${stats}` : ''].filter(Boolean).join('\n'))
          return '复盘已生成'
        })
      }

      // ---- 派生值 ----
      const room = status && status.room && typeof status.room === 'object' ? status.room : {}
      const conn = status && status.conn && typeof status.conn === 'object' ? status.conn : {}
      const counts = status && status.counts && typeof status.counts === 'object' ? status.counts : {}
      const python = status && status.python && typeof status.python === 'object' ? status.python : {}
      const llm = status && status.llm && typeof status.llm === 'object' ? status.llm : {}
      const speech = status && status.speech && typeof status.speech === 'object' ? status.speech : {}
      const running = status ? status.running === true : false
      const engineOn = status ? status.enabled === true : false
      const dryRun = status ? status.dryRun === true : false
      const pausedUntil = status && status.speak ? toMs(status.speak.pausedUntil) : 0
      const speakPaused = pausedUntil > Date.now()
      const pausedText = speakPaused ? `已暂停到 ${fmtTime(pausedUntil)}` : ''
      const speechCanSay = status && status.speak ? status.speak.canSay === true : false

      const sortedEvents = events
        .slice()
        .sort((left, right) => toMs(right && right.ts) - toMs(left && left.ts))
        .slice(0, 30)
      const sortedActions = actions
        .slice()
        .sort((left, right) => toMs(right && right.ts) - toMs(left && left.ts))
        .slice(0, 12)
      const sortedUsers = users
        .slice()
        .sort((left, right) => (Number(right && right.mutes) || 0) - (Number(left && left.mutes) || 0) || (Number(right && right.warns) || 0) - (Number(left && left.warns) || 0))
        .slice(0, 30)

      // ---- 卡片：B 站登录 ----
      const authInfo = auth && typeof auth === 'object' ? auth : {}
      const loggedIn = authInfo.loggedIn === true
      const qrExpireAt = qrAt && qr && qr.expiresIn ? qrAt + Number(qr.expiresIn) * 1000 : 0
      const qrLeftSec = qrExpireAt ? Math.max(0, Math.round((qrExpireAt - Date.now()) / 1000)) : 0
      const authCard = h(Card, { title: 'B 站登录', right: h(Pill, { ok: loggedIn }, loggedIn ? '已登录' : '没登录') },
        h('div', { style: { ...S.small, marginBottom: '8px' } },
          '房管要用你的账号进直播间：发弹幕、@ 提醒、禁言都靠这个登录态。扫码由 B 站官方接口完成，凭证只存在本机。'),
        h('div', { style: { ...S.small, marginBottom: '8px', color: loggedIn ? C.text : C.accent } },
          loggedIn
            ? `当前账号：${authInfo.uname || authInfo.mid || '已登录'}${authInfo.mid ? `（UID ${authInfo.mid}）` : ''}${authInfo.level ? ` · Lv${authInfo.level}` : ''}`
            : (authInfo.message || '还没登录，点下面的按钮出二维码')),

        h('div', { style: { ...S.row, marginBottom: '8px' } },
          h(Btn, { onClick: startLogin, primary: true, disabled: authBusy === 'qr' }, authBusy === 'qr' ? '出码中…' : (qr ? '换一张二维码' : '生成二维码')),
          h(Btn, { onClick: logoutLogin, danger: true, disabled: authBusy === 'logout' || !loggedIn }, authBusy === 'logout' ? '退出中…' : '退出登录'),
          h('span', { style: S.small }, qr ? (qrLeftSec > 0 ? `二维码 ${qrLeftSec} 秒后过期` : '二维码已过期，换一张') : '')),

        qr && qr.svg
          ? h('div', { style: { display: 'flex', justifyContent: 'center', margin: '10px 0' } },
            h('img', {
              src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr.svg)}`,
              alt: 'B 站登录二维码',
              style: { width: '240px', height: '240px', background: '#fff', padding: '8px', borderRadius: '10px', display: 'block' },
            }))
          : null,
        qr && !qr.svg ? h('div', { style: { ...S.small, wordBreak: 'break-all' } }, `二维码图片画不出来，用手机 B 站打开这个地址登录：${qr.url || ''}`) : null,
        authNote ? h('div', { style: { ...S.small, marginTop: '6px', color: C.text, whiteSpace: 'pre-wrap' } }, authNote) : null,
        authInfo.file ? h('div', { style: { ...S.code, marginTop: '6px' } }, `凭证：${authInfo.file}${authInfo.updated ? ` · 更新于 ${authInfo.updated}` : ''}`) : null,
        authInfo.exists === false ? h('div', { style: { ...S.small, marginTop: '4px', color: C.sub } }, '还没登录：扫码之后凭证会写进上面这个文件，删掉它等于退出登录。') : null,
        h('div', { style: { ...S.small, marginTop: '8px', color: C.sub } }, '提示：登录态换了（比如换号）会自动重连直播间，不用手动收工再开工。'))

      // ---- 卡片：状态 ----
      const statusCard = h(Card, { title: 'AI 房管状态' },
        status ? h('div', { style: { ...S.row, marginBottom: '8px' } },
          h(Pill, { ok: running }, running ? '引擎运行中' : '引擎已停止'),
          h(Pill, { ok: conn.connected === true }, conn.connected === true ? '已连上直播间' : '没连上直播间'),
          h(Pill, { ok: engineOn }, engineOn ? '总开关：开' : '总开关：关'),
          h(Pill, { ok: speech && speech.enabled === true }, speech && speech.enabled === true ? '在听主播说话' : '没开语音识别'),
          h(Tag, { color: dryRun ? C.accent : C.ok }, dryRun ? '演习模式' : '实战模式')) : h('div', { style: S.small }, '正在读取状态…'),

        status && speech && speech.enabled === true ? h('div', { style: { ...S.small, marginBottom: '6px', color: C.sub } },
          `语音：识别 ${Number(speech.count) || 0} 句${speech.last ? ` · 最近「${String(speech.last.text || '').slice(0, 40)}」` : ' · 还没听到'}${speech.lastAt ? ` · ${fmtTime(speech.lastAt)}` : ''}`) : null,

        status ? h('div', { style: { ...S.small, marginBottom: '6px', color: speechCanSay ? C.ok : C.danger } },
          speechCanSay
            ? `说话：能说${status?.speak?.lastSayAt ? `（上次说话 ${fmtTime(status.speak.lastSayAt)}）` : '（还没开过口）'}`
            : `说话：说不了 —— ${status?.speak?.block || '原因不明'}${status?.speak?.pausedUntil ? ` · 暂停到 ${fmtTime(status.speak.pausedUntil)}` : ''}`) : null,

        status && (status?.speak?.lastChatResult || status?.llm?.lastError) ? h('div', { style: { ...S.small, marginBottom: '6px', color: C.sub } },
          `最近一轮接话：${status?.speak?.lastChatResult || '还没试过'}${status?.llm?.lastError ? ` · 模型报错：${String(status.llm.lastError).slice(0, 80)}` : ''}`) : null,

        status && status?.llm?.lastText ? h('div', { style: { ...S.small, marginBottom: '6px', color: C.sub, wordBreak: 'break-all' } },
          `模型上次回了：${String(status.llm.lastText).slice(0, 120)}`) : null,

        status ? h('div', { style: S.small, marginBottom: '6px' },
          `直播间 ${room.roomId || '还没设置'} · ${room.title || '（还没拿到标题）'} · 主播 ${room.anchor || '未知'} · 在线 ${Number(room.online) || 0} 人 · ${Number(room.liveStatus) === 1 ? '正在直播' : '没开播'}`) : null,

        status ? h('div', { style: S.small, marginBottom: '8px' },
          conn.connected === true
            ? `连上时间 ${fmtTime(conn.since)} · 最近一条消息 ${conn.lastEventAt ? fmtTime(conn.lastEventAt) : '还没有'} · 重连 ${Number(conn.reconnects) || 0} 次`
            : `还没连上直播间${Number(conn.reconnects) ? `（已经重连 ${Number(conn.reconnects)} 次）` : ''}；开工之后会自动连。`) : null,

        status ? h('div', { style: { ...S.row, marginBottom: '10px' } },
          h(Stat, { label: '弹幕', value: counts.danmaku }),
          h(Stat, { label: '礼物', value: counts.gifts }),
          h(Stat, { label: '醒目留言', value: counts.sc }),
          h(Stat, { label: '进场', value: counts.enters }),
          h(Stat, { label: 'AI 说话', value: counts.says }),
          h(Stat, { label: '提醒', value: counts.warns, color: C.accent }),
          h(Stat, { label: '禁言', value: counts.mutes, color: counts.mutes ? C.danger : C.text })) : null,

        h('div', { style: S.row },
          h(Btn, { onClick: () => toggleRun(true), primary: true, disabled: busy === 'start' || running }, busy === 'start' ? '开工中…' : '开工'),
          h(Btn, { onClick: () => toggleRun(false), disabled: busy === 'stop' || !running }, busy === 'stop' ? '收工中…' : '收工'),
          h(Btn, { onClick: toggleSpeak, disabled: busy === 'speak' }, speakPaused ? '恢复说话' : '暂停说话'),
          pausedText ? h('span', { style: { ...S.small, color: C.accent } }, pausedText) : null),

        h('div', { style: { ...S.small, marginTop: '8px' } },
          `引擎进程：${python.running ? `运行中（pid ${python.pid || '-'}）` : '没在跑'} · 自动重启 ${Number(python.restarts) || 0} 次 · AI 调用 ${Number(llm.calls) || 0} 次${llm.lastCallAt ? `（最近 ${fmtTime(llm.lastCallAt)}）` : ''}`),
        python.lastError ? h('div', { style: { color: C.danger, fontSize: '11px', marginTop: '4px', wordBreak: 'break-all' } }, `引擎报错：${python.lastError}`) : null,
        llm.lastError ? h('div', { style: { color: C.danger, fontSize: '11px', marginTop: '4px', wordBreak: 'break-all' } }, `AI 报错：${llm.lastError}`) : null,
        engineOn ? null : h('div', { style: { ...S.small, marginTop: '6px' } }, '总开关关着：就算开着引擎，AI 也不会说话、不会禁言。'))

      // ---- 卡片：配置 ----
      const configCard = h(Card, { title: 'AI 房管设置' },
        form ? h('div', null,
          h('div', { style: S.group }, '基础'),
          h('div', { style: S.grid },
            h(NumberField, { label: '直播间号', value: form.roomId, onChange: (value) => setField('roomId', value), min: 0, hint: '就是 live.bilibili.com 后面那串数字' }),
            h(TextField, { label: '机器人名字', value: form.persona && form.persona.name, onChange: (value) => setField('persona.name', value), placeholder: '大肥鱼' }),
            h(TextField, { label: '口吻', value: form.persona && form.persona.tone, onChange: (value) => setField('persona.tone', value), placeholder: '嘴甜但不腻，像个熟门熟路的房管' })),
          h('div', { style: { ...S.row, marginTop: '8px' } },
            h(Check, { label: '总开关（允许 AI 房管干活）', checked: form.enabled, onChange: (value) => setField('enabled', value) }),
            h(Check, { label: '演习模式（dryRun）', checked: form.dryRun, onChange: (value) => setField('dryRun', value) })),
          form.dryRun ? h('div', { style: { ...S.banner, marginTop: '8px', marginBottom: 0 } }, '演习模式：只 @ 提醒，不会真禁言') : null,

          h('div', { style: S.group }, '身份 / 人设'),
          h('div', { style: S.grid },
            h(TextField, { label: '怎么称呼主播', value: form.persona && form.persona.masterName, onChange: (value) => setField('persona.masterName', value), placeholder: '主人' }),
            h(TextField, { label: '物种 / 形象', value: form.persona && form.persona.species, onChange: (value) => setField('persona.species', value), placeholder: '一条网上常见的蓝色大肥鱼' }),
            h(TextField, { label: '自称', value: form.persona && form.persona.selfCall, onChange: (value) => setField('persona.selfCall', value), placeholder: '本鱼' })),
          h('div', { style: S.grid },
            h(TextField, { label: '外貌', value: form.persona && form.persona.look, onChange: (value) => setField('persona.look', value), placeholder: '圆滚滚的蓝色身子，小短鳍当手' }),
            h(TextField, { label: '来历', value: form.persona && form.persona.origin, onChange: (value) => setField('persona.origin', value), placeholder: '被主播捞进直播间当房管' })),
          h('div', { style: S.grid },
            h(TextField, { label: '口头禅（逗号分隔）', value: (form.persona && form.persona.catchphrases || []).join('、'), onChange: (value) => setField('persona.catchphrases', String(value || '').split(/[，,、\s]+/).filter(Boolean)), placeholder: '主人、鱼在呢' }),
            h(TextField, { label: '补充设定', value: form.persona && form.persona.extra, onChange: (value) => setField('persona.extra', value), placeholder: '可写别的规矩、忌讳' })),
          h('div', { style: { ...S.row, marginTop: '6px' } },
            h(Check, { label: '叫主播「主人」', checked: !(form.persona && form.persona.callAnchor === false), onChange: (value) => setField('persona.callAnchor', value) })),

          h('div', { style: S.group }, '说话'),
          h('div', { style: S.grid },
            h(NumberField, { label: '每分钟最多说几句', value: form.speak && form.speak.maxPerMinute, onChange: (value) => setField('speak.maxPerMinute', value), min: 0, max: 30 }),
            h(NumberField, { label: '两句之间至少隔（秒）', value: form.speak && form.speak.minGapSec, onChange: (value) => setField('speak.minGapSec', value), min: 0, max: 600 }),
            h(NumberField, { label: '一条弹幕最长字数', value: form.speak && form.speak.maxChars, onChange: (value) => setField('speak.maxChars', value), min: 1, max: 40 }),
            h(NumberField, { label: '主动闲聊间隔（秒）', value: form.speak && form.speak.chatIntervalSec, onChange: (value) => setField('speak.chatIntervalSec', value), min: 10, max: 3600 }),
            h(NumberField, { label: '没人说话超过（秒）就别硬接', value: form.speak && form.speak.quietAfterSec, onChange: (value) => setField('speak.quietAfterSec', value), min: 0, max: 3600 }),
          h(SelectField, {
            label: '模型思考等级',
            hint: '想得越久越容易把正文预算吃光；说不出话就调低一档',
            value: form.llm && form.llm.effort,
            options: [ { value: 'off', label: '不思考（最快，推荐）' }, { value: 'low', label: '低' }, { value: 'medium', label: '中' }, { value: 'high', label: '高' } ],
            onChange: (value) => setField('llm.effort', value),
          })),
          h('div', { style: { ...S.row, marginTop: '6px' } },
            h(Check, { label: '允许主动说话', checked: form.speak && form.speak.enabled, onChange: (value) => setField('speak.enabled', value) }),
            h(Check, { label: '回复主播', checked: form.speak && form.speak.replyToAnchor, onChange: (value) => setField('speak.replyToAnchor', value) }),
            h(Check, { label: '谢礼物', checked: form.speak && form.speak.reactToGift, onChange: (value) => setField('speak.reactToGift', value) }),
            h(Check, { label: '欢迎进场（人多会吵）', checked: form.speak && form.speak.greetEnter, onChange: (value) => setField('speak.greetEnter', value) })),

          h('div', { style: S.group }, '管控'),
          h('div', { style: S.grid },
            h(NumberField, { label: '禁言前先提醒几次', value: form.moderation && form.moderation.warnBeforeMute, onChange: (value) => setField('moderation.warnBeforeMute', value), min: 0, max: 10 }),
            h(NumberField, { label: '统计数据看多久（分钟）', value: form.moderation && form.moderation.windowMin, onChange: (value) => setField('moderation.windowMin', value), min: 1, max: 720 }),
            h(NumberField, { label: '禁言多久（分钟）', value: form.moderation && form.moderation.muteMinutes, onChange: (value) => setField('moderation.muteMinutes', value), min: 1, max: 1440 }),
            h(NumberField, { label: '每小时最多禁言几人', value: form.moderation && form.moderation.maxMutesPerHour, onChange: (value) => setField('moderation.maxMutesPerHour', value), min: 0, max: 200 })),
          h('div', { style: { ...S.row, marginTop: '6px' } },
            h(Check, { label: '开启自动管控', checked: form.moderation && form.moderation.enabled, onChange: (value) => setField('moderation.enabled', value) }),
            h(Check, { label: '到点自动解禁', checked: form.moderation && form.moderation.autoUnban, onChange: (value) => setField('moderation.autoUnban', value) })),
          h('div', { style: { ...S.row, marginTop: '4px' } },
            h('span', { style: { ...S.small, flex: 'none' } }, '哪些情况要管：'),
            h(Check, { label: '刷屏', checked: form.moderation && form.moderation.muteOn && form.moderation.muteOn.spam, onChange: (value) => setField('moderation.muteOn.spam', value) }),
            h(Check, { label: '广告', checked: form.moderation && form.moderation.muteOn && form.moderation.muteOn.ad, onChange: (value) => setField('moderation.muteOn.ad', value) }),
            h(Check, { label: '辱骂', checked: form.moderation && form.moderation.muteOn && form.moderation.muteOn.insult, onChange: (value) => setField('moderation.muteOn.insult', value) }),
            h(Check, { label: '骚扰', checked: form.moderation && form.moderation.muteOn && form.moderation.muteOn.harassment, onChange: (value) => setField('moderation.muteOn.harassment', value) }),
            h(Check, { label: '剧透（默认不管）', checked: form.moderation && form.moderation.muteOn && form.moderation.muteOn.spoiler, onChange: (value) => setField('moderation.muteOn.spoiler', value) })),

          h('div', { style: S.group }, '画面感知'),
          h('div', { style: S.grid },
            h(NumberField, { label: '每隔几分钟看一眼', value: form.vision && form.vision.intervalMin, onChange: (value) => setField('vision.intervalMin', value), min: 1, max: 120 }),
            h(NumberField, { label: '每小时最多看几次', value: form.vision && form.vision.maxPerHour, onChange: (value) => setField('vision.maxPerHour', value), min: 0, max: 60 }),
            h('div', { style: { display: 'flex', alignItems: 'flex-end' } },
              h(Check, { label: '开启画面感知', checked: form.vision && form.vision.enabled, onChange: (value) => setField('vision.enabled', value) }))),

          h('div', { style: S.group }, '主播语音（本地识别）'),
          h('div', { style: S.grid },
            h(NumberField, { label: '每句之间至少隔几秒', value: form.asr && form.asr.gapSec, onChange: (value) => setField('asr.gapSec', value), min: 0, max: 30 }),
            h(NumberField, { label: '每分钟最多识别几句', value: form.asr && form.asr.maxPerMinute, onChange: (value) => setField('asr.maxPerMinute', value), min: 1, max: 120 }),
            h(Field, { label: '模型目录' }, h('input', { type: 'text', style: S.input, value: String((form.asr && form.asr.modelDir) || ''), placeholder: 'sensevoice models 目录', onChange: (event) => setField('asr.modelDir', event.target.value) }))),
          h('div', { style: { ...S.row, marginTop: '4px' } },
            h(Check, { label: '听主播说话（SenseVoice，本地跑）', checked: form.asr && form.asr.enabled, onChange: (value) => setField('asr.enabled', value) }),
            h(Check, { label: '喊到我就接一句', checked: form.asr && form.asr.reactToName, onChange: (value) => setField('asr.reactToName', value) })),

          h('div', { style: S.group }, '免打扰时段'),
          h('div', { style: S.grid },
            h(Field, { label: '开始' }, h('input', { type: 'time', style: S.input, value: String((form.quietHours && form.quietHours.start) || '03:00'), onChange: (event) => setField('quietHours.start', event.target.value) })),
            h(Field, { label: '结束' }, h('input', { type: 'time', style: S.input, value: String((form.quietHours && form.quietHours.end) || '07:00'), onChange: (event) => setField('quietHours.end', event.target.value) })),
            h('div', { style: { display: 'flex', alignItems: 'flex-end' } },
              h(Check, { label: '这个时段别说话', checked: form.quietHours && form.quietHours.enabled, onChange: (value) => setField('quietHours.enabled', value) }))),

          h('div', { style: { ...S.row, marginTop: '12px' } },
            h(Btn, { onClick: saveConfig, primary: true, disabled: busy === 'save' }, busy === 'save' ? '保存中…' : '保存'),
            h(Btn, {
              onClick: () => { setForm(clone(config || {})); setNotice('已恢复成当前保存的配置'); setError('') },
              disabled: busy === 'save',
            }, '放弃修改'),
            h('span', { style: S.small }, '保存只写配置；要真正开跑还得点上面的「开工」。')))
          : h('div', { style: S.small }, config ? '配置读取异常，等一下会自动重试。' : '正在读取配置…'))

      // ---- 卡片：弹幕监控 ----
      const eventsCard = h(Card, {
        title: '直播弹幕监控',
        right: h('div', { style: S.row },
          paused ? h('span', { style: { ...S.small, color: C.accent } }, '已暂停自动刷新') : null,
          freshCount > 0 ? h('span', { style: { ...S.small, color: C.ok } }, `+${freshCount} 条新`) : null,
          h('span', { style: S.small }, `更新 ${fmtTime(eventsAt)}`),
          h(Btn, { onClick: () => setPaused((previous) => !previous), primary: !paused }, paused ? '继续刷新' : '暂停刷新'),
          paused ? h(Btn, { onClick: pullEvents }, '刷新一次') : null),
      },
        h('div', { style: S.list },
          sortedEvents.length
            ? sortedEvents.map((event, index) => {
              const meta = describeEvent(event)
              const uidText = event && event.uid ? `UID ${event.uid}` : ''
              return h('div', { key: `${meta.label}-${event && event.ts}-${index}`, style: S.line },
                h('span', { style: { color: C.faint, fontSize: '10px', minWidth: '52px', flex: 'none' } }, fmtTime(event && event.ts)),
                h('span', { style: { color: C.sub, maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  (event && event.name) || uidText || '匿名'),
                h(Tag, { color: meta.color }, meta.label),
                meta.mention ? h(Tag, { color: C.accent }, meta.mention) : null,
                event && event.owner ? h(Tag, { color: C.danger }, '主播') : null,
                event && event.admin ? h(Tag, { color: C.ok }, '房管') : null,
                event && event.self ? h(Tag, { color: C.faint }, '机器人') : null,
                h('span', { style: { color: meta.body, flex: 1, minWidth: '120px' } }, meta.text))
            })
            : h('div', { style: S.small }, paused ? '自动刷新暂停了；点「刷新一次」拉最新消息。' : '还没有消息；开工后每 3 秒刷一次。')),
        h('div', { style: { ...S.small, marginTop: '6px' } }, `最近展示 ${sortedEvents.length} 条；礼物、醒目留言、进场会用不同颜色标出来。`))

      // ---- 卡片：动作流水 ----
      const actionsCard = h(Card, {
        title: '房管动作流水',
        right: h('div', { style: S.row },
          h('span', { style: S.small }, `更新 ${fmtTime(actionsAt)}`),
          h(Btn, { onClick: makeReview, disabled: busy === 'review' }, busy === 'review' ? '复盘中小等…' : '生成一小时复盘')),
      },
        h('div', { style: S.list },
          sortedActions.length
            ? sortedActions.map((action, index) => {
              const meta = actionMeta(action && action.kind)
              const who = [action && action.name, action && action.uid ? `UID ${action.uid}` : ''].filter(Boolean).join(' · ')
              const text = [action && action.text, action && action.reason].filter(Boolean).join(' / ')
              return h('div', { key: `${action && action.ts}-${index}`, style: S.line },
                h('span', { style: { color: C.faint, fontSize: '10px', minWidth: '52px', flex: 'none' } }, fmtTime(action && action.ts)),
                h(Tag, { color: meta.color }, meta.label),
                who ? h('span', { style: { color: C.sub, maxWidth: '170px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, who) : null,
                h('span', { style: { color: C.text, flex: 1, minWidth: '120px' } }, text || '—'),
                action && action.ok === false ? h('span', { style: { color: C.danger, fontSize: '11px', flex: 'none' } }, '没成功') : null)
            })
            : h('div', { style: S.small }, '还没有动作；AI 说话、提醒、禁言都会记在这里。')),
        review ? h('div', { style: { ...S.code, marginTop: '8px', maxHeight: '200px', overflow: 'auto', whiteSpace: 'pre-wrap', background: C.input, border: `1px solid ${C.border}`, borderRadius: '8px', padding: '8px' } }, review) : null)

      // ---- 卡片：手动操作 ----
      const manualCard = h(Card, { title: '手动操作' },
        h('div', { style: S.small, marginBottom: '8px' }, '拿不准就让 AI 自己来；这里是你亲自上手的入口。'),
        h('div', { style: { ...S.row, marginBottom: '8px' } },
          h('input', {
            style: { ...S.input, flex: 1, minWidth: '160px' },
            placeholder: '以机器人身份发一条弹幕',
            maxLength: 40,
            value: sayText,
            onChange: (event) => setSayText(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') sendDanmaku() },
          }),
          h(Btn, { onClick: sendDanmaku, primary: true, disabled: busy === 'say' || !String(sayText).trim() }, busy === 'say' ? '发送中…' : '发弹幕')),
        h('div', { style: { ...S.row, marginBottom: '8px' } },
          h('input', { style: { ...S.input, width: '120px' }, placeholder: 'UID', value: uid, onChange: (event) => setUid(event.target.value) }),
          h('input', { style: { ...S.input, width: '130px' }, placeholder: '昵称（可不填）', value: name, onChange: (event) => setName(event.target.value) }),
          h('input', { style: { ...S.input, flex: 1, minWidth: '140px' }, placeholder: '原因（可不填）', value: reason, onChange: (event) => setReason(event.target.value) })),
        h('div', { style: S.row },
          h('input', { type: 'number', style: { ...S.input, width: '90px' }, min: 1, max: 1440, value: minutes, onChange: (event) => setMinutes(event.target.value) }),
          h(Btn, { onClick: doWarn, disabled: busy === 'warn' }, busy === 'warn' ? '提醒中…' : '提醒他'),
          h(Btn, { onClick: doMute, danger: true, disabled: busy === 'mute' }, busy === 'mute' ? '禁言中…' : '禁言'),
          h(Btn, { onClick: doUnban, disabled: busy === 'unban' }, busy === 'unban' ? '解禁中…' : '解禁'),
          h('span', { style: S.small }, '禁言时长按左边的分钟数；不填就是配置里的默认值。')),
        h('div', { style: { ...S.small, marginTop: '6px' } }, '也可以去下面的用户档案点「选中」，UID 会自动填进来。'))

      // ---- 卡片：画面预览 ----
      const snapshotCard = h(Card, {
        title: '画面预览',
        right: h('div', { style: S.row },
          h(Btn, { onClick: () => refreshShot(false), primary: true, disabled: busy === 'shot' }, busy === 'shot' ? '刷新中…' : '刷新预览'),
          h(Btn, { onClick: () => refreshShot(true), disabled: busy === 'describe' }, busy === 'describe' ? 'AI 正在看…' : '让 AI 描述画面')),
      },
        h('div', { style: { ...S.small, marginBottom: '8px' } }, `拍摄时间：${shot ? fmtDateTime(shot.timestamp) : '还没有截图'}`),
        shotFailed
          ? h('div', { style: { ...S.small, padding: '24px 0', textAlign: 'center' } }, '还没有截图；开工后 AI 会按间隔自己拍，也可以点「刷新预览」试试。')
          : h('img', {
            key: `shot-${shotTick}`,
            src: `${API}/snapshot/latest.jpg?t=${shotTick}`,
            alt: '直播画面截图',
            onError: () => setShotFailed(true),
            onLoad: () => setShotFailed(false),
            style: { width: '100%', maxHeight: '300px', objectFit: 'contain', background: '#000', borderRadius: '8px', display: 'block' },
          }),
        shotDesc ? h('div', { style: { ...S.small, marginTop: '8px', color: C.text, whiteSpace: 'pre-wrap', maxHeight: '140px', overflow: 'auto' } }, `AI 看到：${shotDesc}`) : null,
        shotError ? h('div', { style: { color: C.danger, fontSize: '11px', marginTop: '6px', wordBreak: 'break-all' } }, shotError) : null,
        shot && shot.path ? h('div', { style: { ...S.code, marginTop: '4px' } }, shot.path) : null)

      // ---- 卡片：用户档案 ----
      const ledgerCard = h(Card, {
        title: '用户档案',
        right: h('span', { style: S.small }, sortedUsers.length ? `${users.length} 人有记录 · 更新 ${fmtTime(usersAt)}` : '还没有记录'),
      },
        sortedUsers.length
          ? h('div', { style: S.list },
            sortedUsers.map((user, index) => {
              const muted = toMs(user && user.mutedUntil) > Date.now()
              return h('div', { key: `${user && user.uid}-${index}`, style: S.line },
                h('span', { style: { color: C.text, maxWidth: '150px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, (user && user.name) || '匿名'),
                h('span', { style: { color: C.faint, fontSize: '10px', flex: 'none' } }, `UID ${(user && user.uid) || '-'}`),
                h('span', { style: { color: C.accent, fontSize: '11px', flex: 'none' } }, `提醒 ${Number(user && user.warns) || 0}`),
                h('span', { style: { color: C.danger, fontSize: '11px', flex: 'none' } }, `禁言 ${Number(user && user.mutes) || 0}`),
                muted ? h('span', { style: { color: C.danger, fontSize: '11px', flex: 'none' } }, `禁到 ${fmtTime(user.mutedUntil)}`) : null,
                h('span', { style: { color: C.sub, fontSize: '11px', flex: 1, minWidth: '110px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  `${fmtTime(user && user.lastAt)} · ${(user && user.lastReason) || '没写原因'}`),
                h(Btn, {
                  onClick: () => {
                    const picked = user && typeof user === 'object' ? user : {}
                    setUid(String(picked.uid || ''))
                    setName(String(picked.name || ''))
                    setNotice(`已选 ${picked.name || picked.uid || '这个人'}，去上面的手动操作`)
                  },
                }, '选中'))
            }))
          : h('div', { style: S.small }, '还没有人被管过；有人刷屏、发广告被提醒之后，这里就会留下他的档案。'))

      const dryRunBanner = dryRun
        ? h('div', { style: S.banner }, '演习模式：只 @ 提醒，不会真禁言')
        : null

      return h('div', { style: { display: 'flex', flexDirection: 'column', width: '100%' } },
        h('div', { style: { ...S.small, marginBottom: '8px' } }, '大肥鱼 AI 房管：先在下面的「B 站登录」扫码，填好直播间号，再点开工。'),
        error ? h('div', { role: 'alert', style: { color: C.danger, fontSize: '12px', marginBottom: '8px', whiteSpace: 'pre-wrap' } }, `出错了：${error}`) : null,
        netError ? h('div', { style: { color: C.danger, fontSize: '11px', marginBottom: '8px', opacity: 0.85, wordBreak: 'break-all' } }, `连接提醒：${netError}`) : null,
        notice ? h('div', { style: { color: C.ok, fontSize: '12px', marginBottom: '8px', whiteSpace: 'pre-wrap' } }, notice) : null,
        dryRunBanner,
        authCard,
        statusCard,
        configCard,
        eventsCard,
        actionsCard,
        manualCard,
        snapshotCard,
        ledgerCard)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dafeiyu-moderator',
          order: 60,
          label: () => 'AI 房管',
        }, ConsolePage))
      },
    }
  },
})
