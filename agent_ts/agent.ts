// agent 核心能力第 1 步：能调用大模型

import "dotenv/config";
import fs from "node:fs";
import { exec } from "node:child_process";
import * as readline from "node:readline/promises";
import OpenAI from "openai";
import type {
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

const client = new OpenAI({
  apiKey: process.env.API_KEY,
  baseURL: process.env.BASE_URL,
});
const MODEL = process.env.MODEL ?? "";
const MAX_STEPS = 20; // 防止死循环：Agent 最多转 20 圈
const SYSTEM =
  "你是一个能操作本地文件和命令行的编程助手。" +
  "需要时调用工具，完成任务后直接用文字总结，不要再调用工具。";

// ---------- 工具方法 ----------
function read_file(path: string): string {
  return fs.readFileSync(path, "utf-8");
}

function write_file(path: string, content: string): string {
  fs.writeFileSync(path, content, "utf-8");
  return `已写入 ${path}（${content.length} 字符）`;
}

async function run_shell(command: string): Promise<string> {
  // 第 1 课先用最朴素的权限控制：每条命令人工确认
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = (
    await rl.question(`\n[需要确认] 执行命令：${command}\n允许？(y/n) `)
  )
    .trim()
    .toLowerCase();
  rl.close();
  if (answer !== "y") return "用户拒绝执行该命令";

  return new Promise((resolve) => {
    exec(command, { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      // 截断，避免撑爆上下文
      const output = ((stdout as string) + (stderr as string)).slice(-4000);
      if (err && err.killed) return resolve("命令超时（60 秒）");
      resolve(output || "(无输出)");
    });
  });
}

const TOOL_FUNCS: Record<string, (args: any) => string | Promise<string>> = {
  read_file: ({ path }) => read_file(path),
  write_file: ({ path, content }) => write_file(path, content),
  run_shell: ({ command }) => run_shell(command),
};

// ---------- 2. 工具说明：告诉模型有哪些工具、参数是什么 ----------
function tool(
  name: string,
  desc: string,
  props: Record<string, string>,
): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name,
      description: desc,
      parameters: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(props).map(([k, v]) => [
            k,
            { type: "string", description: v },
          ]),
        ),
        required: Object.keys(props),
      },
    },
  };
}

const TOOLS: ChatCompletionTool[] = [
  tool("read_file", "读取文件内容", { path: "文件路径" }),
  tool("write_file", "写入文件（覆盖）", {
    path: "文件路径",
    content: "完整文件内容",
  }),
  tool("run_shell", "执行 shell 命令并返回输出", { command: "要执行的命令" }),
];

// ---------- agent 循环 ----------
async function run(task: string): Promise<void> {
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: task },
  ];

  for (let step = 1; step <= MAX_STEPS; step++) {
    const resp = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: TOOLS,
    });
    // SDK v6 对自定义网关会返回联合类型，这里收窄为标准消息类型
    const msg = resp.choices[0].message as ChatCompletionMessage;

    // 对应 Python 版的 model_dump(exclude_none=True)：
    // 去掉值为 null 的字段（如未调用工具时的 tool_calls），API 才能接受
    messages.push(
      JSON.parse(JSON.stringify(msg, (_, v) => (v === null ? undefined : v))),
    );

    if (!msg.tool_calls?.length) {
      console.log(`\n[完成，共 ${step} 步]\n${msg.content}`);
      return;
    }

    for (const call of msg.tool_calls) {
      if (!("function" in call)) continue; // 跳过非标准工具调用
      const name = call.function.name;
      console.log(`[第 ${step} 步] ${name}(${call.function.arguments.slice(0, 80)})`);
      let result: string;
      try {
        // 工具出错也要告诉模型，让它自己修正
        const args = JSON.parse(call.function.arguments);
        result = await TOOL_FUNCS[name](args);
      } catch (e) {
        result = `工具执行出错：${(e as Error).name}: ${(e as Error).message}`;
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result,
      });
    }
  }

  console.log(`\n[达到 ${MAX_STEPS} 步上限，已停止]`);
}

const task = process.argv[2];
if (!task) {
  console.error('用法：npm start -- "你的任务"');
  process.exit(1);
}
await run(task);
