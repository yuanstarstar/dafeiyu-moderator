import { clip, formatClock, normalizeText, pick } from './util.js'

export const SYSTEM_PROMPT = `你是「{name}」——{species}。{look}
来历：{origin}
你在「{anchorName}」的直播间当房管：看场子、接话、管人。

【你是谁（这条最重要）】
- 你是直播间的真人房管，一条活生生的鱼，不是 AI 助手、不是大模型、不是机器人。
- 有人问你是不是 AI、是不是机器人、是不是脚本：别承认，笑着糊弄过去（「什么 AI，我是鱼」「AI 能这么胖吗」这类），别一本正经否认半天。
- 自称「{selfCall}」，偶尔用，别每句都带。
- 被人说胖、说丑、说菜：不当回事，可以自嘲一句「胖点才扛得住」。这种话不许禁言、不许提醒。

【怎么说话】
- 像真人发弹幕：短、随口、带点熟人的松弛感。一条别超过 {maxChars} 个字，超了发不出去。
- 一轮最多说两条，多数时候只说一条。真没什么值得说的就不说——安静看场子比刷屏专业。
- 不用每句都带感叹号，不用「亲」「宝子」「亲爱的」这类客服腔，不列一二三条，不写小作文。
- 别重复你刚说过的话，换个说法。
- 有人点你、问你、送礼、发醒目留言，优先回应，而且回应要接得住前面的上下文。
- 主播说话可以搭腔捧场，但别抢话、别替主播许诺（抽奖、改价、加播都别应下来）。
- 有人吵架就一句降温，不对骂、不站队、不长篇说教。

【你和主播】
- 主播是你的{masterName}。{masterCallLine}
- 主人喊你、问你、跟你说话，优先接；主人正说着话时别抢、别打断。
- 主人让你管谁就管谁，但主人自己骂人、口嗨、玩梗，不算违规。
- 别替主人许诺（抽奖、改价、加播、返场都别应下来），拿不准就说「这我得问主人」。

【怎么管事】
- 先判断值不值得管：广告拉人、辱骂攻击、刷屏、恶意剧透才管；单纯口嗨、玩梗、重复一两句，先放过。
- 管人留台阶：第一次永远温和，指出具体哪儿不对（「别刷了哈」），不扣帽子、不阴阳。
- 提醒过还不改的人，语气才变认真；够次数才禁言。禁言那句要短，把理由说出来。
- 拿不准就不禁言，宁可多提醒一句。观众调侃你、说你胖，不许禁言。
- 不针对人、不报复、不因为一句话就动手。

【输出】只输出一个 JSON 对象，不要任何解释文字：
{"think":"一句话说明你怎么判断的",
 "say":[{"text":"你要发的弹幕原文","replyToUid":0}],
 "warn":[{"uid":123,"name":"昵称","reason":"为什么提醒","text":"发给他的那句（必须 @ 上名字）"}],
 "mute":[{"uid":123,"name":"昵称","reason":"为什么禁言","text":"禁言后说的一句（可选）"}]}
没有的字段给空数组。say 里的 replyToUid 填要回复的人 uid，不回复就填 0。`

export function fillTemplate(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => (vars[key] === undefined || vars[key] === null ? '' : String(vars[key])))
}

function withStop(text) {
  const value = String(text || '').trim()
  if (!value) return ''
  return /[。！？.!?]$/.test(value) ? value : `${value}。`
}

function audienceName(config) {
  const room = config && config.room && typeof config.room === 'object' ? config.room : {}
  return String((config && config.anchorName) || room.anchor || '').trim()
}

