# 大肥鱼 AI 房管 · 插件规格 / 前端接口契约

插件包名 `@local/dafeiyu-moderator`，目录 `D:\bilibili\dafeiyu-moderator`。
宿主入口 `index.js`，前端入口 `client.js`，HTTP 前缀 `/dafeiyu-moderator/api`。

## 一、前端插件约定（照抄 dafeiyu-login-live 的写法）

`D:\bilibili\dafeiyu-login-live\client.js` 是本项目唯一的风格参照，请先完整读一遍。

    window.__ModuleLoader__.load({
      id: '@local/dafeiyu-moderator',
      factory(require) {
        const React = require('react')
        const h = React.createElement
        // ...
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

要求：
- 只依赖 `react`（用 `require('react')`），不引第三方库、不用 JSX，全部 `h(...)`。
- 颜色用 CSS 变量：`var(--dsw-alias-label-primary,#e8e8ee)`、`--dsw-alias-label-secondary`、`--dsw-alias-label-tertiary`、`--dsw-alias-border-primary`、`--dsw-alias-bg-secondary`、`--dsw-alias-bg-primary`、`--dsw-alias-brand-primary`、`--dsw-alias-state-error-primary`、`--dsw-alias-state-success-primary`。
- 所有请求带 `x-dafeiyu: 1` 头；`fetch('/dafeiyu-moderator/api' + path)`。
- 中文界面。出错要显示 `error` 文本，不能静默。
- 轮询定时器必须在组件卸载时清掉（useEffect 返回 cleanup）。
- 代码要能直接跑，不要留 TODO。

## 二、HTTP 接口契约

统一返回 JSON，带 `ok` 字段；失败 `{ok:false, error:'中文原因'}`。POST 必须带 `x-dafeiyu: 1` 否则 403。

### GET /status
    {
      ok: true,
      status: {
        running: boolean,          // 引擎是否在跑
        enabled: boolean,          // 用户开的开关
        dryRun: boolean,           // 演习模式（只说不做，禁言只记录）
        room: { roomId:number, title:string, anchor:string, anchorUid:number, liveStatus:number, online:number },
        conn: { connected:boolean, since:number|null, lastEventAt:number|null, reconnects:number },
        python: { running:boolean, pid:number|null, restarts:number, lastError:string },
        counts: { danmaku:number, gifts:number, sc:number, enters:number, says:number, warns:number, mutes:number },
        speak: { pausedUntil:number|null },   // 时间戳(ms)，null 表示没暂停
        llm: { calls:number, lastCallAt:number|null, lastError:string }
      },
      config: {...},              // 同 /config
      recent: [ Event ]           // 最近 40 条，见下
    }

### Event
    {
      type: 'danmaku'|'gift'|'enter'|'follow'|'sc'|'live'|'view'|'system',
      ts: number,                 // 毫秒
      uid?: number, name?: string,
      text?: string,              // 弹幕/SC 文本、gift 的礼物名在 giftName
      giftName?: string, num?: number, price?: number,
      owner?: boolean, admin?: boolean, self?: boolean,   // self=机器人自己发的
      viewers?: number, liveStatus?: number, note?: string
    }

### GET /config → `{ok, config}`
### POST /config `{patch}` → 深合并保存 → `{ok, config}`

config 结构：

    {
      roomId: 0,
      enabled: false,
      dryRun: true,
      cookieFile: '',
      pythonPath: '',
      ffmpegPath: '',
      persona: { name:'大肥鱼', tone:'嘴甜但不腻，像个熟门熟路的房管', catchphrases:[] },
      speak: { enabled:true, maxPerMinute:4, minGapSec:15, maxChars:20,
               replyToAnchor:true, reactToGift:true, greetEnter:false, chatIntervalSec:75 },
      moderation: { enabled:true, warnBeforeMute:2, windowMin:30, muteMinutes:5,
                    autoUnban:true, maxMutesPerHour:5, whitelist:[], extraWords:[],
                    muteOn:{ spam:true, ad:true, insult:true, harassment:true, spoiler:false } },
      vision: { enabled:true, intervalMin:8, maxPerHour:6 },
      quietHours: { enabled:false, start:'03:00', end:'07:00' }
    }

### POST /start → `{ok, status}`；POST /stop → `{ok, status}`
### GET /events?limit=100 → `{ok, events:[Event]}`
### GET /actions?limit=60 → `{ok, actions:[{ts, kind:'say'|'warn'|'mute'|'unban'|'skip'|'snapshot', uid?, name?, text?, reason?, ok:boolean}]}`
### GET /ledger?limit=50 → `{ok, users:[{uid, name, warns:number, mutes:number, lastAt:number, lastReason:string, lastCategory:string, mutedUntil:number|null}]}`
### POST /say `{text, replyTo?}` → `{ok, result}`
### POST /warn `{uid, name?, reason?, text?}` → `{ok, action}`
### POST /mute `{uid, name?, minutes?, reason?}` → `{ok, action}`
### POST /unban `{uid}` → `{ok, result}`
### POST /speak `{enabled:boolean}` → 暂停/恢复机器人说话 → `{ok, speak}`
### GET /snapshot?describe=1 → `{ok, snapshot:{path, timestamp, url}, description?}`
### GET /snapshot/latest.jpg → 直接返回 JPEG 二进制（无需 header）
### POST /review `{minutes?:60}` → `{ok, review:{text, stats}}` 近期房管复盘
### GET /room?roomId=123 → `{ok, room}` 查直播间信息

## 三、前端面板内容（必须全部实现）

1. **状态条**：运行中/已停止、连没连上直播间、房间号/标题/主播、在线人数、今日计数（弹幕/礼物/提醒/禁言）。按钮：开工、收工。
2. **配置卡**：直播间号、总开关、演习模式（dryRun）、机器人名字、口吻、说话频率、最长字数、回复主播、谢礼物、禁言前提醒次数、禁言时长、举报窗口、每小时最多禁言、画面感知开关/间隔、免打扰时段。一个「保存」按钮；保存后局部刷新。dryRun 要用醒目提示「演习模式：只 @ 提醒，不会真禁言」。
3. **直播弹幕监控**：显示最近 30 条，带时间、昵称、徽章（主播/房管/机器人）、文本；礼物/SC/进场用不同颜色或前缀区分；新消息进来要能看出来（比如更新时间）；支持暂停自动刷新。
4. **房管动作流水**：最近 12 条动作（说话/提醒/禁言/解禁），带原因和时间。
5. **手动操作**：发弹幕输入框、按 UID 提醒、按 UID 禁言（分钟）、解禁。
6. **画面预览**：`<img src="/dafeiyu-moderator/api/snapshot/latest.jpg?t=...">`，刷新按钮，显示拍摄时间与（若有）AI 描述。
7. **用户档案**：ledger 列表，显示违规次数/禁言次数/最近原因。

面板布局在设置页里，宽度自适应；用卡片分区，不要一坨文字。
