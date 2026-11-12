# agent核心能力第1步：能调用大模型

import json
import os

import skills  # 导入即注册 load_skill
from context import (
    clear_old_tool_results,
    compact,
    load_session,
    save_session,
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
def run(user_input: str, messages) -> None:
    messages.append({"role": "user", "content": user_input})
    for step in range(MAX_STEPS):
        # 用上一次调用的真实 token 数，决定这一轮要不要处理
        if usage["prompt_tokens"] > HARD_LIMIT:
            messages[:] = compact(client, MODEL, messages)
        elif usage["prompt_tokens"] > SOFT_LIMIT:
            clear_old_tool_results(messages)

        resp = client.chat.completions.create(
            model=MODEL, messages=messages, tools=get_schemas()
        )
        usage["prompt_tokens"] = resp.usage.prompt_tokens if resp.usage else 0
        print(f"   [prompt_tokens={usage['prompt_tokens']}]")
        msg = resp.choices[0].message
        messages.append(msg.model_dump(exclude_none=True))
        if not msg.tool_calls:
            return msg.content
        for call in msg.tool_calls:
            result = handle_call(call, perms)
            messages.append(
                {"role": "tool", "tool_call_id": call.id, "content": result}
            )

    return f"\n[达到 {MAX_STEPS} 步上限，已停止]"


if __name__ == "__main__":
    messages = load_session("default") or [{"role": "system", "content": ""}]
    messages[0] = {"role": "system", "content": build_system()}  # 每次用最新的技能列表

    while True:
        q = input("你> ").strip()
        if q in ("exit", "quit"):
            break
        print("\n" + run(q, messages) + "\n")
        save_session("default", messages)
