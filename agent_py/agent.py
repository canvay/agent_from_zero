# agent核心能力第1步：能调用大模型

import json
import os
import sys

from dotenv import load_dotenv
from openai import OpenAI
from tools import execute, get_schemas

load_dotenv()

client = OpenAI(api_key=os.environ["API_KEY"], base_url=os.environ["BASE_URL"])
MODEL = os.environ["MODEL"]
MAX_STEPS = 20  # 防止死循环：Agent 最多转 20 圈
SYSTEM = (
    "你是一个能操作本地文件和命令行的编程助手。"
    "需要时调用工具，完成任务后直接用文字总结，不要再调用工具。"
)


# agent循环
def run(user_input: str, messages) -> None:
    messages.append({"role": "user", "content": user_input})
    for step in range(MAX_STEPS):
        resp = client.chat.completions.create(
            model=MODEL, messages=messages, tools=get_schemas()
        )
        msg = resp.choices[0].message
        messages.append(msg.model_dump(exclude_none=True))
        if not msg.tool_calls:
            return msg.content
        for call in msg.tool_calls:
            name = call.function.name
            arguments = call.function.arguments
            try:
                args = json.loads(arguments or "{}")
            except json.JSONDecodeError:
                result = "Error: 参数不是合法的 JSON"
            else:
                print(f"🔧 {name}({arguments[:80]})")
                result = execute(name, args)
            messages.append(
                {"role": "tool", "tool_call_id": call.id, "content": result}
            )

    return f"\n[达到 {MAX_STEPS} 步上限，已停止]"


if __name__ == "__main__":
    messages = [{"role": "system", "content": SYSTEM}]
    while True:
        q = input("你> ").strip()
        if q in ("exit", "quit"):
            break
        print("\n" + run(q, messages) + "\n")
