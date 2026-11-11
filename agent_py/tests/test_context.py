import context
from context import clear_old_tool_results, split_for_compact, truncate_tool_result


def check_pairing(messages):
    """每条 tool 消息，前面必须有声明了该 tool_call_id 的 assistant 消息"""
    declared = set()
    for m in messages:
        if m["role"] == "assistant":
            for c in m.get("tool_calls") or []:
                declared.add(c["id"])
        if m["role"] == "tool":
            assert m["tool_call_id"] in declared, (
                f"孤立的 tool 消息: {m['tool_call_id']}"
            )


def fake_turn(i):
    return [
        {"role": "user", "content": f"任务 {i}"},
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": f"c{i}",
                    "type": "function",
                    "function": {"name": "read_file", "arguments": '{"path": "a"}'},
                }
            ],
        },
        {"role": "tool", "tool_call_id": f"c{i}", "content": "x" * 100},
        {"role": "assistant", "content": f"完成 {i}"},
    ]


def test_truncate():
    out = truncate_tool_result("x" * 10000)
    assert len(out) < 4200 and "省略" in out
    assert truncate_tool_result("short") == "short"


def test_clear_only_changes_content():
    msgs = [{"role": "system", "content": ""}]
    for i in range(5):
        msgs += fake_turn(i)
    n = len(msgs)
    clear_old_tool_results(msgs, keep=1)
    assert len(msgs) == n  # 一条都没删
    tools = [m["content"] for m in msgs if m["role"] == "tool"]
    assert tools[:-1] == [context.PLACEHOLDER] * 4 and tools[-1] == "x" * 100
    check_pairing(msgs)


def test_split_keeps_pairs():
    msgs = [{"role": "system", "content": ""}]
    for i in range(4):
        msgs += fake_turn(i)
    old, recent = split_for_compact(msgs, keep_turns=2)
    assert recent[0] == {"role": "user", "content": "任务 2"}
    check_pairing([msgs[0]] + recent)
    assert split_for_compact(msgs[:5], keep_turns=2) is None  # 只有一轮，不压缩


def test_session_roundtrip():
    msgs = [{"role": "system", "content": "s"}, {"role": "user", "content": "你好"}]
    context.save_session("t", msgs)
    assert context.load_session("t") == msgs
    assert context.load_session("不存在") is None
    # 会话文件不在工作区里，Agent 的 read_file 读不到
    assert not str(context.SESSION_DIR).startswith(
        __import__("os").environ["NAMI_WORKSPACE"]
    )
