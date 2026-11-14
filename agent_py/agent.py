# agent核心能力第1步：能调用大模型

import json
import os

import mcp_client
import scheduler  # noqa: F401
import skills  # 导入即注册 load_skill
from context import (
    clear_old_tool_results,
    compact,
    load_session,
    save_session,
    truncate_tool_result,
)
from dotenv import load_dotenv
from openai import OpenAI
from permissions import PermissionManager
from tools import execute, get_schemas

BASE_SYSTEM = (
    "你是一个能使用工具的助手，在用户的工作区内完成任务。"
    "必要时调用工具，完成后用简洁的语言汇报结果。"
)


def build_system():
    return BASE_SYSTEM + skills.project_notes() + skills.skills_section()


load_dotenv()


SOFT_LIMIT = 16000  # 超过：清理旧工具结果
HARD_LIMIT = 24000  # 超过：摘要压缩
# 这两个是演示用的小值，方便你复现。实际按模型窗口的比例来设。

usage = {"prompt_tokens": 0}  # 上一次调用的真实 token 数（第 6 课会收进 Session）

client = OpenAI(api_key=os.environ["API_KEY"], base_url=os.environ["BASE_URL"])
MODEL = os.environ["MODEL"]
MAX_STEPS = 20  # 防止死循环：Agent 最多转 20 圈

perms = PermissionManager()


def make_client():
    return OpenAI(api_key=os.environ["API_KEY"], base_url=os.environ["BASE_URL"])


class Session:
    """一个会话 = 一份 messages + 一个权限管理器 + 上一次的 token 数"""

    def __init__(self, name, ask=None, persist=True):
        self.name = name
        self.persist = persist
        saved = load_session(name) if persist else None
        self.messages = saved or [{"role": "system", "content": ""}]
        self.messages[0] = {
            "role": "system",
            "content": build_system(),
        }  # 每次用最新的技能列表
        self.perms = PermissionManager(ask=ask)
        self.prompt_tokens = 0

    def save(self):
        if self.persist:
            save_session(self.name, self.messages)


def handle_call(call, perms):
    """解析参数 → 权限检查 → 执行。永远返回字符串。"""
    name = call.function.name
    try:
        args = json.loads(call.function.arguments or "{}")
    except json.JSONDecodeError:
        return "Error: 参数不是合法的 JSON"
    decision = perms.check(name, args)
    if not decision.allowed:
        return f"[权限拒绝] {decision.reason}"  # 拒绝也要回传，让模型换条路
    return execute(name, args)


# agent循环
def run(session, user_input, client, model=MODEL, log=print):
    messages = session.messages
    messages.append({"role": "user", "content": user_input})
    for _ in range(MAX_STEPS):
        if session.prompt_tokens > HARD_LIMIT:
            messages[:] = compact(client, model, messages)
        elif session.prompt_tokens > SOFT_LIMIT:
            clear_old_tool_results(messages)

        resp = client.chat.completions.create(
            model=model, messages=messages, tools=get_schemas()
        )
        session.prompt_tokens = resp.usage.prompt_tokens if resp.usage else 0
        msg = resp.choices[0].message
        messages.append(msg.model_dump(exclude_none=True))

        if not msg.tool_calls:
            return msg.content or ""
        for call in msg.tool_calls:
            log(f"🔧 {call.function.name}({call.function.arguments[:80]})")
            result = handle_call(call, session.perms)
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": truncate_tool_result(result),
                }
            )
    return "（达到最大步数，已停止）"


def main():
    client = make_client()
    mcp_client.load_servers()
    session = Session("default")  # ask 不传，默认还是终端确认
    while True:
        q = input("你> ").strip()
        if q in ("exit", "quit"):
            break
        print("\n" + run(session, q, client) + "\n")
        session.save()


if __name__ == "__main__":
    main()
