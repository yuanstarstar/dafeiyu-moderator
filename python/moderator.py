#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""大肥鱼 AI 房管 · Python 侧车（B 站直播能力）

协议：stdin/stdout 各一行一个 JSON。
  请求  {"id":1,"cmd":"start","roomId":123}
  回执  {"id":1,"ok":true,"data":{...}} / {"id":1,"ok":false,"error":"..."}
  事件  {"event":"danmaku","uid":1,"name":"x","text":"y","ts":1700000000000}
stdout 只走协议；日志一律写 stderr（宿主会转到插件日志里）。

依赖：bilibili-api-python（已在 %USERPROFILE%\\.dsh\\bili-duty\\.venv 里）与 ffmpeg。
"""

import asyncio
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import asr as asr_mod  # noqa: E402  本地 SenseVoice 语音识别

# --------------------------------------------------------------------------
# 基础工具
# --------------------------------------------------------------------------

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BOT_NAME = "大肥鱼"


def credential_path():
    """B 站凭证文件：宿主配置 > 插件自己 data 目录 > 旧的 ~/.dsh/bili-duty（兼容老用户）。"""
    raw = str(CONFIG.get("cookieFile") or "").strip()
    if raw:
        return raw
    inside = os.path.join(ROOT, "data", "bili_credential.json")
    if os.path.exists(inside):
        return inside
    legacy = os.path.join(os.path.expanduser("~"), ".dsh", "bili-duty", "bili_credential.json")
    if os.path.exists(legacy):
        return legacy
    return inside


def resolve_ffmpeg():
    """ffmpeg 位置：配置 > PATH > 常见目录 > 插件自带。"""
    raw = str(CONFIG.get("ffmpegPath") or "").strip()
    if raw and os.path.basename(raw).lower() not in ("ffmpeg", "ffmpeg.exe"):
        return raw
    found = shutil.which("ffmpeg")
    if found:
        return found
    for cand in (
        os.path.join(os.path.expanduser("~"), ".dsh", "tools", "ffmpeg", "bin", "ffmpeg.exe"),
        os.path.join(ROOT, "data", "bin", "ffmpeg.exe"),
        os.path.join(ROOT, "vendor", "ffmpeg", "ffmpeg.exe"),
        os.path.join(ROOT, "vendor", "ffmpeg", "bin", "ffmpeg.exe"),
    ):
        if os.path.exists(cand):
            return cand
    return raw or "ffmpeg"
CONFIG = {
    "roomId": 0,
    "cookieFile": "",
    "ffmpegPath": "ffmpeg",
    "snapshotDir": "",
    "maxDanmakuPerSec": 20,
    "timeoutSec": 30,
    # 语音识别（本地 SenseVoice）
    "asrEnabled": False,
    "asrModelDir": "",
    "asrLanguage": "auto",
    "asrMinSpeechSec": 0.6,
    "asrGapSec": 1.2,
    "asrMaxPerMinute": 30,
}
STATE = {
    "started": False,
    "roomId": 0,
    "liveStatus": 0,
    "title": "",
    "anchor": "",
    "anchorUid": 0,
    "online": 0,
    "rankCount": 0,
    "connectedAt": 0,
    "lastEventAt": 0,
    "reconnects": 0,
    "droppedDanmaku": 0,
    "seq": 0,
}

VERBOSE = os.environ.get("DFM_VERBOSE", "") not in ("", "0", "false")


def now_ms():
    return int(time.time() * 1000)


OUT_QUEUE = queue.Queue()


def _writer_loop():
    """stdout/stderr 都交给这一个线程写：宿主读得慢也不会把事件循环卡住。"""
    while True:
        item = OUT_QUEUE.get()
        if item is None:
            return
        stream, text = item
        try:
            stream.write(text)
            stream.flush()
        except Exception:
            pass


threading.Thread(target=_writer_loop, daemon=True).start()


def log(*args):
    try:
        OUT_QUEUE.put((sys.stderr, "[moderator] " + " ".join(str(a) for a in args) + "\n"))
    except Exception:
        pass


EMIT_LOCK = threading.Lock()


def emit(obj):
    """向宿主写一条事件。stdout 永远只写 JSON 行。识别线程也会调，排队写。"""
    obj.setdefault("ts", now_ms())
    if obj.get("event") in ("danmaku", "gift", "sc", "enter", "follow", "share", "speech", "live", "view"):
        STATE["lastEventAt"] = obj["ts"]
    try:
        OUT_QUEUE.put((sys.stdout, json.dumps(obj, ensure_ascii=False) + "\n"))
    except Exception as exc:  # 宿主没了就没必要继续
        log("stdout closed:", exc)


def respond(req_id, ok, data=None, error=None):
    payload = {"id": req_id, "ok": bool(ok)}
    if data is not None:
        payload["data"] = data
    if error is not None:
        payload["error"] = str(error)
    emit(payload)


def clip(text, limit=200):
    text = str(text or "")
    return text if len(text) <= limit else text[:limit] + "…"


def _parse_ts(value):
    """把历史弹幕接口的 "2026-10-26 16:38:15" 解析成本地时间戳（失败返回 0）。"""
    text = str(value or "").strip()
    if not text:
        return 0.0
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return time.mktime(time.strptime(text, fmt))
        except ValueError:
            continue
    return 0.0


# --------------------------------------------------------------------------
# 凭证 / 直播间
# --------------------------------------------------------------------------

def load_credential():
    from bilibili_api import Credential

    path = credential_path()
    if not path or not os.path.exists(path):
        raise RuntimeError("还没登录 B 站：面板「登录」里扫码，或把凭证放到 %s" % (path or "(未配置)"))
    with open(path, "r", encoding="utf-8") as fh:
        raw = json.load(fh)
    sessdata = raw.get("sessdata") or raw.get("SESSDATA") or ""
    bili_jct = raw.get("bili_jct") or raw.get("BILI_JCT") or raw.get("biliJct") or ""
    buvid3 = raw.get("buvid3") or raw.get("BUVID3") or ""
    dedeuserid = raw.get("dedeuserid") or raw.get("DEDEUSERID") or raw.get("dedeUserId") or ""
    if not sessdata:
        raise RuntimeError("凭证文件里没有 sessdata，先把 B 站登录状态存进去")
    # bilibili-api 要求 buvid3 是字符串，null 会炸
    return Credential(
        sessdata=str(sessdata),
        bili_jct=str(bili_jct),
        buvid3=str(buvid3) if buvid3 else "",
        dedeuserid=str(dedeuserid),
    )


def make_room(room_id=None):
    from bilibili_api import live

    rid = int(room_id or CONFIG.get("roomId") or STATE.get("roomId") or 0)
    if not rid:
        raise RuntimeError("还没配置直播间号")
    return live.LiveRoom(rid, credential=load_credential())


# ---------------- 历史弹幕接口（实时 ws 被 B 站采样，靠它兜底） ----------------

COOKIE_HEADER = None
REAL_ROOM = {}
OWN_UID = {}


def own_uid():
    """登录账号自己的 uid：B 站会把自己的弹幕也推回来，那是回声，不能再当成观众消息。"""
    if "v" in OWN_UID:
        return OWN_UID["v"]
    path = credential_path()
    uid = 0
    if path and os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                uid = int(json.load(fh).get("dedeuserid") or 0)
        except Exception:
            uid = 0
    OWN_UID["v"] = uid
    return uid


def cookie_header():
    """从凭证文件拼出 Cookie 头，历史弹幕接口需要登录态。"""
    global COOKIE_HEADER
    if COOKIE_HEADER is not None:
        return COOKIE_HEADER
    path = credential_path()
    parts = []
    if path and os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                raw = json.load(fh)
            if raw.get("sessdata"):
                parts.append("SESSDATA=%s" % raw["sessdata"])
            if raw.get("bili_jct"):
                parts.append("bili_jct=%s" % raw["bili_jct"])
            if raw.get("dedeuserid"):
                parts.append("DedeUserID=%s" % raw["dedeuserid"])
        except Exception:
            parts = []
    COOKIE_HEADER = "; ".join(parts)
    return COOKIE_HEADER


def http_json(url, referer="", timeout=8):
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Referer": referer or "https://live.bilibili.com/",
        "Accept": "application/json, text/plain, */*",
        # 不复用连接：B 站偶发「慢滴」响应，keep-alive 卡住一个连接会连累后续请求
        "Connection": "close",
    }
    cookie = cookie_header()
    if cookie:
        headers["Cookie"] = cookie
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _reset_cred_cache():
    """扫码登录 / 退出后，把拼好的 Cookie 与缓存清掉，下一次请求用新凭证。"""
    global COOKIE_HEADER
    COOKIE_HEADER = None
    OWN_UID.pop("v", None)


# ---------------- 扫码登录（passport 接口，凭证只落在本机） ----------------

PASSPORT_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
               "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
QR_GENERATE = "https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header"
QR_POLL = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=%s&source=main-fe-header"
NAV_URL = "https://api.bilibili.com/x/web-interface/nav"
COOKIE_KEEP = ("SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "buvid3", "buvid4")
AUTH_MEMO = {}


def _passport_json(url, timeout=10):
    """请求 passport 接口：要 json，也要 Set-Cookie（登录成功的凭证就在里面）。"""
    req = urllib.request.Request(url, headers={
        "User-Agent": PASSPORT_UA,
        "Referer": "https://www.bilibili.com/",
        "Accept": "application/json, text/plain, */*",
        "Connection": "close",
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        text = resp.read().decode("utf-8", "ignore")
        try:
            body = json.loads(text) if text else {}
        except Exception:
            body = {}
        jar = {}
        try:
            for line in resp.headers.get_all("Set-Cookie") or []:
                first = str(line or "").split(";")[0] or ""
                if "=" not in first:
                    continue
                name, value = first.split("=", 1)
                name, value = name.strip(), value.strip()
                if name in COOKIE_KEEP and value:
                    jar[name] = value
        except Exception:
            pass
    return body, jar


def auth_qr():
    body, _ = _passport_json(QR_GENERATE)
    data = (body or {}).get("data") or {}
    key = str(data.get("qrcode_key") or "")
    url = str(data.get("url") or "")
    if not key or not url:
        raise RuntimeError("生成二维码失败：%s" % ((body or {}).get("message") or "返回里没有 qrcode_key"))
    AUTH_MEMO["key"] = key
    AUTH_MEMO["at"] = time.time()
    return {"key": key, "url": url, "expiresIn": 180}


def _write_credential(jar, target):
    data = {
        "sessdata": jar.get("SESSDATA", ""),
        "bili_jct": jar.get("bili_jct", ""),
        "buvid3": jar.get("buvid3", ""),
        "dedeuserid": jar.get("DedeUserID", ""),
        "updated": time.strftime("%Y-%m-%d %H:%M:%S"),
        "note": "大肥鱼 AI 房管扫码登录写入（别外传）",
    }
    folder = os.path.dirname(os.path.abspath(target))
    if folder and not os.path.isdir(folder):
        os.makedirs(folder, exist_ok=True)
    tmp = target + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    os.replace(tmp, target)
    return data


def auth_poll(key):
    key = str(key or AUTH_MEMO.get("key") or "").strip()
    if not key:
        raise RuntimeError("缺 qrcode_key，先点「生成二维码」")
    body, jar = _passport_json(QR_POLL % urllib.parse.quote(key))
    data = (body or {}).get("data") or {}
    code = data.get("code")
    if code == 86101:
        return {"state": "waiting", "code": code, "message": "还没扫码"}
    if code == 86090:
        return {"state": "scanned", "code": code, "message": "扫了，等手机上确认"}
    if code == 86038:
        return {"state": "expired", "code": code, "message": "二维码过期了，重新生成一张"}
    if code != 0:
        raise RuntimeError((body or {}).get("message") or data.get("message") or ("登录状态未知：%s" % code))
    if not jar.get("SESSDATA") or not jar.get("bili_jct"):
        raise RuntimeError("登录成功但没拿到完整凭证（Set-Cookie 里缺 SESSDATA 或 bili_jct）")
    target = credential_path()
    _write_credential(jar, target)
    _reset_cred_cache()
    AUTH_MEMO.pop("key", None)
    user = {}
    try:
        st = auth_status()
        user = {k: st.get(k) for k in ("mid", "uname", "face", "level")}
    except Exception:
        user = {}
    return {"state": "ok", "code": 0, "message": "登录成功", "file": target, "user": user}


def auth_status():
    path = credential_path()
    st = {"file": path, "exists": os.path.exists(path), "loggedIn": False}
    if not st["exists"]:
        st["message"] = "还没登录"
        return st
    try:
        st["updated"] = time.strftime("%Y-%m-%d %H:%M", time.localtime(os.path.getmtime(path)))
    except Exception:
        st["updated"] = ""
    try:
        body = http_json(NAV_URL, "https://www.bilibili.com/", timeout=8)
    except Exception as exc:
        st["message"] = "连不上 B 站：%s" % clip(exc, 120)
        return st
    data = (body or {}).get("data") or {}
    st["loggedIn"] = bool(data.get("isLogin"))
    if data.get("isLogin"):
        st["mid"] = data.get("mid")
        st["uname"] = data.get("uname")
        st["face"] = data.get("face")
        st["level"] = (data.get("level_info") or {}).get("current_level")
        st["message"] = "已登录：%s" % (data.get("uname") or data.get("mid"))
    else:
        st["message"] = "登录已失效，重新扫码就好"
    return st


def auth_logout():
    path = credential_path()
    removed = False
    for target in (path, os.path.join(ROOT, "data", "bili_credential.json")):
        if target and os.path.exists(target):
            try:
                os.remove(target)
                removed = True
            except Exception:
                pass
    _reset_cred_cache()
    return {"ok": True, "removed": removed, "message": "已退出登录（本机凭证已删除）"}


def real_room_id(rid):
    """显示号可能不是真实房间号，历史弹幕接口要真实号。"""
    rid = int(rid or 0)
    if rid in REAL_ROOM:
        return REAL_ROOM[rid]
    real = rid
    try:
        payload = http_json("https://api.live.bilibili.com/room/v1/Room/room_init?id=%s" % rid,
                            "https://live.bilibili.com/%s" % rid)
        real = int(((payload.get("data") or {}).get("room_id")) or rid)
    except Exception:
        pass
    REAL_ROOM[rid] = real
    return real


def fetch_history(rid, limit=10):
    """拉最近的历史弹幕（登录态下最多 10 条）。返回 [{uid,name,text,timeline}]。"""
    real = real_room_id(rid)
    payload = http_json(
        "https://api.live.bilibili.com/xlive/web-room/v1/dM/gethistory?roomid=%s&room_type=0" % real,
        "https://live.bilibili.com/%s" % rid)
    rows = ((payload.get("data") or {}).get("room") or [])[:limit]
    out = []
    for row in rows:
        text = str(row.get("text") or "").strip()
        if not text:
            continue
        out.append({
            "uid": _num(row.get("uid")),
            "name": str(row.get("nickname") or ""),
            "text": text,
            "timeline": str(row.get("timeline") or ""),
        })
    return out


def parse_room_info(info):
    """把 get_room_info() 的结果压成前端要的样子。"""
    out = {"roomId": STATE.get("roomId"), "title": "", "anchor": "", "anchorUid": 0,
           "liveStatus": 0, "online": 0}
    if not isinstance(info, dict):
        return out
    room = info.get("room_info") or {}
    anchor = info.get("anchor_info") or {}
    base = anchor.get("base_info") or {}
    out["title"] = str(room.get("title") or "")
    out["anchor"] = str(base.get("uname") or anchor.get("uname") or "")
    out["anchorUid"] = int(room.get("uid") or base.get("uid") or 0)
    out["liveStatus"] = int(room.get("live_status") or 0)
    out["online"] = int(room.get("online") or 0)
    out["area"] = str(room.get("area_name") or "")
    out["cover"] = str(room.get("user_cover") or room.get("keyframe") or "")
    return out


# --------------------------------------------------------------------------
# 事件解析
# --------------------------------------------------------------------------

def _num(v, default=0):
    try:
        return int(v)
    except Exception:
        try:
            return int(float(v))
        except Exception:
            return default


def _float(v, default=0.0):
    try:
        return float(v)
    except Exception:
        return default


def parse_danmaku(data):
    info = data.get("info")
    if not isinstance(info, list) or len(info) < 3:
        return None
    text = str(info[1] or "")
    user = info[2] if isinstance(info[2], list) else []
    uid = _num(user[0]) if len(user) > 0 else 0
    name = str(user[1]) if len(user) > 1 else ""
    owner = bool(user[2]) if len(user) > 2 else False
    admin = bool(user[3]) if len(user) > 3 else False
    medal = 0
    medal_name = ""
    if len(info) > 3 and isinstance(info[3], list) and len(info[3]) >= 2:
        medal = _num(info[3][0])
        medal_name = str(info[3][1] or "")
    return {
        "event": "danmaku",
        "uid": uid,
        "name": name or ("用户%s" % uid),
        "text": text,
        "owner": owner,
        "admin": admin,
        "medal": medal,
        "medalName": medal_name,
        "ts": now_ms(),
    }


def parse_gift(data):
    d = data.get("data") or {}
    if not isinstance(d, dict):
        return None
    return {
        "event": "gift",
        "uid": _num(d.get("uid")),
        "name": str(d.get("uname") or ""),
        "giftName": str(d.get("giftName") or d.get("gift_name") or "礼物"),
        "num": _num(d.get("num"), 1),
        "price": _num(d.get("price")),
        "coinType": str(d.get("coin_type") or ""),
        "ts": now_ms(),
    }


def parse_super_chat(data):
    d = data.get("data") or {}
    if not isinstance(d, dict):
        return None
    user = d.get("user_info") or {}
    return {
        "event": "sc",
        "uid": _num(d.get("uid") or user.get("uid")),
        "name": str(user.get("uname") or d.get("uname") or ""),
        "text": str(d.get("message") or ""),
        "price": _num(d.get("price")),
        "ts": now_ms(),
    }


def parse_interact(data):
    d = data.get("data") or {}
    if not isinstance(d, dict):
        return None
    msg_type = _num(d.get("msg_type"))
    kinds = {1: "enter", 2: "follow", 3: "share", 4: "enter", 5: "enter"}
    return {
        "event": kinds.get(msg_type, "interact"),
        "uid": _num(d.get("uid")),
        "name": str(d.get("uname") or ""),
        "msgType": msg_type,
        "ts": now_ms(),
    }


# --------------------------------------------------------------------------
# 房管侧车主体
# --------------------------------------------------------------------------

class Moderator:
    def __init__(self):
        self.dm = None            # LiveDanmaku
        self.task = None          # 连接协程
        self.refresh_task = None  # 定时刷新房间信息（在线人数/开播状态）
        self.history_task = None  # 历史弹幕轮询（补 ws 采样漏掉的弹幕）
        self.speech_task = None   # 主播语音识别
        self.asr = None
        self.asr_stop = threading.Event()
        self.speech_count = 0
        self.last_speech = None
        self.history_seen = {}
        # uid|text -> 上次送达时刻（或历史接口给的服务端发送时刻），用于跨源去重
        self.delivered = {}
        # 自己刚发出去的几句（用来把 B 站回推的「自己说的」认出来，又不误伤主播本人的话）
        self.sent_lines = []
        self.room_cache = None
        self.play_cache = {"url": "", "at": 0}
        self.bucket_at = 0.0
        self.bucket_count = 0
        self.dedup = {}
        self.stopping = False
        self.lock = asyncio.Lock()
        self.msg_send_at = 0.0

    # ---------------- 生命周期 ----------------

    def configure(self, cfg):
        if not isinstance(cfg, dict):
            return dict(CONFIG)
        for key in ("cookieFile", "ffmpegPath", "snapshotDir", "maxDanmakuPerSec", "roomId", "timeoutSec",
                    "asrModelDir", "asrLanguage", "asrMinSpeechSec", "asrGapSec", "asrMaxPerMinute"):
            if key in cfg and cfg[key] not in (None, ""):
                CONFIG[key] = cfg[key]
        for key in ("asrEnabled",):
            if key in cfg:
                CONFIG[key] = bool(cfg[key])
        CONFIG["roomId"] = _num(cfg.get("roomId", CONFIG.get("roomId")))
        return dict(CONFIG)

    async def start(self, room_id=None):
        rid = _num(room_id or CONFIG.get("roomId") or STATE.get("roomId"))
        if not rid:
            raise RuntimeError("还没配置直播间号，先填 roomId")
        if STATE["started"] and rid == STATE["roomId"]:
            return self.status()
        await self.stop(silent=True)
        STATE["roomId"] = rid
        CONFIG["roomId"] = rid
        self.stopping = False
        try:
            info = await asyncio.wait_for(make_room(rid).get_room_info(), timeout=CONFIG["timeoutSec"])
            parsed = parse_room_info(info)
            STATE.update({
                "title": parsed["title"],
                "anchor": parsed["anchor"],
                "anchorUid": parsed["anchorUid"],
                "liveStatus": parsed["liveStatus"],
                "online": parsed["online"],
            })
        except Exception as exc:
            log("房间信息读取失败（不致命）:", exc)
        # 先建连接对象，避免 start 回执太慢
        from bilibili_api import live

        self.dm = live.LiveDanmaku(rid, credential=load_credential(), max_retry=3, retry_after=2)
        self._register_handlers(self.dm)
        self.task = asyncio.create_task(self._run(rid))
        self.refresh_task = asyncio.create_task(self._refresh_room(rid))
        self.history_task = asyncio.create_task(self._poll_history(rid))
        self.asr_stop.clear()
        if CONFIG.get("asrEnabled"):
            self.speech_task = asyncio.create_task(self._speech_loop(rid))
        STATE["started"] = True
        STATE["reconnects"] = 0
        STATE["droppedDanmaku"] = 0
        STATE["connectedAt"] = now_ms()
        emit({"event": "ready", "room": self.room_payload()})
        return self.status()

    async def stop(self, silent=False):
        self.stopping = True
        dm, self.dm = self.dm, None
        if dm is not None:
            try:
                await asyncio.wait_for(dm.disconnect(), timeout=8)
            except Exception as exc:
                log("断开弹幕连接时出错（忽略）:", clip(exc))
        if self.task is not None:
            self.task.cancel()
            try:
                await self.task
            except (asyncio.CancelledError, Exception):
                pass
            self.task = None
        if self.refresh_task is not None:
            self.refresh_task.cancel()
            try:
                await self.refresh_task
            except (asyncio.CancelledError, Exception):
                pass
            self.refresh_task = None
        if self.history_task is not None:
            self.history_task.cancel()
            try:
                await self.history_task
            except (asyncio.CancelledError, Exception):
                pass
            self.history_task = None
        self.asr_stop.set()
        if self.speech_task is not None:
            self.speech_task.cancel()
            try:
                await self.speech_task
            except (asyncio.CancelledError, Exception):
                pass
            self.speech_task = None
        STATE["started"] = False
        if not silent:
            emit({"event": "log", "message": "已停止监听直播间"})
        return self.status()

    async def _run(self, rid):
        """连接 + 断线重连。LiveDanmaku.connect() 正常时不会返回。"""
        while not self.stopping:
            dm = self.dm
            if dm is None:
                return
            try:
                emit({"event": "log", "message": "正在连接直播间 %s …" % rid})
                await dm.connect()
            except asyncio.CancelledError:
                return
            except Exception as exc:
                log("弹幕连接异常:", clip(traceback.format_exc(), 500))
                emit({"event": "error", "where": "danmaku-connect", "message": clip(exc)})
            if self.stopping:
                return
            STATE["reconnects"] += 1
            emit({"event": "log", "message": "弹幕连接断开，%s 秒后重连" % 5})
            await asyncio.sleep(5)
            try:
                from bilibili_api import live

                self.dm = live.LiveDanmaku(rid, credential=load_credential(), max_retry=3, retry_after=2)
                self._register_handlers(self.dm)
            except Exception as exc:
                log("重建连接失败:", clip(exc))
                emit({"event": "error", "where": "danmaku-reconnect", "message": clip(exc)})
                await asyncio.sleep(10)

    async def _refresh_room(self, rid):
        """每 60 秒刷一次房间信息：在线人数、开播状态、标题。"""
        while not self.stopping:
            await asyncio.sleep(60)
            if self.stopping:
                return
            try:
                info = await asyncio.wait_for(make_room(rid).get_room_info(), timeout=CONFIG["timeoutSec"])
                parsed = parse_room_info(info)
                changed = False
                if parsed["online"] and parsed["online"] != STATE["online"]:
                    STATE["online"] = parsed["online"]
                    changed = True
                if parsed["liveStatus"] != STATE["liveStatus"]:
                    STATE["liveStatus"] = parsed["liveStatus"]
                    emit({"event": "live", "liveStatus": parsed["liveStatus"],
                          "note": "直播开始了" if parsed["liveStatus"] else "直播结束了"})
                if parsed["title"] and parsed["title"] != STATE["title"]:
                    STATE["title"] = parsed["title"]
                    changed = True
                if changed:
                    emit({"event": "view", "viewers": STATE["online"], "title": STATE["title"]})
            except asyncio.CancelledError:
                return
            except Exception:
                pass

    async def _poll_history(self, rid):
        """ws 推送被 B 站采样了，这里每 4 秒补拉一次历史弹幕，保证「看得见弹幕」。"""
        await asyncio.sleep(1.5)
        fails = 0
        while not self.stopping:
            try:
                # B 站偶发慢响应（实测有 36 秒才回的情况）。每次只等 6 秒、一轮试两次，
                # 宁可丢掉一次慢响应，也别把节奏拖成半分钟没弹幕。
                rows = []
                last_exc = None
                started = time.time()
                for _attempt in range(2):
                    try:
                        rows = await asyncio.wait_for(asyncio.to_thread(fetch_history, rid), timeout=6)
                        last_exc = None
                        break
                    except asyncio.CancelledError:
                        return
                    except Exception as exc:
                        last_exc = exc
                if VERBOSE:
                    log("拉取第 %s 轮：%s 条 / %.1fs / %s" % (fails + 1, len(rows), time.time() - started, type(last_exc).__name__ if last_exc else "ok"))
                if last_exc is not None:
                    raise last_exc
                if VERBOSE:
                    log("历史弹幕补拉：%s 条" % len(rows))
                fails = 0
                anchor_uid = int(STATE.get("anchorUid") or 0)
                me = own_uid()
                for row in rows:
                    key = "%s|%s|%s" % (row["uid"], row["text"], row["timeline"])
                    if key in self.history_seen:
                        continue
                    self.history_seen[key] = time.time()
                    if row["uid"] and row["uid"] == me and not (anchor_uid and row["uid"] == anchor_uid):
                        continue  # 自己的弹幕（宿主那边已经记成自己说的话了）
                    if row["uid"] and row["uid"] == me and self._is_own_echo(row["text"]):
                        continue  # 自己刚发出去的那句被历史接口又捞回来了
                    if self._is_duplicate("%s|%s" % (row["uid"], row["text"])):
                        continue
                    if self._already_delivered(row["uid"], row["text"], row["timeline"]):
                        continue  # ws 或上一轮历史已经送过同一条
                    if not self._allow_event():
                        continue
                    emit({
                        "event": "danmaku",
                        "uid": row["uid"],
                        "name": row["name"],
                        "text": row["text"],
                        # 历史接口不带身份字段，用主播 uid 兜底，不然主播自己说话也会被当普通观众
                        "owner": bool(anchor_uid and row["uid"] == anchor_uid),
                        "admin": False,
                        "medal": 0,
                        "medalName": "",
                        "src": "history",
                    })
                if len(self.history_seen) > 800:
                    cutoff = time.time() - 900
                    self.history_seen = {k: v for k, v in self.history_seen.items() if v >= cutoff}
            except asyncio.CancelledError:
                return
            except Exception as exc:
                fails += 1
                # 偶发超时是常态，只在头几次和每 30 次提醒一次，避免刷屏
                if fails <= 2 or fails % 30 == 0:
                    log("历史弹幕轮询失败（忽略，第 %s 次）：%s" % (fails, clip(exc) or type(exc).__name__))
            await asyncio.sleep(2 if fails else 4)

    # ---------------- 主播语音识别 ----------------

    def _load_asr(self):
        if self.asr is None:
            self.asr = asr_mod.Asr(
                model_dir=CONFIG.get("asrModelDir") or "",
                language=CONFIG.get("asrLanguage") or "auto",
            )
        if self.asr.ready:
            return True
        ok = self.asr.load(log=lambda msg: emit({"event": "log", "message": msg}))
        if not ok:
            emit({"event": "error", "where": "asr", "message": self.asr.error})
        return ok

    def _on_speech(self, text, dur, cost):
        """识别线程里回调：发 speech 事件给宿主。"""
        if self.stopping or self.asr_stop.is_set():
            return
        self.speech_count += 1
        self.last_speech = {"text": text, "dur": round(dur, 2), "at": now_ms()}
        if VERBOSE:
            log("语音 %s（%.1fs 音频 / %.2fs 识别）" % (text, dur, cost))
        emit({"event": "speech", "text": text, "dur": round(dur, 2), "cost": round(cost, 2)})

    async def _speech_loop(self, rid):
        """拉直播流音频 → VAD → 识别；断了就重连。"""
        def note(msg):
            # 反复用新地址重连时同一条日志会刷屏，连着重复就压掉
            nonlocal last_note
            if msg == last_note:
                return
            last_note = msg
            emit({"event": "log", "message": msg})

        last_note = ""
        stale = False
        broken = 0
        note("语音识别已开启")
        while not self.stopping:
            try:
                ok = await asyncio.to_thread(self._load_asr)
                if not ok:
                    note("语音识别没起来，30 秒后再试")
                    await asyncio.sleep(30)
                    continue
                url = await self._play_url(force=stale)
                if not url:
                    raise RuntimeError("拿不到直播播放地址（主播可能没开播）")
                pump = asr_mod.AudioPump(
                    ffmpeg=resolve_ffmpeg(),
                    url=url,
                    asr=self.asr,
                    on_text=self._on_speech,
                    should_stop=self.asr_stop.is_set,
                    log=lambda msg: log("语音:", msg),
                    min_speech=_float(CONFIG.get("asrMinSpeechSec"), 0.6),
                    gap=_float(CONFIG.get("asrGapSec"), 1.2),
                    max_per_minute=_num(CONFIG.get("asrMaxPerMinute"), 30),
                )
                guard = asyncio.create_task(self._watch_audio(pump))
                try:
                    reason = await asyncio.to_thread(pump.run)
                finally:
                    guard.cancel()
                if self.stopping or self.asr_stop.is_set():
                    break
                # 几乎没读到音频就断了：多半是签名地址被踢/过期，下一轮强制换新地址
                stale = pump.bytes_read < 16000 * 2
                broken = broken + 1 if stale else 0
                note("语音流断开（%s，%d KB），%s重连" % (
                    reason, pump.bytes_read // 1024, "换地址" if stale else "3 秒后"))
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if self.stopping or self.asr_stop.is_set():
                    break
                log("语音识别异常:", clip(exc))
                stale = True
                broken += 1
                note("语音识别异常：%s" % clip(exc, 120))
            # 一直被打断就别硬顶，逐步拉开重试间隔（最多 10 秒）
            await asyncio.sleep(min(1 + broken, 10) if stale else 3)

    async def _watch_audio(self, pump):
        """音频流呆住（网络卡住 / ffmpeg 不再吐数据）就掐掉重连，不然会一直「听得见开播、听不见人说话」。"""
        while not self.stopping and not self.asr_stop.is_set():
            await asyncio.sleep(5)
            try:
                if not pump.proc or pump.proc.poll() is not None:
                    return
                idle = time.time() - pump.last_read_at
                if idle > 20:
                    emit({"event": "log", "message": "音频流 %d 秒没数据，重连中" % int(idle)})
                    pump.stop()
                    return
            except Exception:
                return

    def _register_handlers(self, dm):
        dm.add_event_listener("DANMU_MSG", self._on_danmaku)
        dm.add_event_listener("SEND_GIFT", self._on_gift)
        dm.add_event_listener("SUPER_CHAT_MESSAGE", self._on_super_chat)
        dm.add_event_listener("INTERACT_WORD", self._on_interact)
        dm.add_event_listener("LIVE", self._on_live)
        dm.add_event_listener("PREPARING", self._on_preparing)
        dm.add_event_listener("ONLINE_RANK_COUNT", self._on_online)
        dm.add_event_listener("VIEW", self._on_view)

    # ---------------- 事件处理 ----------------

    def _allow_event(self):
        """令牌桶 + 去重：大房间弹幕太多时只采样，避免打爆宿主。"""
        now = time.time()
        if now - self.bucket_at >= 1.0:
            self.bucket_at = now
            self.bucket_count = 0
        limit = _num(CONFIG.get("maxDanmakuPerSec"), 20)
        self.bucket_count += 1
        if self.bucket_count > limit:
            STATE["droppedDanmaku"] += 1
            return False
        return True

    def _is_duplicate(self, key):
        now = time.time()
        last = self.dedup.get(key, 0)
        self.dedup[key] = now
        if len(self.dedup) > 2000:
            cutoff = now - 30
            self.dedup = {k: v for k, v in self.dedup.items() if v >= cutoff}
        return now - last < 3.0

    def _already_delivered(self, uid, text, timeline, mark=True):
        """同一条弹幕是否已经送过（跨 ws / 历史接口）。

        历史接口偶尔很慢（实测 25~40 秒才返回），等它回来时按「到达时间」去重早就过期了，
        于是同一条弹幕会在面板里出现两遍。所以这里比的是**服务端发送时间**：
        ws 送来时记下到达时刻，历史行带着发送时刻，只要发送时刻不晚于上次送达，
        就认定是同一条。观众真的又发了一遍（发送时刻更晚）则照常放行。
        """
        key = "%s|%s" % (uid, text)
        now = time.time()
        sent = _parse_ts(timeline) or 0
        last = self.delivered.get(key, 0)
        hit = False
        if last:
            if sent:
                hit = last >= sent - 3.0
            else:
                hit = now - last < 90.0
        if mark:
            self.delivered[key] = max(last, sent or now)
            if len(self.delivered) > 3000:
                cutoff = now - 900
                self.delivered = {k: v for k, v in self.delivered.items() if v >= cutoff}
        return hit

    def _is_own_echo(self, text):
        """自己刚发出去的那句（90 秒内）：B 站会回推，历史接口也会捞回来。"""
        body = (text or "").strip()
        if not body:
            return False
        now = time.time()
        self.sent_lines = [(t, ts) for t, ts in self.sent_lines if now - ts < 90]
        return any(t == body for t, _ in self.sent_lines)

    def _on_danmaku(self, info):
        try:
            data = info.get("data") if isinstance(info, dict) else None
            if not isinstance(data, dict):
                return
            event = parse_danmaku(data)
            if not event:
                return
            if event["uid"] and event["uid"] == own_uid():
                # B 站把自己的弹幕也推回来，别让它重复出现在面板里。
                # 但插件用的账号可能就是这个直播间的主播本人：主播说的话不能吞，
                # 只吞「自己刚发出去的那几句」。
                anchor_uid = int(STATE.get("anchorUid") or 0)
                if not (anchor_uid and event["uid"] == anchor_uid) or self._is_own_echo(event["text"]):
                    return
            # ws 这边只做「短时间去重」（B 站偶尔会把同一句推两遍），
            # 跨源去重交给 _already_delivered（它比的是服务端发送时间，不吃慢响应）
            if self._is_duplicate("%s|%s" % (event["uid"], event["text"])):
                return
            if not self._allow_event():
                return
            self._already_delivered(event["uid"], event["text"], "")
            STATE["lastEventAt"] = now_ms()
            emit(event)
        except Exception as exc:
            log("处理弹幕出错:", clip(traceback.format_exc(), 400))

    def _on_gift(self, info):
        try:
            event = parse_gift(info.get("data") or {})
            if event and self._allow_event():
                STATE["lastEventAt"] = now_ms()
                emit(event)
        except Exception as exc:
            log("处理礼物出错:", clip(exc))

    def _on_super_chat(self, info):
        try:
            event = parse_super_chat(info.get("data") or {})
            if event:
                STATE["lastEventAt"] = now_ms()
                emit(event)
        except Exception as exc:
            log("处理醒目留言出错:", clip(exc))

    def _on_interact(self, info):
        try:
            event = parse_interact(info.get("data") or {})
            if event and event.get("uid"):
                STATE["lastEventAt"] = now_ms()
                emit(event)
        except Exception as exc:
            log("处理进场出错:", clip(exc))

    def _on_live(self, info):
        STATE["liveStatus"] = 1
        emit({"event": "live", "liveStatus": 1, "note": "直播开始了"})

    def _on_preparing(self, info):
        STATE["liveStatus"] = 0
        emit({"event": "live", "liveStatus": 0, "note": "直播结束了"})

    def _on_online(self, info):
        """在线榜单人数：只当活跃度参考，不能当成在线观众数。"""
        try:
            data = info.get("data") or {}
            count = _num(data.get("count"))
            if count:
                STATE["rankCount"] = count
        except Exception:
            pass

    def _on_view(self, info):
        """VIEW 包只是个整数计数，不是人数，忽略。真实在线人数靠定时刷新房间信息。"""
        return

    # ---------------- 主动操作 ----------------

    async def say(self, text, reply_mid=None, room_id=None):
        text = str(text or "").strip()
        if not text:
            raise RuntimeError("弹幕内容不能为空")
        # B 站普通用户弹幕 20 字上限；给一点余量，超了直接截断，不让接口报错
        if len(text) > 40:
            text = text[:40]
        gap = time.time() - self.msg_send_at
        if gap < 1.2:
            await asyncio.sleep(1.2 - gap)
        from bilibili_api.utils.danmaku import Danmaku

        room = make_room(room_id)
        dm = Danmaku(text=text, mode=1)
        kwargs = {"room_id": _num(room_id or CONFIG.get("roomId") or STATE.get("roomId"))}
        if reply_mid:
            kwargs["reply_mid"] = _num(reply_mid)
        result = await asyncio.wait_for(room.send_danmaku(dm, **kwargs), timeout=CONFIG["timeoutSec"])
        self.msg_send_at = time.time()
        self.sent_lines.append((text, time.time()))
        if len(self.sent_lines) > 20:
            self.sent_lines = self.sent_lines[-20:]
        emit({"event": "self-said", "text": text, "replyMid": _num(reply_mid), "ts": now_ms()})
        return {"sent": True, "text": text, "replyMid": _num(reply_mid), "raw": _brief(result)}

    async def ban(self, uid, hour=1, room_id=None):
        uid = _num(uid)
        if not uid:
            raise RuntimeError("uid 无效")
        hour = max(1, _num(hour, 1))
        room = make_room(room_id)
        result = await asyncio.wait_for(room.ban_user(uid, hour=hour), timeout=CONFIG["timeoutSec"])
        return {"uid": uid, "hours": hour, "raw": _brief(result)}

    async def unban(self, uid, room_id=None):
        uid = _num(uid)
        if not uid:
            raise RuntimeError("uid 无效")
        room = make_room(room_id)
        result = await asyncio.wait_for(room.unban_user(uid), timeout=CONFIG["timeoutSec"])
        return {"uid": uid, "raw": _brief(result)}

    async def snapshot(self, out_dir=None):
        """抓一帧当前直播画面，返回本地 jpg 路径。"""
        out_dir = out_dir or CONFIG.get("snapshotDir") or os.path.join(
            ROOT, "data", "snapshots")
        os.makedirs(out_dir, exist_ok=True)
        # 抓帧单独换一个新签名地址：B 站的 FLV 地址同时开两路会把先开的那路踢掉，
        # 音频线程正在用缓存地址，这里必须另取一个。
        url = await self._play_url(force=True)
        ffmpeg = resolve_ffmpeg()
        stamp = time.strftime("%Y%m%d-%H%M%S")
        target = os.path.join(out_dir, "frame-%s-%s.jpg" % (stamp, os.getpid()))
        cmd = [
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
            "-user_agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                           "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            "-referer", "https://live.bilibili.com/",
            "-probesize", "1000000", "-analyzeduration", "1000000",
            "-i", url, "-frames:v", "1", "-q:v", "3", target,
        ]
        started = time.time()
        # 用同步 subprocess 丢到线程里跑：Windows 下 asyncio 的 create_subprocess_exec
        # 在受限制的进程环境里会直接 WinError 5，而 subprocess.run 一直可用。
        result = await asyncio.to_thread(self._grab_frame, cmd)
        if result != 0 or not os.path.exists(target):
            raise RuntimeError("抓帧失败：%s" % clip(result, 300))
        self._cleanup_snapshots(out_dir)
        return {
            "path": target,
            "url": "",   # 由宿主补成可访问地址
            "timestamp": now_ms(),
            "bytes": os.path.getsize(target),
            "elapsedMs": int((time.time() - started) * 1000),
        }

    @staticmethod
    def _grab_frame(cmd):
        try:
            done = subprocess.run(cmd, capture_output=True, timeout=45)
        except subprocess.TimeoutExpired:
            return "抓帧超时（45 秒），直播可能刚断流"
        if done.returncode == 0:
            return 0
        return done.stderr.decode("utf-8", "ignore") or "ffmpeg 返回 %s" % done.returncode

    def _cleanup_snapshots(self, out_dir):
        try:
            files = [os.path.join(out_dir, f) for f in os.listdir(out_dir) if f.endswith(".jpg")]
            files.sort(key=lambda p: os.path.getmtime(p), reverse=True)
            for old in files[12:]:
                os.remove(old)
        except Exception:
            pass

    async def _play_url(self, force=False):
        now = time.time()
        if not force and self.play_cache["url"] and now - self.play_cache["at"] < 60:
            return self.play_cache["url"]
        room = make_room()
        data = await asyncio.wait_for(room.get_room_play_url(), timeout=CONFIG["timeoutSec"])
        durl = (data or {}).get("durl") or []
        if not durl or not durl[0].get("url"):
            raise RuntimeError("拿不到直播流地址：房间可能没在播")
        self.play_cache = {"url": durl[0]["url"], "at": now}
        return self.play_cache["url"]

    async def room_info(self, room_id=None):
        info = await asyncio.wait_for(make_room(room_id).get_room_info(), timeout=CONFIG["timeoutSec"])
        parsed = parse_room_info(info)
        if _num(room_id or 0) in (0, _num(CONFIG.get("roomId"))):
            STATE.update({
                "title": parsed["title"],
                "anchor": parsed["anchor"],
                "anchorUid": parsed["anchorUid"],
                "liveStatus": parsed["liveStatus"],
                "online": parsed["online"],
            })
        return parsed

    # ---------------- 状态 ----------------

    def room_payload(self):
        return {
            "roomId": STATE.get("roomId"),
            "title": STATE.get("title"),
            "anchor": STATE.get("anchor"),
            "anchorUid": STATE.get("anchorUid"),
            "liveStatus": STATE.get("liveStatus"),
            "online": STATE.get("online"),
        }

    def status(self):
        return {
            "started": STATE["started"],
            "room": self.room_payload(),
            "connectedAt": STATE["connectedAt"],
            "lastEventAt": STATE["lastEventAt"],
            "reconnects": STATE["reconnects"],
            "droppedDanmaku": STATE["droppedDanmaku"],
            "config": dict(CONFIG),
            "speech": {
                "enabled": bool(CONFIG.get("asrEnabled")),
                "ready": bool(self.asr and self.asr.ready),
                "count": self.speech_count,
                "last": self.last_speech,
                "error": (self.asr.error if self.asr else ""),
                **(self.asr.status() if self.asr else {}),
            },
        }

    # ---------------- 命令分发 ----------------

    async def handle(self, req):
        cmd = str(req.get("cmd") or "").strip()
        req_id = req.get("id")
        try:
            if cmd == "configure":
                return respond(req_id, True, {"config": self.configure(req.get("config") or {})})
            if cmd == "start":
                return respond(req_id, True, {"status": await self.start(req.get("roomId"))})
            if cmd == "stop":
                return respond(req_id, True, {"status": await self.stop()})
            if cmd == "status":
                return respond(req_id, True, {"status": self.status()})
            if cmd == "roominfo":
                return respond(req_id, True, {"room": await self.room_info(req.get("roomId"))})
            if cmd == "say":
                return respond(req_id, True, {"result": await self.say(req.get("text"), req.get("replyMid"))})
            if cmd == "ban":
                return respond(req_id, True, {"result": await self.ban(req.get("uid"), req.get("hour", 1))})
            if cmd == "unban":
                return respond(req_id, True, {"result": await self.unban(req.get("uid"))})
            if cmd == "snapshot":
                return respond(req_id, True, await self.snapshot(req.get("outDir")))
            if cmd == "auth_status":
                return respond(req_id, True, {"auth": await asyncio.to_thread(auth_status)})
            if cmd == "auth_qr":
                return respond(req_id, True, {"qr": await asyncio.to_thread(auth_qr)})
            if cmd == "auth_poll":
                return respond(req_id, True, {"auth": await asyncio.to_thread(auth_poll, req.get("key"))})
            if cmd == "auth_logout":
                return respond(req_id, True, {"auth": await asyncio.to_thread(auth_logout)})
            if cmd == "ping":
                return respond(req_id, True, {"pong": now_ms(), "status": self.status()})
            if cmd == "shutdown":
                respond(req_id, True, {"bye": True})
                # 先把回执刷出去，再干脆退出（Windows 上优雅关 asyncio 容易卡住）
                await asyncio.sleep(0.3)
                await self.stop(silent=True)
                os._exit(0)
            return respond(req_id, False, error="未知命令：%s" % cmd)
        except SystemExit:
            raise
        except Exception as exc:
            log("命令 %s 失败:" % cmd, clip(traceback.format_exc(), 600))
            return respond(req_id, False, error=clip(exc, 400))


def _brief(value, limit=400):
    try:
        text = json.dumps(value, ensure_ascii=False)
    except Exception:
        text = str(value)
    return clip(text, limit)


# --------------------------------------------------------------------------
# 自检模式：不给宿主也能验证连接/抓帧
# --------------------------------------------------------------------------

async def selftest(room_id, seconds):
    mod = Moderator()
    mod.configure({"roomId": room_id})
    emit({"event": "selftest", "roomId": room_id})

    async def stopper():
        await asyncio.sleep(seconds)
        await mod.stop(silent=True)

    await mod.start(room_id)
    await asyncio.sleep(2)
    try:
        snap = await mod.snapshot()
        emit({"event": "selftest-snapshot", "snapshot": snap})
    except Exception as exc:
        emit({"event": "selftest-snapshot-error", "error": clip(exc)})
    await asyncio.gather(asyncio.create_task(stopper()), asyncio.sleep(seconds + 0.5))


# --------------------------------------------------------------------------
# 主循环
# --------------------------------------------------------------------------

async def main():
    loop = asyncio.get_running_loop()
    mod = Moderator()
    emit({"event": "boot", "pid": os.getpid(), "python": sys.version.split()[0]})

    # 先把大块依赖在主线程里 import 掉：import 锁 + 加载 DLL 很重，
    # 留给工作线程 import 会把事件循环拖住几十秒（实测 50 秒以上）。
    try:
        import numpy  # noqa: F401
    except Exception:
        pass
    try:
        import sherpa_onnx  # noqa: F401
    except Exception:
        pass

    async def loop_monitor():
        last = time.time()
        while True:
            await asyncio.sleep(1)
            now = time.time()
            STATE["heartbeat"] = now
            lag = now - last - 1
            if lag > 1.0:
                log("事件循环卡顿 %.1fs" % lag)
            last = now

    if VERBOSE:
        asyncio.create_task(loop_monitor())

        def stack_watch():
            import traceback
            while True:
                time.sleep(2)
                if time.time() - STATE.get("heartbeat", 0) > 4:
                    frames = sys._current_frames()
                    for tid, frame in frames.items():
                        stack = traceback.format_stack(frame)
                        if stack:
                            log("线程 %s 卡在：%s" % (tid, stack[-1].strip().replace("\n", " ")[:180]))
                    time.sleep(6)

        threading.Thread(target=stack_watch, daemon=True).start()

    # Windows 上 asyncio 的 proactor 读 stdin 在 EOF 时会抛「句柄无效」，
    # 所以用一个后台线程做阻塞 readline，再把行丢回事件循环。
    queue = asyncio.Queue()
    stop_flag = threading.Event()

    def pump_stdin():
        while not stop_flag.is_set():
            try:
                line = sys.stdin.readline()
            except Exception:
                line = ""
            if not line:
                loop.call_soon_threadsafe(queue.put_nowait, None)
                return
            loop.call_soon_threadsafe(queue.put_nowait, line)

    threading.Thread(target=pump_stdin, daemon=True).start()

    pending = set()
    while True:
        line = await queue.get()
        if line is None:
            break
        text = line.strip()
        if not text:
            continue
        try:
            req = json.loads(text)
        except Exception as exc:
            emit({"event": "error", "where": "stdin-json", "message": clip(exc)})
            continue
        if VERBOSE:
            log("<<", text[:300])
        task = asyncio.create_task(mod.handle(req))
        pending.add(task)
        task.add_done_callback(pending.discard)
    stop_flag.set()
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)
    await mod.stop(silent=True)


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        room = 0
        seconds = 15
        args = sys.argv[1:]
        for i, arg in enumerate(args):
            if arg == "--room" and i + 1 < len(args):
                room = _num(args[i + 1])
            if arg == "--seconds" and i + 1 < len(args):
                seconds = _num(args[i + 1], 15)
        asyncio.run(selftest(room, seconds))
    else:
        try:
            asyncio.run(main())
        except KeyboardInterrupt:
            pass
