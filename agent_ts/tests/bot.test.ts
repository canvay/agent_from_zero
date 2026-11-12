// tests/bot.test.ts —— 对应 agent_py/tests/test_bot.py
import fs from "node:fs";
import path from "node:path";
import type OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { Session, run } from "../agent";
import { ALLOWED, handleMessage, makeChatAsk } from "../bot";
import { WORKSPACE } from "../permissions";
import { FakeChannel, FakeClient, toolCall } from "./fake";

// ---------- 主循环 ----------
describe("run loop", () => {
  it("run_loop_pairs_tool_messages", async () => {
    fs.writeFileSync(path.join(WORKSPACE, "a.txt"), "hello");
    const c = new FakeClient([[toolCall("c1", "read_file", { path: "a.txt" })], "内容是 hello"]);
    const s = new Session("t1", async () => ["n", ""], false);
    const reply = await run(s, "读 a.txt", c as unknown as OpenAI, "", () => {});
    expect(reply).toBe("内容是 hello");
    const roles = s.messages.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "tool", "assistant"]);
    expect(s.messages[3]).toMatchObject({ tool_call_id: "c1", content: "hello" });
    expect(() => JSON.stringify(s.messages)).not.toThrow(); // 能序列化
  });
});

// ---------- 第 6 课 ----------
describe("chat ask", () => {
  it("chat_ask_with_reason_and_buffer", async () => {
    const ch = new FakeChannel([
      [1, 1, "顺便问个问题"],
      [2, 2, "别的人"],
      [1, 1, "n 先列出来"],
    ]);
    const ask = makeChatAsk(ch, 1, 5);
    expect(await ask("run_shell", { command: "rm a" })).toEqual(["n", "先列出来"]);
    expect(ch.pending).toEqual([
      [1, 1, "顺便问个问题"],
      [2, 2, "别的人"],
    ]);
    expect(ch.sent[0][1]).not.toContain("a 本会话一直允许");
  });

  it("chat_ask_timeout", async () => {
    const ask = makeChatAsk(new FakeChannel(), 1, 1);
    expect(await ask("run_shell", { command: "ls" })).toEqual(["n", "确认超时"]);
  });
});

describe("allowlist and rollback", () => {
  it("allowlist_and_rollback", async () => {
    ALLOWED.clear();
    ALLOWED.add(7);
    const ch = new FakeChannel();
    const sessions = new Map<number, Session>();
    await handleMessage(ch, new FakeClient([]) as unknown as OpenAI, sessions, 9, 9, "hi");
    expect(ch.sent).toEqual([]);
    expect(sessions.size).toBe(0);

    class Boom extends FakeClient {
      create(p: any) {
        if (this.script.length) return super.create(p);
        throw new Error("断网");
      }
    }
    const c = new Boom([[toolCall("c1", "list_dir", { path: "." })]]);
    await handleMessage(ch, c as unknown as OpenAI, sessions, 7, 7, "列目录");
    expect(ch.sent[ch.sent.length - 1][1]).toContain("已撤销");
    expect(sessions.get(7)!.messages.map((m) => m.role)).toEqual(["system"]);
  });
});
