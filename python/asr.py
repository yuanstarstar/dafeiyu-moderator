"""本地语音识别：sherpa-onnx SenseVoice 小模型 + silero VAD 切句。

不依赖网络：从直播间 FLV 拉音频（ffmpeg）→ VAD 找说话段 → SenseVoice 识别成文字。
由 moderator.py 的 `_speech_loop` 调用，识别结果以 `speech` 事件发给宿主。
"""

import os
import re
import subprocess
import time

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 模型默认找这些地方：插件自己的 data/models（自带）、~/.dsh/speech-to-text/sensevoice/models（本机已装的那份）
DEFAULT_MODEL_DIR = os.path.join(os.path.expanduser("~"), ".dsh", "speech-to-text", "sensevoice", "models")
MODEL_PLACES = (
    os.path.join(HERE, "data", "models"),
    os.path.join(HERE, "models"),
    DEFAULT_MODEL_DIR,
)

# SenseVoice 会把语种/情绪/事件标签包在 <|...|> 里，识别文本里要剥掉
SPECIAL_TAG = re.compile(r"<\|[^|]*\|>")
# 明显是幻听/字幕残留的短语，直接丢
NOISE = {
    "。", "，", "嗯。", "啊。", "哦。", "谢谢观看", "谢谢大家", "字幕", "字幕由", "请不吝点赞",
    "订阅", "转发", "打赏", "支持", "明镜与点点", "中文字幕", "感谢观看", "谢谢收看",
}
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)


def find_models(model_dir=""):
    """在给定目录里找出 sensevoice int8 模型、tokens、silero VAD 三个文件。"""
    roots = [model_dir] if model_dir else list(MODEL_PLACES)
    for root in roots:
        found = _find_in(root)
        if found:
            return found
    return None


def _find_in(root):
    candidates = [
        (os.path.join(root, "sensevoice-onnx", "model.int8.onnx"), os.path.join(root, "sensevoice-onnx", "tokens.txt")),
        (os.path.join(root, "model.int8.onnx"), os.path.join(root, "tokens.txt")),
        (os.path.join(root, "sensevoice", "model.int8.onnx"), os.path.join(root, "sensevoice", "tokens.txt")),
    ]
    vad_candidates = [
        os.path.join(root, "silero", "silero_vad.onnx"),
        os.path.join(root, "silero_vad.onnx"),
    ]
    model = tokens = None
    for m, t in candidates:
        if os.path.isfile(m) and os.path.isfile(t):
            model, tokens = m, t
            break
    vad = next((path for path in vad_candidates if os.path.isfile(path)), None)
    if not model or not vad:
        return None
    return {"model": model, "tokens": tokens, "vad": vad}


def clean_text(text):
    """去掉 <|zh|><|NEUTRAL|> 这类标签和幻听短语。"""
    raw = SPECIAL_TAG.sub("", str(text or ""))
    text = re.sub(r"\s+", " ", raw).strip()
    text = text.strip(" \t\r\n")
    if not text:
        return ""
    if text in NOISE:
        return ""
    # 只剩标点/单个语气字的不算一句话
    core = re.sub(r"[，。！？、,.!?~\s]", "", text)
    if len(core) < 2:
        return ""
    return text


class Asr:
    """SenseVoice 识别器。加载一次，反复用。"""

    def __init__(self, model_dir="", language="auto", num_threads=2):
        self.model_dir = model_dir or ""
        self.language = language or "auto"
        self.num_threads = int(num_threads) if num_threads else 2
        self.recognizer = None
        self.paths = None
        self.error = ""
        self.loaded_at = 0
        self.segments = 0
        self.asr_seconds = 0.0

    @property
    def ready(self):
        return self.recognizer is not None

    def load(self, log=None):
        if self.recognizer is not None:
            return True
        try:
            import sherpa_onnx
        except ImportError as exc:
            self.error = "没装 sherpa-onnx（%s），先用 uv pip install sherpa-onnx" % exc
            if log:
                log(self.error)
            return False
        paths = find_models(self.model_dir)
        if not paths:
            where = self.model_dir or "、".join(MODEL_PLACES)
            self.error = "在 %s 里没找到 SenseVoice 模型（model.int8.onnx / tokens.txt / silero_vad.onnx）" % where
            if log:
                log(self.error)
            return False
        started = time.time()
        try:
            self.recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
                model=paths["model"],
                tokens=paths["tokens"],
                num_threads=self.num_threads,
                use_itn=True,
                language=self.language,
                debug=False,
            )
        except Exception as exc:
            self.error = "加载 SenseVoice 失败：%s" % exc
            if log:
                log(self.error)
            self.recognizer = None
            return False
        self.paths = paths
        self.loaded_at = int(time.time() * 1000)
        self.error = ""
        if log:
            log("SenseVoice 已加载（%.2fs）" % (time.time() - started))
        return True

    def new_vad(self, buffer_seconds=40):
        import sherpa_onnx

        config = sherpa_onnx.VadModelConfig()
        config.silero_vad.model = self.paths["vad"]
        config.silero_vad.threshold = 0.5
        config.silero_vad.min_silence_duration = 0.35
        config.silero_vad.min_speech_duration = 0.45
        config.silero_vad.max_speech_duration = 12
        config.silero_vad.window_size = 512
        config.sample_rate = 16000
        return sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=buffer_seconds)

    def transcribe(self, samples):
        """samples: float32 单声道 16k。返回 (文本, 耗时秒)。"""
        if self.recognizer is None:
            return "", 0.0
        started = time.time()
        stream = self.recognizer.create_stream()
        stream.accept_waveform(16000, samples)
        self.recognizer.decode_stream(stream)
        text = clean_text(getattr(stream.result, "text", ""))
        cost = time.time() - started
        self.segments += 1
        self.asr_seconds += cost
        return text, cost

    def status(self):
        return {
            "ready": self.ready,
            "modelDir": self.model_dir,
            "language": self.language,
            "loadedAt": self.loaded_at or None,
            "segments": self.segments,
            "asrSeconds": round(self.asr_seconds, 2),
            "error": self.error,
        }


