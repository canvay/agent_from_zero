// 对应 agent_py/tests/test_context.py
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { describe, expect, it } from "vitest";
import {
  PLACEHOLDER,
  SESSION_DIR,
  clearOldToolResults,
  loadSession,
  saveSession,
  splitForCompact,
  truncateToolResult,
} from "../context";

type Msg = ChatCompletionMessageParam;

/** 每条 tool 消息，前面必须有声明了该 tool_call_id 的 assistant 消息 */
function checkPairing(messages: Msg[]) {
  const declared = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant") {
      for (const c of m.tool_calls ?? []) declared.add(c.id);
    }
    if (m.role === "tool") {
      expect(declared.has(m.tool_call_id), `孤立的 tool 消息: ${m.tool_call_id}`).toBe(true);
    }
  }
}

function fakeTurn(i: number): Msg[] {
  return [
    { role: "user", content: `任务 ${i}` },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: `c${i}`,
          type: "function",
          function: { name: "read_file", arguments: '{"path": "a"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: `c${i}`, content: "x".repeat(100) },
    { role: "assistant", content: `完成 ${i}` },
  ] as unknown as Msg[];
}

describe("context", () => {
  it("truncate", () => {
    const out = truncateToolResult("x".repeat(10000));
    expect(out.length).toBeLessThan(4200);
    expect(out).toContain("省略");
    expect(truncateToolResult("short")).toBe("short");
  });

  it("clear_only_changes_content", () => {
    const msgs: Msg[] = [{ role: "system", content: "" }];
    for (let i = 0; i < 5; i++) msgs.push(...fakeTurn(i));
    const n = msgs.length;
    clearOldToolResults(msgs, 1);
    expect(msgs.length).toBe(n); // 一条都没删
    const tools = msgs
      .filter((m) => m.role === "tool")
      .map((m) => (m as { content: string }).content);
    expect(tools.slice(0, -1)).toEqual(Array(4).fill(PLACEHOLDER));
    expect(tools.at(-1)).toBe("x".repeat(100));
    checkPairing(msgs);
  });

  it("split_keeps_pairs", () => {
    const msgs: Msg[] = [{ role: "system", content: "" }];
    for (let i = 0; i < 4; i++) msgs.push(...fakeTurn(i));
    const [old, recent] = splitForCompact(msgs, 2)!;
    expect(recent[0]).toEqual({ role: "user", content: "任务 2" });
    checkPairing([msgs[0], ...recent]);
    expect(splitForCompact(msgs.slice(0, 5), 2)).toBeNull(); // 只有一轮，不压缩
  });

  it("session_roundtrip", () => {
    const msgs: Msg[] = [
      { role: "system", content: "s" },
      { role: "user", content: "你好" },
    ];
    saveSession("t", msgs);
    expect(loadSession("t")).toEqual(msgs);
    expect(loadSession("不存在")).toBeNull();
    // 会话文件不在工作区里，Agent 的 read_file 读不到
    expect(SESSION_DIR.startsWith(process.env.NAMI_WORKSPACE ?? "")).toBe(false);
  });
});
