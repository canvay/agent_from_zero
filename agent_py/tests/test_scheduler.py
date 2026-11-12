import json
from datetime import datetime, timedelta

import pytest
from fake import FakeClient, FakeChannel, tool_call

from permissions import WORKSPACE, PermissionManager
import bot
import scheduler


# ---------- 第7课 ----------
def test_next_run():
    t = datetime(2026, 10, 28, 10, 0)
    assert scheduler.next_run("every 30m", t) == t + timedelta(minutes=30)
    assert scheduler.next_run("every 2h", t) == t + timedelta(hours=2)
    assert scheduler.next_run("daily 09:00", t) == datetime(2026, 10, 29, 9, 0)
    assert scheduler.next_run("daily 11:30", t) == datetime(2026, 10, 28, 11, 30)
    for bad in ("every 1m", "daily 25:00", "每天九点"):
        with pytest.raises(ValueError):
            scheduler.next_run(bad, t)


def test_no_catch_up_and_preauth(tmp_path):
    now = [datetime(2026, 10, 28, 8, 0)]
    s = scheduler.Scheduler(tmp_path / "t.json", now=lambda: now[0])
    task = s.add("every 1h", "看看", chat_id=1, allow={"fetch_url"})
    with pytest.raises(ValueError):
        s.add("every 1h", "x", 1, allow={"run_shell"})
    now[0] = datetime(2026, 10, 28, 13, 5)  # 停机 5 小时
    assert len(s.due()) == 1
    s.mark_started(task)
    assert s.due() == [] and task["next_run"] == "2026-10-28T14:05:00"
    assert scheduler.Scheduler(tmp_path / "t.json").tasks[0]["id"] == task["id"]


def test_task_cannot_schedule_tasks_or_shell():
    ask = scheduler.make_task_ask({"allow": ["fetch_url"]})
    pm = PermissionManager(ask=ask)
    assert pm.check("fetch_url", {"url": "https://x"}).allowed
    assert not pm.check("run_shell", {"command": "ls"}).allowed
    assert not pm.check("schedule_task", {"spec": "every 5m", "prompt": "x"}).allowed
    assert pm.check("read_file", {"path": "a.txt"}).allowed


def test_heartbeat_silent(tmp_path, monkeypatch):
    s = scheduler.Scheduler(tmp_path / "h.json", now=lambda: datetime(2026, 1, 1))
    monkeypatch.setattr(scheduler, "SCHED", s)
    s.add("every 30m", "看 inbox", 1, kind="heartbeat")
    s.add("every 30m", "报个时", 1)
    for t in s.tasks:
        t["next_run"] = "2000-01-01T00:00:00"
    ch = FakeChannel()
    bot.run_due_tasks(ch, FakeClient([scheduler.HEARTBEAT_OK, "现在是早上"]))
    assert len(ch.sent) == 1 and "现在是早上" in ch.sent[0][1]


def test_schedule_tool_needs_chat(tmp_path, monkeypatch):
    monkeypatch.setattr(scheduler, "SCHED", scheduler.Scheduler(tmp_path / "x.json"))
    assert scheduler.schedule_task("every 1h", "x").startswith("Error")
    scheduler.CURRENT["chat_id"] = 5
    try:
        assert "已创建任务" in scheduler.schedule_task(
            "daily 09:00", "早报", allow="fetch_url"
        )
        assert "早报" in scheduler.list_tasks()
        assert scheduler.schedule_task("every 1h", "x", allow="run_shell").startswith(
            "Error"
        )
    finally:
        scheduler.CURRENT["chat_id"] = None
