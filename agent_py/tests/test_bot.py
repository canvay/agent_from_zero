import json

import agent
import bot
from fake import FakeChannel, FakeClient, tool_call
from permissions import WORKSPACE


# ---------- 主循环 ----------
def test_run_loop_pairs_tool_messages():
    (WORKSPACE/"a.txt").write_text("hello")
    c = FakeClient([[tool_call("c1", "read_file", {"path": "a.txt"})], "内容是 hello"])
    s = agent.Session("t1", ask=lambda n, a: ("n", ""), persist=False)
    assert agent.run(s, "读 a.txt", c, log=lambda *_: None) == "内容是 hello"
    roles = [m["role"] for m in s.messages]
    assert roles == ["system", "user", "assistant", "tool", "assistant"]
    assert s.messages[3]["tool_call_id"] == "c1" and s.messages[3]["content"] == "hello"
    json.dumps(s.messages)   # 能序列化

# ---------- 第6课 ----------
def test_chat_ask_with_reason_and_buffer():
    ch = FakeChannel([(1, 1, "顺便问个问题"), (2, 2, "别的人"), (1, 1, "n 先列出来")])
    ask = bot.make_chat_ask(ch, 1, wait=5)
    assert ask("run_shell", {"command": "rm a"}) == ("n", "先列出来")
    assert ch.pending == [(1, 1, "顺便问个问题"), (2, 2, "别的人")]
    assert "a 本会话一直允许" not in ch.sent[0][1]

def test_chat_ask_timeout():
    ask = bot.make_chat_ask(FakeChannel(), 1, wait=1)
    assert ask("run_shell", {"command": "ls"}) == ("n", "确认超时")

def test_allowlist_and_rollback(monkeypatch):
    monkeypatch.setattr(bot, "ALLOWED", {7})
    ch = FakeChannel(); sessions = {}
    bot.handle_message(ch, FakeClient([]), sessions, 9, 9, "hi")
    assert ch.sent == [] and sessions == {}
    class Boom(FakeClient):
        def create(self, **kw):
            if self.script: return super().create(**kw)
            raise ConnectionError("断网")
    c = Boom([[tool_call("c1", "list_dir", {"path": "."})]])
    bot.handle_message(ch, c, sessions, 7, 7, "列目录")
    assert "已撤销" in ch.sent[-1][1]
    assert [m["role"] for m in sessions[7].messages] == ["system"]
