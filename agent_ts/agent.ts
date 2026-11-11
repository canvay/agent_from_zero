// agent 核心能力第 1 步：能调用大模型

import "dotenv/config";
import * as readline from "node:readline/promises";
import OpenAI from "openai";
import type {
  ChatCompletionMessage,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import {
  clearOldToolResults,
  compact,
  loadSession,
  saveSession,
} from "./context";
import { PermissionManager, getSharedRl } from "./permissions";
import { execute, getSchemas } from "./tools";

const client = new OpenAI({
  apiKey: process.env.API_KEY,
  baseURL: process.env.BASE_URL,
});
const MODEL = process.env.MODEL ?? "";
const MAX_STEPS = 20; // 防止死循环：Agent 最多转 20 圈
const SOFT_LIMIT = 16000; // 超过：清理旧工具结果
const HARD_LIMIT = 24000; // 超过：摘要压缩
// 这两个是演示用的小值，方便你复现。实际按模型窗口的比例来设。
const SYSTEM =
  "你是一个能操作本地文件和命令行的编程助手。" +
  "需要时调用工具，完成任务后直接用文字总结，不要再调用工具。";

const perms = new PermissionManager();
const usage = { promptTokens: 0 }; // 上一次调用的真实 token 数（第 6 课会收进 Session）

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
async function run(userInput: string, messages: ChatCompletionMessageParam[]): Promise<string> {
  messages.push({ role: "user", content: userInput });
  for (let step = 0; step < MAX_STEPS; step++) {
    // 用上一次调用的真实 token 数，决定这一轮要不要处理
    if (usage.promptTokens > HARD_LIMIT) {
      // 对应 Python 的 messages[:] = compact(...)：原地替换内容，保持引用不变
      messages.splice(0, messages.length, ...(await compact(client, MODEL, messages)));
    } else if (usage.promptTokens > SOFT_LIMIT) {
      clearOldToolResults(messages);
    }

    const resp = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: getSchemas(),
    });
    usage.promptTokens = resp.usage?.prompt_tokens ?? 0;
    console.log(`   [prompt_tokens=${usage.promptTokens}]`);
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
      const result = await handleCall(call, perms);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result,
      });
    }
  }
  return `\n[达到 ${MAX_STEPS} 步上限，已停止]`;
}

// ---------- 交互式 REPL ----------
const rl = getSharedRl();
// stdin 结束（EOF / Ctrl+Z）时干净退出：挂起的 question 永远不会 resolve，
// 不处理会触发 Node 的 "unsettled top-level await"（exit code 13）
rl.on("close", () => process.exit(0));
const messages: ChatCompletionMessageParam[] =
  loadSession("default") ?? [{ role: "system", content: SYSTEM }];
while (true) {
  let q: string;
  try {
    q = (await rl.question("你> ")).trim();
  } catch {
    break; // question 被中断（如 Ctrl+C），退出而不是崩掉
  }
  if (q === "exit" || q === "quit") break;
  console.log("\n" + (await run(q, messages)) + "\n");
  saveSession("default", messages);
}
rl.close();
