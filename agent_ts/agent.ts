// agent 核心能力第 1 步：能调用大模型

import "dotenv/config";
import * as readline from "node:readline/promises";
import OpenAI from "openai";
import type {
  ChatCompletionMessage,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { execute, getSchemas } from "./tools.js";

const client = new OpenAI({
  apiKey: process.env.API_KEY,
  baseURL: process.env.BASE_URL,
});
const MODEL = process.env.MODEL ?? "";
const MAX_STEPS = 20; // 防止死循环：Agent 最多转 20 圈
const SYSTEM =
  "你是一个能操作本地文件和命令行的编程助手。" +
  "需要时调用工具，完成任务后直接用文字总结，不要再调用工具。";

// ---------- agent 循环 ----------
async function run(userInput: string, messages: ChatCompletionMessageParam[]): Promise<string> {
  messages.push({ role: "user", content: userInput });
  for (let step = 0; step < MAX_STEPS; step++) {
    const resp = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: getSchemas(),
    });
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
      const name = call.function.name;
      const arguments_ = call.function.arguments;
      let args: Record<string, any> | undefined;
      try {
        args = JSON.parse(arguments_ || "{}");
      } catch {
        // 参数不是合法 JSON，保持 undefined，下面按错误处理
      }
      let result: string;
      if (args === undefined) {
        result = "Error: 参数不是合法的 JSON";
      } else {
        console.log(`🔧 ${name}(${arguments_.slice(0, 80)})`);
        result = await execute(name, args);
      }
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
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const messages: ChatCompletionMessageParam[] = [{ role: "system", content: SYSTEM }];
while (true) {
  const q = (await rl.question("你> ")).trim();
  if (q === "exit" || q === "quit") break;
  console.log("\n" + (await run(q, messages)) + "\n");
}
rl.close();
