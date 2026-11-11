# context.py
import json
import os
from pathlib import Path

MAX_TOOL_CHARS = 4000  # 单个工具结果最多保留的字符数
KEEP_RECENT_TOOL_RESULTS = 3  # 清理时，保留最近几条工具结果
KEEP_LAST_TURNS = 2  # 压缩时，原样保留最近几轮用户对话

# 程序自己的状态（会话记录、后面的定时任务）放在工作区之外，Agent 的文件工具碰不到
STATE_DIR = Path(os.environ.get("NAMI_STATE_DIR", Path.home() / ".nami-agent"))
SESSION_DIR = STATE_DIR / "sessions"

PLACEHOLDER = "[旧工具结果已清理，如需要请重新调用工具]"

SUMMARY_PROMPT = """你是对话摘要器。把下面这段 Agent 的历史对话压缩成摘要，要求：
1. 保留：用户的目标、已完成的步骤、关键结论、重要的文件路径和参数、尚未解决的问题
2. 丢弃：寒暄、重复内容、工具返回的大段原文
3. 用简洁的条目写，不要超过 500 字
只输出摘要本身。"""


def truncate_tool_result(text, limit=MAX_TOOL_CHARS):
    if len(text) <= limit:
        return text
    half = limit // 2
    return f"{text[:half]}\n...[中间省略 {len(text) - limit} 字符]...\n{text[-half:]}"


def clear_old_tool_results(messages, keep=KEEP_RECENT_TOOL_RESULTS):
    tool_idx = [i for i, m in enumerate(messages) if m["role"] == "tool"]
    old = tool_idx[:-keep] if keep > 0 else tool_idx
    for i in old:
        messages[i]["content"] = PLACEHOLDER


def split_for_compact(messages, keep_turns=KEEP_LAST_TURNS):
    """返回 (要被压缩的旧消息, 原样保留的新消息)；没有可压缩的内容返回 None。
    约定 messages[0] 是 system。"""
    user_idx = [i for i, m in enumerate(messages) if m["role"] == "user"]
    if len(user_idx) <= keep_turns:
        return None
    cut = user_idx[-keep_turns]
    return messages[1:cut], messages[cut:]


def render_for_summary(msgs):
    lines = []
    for m in msgs:
        if m["role"] == "assistant" and m.get("tool_calls"):
            calls = ", ".join(
                f"{c['function']['name']}({c['function']['arguments']})"
                for c in m["tool_calls"]
            )
            if m.get("content"):
                lines.append(f"[assistant] {m['content']}")
            lines.append(f"[assistant 调用工具] {calls}")
        else:
            lines.append(f"[{m['role']}] {m.get('content') or ''}")
    return "\n".join(lines)


def compact(client, model, messages):
    parts = split_for_compact(messages)
    if parts is None:
        return messages
    old, recent = parts
    resp = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": SUMMARY_PROMPT},
            {"role": "user", "content": render_for_summary(old)},
        ],
    )
    summary = resp.choices[0].message.content
    return [
        messages[0],
        {"role": "user", "content": f"[以下是此前对话的摘要]\n{summary}"},
        {"role": "assistant", "content": "好的，我已了解之前的进展，继续。"},
        *recent,
    ]


def save_session(name, messages):
    SESSION_DIR.mkdir(parents=True, exist_ok=True)
    (SESSION_DIR / f"{name}.json").write_text(
        json.dumps(messages, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def load_session(name):
    path = SESSION_DIR / f"{name}.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))