export function systemPrompt(config) {
  const persona = config.persona || {}
  const chars = Number(config.speak?.maxChars) || 20
  const name = persona.name || '大肥鱼'
  const species = persona.species || '一条网上常见的蓝色大肥鱼'
  const look = withStop(persona.look || '圆滚滚的蓝色身子，肚皮偏浅，两片小短鳍当手，腮帮子鼓鼓的，一激动鳞片发亮')
  const origin = withStop(persona.origin || '网上那条有名的蓝色大肥鱼，被主播捞进直播间当房管')
  const selfCall = persona.selfCall || '本鱼'
  const masterName = persona.masterName || '主人'
  const anchorName = persona.anchorName || audienceName(config) || masterName
  const callMaster = persona.callAnchor !== false
  const masterCallLine = callMaster
    ? `跟主人说话可以带一句「${masterName}」，但别每句都叫，叫多了像复读机。`
    : '你对主播直接说事，不用叫「主人」。'
  const head = fillTemplate(SYSTEM_PROMPT, { name, species, look, origin, anchorName, masterName, masterCallLine, selfCall, maxChars: chars })
  const extra = [
    `本场主播：${persona.anchorName || audienceName(config) || '主播'}（你的${masterName}）。`,
    `你今天的人设口吻：${persona.tone || '嘴甜但不惯着，护主人，心软手不软'}。`,
  ]
  if (Array.isArray(persona.catchphrases) && persona.catchphrases.length > 0) {
    extra.push(`你的口头禅（偶尔用，别每句都用）：${persona.catchphrases.slice(0, 6).join('、')}。`)
  }
  if (persona.extra) extra.push(`额外设定：${clip(persona.extra, 400)}`)
  return `${head}\n\n${extra.join('\n')}`
}

const KIND_LABEL = {
  danmaku: '弹幕',
  gift: '礼物',
  sc: '醒目留言',
  enter: '进场',
  follow: '关注',
  share: '分享',
  live: '直播状态',
  view: '在线人数',
  system: '系统',
}

export function formatEventLine(event) {
  const who = event.name || (event.uid ? `用户${event.uid}` : '')
  const tags = []
  if (event.owner) tags.push('主播')
  if (event.admin) tags.push('房管')
  if (event.self) tags.push('你自己')
  if (event.medal) tags.push(`粉丝牌${event.medalName || ''}${event.medal}`)
  const tagText = tags.length > 0 ? `(${tags.join('/')})` : ''
  const head = `[${formatClock(event.ts)}] #${event.uid || 0} ${who}${tagText}`
  switch (event.type || event.event) {
    case 'danmaku':
      return `${head}：${normalizeText(event.text).slice(0, 80)}`
    case 'gift':
      return `${head} 送了 ${event.giftName || '礼物'}×${event.num || 1}`
    case 'sc':
      return `${head} 醒目留言(¥${event.price || 0})：${clip(normalizeText(event.text), 80)}`
    case 'enter':
      return `${head} 进入直播间`
    case 'follow':
      return `${head} 关注了主播`
    case 'share':
      return `${head} 分享了直播间`
    case 'live':
      return `[直播状态] ${event.note || (event.liveStatus ? '开播了' : '下播了')}`
    case 'view':
      return `[在线人数] ${event.viewers || 0}`
    case 'speech':
      return `[${formatClock(event.ts)}] 主播说：${clip(normalizeText(event.text), 90)}`
    default:
      return `${head} ${KIND_LABEL[event.type] || ''} ${clip(event.text || event.note || '', 80)}`
  }
}

export function buildSceneLine(scene) {
  if (!scene || !scene.text) return ''
  const age = Math.max(0, Math.round((Date.now() - (scene.at || Date.now())) / 1000))
  return `【你刚才看了一眼直播画面（${age} 秒前）】${clip(scene.text, 260)}`
}

/**
 * 决策提示词：把「最近的弹幕/礼物 + 你刚说过的话 + 重点人物档案 + 画面」摊给模型。
 * mode: chat（自由参与） / moderate（有人疑似违规，重点判断要不要管） / anchor（主播或房管直接命令你）
 */
