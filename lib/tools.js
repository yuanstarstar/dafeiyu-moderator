function defineTool(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    },
    execute,
  }
}

const NO_PROPS = { type: 'object', properties: {}, additionalProperties: false }

export function registerTools(ctx, { engine, store, vision, sidecar, login }) {
  const register = (tool, label) => ctx.effect(() => ctx.tools.register(tool), label)

  register(
    defineTool(
      'dafeiyu_mod_status',
      '看大肥鱼 AI 房管的当前状态：有没有在盯直播间、连没连上、今天发了多少弹幕/提醒/禁言、模型和 Python 侧车是否正常。',
      NO_PROPS,
      async () => engine.status(),
    ),
    'dafeiyu-moderator: status',
  )

  register(
    defineTool(
      'dafeiyu_mod_start',
      '让 AI 房管开始盯直播间（用设置里的 roomId）。会自动连弹幕、开始自动参与和管控。',
      { type: 'object', properties: { roomId: { type: 'number', description: '直播间号；不填用配置里的' } }, additionalProperties: false },
      async ({ roomId }) => {
        if (roomId) store.patchConfig({ roomId: Number(roomId) })
        if (!store.getConfig().enabled) store.patchConfig({ enabled: true })
        return engine.start()
      },
    ),
    'dafeiyu-moderator: start',
  )

  register(
    defineTool(
      'dafeiyu_mod_login',
      'B 站登录：action=status 看登录状态；action=qr 生成扫码登录二维码；action=poll 查扫码结果（扫码后在手机上确认）；action=logout 退出登录并删掉本机凭证。',
      {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'qr', 'poll', 'logout'], description: '要做什么，默认 status' },
          key: { type: 'string', description: 'action=poll 时的二维码 key（qr 返回的）' },
        },
        additionalProperties: false,
      },
      async ({ action, key }) => {
        const what = String(action || 'status')
        if (what === 'qr') return login.start()
        if (what === 'poll') return login.poll(key)
        if (what === 'logout') return login.logout()
        return login.status()
      },
    ),
    'dafeiyu-moderator: login',
  )
  register(
    defineTool(
      'dafeiyu_mod_stop',
      '让 AI 房管停止盯直播间（断开弹幕监听，Python 侧车进程保留）。',
      NO_PROPS,
      async () => engine.stop(),
    ),
    'dafeiyu-moderator: stop',
  )

  register(
    defineTool(
      'dafeiyu_mod_say',
      '用大肥鱼的身份在直播间发一条弹幕（真人房管口吻，会自动截断到字数上限）。',
      {
        type: 'object',
        properties: {
          text: { type: 'string', description: '弹幕内容' },
          replyTo: { type: 'number', description: '要回复的观众 uid，可不填' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      async ({ text, replyTo }) => engine.say(text, { replyToUid: Number(replyTo) || 0, reason: 'agent 让发的', kind: 'say', force: true }),
    ),
    'dafeiyu-moderator: say',
  )

  register(
    defineTool(
      'dafeiyu_mod_warn',
      '在大肥鱼直播间 @ 某位观众提醒他（计入提醒次数；提醒够次数还不改才会被禁言）。',
      {
        type: 'object',
        properties: {
          uid: { type: 'number', description: '观众 uid' },
          name: { type: 'string', description: '观众昵称（用于 @）' },
          reason: { type: 'string', description: '为什么要提醒，写给自己看的' },
          text: { type: 'string', description: '自定义提醒话术；不填自动生成' },
        },
        required: ['uid'],
        additionalProperties: false,
      },
      async ({ uid, name, reason, text }) => engine.warn(uid, { name: name || '', reason: reason || '提醒', text: text || '', source: 'agent' }),
    ),
    'dafeiyu-moderator: warn',
  )

  register(
    defineTool(
      'dafeiyu_mod_mute',
      '禁言某位观众（会先检查白名单、每小时上限与演习模式；到点自动解禁）。',
      {
        type: 'object',
        properties: {
          uid: { type: 'number', description: '观众 uid' },
          name: { type: 'string', description: '观众昵称' },
          minutes: { type: 'number', description: '禁言分钟数，默认用配置里的' },
          reason: { type: 'string', description: '禁言原因' },
        },
        required: ['uid'],
        additionalProperties: false,
      },
      async ({ uid, name, minutes, reason }) =>
        engine.mute(uid, { name: name || '', minutes: minutes || store.getConfig().moderation.muteMinutes, reason: reason || '多次提醒不改', source: 'agent' }),
    ),
    'dafeiyu-moderator: mute',
  )

  register(
    defineTool(
      'dafeiyu_mod_unban',
      '提前解禁某位观众。',
      { type: 'object', properties: { uid: { type: 'number', description: '观众 uid' } }, required: ['uid'], additionalProperties: false },
      async ({ uid }) => engine.unban(uid, { announce: true, reason: 'agent 解禁' }),
    ),
    'dafeiyu-moderator: unban',
  )

  register(
    defineTool(
      'dafeiyu_mod_look',
      '看一眼前直播间画面（抓一帧），可以让模型用一句话描述主播在干什么。',
      { type: 'object', properties: { describe: { type: 'boolean', description: '要不要让模型描述，默认 true' } }, additionalProperties: false },
      async ({ describe }) => {
        const looked = await vision.look({ force: true, describe: describe !== false })
        return {
          snapshot: { ...looked.snapshot, url: vision.snapshotUrl(looked.snapshot.path) },
          scene: looked.scene,
          describeError: looked.describeError || '',
        }
      },
    ),
    'dafeiyu-moderator: look',
  )

  register(
    defineTool(
      'dafeiyu_mod_review',
      '让 AI 房管复盘最近一段时间的表现（发生了什么、管得对不对、下回怎么改）。',
      { type: 'object', properties: { minutes: { type: 'number', description: '复盘多少分钟，默认 60' } }, additionalProperties: false },
      async ({ minutes }) => engine.review(minutes || 60),
    ),
    'dafeiyu-moderator: review',
  )

  register(
    defineTool(
      'dafeiyu_mod_ledger',
      '看被管过的观众档案：谁被提醒过几次、谁被禁言过、最近原因是什么。',
      { type: 'object', properties: { limit: { type: 'number', description: '条数，默认 20' } }, additionalProperties: false },
      async ({ limit }) => {
        store.pruneLedger()
        return { users: store.ledgerList(limit || 20) }
      },
    ),
    'dafeiyu-moderator: ledger',
  )

  register(
    defineTool(
      'dafeiyu_mod_config',
      '改 AI 房管的设置（深合并 patch）。常用：{roomId, enabled, dryRun, speak:{maxChars,chatIntervalSec}, moderation:{warnBeforeMute,muteMinutes}}。',
      {
        type: 'object',
        properties: { patch: { type: 'object', description: '要合并进配置的对象', additionalProperties: true } },
        required: ['patch'],
        additionalProperties: false,
      },
      async ({ patch }) => ({ config: store.patchConfig(patch || {}) }),
    ),
    'dafeiyu-moderator: config',
  )

  register(
    defineTool(
      'dafeiyu_mod_persona',
      '看 / 改 AI 房管的身份人设（默认蓝色大肥鱼，把主播叫「主人」）。不给参数就看；给了 persona 就深合并。字段：name/species/look/origin/selfCall/masterName/callAnchor/anchorName/tone/catchphrases/extra。',
      {
        type: 'object',
        properties: { persona: { type: 'object', description: '要改的人设字段（可省）', additionalProperties: true } },
        additionalProperties: false,
      },
      async ({ persona }) => {
        if (persona && typeof persona === 'object') {
          const config = store.patchConfig({ persona })
          return { ok: true, persona: config.persona }
        }
        return { persona: store.getConfig().persona }
      },
    ),
    'dafeiyu-moderator: persona',
  )

  register(
    defineTool(
      'dafeiyu_mod_room',
      '查一个 B 站直播间的基础信息（标题、主播、是否在播、在线人数）。',
      { type: 'object', properties: { roomId: { type: 'number', description: '直播间号' } }, required: ['roomId'], additionalProperties: false },
      async ({ roomId }) => {
        if (!sidecar.running) await engine.start().catch(() => {})
        const data = await sidecar.request('roominfo', { roomId: Number(roomId) }, 25_000)
        return data.room || {}
      },
    ),
    'dafeiyu-moderator: room',
  )
}
