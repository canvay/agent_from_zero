"""telegram.py —— 第 6 课：Telegram 渠道（长轮询，不需要公网 IP）"""

import json
import time
import urllib.error
import urllib.request

MAX_LEN = 4000  # Telegram 单条上限 4096，留点余量
RETRIES = 3  # 瞬时网络错误（TLS 握手超时等）的重试次数


class Telegram:
    def __init__(self, token, timeout=30):
        self.base = f"https://api.telegram.org/bot{token}/"
        self.timeout = timeout
        self.offset = 0
        self.pending = []  # 等待确认期间收到的"别的消息"，稍后处理

    def _call(self, method, **params):
        req = urllib.request.Request(
            self.base + method,
            data=json.dumps(params).encode(),
            headers={"Content-Type": "application/json"},
        )
        # 不走代理时 api.telegram.org 直连很慢，TLS 握手超时是常态而不是异常
        # urllib 默认会读 HTTP(S)_PROXY 环境变量，启动前设好即可
        for attempt in range(1, RETRIES + 1):
            try:
                with urllib.request.urlopen(req, timeout=self.timeout + 10) as r:
                    body = json.loads(r.read())
                break
            except (urllib.error.URLError, TimeoutError) as e:
                if attempt == RETRIES:
                    raise
                wait = 2**attempt  # 2s、4s，指数退避
                print(f"[tg] {method} 网络错误（第 {attempt} 次）：{e}，{wait} 秒后重试")
                time.sleep(wait)
        if not body.get("ok"):
            raise RuntimeError(f"Telegram API 错误：{body}")
        return body["result"]

    def fetch(self, timeout=None):
        """只拉新消息。返回 [(chat_id, user_id, text)]，只要私聊文本。"""
        updates = self._call(
            "getUpdates",
            offset=self.offset,
            timeout=self.timeout if timeout is None else timeout,
        )
        out = []
        for u in updates:
            self.offset = u["update_id"] + 1  # 确认已收到，下次不再返回
            m = u.get("message")
            if m and "text" in m and m["chat"]["type"] == "private":
                out.append((m["chat"]["id"], m["from"]["id"], m["text"]))
        return out

    def poll(self, timeout=None):
        """先交出积压的消息，没有积压再去拉新的。"""
        if self.pending:
            out, self.pending = self.pending, []
            return out
        return self.fetch(timeout)

    def send(self, chat_id, text):
        text = text or "（空回复）"
        for i in range(0, len(text), MAX_LEN):
            self._call("sendMessage", chat_id=chat_id, text=text[i : i + MAX_LEN])
