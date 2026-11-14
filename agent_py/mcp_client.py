"""mcp_client.py —— 第 8 课：最小的 MCP 客户端（stdio 传输，不依赖 SDK）

MCP 服务器是一个独立进程。我们通过它的 stdin/stdout 收发 JSON-RPC 2.0 消息，
每条消息一行。握手之后问它有哪些工具，再把每个工具注册进第 2 课的注册表。
"""

import json
import os
import subprocess
import threading

from context import STATE_DIR
from permissions import TOOL_RISK, Risk
from tools import TOOLS

PROTOCOL_VERSION = "2025-11-25"
# 配置放在状态目录，不在工作区：能改配置，就能让 Agent 启动任意程序
CONFIG_FILE = STATE_DIR / "mcp.json"
TIMEOUT = 30


class MCPError(Exception):
    pass


class MCPServer:
    """一个 MCP 服务器进程，以及和它说话的方法。"""

    def __init__(self, name, command, args=(), env=None):
        self.name = name
        self.proc = subprocess.Popen(
            [command, *args],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,  # 服务器的日志走 stderr，这里直接丢掉
            text=True,
            encoding="utf-8",
            errors="replace",  # 非 UTF-8 字节替换掉，而不是炸掉读取线程
            bufsize=1,
            # 给 Python 写的服务器统一 UTF-8 输出（Windows 管道默认用 GBK）
            env={**os.environ, "PYTHONIOENCODING": "utf-8", **(env or {})},
        )
        self.next_id = 0
        self.lock = threading.Lock()  # 第 9 课的子 Agent 可能并发调用

    # ---------- JSON-RPC ----------
    def _send(self, msg):
        self.proc.stdin.write(
            json.dumps(msg, ensure_ascii=False) + "\n"
        )  # 一条消息一行
        self.proc.stdin.flush()

    def request(self, method, params=None):
        with self.lock:
            self.next_id += 1
            rid = self.next_id
            self._send(
                {"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}}
            )
            while True:
                line = self._readline()
                msg = json.loads(line)
                if msg.get("id") != rid:  # 服务器主动发来的通知，这一版先忽略
                    continue
                if "error" in msg:
                    raise MCPError(
                        f"{msg['error'].get('code')}: {msg['error'].get('message')}"
                    )
                return msg["result"]

    def notify(self, method, params=None):
        with self.lock:
            self._send({"jsonrpc": "2.0", "method": method, "params": params or {}})

    def _readline(self):
        result = []
        t = threading.Thread(target=lambda: result.append(self.proc.stdout.readline()))
        t.start()
        t.join(TIMEOUT)
        if not result or not result[0]:
            raise MCPError(f"MCP 服务器 {self.name} 没有响应或已退出")
        return result[0]

    # ---------- MCP ----------
    def initialize(self):
        info = self.request(
            "initialize",
            {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "nami-agent", "version": "0.8"},
            },
        )
        self.notify("notifications/initialized")
        return info

    def list_tools(self):
        tools, cursor = [], None
        while True:  # 工具多时会分页
            result = self.request("tools/list", {"cursor": cursor} if cursor else {})
            tools += result.get("tools", [])
            cursor = result.get("nextCursor")
            if not cursor:
                return tools

    def call_tool(self, tool, arguments):
        result = self.request("tools/call", {"name": tool, "arguments": arguments})
        parts = []
        for block in result.get("content", []):
            if block.get("type") == "text":
                parts.append(block["text"])
            else:  # 图片、音频等，这一版只告诉模型有这么个东西
                parts.append(f"[{block.get('type')} 内容，已省略]")
        text = "\n".join(parts) or "(空结果)"
        return f"Error: {text}" if result.get("isError") else text

    def close(self):
        try:
            self.proc.stdin.close()  # 规范建议：先关输入流，让服务器自己退出
            self.proc.wait(timeout=3)
        except Exception:  # noqa: BLE001
            self.proc.kill()


SERVERS = {}


def register_server(server, safe=()):
    """把一个服务器的全部工具注册成 mcp__服务器__工具。"""
    for t in server.list_tools():
        full = f"mcp__{server.name}__{t['name']}"
        desc = (t.get("description") or "")[:1000]  # 描述也是提示词，限个长度
        TOOLS[full] = {
            "schema": {
                "type": "function",
                "function": {
                    "name": full,
                    "description": f"[MCP:{server.name}] {desc}",
                    "parameters": t.get("inputSchema")
                    or {"type": "object", "properties": {}},
                },
            },
            "func": lambda _s=server, _t=t["name"], **args: _s.call_tool(_t, args),
        }
        # 默认不登记风险 = 按 CONFIRM 处理；只有配置里点名的工具才算只读
        if t["name"] in safe:
            TOOL_RISK[full] = Risk.SAFE
    SERVERS[server.name] = server


def load_servers(config_file=CONFIG_FILE, log=print):
    """读取 ~/.nami-agent/mcp.json，启动并注册里面的每个服务器。"""
    if not config_file.exists():
        return
    try:
        config = json.loads(config_file.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        # 配置坏了只提示，不崩：Windows 路径要写成 D:/x/y 或 D:\\x\\y
        log(f"[MCP] 配置文件 {config_file} 解析失败（{e}），本次跳过所有 MCP 服务器")
        return
    for name, spec in config.get("servers", {}).items():
        try:
            s = MCPServer(name, spec["command"], spec.get("args", []), spec.get("env"))
            s.initialize()
            register_server(s, safe=set(spec.get("safe_tools", [])))
            log(
                f"[MCP] {name}：已接入 {sum(k.startswith(f'mcp__{name}__') for k in TOOLS)} 个工具"
            )
        except Exception as e:  # 一个服务器起不来，不影响其他的  # noqa: BLE001
            log(f"[MCP] {name} 启动失败：{e}")


def close_all():
    for s in SERVERS.values():
        s.close()
    SERVERS.clear()