class AudioPump:
    """在后台线程里跑：ffmpeg 拉音频 → VAD 切句 → 识别 → 回调。"""

    def __init__(self, *, ffmpeg, url, asr, on_text, should_stop=None, log=None,
                 min_speech=0.6, gap=1.2, max_per_minute=30, chunk_bytes=3200):
        self.ffmpeg = ffmpeg
        self.url = url
        self.asr = asr
        self.on_text = on_text or (lambda text, dur: None)
        self.should_stop = should_stop or (lambda: False)
        self.log = log or (lambda *a: None)
        self.min_speech = float(min_speech or 0.6)
        self.gap = float(gap or 0)
        self.max_per_minute = int(max_per_minute or 0)
        self.chunk_bytes = int(chunk_bytes)
        self.proc = None
        self.reason = ""
        self.segments = 0
        self.emitted = 0
        self.last_emit_at = 0.0
        self.emit_window = []
        self.bytes_read = 0
        self.last_read_at = time.time()

    def stop(self):
        try:
            if self.proc and self.proc.poll() is None:
                self.proc.kill()
        except Exception:
            pass

    def _allow(self, now_ts):
        if self.gap and now_ts - self.last_emit_at < self.gap:
            return False
        if self.max_per_minute > 0:
            cutoff = now_ts - 60
            self.emit_window = [ts for ts in self.emit_window if ts >= cutoff]
            if len(self.emit_window) >= self.max_per_minute:
                return False
        return True

    def run(self):
        """阻塞运行，直到直播流断开或 should_stop() 为真。返回原因字符串。"""
        cmd = [
            self.ffmpeg, "-hide_banner", "-loglevel", "error",
            "-user_agent", UA, "-referer", "https://live.bilibili.com/",
            "-probesize", "2000000", "-analyzeduration", "2000000",
            "-rw_timeout", "12000000",
            "-i", self.url, "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "-",
        ]
        err_path = os.environ.get("DFM_FFMPEG_LOG") or ""
        err_file = None
        try:
            if err_path:
                err_file = open(err_path, "wb")
                stderr = err_file
            else:
                stderr = subprocess.DEVNULL
            self.proc = subprocess.Popen(
                cmd, stdout=subprocess.PIPE, stderr=stderr,
                stdin=subprocess.DEVNULL,
            )
        except Exception as exc:
            self.reason = "拉音频失败：%s" % exc
            return self.reason

        import numpy as np

        vad = self.asr.new_vad()
        last_stat = time.time()
        peak = 0.0
        while not self.should_stop():
            data = self.proc.stdout.read(self.chunk_bytes)
            if data:
                self.bytes_read += len(data)
                self.last_read_at = time.time()
            if not data:
                self.reason = "直播流结束"
                break
            samples = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
            if samples.size:
                local_peak = float(np.abs(samples).max())
                if local_peak > peak:
                    peak = local_peak
            vad.accept_waveform(samples)
            while not vad.empty():
                seg = vad.front
                seg_samples = list(seg.samples)
                vad.pop()
                self.segments += 1
                dur = len(seg_samples) / 16000.0
                if dur < self.min_speech:
                    continue
                now_ts = time.time()
                if not self._allow(now_ts):
                    continue
                text, cost = self.asr.transcribe(seg_samples)
                if not text:
                    continue
                self.last_emit_at = now_ts
                self.emit_window.append(now_ts)
                self.emitted += 1
                try:
                    self.on_text(text, dur, cost)
                except Exception as exc:
                    self.log("语音回调出错：%s" % exc)
            if time.time() - last_stat >= 30:
                last_stat = time.time()
                self.log("语音流：%d KB / 片段 %d / 说出 %d / 峰值 %.3f" % (
                    self.bytes_read // 1024, self.segments, self.emitted, peak))
        self.stop()
        if err_file is not None:
            try:
                err_file.close()
            except Exception:
                pass
        if not self.reason:
            self.reason = "手动停止"
        return self.reason
