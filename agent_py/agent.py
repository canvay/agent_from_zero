# agent核心能力第1步：能调用大模型

import os
import sys

from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()

client = OpenAI(api_key=os.environ["API_KEY"], base_url=os.environ["BASE_URL"])
MODEL = os.environ["MODEL"]
SYSTEM = (
    "你是一个能操作本地文件和命令行的编程助手。"
    "需要时调用工具，完成任务后直接用文字总结，不要再调用工具。"
)


# agent循环
def run(task: str) -> None:
    resp = client.chat.completions.create(
        model=MODEL,
        messages=[
            # {"role": "system", "content": SYSTEM},
            {"role": "user", "content": task},
        ],
    )
    msg = resp.choices[0].message
    print(f"{msg.content}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit('用法：python agent.py "你的任务"')
    run(sys.argv[1])
