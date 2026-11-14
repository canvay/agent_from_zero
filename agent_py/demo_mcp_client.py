"""demo_mcp_server.py —— 第 8 课：一个只用标准库写的 MCP 服务器，用来测试客户端

两个工具：
- now：返回当前时间（只读）
- word_count：统计一段文字的字数（只读）

真实项目里一般用官方 SDK 写服务器，这里手写是为了看清协议本身。
"""

import json
import sys
from datetime import datetime

# Windows 下管道默认用系统区域编码（GBK），必须显式对齐成 UTF-8，
# 否则中文描述/结果会以 GBK 字节写入 stdout，客户端按 UTF-8 读就崩
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

TOOLS = [
    {
        "name": "now",
        "description": "返回当前的本地时间。",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "word_count",
        "description": "统计一段文字的字符数和行数。",
        "inputSchema": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        },
    },
]


def call(name, args):
    if name == "now":
        return datetime.now().isoformat(timespec="seconds"), False
    if name == "word_count":
        text = args.get("text", "")
        return f"{len(text)} 个字符，{len(text.splitlines()) or 1} 行", False
    return f"没有工具 {name}", True


def handle(msg):
    method, params = msg.get("method"), msg.get("params") or {}
    if method == "initialize":
        return {
            "protocolVersion": params.get("protocolVersion", "2025-11-25"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "demo", "version": "1.0"},
        }
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "tools/call":
        text, is_error = call(params.get("name"), params.get("arguments") or {})
        return {"content": [{"type": "text", "text": text}], "isError": is_error}
    raise KeyError(method)


for line in sys.stdin:  # 一行一条消息
    msg = json.loads(line)
    if "id" not in msg:  # 通知（比如 notifications/initialized）不需要回复
        continue
    try:
        reply = {"jsonrpc": "2.0", "id": msg["id"], "result": handle(msg)}
    except KeyError:
        reply = {
            "jsonrpc": "2.0",
            "id": msg["id"],
            "error": {"code": -32601, "message": f"未知方法 {msg.get('method')}"},
        }
    print(json.dumps(reply, ensure_ascii=False), flush=True)
    print(f"[demo] 处理了 {msg.get('method')}", file=sys.stderr)  # 日志只能写 stderr