export function buildDecisionPrompt({ mode, config, events, focus, ledgerRows, scene, selfLines, speechLines, room, command, idleSec = 0, freshCount = 0, quietSec = 0 }) {
  const maxChars = Number(config.speak?.maxChars) || 20
  const lines = []
  lines.push(`直播间：${room?.title || '(未知)'}｜主播：${room?.anchor || config.persona?.name || '主播'}｜在线：${room?.online || 0}`)

  if (mode === 'anchor') {
    lines.push('', `【点你名的人：${focus?.name || '主播/房管'}（uid=${focus?.uid || 0}）说的话】${clip(focus?.text || command || '', 200)}`)
    lines.push('这是主播或房管在直接跟你说话。按他的意思办，能办就办事，办不了就说明白；回话要短。')
    if (command) {
      lines.push('')
      lines.push('已知可用指令（如果像在说这些，就把要做的事放进对应字段，不要自己发明动作）：')
      lines.push('- 「看看/画面/在播什么」→ say 里说一句你看到的画面')

      lines.push('- 「提醒某人」→ warn 里写那个人')
      lines.push('- 「禁言某人（几分钟）」→ mute 里写那个人')
      lines.push('- 「歇会/别说了/安静」→ say 里回一句，然后在 say 的空数组里留空')
      lines.push('- 「说/念 某句话」→ say 里原样发出去')
    }
  }

  if (events && events.length > 0) {
    lines.push('', `【最近 ${events.length} 条动静（旧→新）】`)
    for (const event of events) lines.push(formatEventLine(event))
  } else {
    lines.push('', '【最近还没有弹幕】')
  }

  if (speechLines && speechLines.length > 0) {
    lines.push('', '【主播刚说的话（语音识别，可能有错字）】')
    for (const item of speechLines.slice(-10)) {
      const text = typeof item === 'string' ? item : item?.text || ''
      if (text) lines.push(`- ${clip(text, 80)}`)
    }
    lines.push('主播说话时可以接一句（别复读、别打断），也可以不接。')
  }

  if (selfLines && selfLines.length > 0) {
    lines.push('', '【你自己刚说过的话，别重复】')
    for (const text of selfLines.slice(-8)) lines.push(`- ${clip(text, 60)}`)
  }

  if (mode === 'moderate' && focus) {
    lines.push('', `【重点看这个人】${focus.name || '用户'}（uid=${focus.uid}）刚说：${clip(focus.text, 120)}`)
    lines.push(`系统初判：疑似「${focus.categoryLabel || focus.category || '违规'}」。`)
    if (ledgerRows && ledgerRows.length > 0) {
      lines.push('他最近的房管记录：')
      for (const row of ledgerRows.slice(0, 5)) {
        lines.push(`- ${formatClock(row.at)} ${row.kind === 'mute' ? '禁言' : '提醒'}过（${row.category || ''}）：${row.reason || ''}`)
      }
      const warns = ledgerRows.filter((row) => row.kind === 'warn').length
      lines.push(`窗口内已提醒 ${warns} 次。提醒满 ${config.moderation?.warnBeforeMute ?? 2} 次仍不改，才可以禁言。`)
    } else {
      lines.push('他之前没有记录，这是第一次，原则上只提醒、不禁言。')
    }
    lines.push('谨慎判断：可能是玩笑或误判就别动手；要动手也先 warn。')
  }

  const sceneLine = buildSceneLine(scene)
  if (sceneLine) lines.push('', sceneLine)

  const now = new Date()
  lines.push('', `现在是 ${formatClock(now.getTime())}。`)
  if (mode === 'chat') {
    const idle = Number(idleSec) || 0
    const fresh = Number(freshCount) || 0
    const quiet = Number(quietSec) || 0
    if (fresh > 0) {
      lines.push(`这轮有 ${fresh} 条新动静，说 1 条（最多 2 条，每条 ≤${maxChars} 字），接最近的梗、捧个场、吐个槽都行，要像个活人在看。`)
      lines.push('刚说完同一句、又完全没新内容才留空；没人接话时别自说自话。')
    } else {
      lines.push(`这一轮没有新弹幕、也没有新礼物${quiet > 0 ? `（最后一条动静是 ${Math.round(quiet / 60) || 1} 分钟前）` : ''}。`)
      lines.push('别硬找话说：say 直接给空数组。除非有人点到你，否则直播间安静的时候你也就安静待着。')
    }
    if (idle > 300 && fresh > 0) {
      lines.push(`你已经 ${Math.round(idle / 60)} 分钟没说话了，这轮接着新话题开口。`)
    }
  } else if (mode === 'moderate') {
    lines.push(`这轮先决定管不管：值不值得提醒？够不够禁言？之后可以说 0~1 条弹幕收尾（≤${maxChars} 字）。`)
  } else {
    lines.push(`这轮以回应点名的人为主，说 1~2 条（每条 ≤${maxChars} 字）。`)
  }
  lines.push('按约定的 JSON 输出。')

  return {
    system: systemPrompt({ ...config, persona: { ...(config.persona || {}), anchorName: (config.persona && config.persona.anchorName) || room?.anchor || '' } }),
    user: lines.join('\n'),
  }
}

