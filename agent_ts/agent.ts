// agent 核心能力第 1 步：能调用大模型

import "dotenv/config";
import * as readline from "node:readline/promises";
import { pathToFileURL } from "node:url";
import OpenAI from "openai";
import type {
  ChatCompletionMessage,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { projectNotes, skillsSection } from "./skills"; // 导入即注册 load_skill
import {
  clearOldToolResults,
  compact,
  loadSession,
  saveSession,
  truncateToolResult,
} from "./context";
import { PermissionManager, getSharedRl, type Ask } from "./permissions";
import { execute, getSchemas } from "./tools";

const BASE_SYSTEM =
  "你是一个能使用工具的助手，在用户的工作区内完成任务。" +
  "必要时调用工具，完成后用简洁的语言汇报结果。";

const SOFT_LIMIT = 16000; // 超过：清理旧工具结果
const HARD_LIMIT = 24000; // 超过：摘要压缩
// 这两个是演示用的小值，方便你复现。实际按模型窗口的比例来设。
const MAX_STEPS = 20; // 防止死循环：Agent 最多转 20 圈
const MODEL = process.env.MODEL ?? "";

export function makeClient(): OpenAI {
  return new OpenAI({ apiKey: process.env.API_KEY, baseURL: process.env.BASE_URL });
}

function buildSystem(): string {
  return BASE_SYSTEM + projectNotes() + skillsSection();
}

/** 一个会话 = 一份 messages + 一个权限管理器 + 上一次的 token 数 */
export class Session {
  name: string;
  persist: boolean;
  messages: ChatCompletionMessageParam[];
  perms: PermissionManager;
  promptTokens = 0;

  constructor(name: string, ask?: Ask, persist = true) {
    this.name = name;
    this.persist = persist;
    const saved = persist ? loadSession(name) : null;
    this.messages = saved ?? [{ role: "system", content: "" }];
    this.messages[0] = { role: "system", content: buildSystem() }; // 每次用最新的技能列表
    this.perms = new PermissionManager(ask);
  }

  save(): void {
    if (this.persist) saveSession(this.name, this.messages);
  }
}

/** 解析参数 → 权限检查 → 执行。永远返回字符串。 */
async function handleCall(
  call: { id: string; function: { name: string; arguments: string } },
  perms: PermissionManager,
): Promise<string> {
  const name = call.function.name;
  let args: Record<string, any>;
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    return "Error: 参数不是合法的 JSON";
  }
  const decision = await perms.check(name, args);
  if (!decision.allowed) {
    return `[权限拒绝] ${decision.reason}`; // 拒绝也要回传，让模型换条路
  }
  return execute(name, args);
}

// ---------- agent 循环 ----------
export async function run(
  session: Session,
  userInput: string,
  client: OpenAI,
  model: string = MODEL,
  log: (msg: string) => void = console.log,
): Promise<string> {
  const messages = session.messages;
  messages.push({ role: "user", content: userInput });
  for (let step = 0; step < MAX_STEPS; step++) {
    // 用上一次调用的真实 token 数，决定这一轮要不要处理
    if (session.promptTokens > HARD_LIMIT) {
      // 对应 Python 的 messages[:] = compact(...)：原地替换内容，保持引用不变
      messages.splice(0, messages.length, ...(await compact(client, model, messages)));
    } else if (session.promptTokens > SOFT_LIMIT) {
      clearOldToolResults(messages);
    }

    const resp = await client.chat.completions.create({
      model,
      messages,
      tools: getSchemas(),
    });
    session.promptTokens = resp.usage?.prompt_tokens ?? 0;
    // SDK v6 对自定义网关会返回联合类型，这里收窄为标准消息类型
    const msg = resp.choices[0].message as ChatCompletionMessage;

    // 对应 Python 版的 model_dump(exclude_none=True)：
    // 去掉值为 null 的字段（如未调用工具时的 tool_calls），API 才能接受
    messages.push(
      JSON.parse(JSON.stringify(msg, (_, v) => (v === null ? undefined : v))),
    );

    if (!msg.tool_calls?.length) return msg.content ?? "";

    for (const call of msg.tool_calls) {
      if (!("function" in call)) continue; // 跳过非标准工具调用
      log(`🔧 ${call.function.name}(${call.function.arguments.slice(0, 80)})`);
      const result = await handleCall(call, session.perms);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: truncateToolResult(result),
      });
    }
  }
  return "（达到最大步数，已停止）";
}

// ---------- 交互式 REPL ----------
async function main(): Promise<void> {
  const client = makeClient();
  const session = new Session("default"); // ask 不传，默认还是终端确认
  const rl = getSharedRl();
  // stdin 结束（EOF / Ctrl+Z）时干净退出：挂起的 question 永远不会 resolve，
  // 不处理会触发 Node 的 "unsettled top-level await"（exit code 13）
  rl.on("close", () => process.exit(0));
  while (true) {
    let q: string;
    try {
      q = (await rl.question("你> ")).trim();
    } catch {
      break; // question 被中断（如 Ctrl+C），退出而不是崩掉
    }
    if (q === "exit" || q === "quit") break;
    console.log("\n" + (await run(session, q, client)) + "\n");
    session.save();
  }
  rl.close();
}

// 对应 Python 的 if __name__ == "__main__"：直接运行才启动 REPL，被测试导入时不启动
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
