// context.ts —— 对应 Python 版 context.py：工具结果清理、对话压缩、会话持久化
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

export const MAX_TOOL_CHARS = 4000; // 单个工具结果最多保留的字符数
export const KEEP_RECENT_TOOL_RESULTS = 3; // 清理时，保留最近几条工具结果
export const KEEP_LAST_TURNS = 2; // 压缩时，原样保留最近几轮用户对话

// 程序自己的状态（会话记录、后面的定时任务）放在工作区之外，Agent 的文件工具碰不到
const STATE_DIR =
  process.env.NAMI_STATE_DIR || path.join(os.homedir(), ".nami-agent");
export const SESSION_DIR = path.join(STATE_DIR, "sessions");
export const PLACEHOLDER = "[旧工具结果已清理，如需要请重新调用工具]";

const SUMMARY_PROMPT = `你是对话摘要器。把下面这段 Agent 的历史对话压缩成摘要，要求：
1. 保留：用户的目标、已完成的步骤、关键结论、重要的文件路径和参数、尚未解决的问题
2. 丢弃：寒暄、重复内容、工具返回的大段原文
3. 用简洁的条目写，不要超过 500 字
只输出摘要本身。`;

/** 超长工具结果掐头留尾（Python 版 truncate_tool_result） */
export function truncateToolResult(text: string, limit = MAX_TOOL_CHARS): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${text.slice(0, half)}\n...[中间省略 ${text.length - limit} 字符]...\n${text.slice(-half)}`;
}

/** 就地把旧工具结果替换为占位符，保留最近 keep 条 */
export function clearOldToolResults(
  messages: ChatCompletionMessageParam[],
  keep = KEEP_RECENT_TOOL_RESULTS,
): void {
  const toolIdx = messages
    .map((m, i) => (m.role === "tool" ? i : -1))
    .filter((i) => i >= 0);
  const old = keep > 0 ? toolIdx.slice(0, -keep) : toolIdx;
  for (const i of old) {
    (messages[i] as { content: string }).content = PLACEHOLDER;
  }
}

/** 返回 [要被压缩的旧消息, 原样保留的新消息]；没有可压缩的内容返回 null。
 *  约定 messages[0] 是 system。 */
export function splitForCompact(
  messages: ChatCompletionMessageParam[],
  keepTurns = KEEP_LAST_TURNS,
): [ChatCompletionMessageParam[], ChatCompletionMessageParam[]] | null {
  const userIdx = messages
    .map((m, i) => (m.role === "user" ? i : -1))
    .filter((i) => i >= 0);
  if (userIdx.length <= keepTurns) return null;
  const cut = userIdx[userIdx.length - keepTurns];
  return [messages.slice(1, cut), messages.slice(cut)];
}

/** 把待压缩的旧消息渲染成摘要器能读的纯文本 */
export function renderForSummary(msgs: ChatCompletionMessageParam[]): string {
  const lines: string[] = [];
  for (const m of msgs) {
    if (m.role === "assistant" && m.tool_calls?.length) {
      // SDK v6 对自定义网关返回联合类型，只渲染标准 function 调用
      const calls = m.tool_calls
        .filter((c) => "function" in c)
        .map((c) => `${c.function.name}(${c.function.arguments})`)
        .join(", ");
      if (m.content) lines.push(`[assistant] ${m.content}`);
      lines.push(`[assistant 调用工具] ${calls}`);
    } else {
      lines.push(`[${m.role}] ${(m as { content?: string }).content ?? ""}`);
    }
  }
  return lines.join("\n");
}

/** 调模型把旧消息压成摘要，返回新的消息数组（对应 Python 版 compact） */
export async function compact(
  client: OpenAI,
  model: string,
  messages: ChatCompletionMessageParam[],
): Promise<ChatCompletionMessageParam[]> {
  const parts = splitForCompact(messages);
  if (!parts) return messages;
  const [old, recent] = parts;
  const resp = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: SUMMARY_PROMPT },
      { role: "user", content: renderForSummary(old) },
    ],
  });
  const summary = resp.choices[0].message.content ?? "";
  return [
    messages[0],
    { role: "user", content: `[以下是此前对话的摘要]\n${summary}` },
    { role: "assistant", content: "好的，我已了解之前的进展，继续。" },
    ...recent,
  ];
}

export function saveSession(name: string, messages: ChatCompletionMessageParam[]): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(SESSION_DIR, `${name}.json`),
    JSON.stringify(messages, null, 2),
    "utf-8",
  );
}

export function loadSession(name: string): ChatCompletionMessageParam[] | null {
  const file = path.join(SESSION_DIR, `${name}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf-8")) as ChatCompletionMessageParam[];
}
