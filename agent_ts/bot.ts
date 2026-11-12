// bot.ts —— 第 6 课：常驻的 Agent（Telegram 渠道）
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type OpenAI from "openai";
import { Session, makeClient, run } from "./agent";
import { SESSION_DIR } from "./context";
import { REMEMBERABLE, renderCall, type Ask } from "./permissions";
import { Telegram, type Msg } from "./telegram";

const CONFIRM_WAIT = 120; // 秒

// 允许操作的 Telegram 用户 ID（逗号分隔）。导出为可变 Set，测试里可以改。
export const ALLOWED = new Set<number>(
  (process.env.TG_ALLOWED_USERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number),
);

interface Channel {
  fetch(timeout?: number): Promise<Msg[]>;
  send(chatId: number, text: string): Promise<void>;
  pending: Msg[];
}

export function makeChatAsk(channel: Channel, chatId: number, wait = CONFIRM_WAIT): Ask {
  return async (name, args) => {
    let opts = "y 允许 / n 拒绝（可附原因，如：n 先列出来给我看）";
    if (REMEMBERABLE.has(name)) opts += " / a 本会话一直允许";
    await channel.send(
      chatId,
      `⚠️ Agent 想执行：${name}\n${renderCall(name, args)}\n\n回复 ${opts}\n${wait} 秒内不回复视为拒绝。`,
    );
    const deadline = Date.now() + wait * 1000;
    while (Date.now() < deadline) {
      const left = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
      for (const [c, u, text] of await channel.fetch(Math.min(20, left))) {
        const [ans, ...rest] = text.trim().split(/\s+/);
        if (c === chatId && ["y", "n", "a"].includes(ans.toLowerCase())) {
          return [ans.toLowerCase() as "y" | "n" | "a", rest.join(" ").trim()];
        }
        channel.pending.push([c, u, text]);
      }
    }
    return ["n", "确认超时"];
  };
}

export async function handleMessage(
  tg: Channel,
  client: OpenAI,
  sessions: Map<number, Session>,
  chatId: number,
  userId: number,
  text: string,
): Promise<void> {
  if (!ALLOWED.has(userId)) {
    console.log(`[忽略] 非白名单用户 ${userId}`);
    return;
  }
  if (text.trim() === "/reset") {
    sessions.delete(chatId);
    fs.rmSync(path.join(SESSION_DIR, `tg-${chatId}.json`), { force: true });
    await tg.send(chatId, "会话已重置。");
    return;
  }

  let s = sessions.get(chatId);
  if (!s) {
    s = new Session(`tg-${chatId}`, makeChatAsk(tg, chatId));
    sessions.set(chatId, s);
  }
  const backup = [...s.messages];
  let reply: string;
  try {
    reply = await run(s, text, client);
  } catch (e) {
    s.messages.splice(0, s.messages.length, ...backup); // 回滚，避免留下没有配对的 tool_calls
    reply = `[出错，本轮已撤销] ${(e as Error).name}: ${(e as Error).message}`;
  }
  s.save();
  await tg.send(chatId, reply);
}

export async function main(): Promise<void> {
  if (!ALLOWED.size) {
    console.error(
      "必须设置 TG_ALLOWED_USERS（逗号分隔的 Telegram 用户 ID），否则任何人都能操作你的电脑。",
    );
    process.exit(1);
  }
  const tg = new Telegram(process.env.TG_BOT_TOKEN ?? "");
  const client = makeClient();
  const sessions = new Map<number, Session>();
  console.log("nami-agent 已启动");
  while (true) {
    let batch: Msg[];
    try {
      batch = await tg.poll();
    } catch (e) {
      console.log(`[轮询出错] ${(e as Error).message}，5 秒后重试`);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    for (const [chatId, userId, text] of batch) {
      try {
        await handleMessage(tg, client, sessions, chatId, userId, text);
      } catch (e) {
        // 单条消息失败不能拖垮常驻进程：记日志，继续处理后面的
        console.log(`[处理消息出错] chat=${chatId} ${(e as Error).name}: ${(e as Error).message}`);
      }
    }
  }
}

// 对应 Python 的 if __name__ == "__main__"
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
