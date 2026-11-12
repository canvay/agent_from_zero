import os
import re
import sys
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from textwrap import indent

# Agent 只允许碰这个目录。默认是启动时的当前目录。
WORKSPACE = Path(os.environ.get("NAMI_WORKSPACE", os.getcwd())).resolve()

# 允许"本次会话一直允许"的工具。run_shell 不在里面：每条命令都要过目。
REMEMBERABLE = {"write_file"}

# 明显的灾难性命令。注意：这是安全带，不是边界（见文章第八节）。
SHELL_DENY_PATTERNS = [
    r"\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(/|~|\*)",  # rm -rf / ~ *
    r"\bsudo\b",
    r"\bmkfs\b",
    r"\bdd\s+if=",
    r":\(\)\s*\{",  # fork bomb
    r"(curl|wget)\b.*\|\s*(sh|bash)\b",  # curl ... | sh
    r">\s*/dev/sd",
]

SKILLS_DIR = WORKSPACE / "skills"


class Risk(Enum):
    SAFE = "safe"  # 只读：直接放行
    CONFIRM = "confirm"  # 有副作用：问人
    DENY = "deny"  # 永远不允许


# 工具风险登记表。没登记的工具一律按 CONFIRM 处理。
TOOL_RISK = {
    "list_dir": Risk.SAFE,
    "read_file": Risk.SAFE,
    "write_file": Risk.CONFIRM,
    "run_shell": Risk.CONFIRM,
    "fetch_url": Risk.CONFIRM,
    "load_skill": Risk.SAFE,  # 只读，直接放行
    "list_tasks": Risk.SAFE,
    "schedule_task": Risk.CONFIRM,
    "cancel_task": Risk.CONFIRM,
}


def resolve_in_workspace(path_str: str) -> Path | None:
    """把路径解析成绝对路径；不在工作区内返回 None。
    resolve() 会展开 .. 和符号链接，所以 ../../etc/passwd 和指向外部的软链接都会被识别。"""
    p = Path(path_str).expanduser()
    if not p.is_absolute():
        p = WORKSPACE / p
    p = p.resolve()
    return p if p.is_relative_to(WORKSPACE) else None


def render_call(name: str, args: dict, max_chars: int = 400) -> str:
    """确认界面：展示将要执行的真实内容，而不是模型的自述。"""
    if name == "run_shell":
        return f"  $ {args.get('command', '')}"
    if name == "write_file":
        content = args.get("content", "")
        preview = content[:max_chars]
        if len(content) > max_chars:
            preview += f"\n...（已截断，共 {len(content)} 字符）"
        return f"  路径：{args.get('path')}\n" + indent(preview, "    ")
    return f"  {args}"


@dataclass
class Decision:
    allowed: bool
    reason: str = ""


class PermissionManager:
    def __init__(self, ask=None):
        self.always_allowed: set[str] = set()
        # ask 可注入：ask(name, args) -> ("y" | "n" | "a", 拒绝原因)
        # 第 3 课用它方便测试，第 6、7 课会换成聊天确认和无人值守的预授权
        self.ask = ask or self._ask_terminal

    def check(self, name: str, args: dict) -> Decision:
        # 第 1 关：硬规则，人也无法放行
        reason = self._hard_limits(name, args)
        if reason:
            return Decision(False, reason)
        # 第 2 关：风险分级
        risk = TOOL_RISK.get(name, Risk.CONFIRM)
        if risk is Risk.DENY:
            return Decision(False, f"工具 {name} 被策略禁用。")
        if risk is Risk.SAFE or name in self.always_allowed:
            return Decision(True)

        # 第 3 关：人工确认
        return self._confirm(name, args)

    def _hard_limits(self, name: str, args: dict) -> str | None:
        if name in ("read_file", "write_file", "list_dir"):
            path = args.get("path", ".")
            p = resolve_in_workspace(path)
            if p is None:
                return f"路径 {path!r} 在工作区 {WORKSPACE} 之外，禁止访问。"
            if name == "write_file" and p.is_relative_to(SKILLS_DIR):
                return "技能目录是只读的，Agent 不能修改自己的技能。"
        if name == "run_shell":
            cmd = args.get("command", "")
            for pat in SHELL_DENY_PATTERNS:
                if re.search(pat, cmd):
                    return f"命令命中危险模式，已被策略拦截：{cmd!r}"
        return None

    def _confirm(self, name: str, args: dict) -> Decision:
        answer, note = self.ask(name, args)
        if answer == "a" and name in REMEMBERABLE:
            self.always_allowed.add(name)
            return Decision(True)
        if answer in ("y", "a"):
            return Decision(True)
        msg = "用户拒绝了这次操作。"
        if note:
            msg += f"原因：{note}。"
        msg += "不要重试同一操作；请换一种方式，或向用户说明你想做什么、为什么。"
        return Decision(False, msg)

    @staticmethod
    def _ask_terminal(name: str, args: dict):
        if not sys.stdin.isatty():
            # 非交互环境（管道、脚本）没有人可以确认，默认拒绝
            return "n", "当前是非交互环境，无法确认"
        print(f"\n⚠️  Agent 想执行：{name}")
        print(render_call(name, args))
        options = "[y]允许 / [n]拒绝" + (
            " / [a]本次会话一直允许" if name in REMEMBERABLE else ""
        )
        while True:
            ans = input(f"{options} > ").strip().lower()
            if ans in ("y", "n") or (ans == "a" and name in REMEMBERABLE):
                break
        note = input("拒绝原因（可选，回车跳过）> ").strip() if ans == "n" else ""
        return ans, note
