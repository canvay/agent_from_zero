"""bot.py —— 第 6 课：常驻的 Agent"""

import os
import sys
import time

import scheduler
from agent import Session, make_client, run
from context import SESSION_DIR
from permissions import REMEMBERABLE, render_call
from telegram import Telegram

ALLOWED = {
    int(x) for x in os.environ.get("TG_ALLOWED_USERS", "").split(",") if x.strip()
}
CONFIRM_WAIT = 120
POLL_TIMEOUT = 10  # 给调度器留出检查的机会


def make_chat_ask(channel, chat_id, wait=CONFIRM_WAIT):
    def ask(name, args):
        opts = "y 允许 / n 拒绝（可附原因，如：n 先列出来给我看）"
        if name in REMEMBERABLE:
            opts += " / a 本会话一直允许"
        channel.send(
            chat_id,
            f"⚠️ Agent 想执行：{name}\n{render_call(name, args)}\n\n"
            f"回复 {opts}\n{wait} 秒内不回复视为拒绝。",
        )
        deadline = time.time() + wait
        while time.time() < deadline:
            left = max(1, int(deadline - time.time()))
            for c, u, text in channel.fetch(timeout=min(20, left)):
                ans, _, note = text.strip().partition(" ")
                if c == chat_id and ans.lower() in ("y", "n", "a"):
                    return ans.lower(), note.strip()
                channel.pending.append((c, u, text))
        return "n", "确认超时"

    return ask


def handle_message(tg, client, sessions, chat_id, user_id, text):
    if user_id not in ALLOWED:
        print(f"[忽略] 非白名单用户 {user_id}")
        return
    cmd = text.strip()
    if cmd == "/reset":
        sessions.pop(chat_id, None)
        (SESSION_DIR / f"tg-{chat_id}.json").unlink(missing_ok=True)
        tg.send(chat_id, "会话已重置。")
        return
    if cmd == "/tasks":
        tg.send(
            chat_id,
            scheduler.format_tasks(
                [t for t in scheduler.get_scheduler().tasks if t["chat_id"] == chat_id]
            ),
        )
        return

    s = sessions.get(chat_id)
    if s is None:
        s = sessions[chat_id] = Session(f"tg-{chat_id}", ask=make_chat_ask(tg, chat_id))
    backup = list(s.messages)
    scheduler.CURRENT["chat_id"] = chat_id
    try:
        reply = run(s, text, client)
    except Exception as e:  # noqa: BLE001
        s.messages[:] = backup
        reply = f"[出错，本轮已撤销] {type(e).__name__}: {e}"
    finally:
        scheduler.CURRENT["chat_id"] = None
    s.save()
    tg.send(chat_id, reply)


def run_due_tasks(tg, client):
    sched = scheduler.get_scheduler()
    for task in sched.due():
        sched.mark_started(task)  # 先记下一次，再执行：任务崩了也不会反复重跑
        s = Session(
            f"task-{task['id']}", ask=scheduler.make_task_ask(task), persist=False
        )
        try:
            reply = run(s, scheduler.task_input(task), client)
        except Exception as e:  # noqa: BLE001
            reply = f"[定时任务出错] {type(e).__name__}: {e}"
        if task["kind"] == "heartbeat" and reply.strip() == scheduler.HEARTBEAT_OK:
            print(f"[心跳] {task['id']} 无事")
            continue
        tg.send(task["chat_id"], f"⏰ 任务 {task['id']}\n{reply}")


def main():
    if not ALLOWED:
        sys.exit(
            "必须设置 TG_ALLOWED_USERS（逗号分隔的 Telegram 用户 ID），否则任何人都能操作你的电脑。"
        )

    tg = Telegram(os.environ["TG_BOT_TOKEN"], timeout=POLL_TIMEOUT)
    client = make_client()
    sessions = {}
    print("nami-agent 已启动")
    while True:
        try:
            batch = tg.poll()
        except Exception as e:  # noqa: BLE001
            print(f"[轮询出错] {e}，5 秒后重试")
            time.sleep(5)
            continue
        for chat_id, user_id, text in batch:
            try:
                handle_message(tg, client, sessions, chat_id, user_id, text)
            except Exception as e:  # noqa: BLE001
                # 单条消息失败不能拖垮常驻进程：记日志，继续处理后面的
                print(f"[处理消息出错] chat={chat_id} {type(e).__name__}: {e}")
        run_due_tasks(tg, client)


if __name__ == "__main__":
    main()