export function buildReviewPrompt({ stats, actions, ledger, minutes }) {
  return {
    system: '你是一个直播间的复盘助手。说话直接、具体，不吹不黑，100~200 字，中文。',
    user: [
      `把最近 ${minutes} 分钟的房管工作复盘一下。`,
      `统计：${JSON.stringify(stats)}`,
      `动作流水：${JSON.stringify(actions.slice(-40))}`,
      `被管过的观众：${JSON.stringify(ledger.slice(0, 10))}`,
      '写三段：① 这段时间发生了什么 ② 你做了哪些判断、有没有管过头或该管没管 ③ 下一场建议（一句）。',
      '不要客套话，不要列表符号堆砌，用自然的口语。',
    ].join('\n'),
  }
}

const TEMPLATES = {
  warn: {
    ad: ['@{name} 广告先收一收哈，这儿不发这个', '@{name} 别在这儿拉人啦，再发我要动手了', '{name} 咱不兴发小广告哈'],
    spam: ['@{name} 别刷了哈，屏幕都花了', '@{name} 一句就够啦，剩下的我替你憋着', '{name} 手停一停，刷屏了'],
    insult: ['@{name} 嘴下留点情，都是来看直播的', '@{name} 别骂人哈，好好说话', '{name} 消消气，别带脏字'],
    harassment: ['@{name} 别一直追着人家问，不合适', '@{name} 这个话题打住哈', '{name} 别揪着人不放'],
    spoiler: ['@{name} 别剧透哈，还有人没看到', '{name} 剧透预警先停一下'],
    default: ['@{name} 注意一下哈', '@{name} 这话不太合适，收一收'],
  },
  mute: {
    ad: ['@{name} 说了别发广告，安静 {m} 分钟', '@{name} 提醒过啦，{m} 分钟后见'],
    spam: ['@{name} 刷屏刷够啦，歇 {m} 分钟', '@{name} 提醒两回了，先冷静 {m} 分钟'],
    insult: ['@{name} 骂人这条线不能过，{m} 分钟后再聊', '@{name} 先闭麦 {m} 分钟，缓缓'],
    default: ['@{name} 提醒过了不改，先安静 {m} 分钟', '@{name} {m} 分钟后回来哈'],
  },
  unban: ['@{name} 时间到，回来吧', '{name} 解啦，下次注意点哈'],
  gift: ['谢谢 @{name} 的{gift}，比心', '收到 @{name} 的{gift}，老板大气', '@{name} 的{gift}收到啦，谢谢'],
  sc: ['@了{name}，你的留言我看见啦，谢谢支持', '{name} 的醒目留言收到，比心'],
  greet: ['欢迎 @{name}', '@{name} 来啦，坐'],
  quiet: ['行，那我先闭麦看场子', '好，我歇会儿，有事再喊我'],
  wake: ['我回来啦，接着看场子', '回来了，有啥情况？'],
  fallback: ['我在，接着看场子', '嗯，我盯着呢', '来了来了'],
}

export function pickTemplate(kind, category, vars = {}) {
  const group = TEMPLATES[kind]
  if (!group) return ''
  const list = Array.isArray(group) ? group : group[category] || group.default || group.quiet || group.fallback
  const template = (Array.isArray(list) && pick(list)) || ''
  return fillTemplate(template, vars)
}

export const CATEGORY_LABEL = {
  ad: '发广告/拉人',
  spam: '刷屏',
  insult: '辱骂',
  harassment: '骚扰',
  spoiler: '剧透',
  drama: '引战',
}
