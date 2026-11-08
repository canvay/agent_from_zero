// 工具注册表：用 tool() 把函数注册为工具，自动生成 schema 并挂到 TOOLS 上
import fs from "node:fs";
import { dirname } from "node:path";
import { exec } from "node:child_process";
import type { FunctionParameters } from "openai/resources/shared";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

const MAX_OUTPUT = 8000; // 工具返回给模型的最大字符数

type ToolFunc = (args: any) => string | Promise<string>;
const TOOLS: Record<string, { schema: ChatCompletionTool; func: ToolFunc }> = {};

function tool(
  name: string,
  description: string,
  parameters: FunctionParameters,
) {
  // 对应 Python 的装饰器：tool(...)(func) 把函数注册进 TOOLS
  return (func: ToolFunc): ToolFunc => {
    TOOLS[name] = {
      schema: {
        type: "function",
        function: { name, description, parameters },
      },
      func,
    };
    return func;
  };
}

/** 简写：所有参数都是必填的字符串 */
function params(props: Record<string, string>) {
  return {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(props).map(([k, v]) => [
        k,
        { type: "string", description: v },
      ]),
    ),
    required: Object.keys(props),
  };
}

// ---------- 工具 ----------
const list_dir = tool(
  "list_dir",
  "列出某个目录下的文件和子目录。",
  params({ path: "目录路径，当前目录写 ." }),
)(({ path = "." }) => {
  const entries = fs.readdirSync(path, { withFileTypes: true });
  return (
    entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => e.name + (e.isDirectory() ? "/" : ""))
      .join("\n") || "(空目录)"
  );
});

const read_file = tool("read_file", "读取一个文本文件的内容。", params({ path: "文件路径" }))(
  ({ path }) => fs.readFileSync(path, "utf-8"),
);

const write_file = tool(
  "write_file",
  "把内容写入文件，已存在则覆盖，目录不存在会自动创建。",
  params({ path: "文件路径", content: "要写入的完整内容" }),
)(({ path, content }) => {
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, content, "utf-8");
  return `已写入 ${path}（${content.length} 字符）`;
});

const run_shell = tool(
  "run_shell",
  "在当前目录执行一条 shell 命令，返回退出码、标准输出和错误输出。",
  params({ command: "要执行的命令" }),
)(
  ({ command }) =>
    new Promise((resolve) => {
      exec(command, { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code = err && typeof err.code === "number" ? err.code : (err ? 1 : 0);
        resolve(`[exit ${err?.killed ? "timeout" : code}]\n${stdout}${stderr}`);
      });
    }),
);

const fetch_url = tool(
  "fetch_url",
  "抓取一个网页或接口的文本内容。url 必须以 http 或 https 开头。",
  params({ url: "完整的 URL" }),
)(async ({ url }) => {
  const resp = await fetch(url, {
    headers: { "User-Agent": "canvay-agent" },
    signal: AbortSignal.timeout(15_000),
  });
  return await resp.text();
});

// ---------- 对 agent 暴露的接口 ----------
/** 返回给模型看的全部工具说明书 */
export function getSchemas(): ChatCompletionTool[] {
  return Object.values(TOOLS).map((t) => t.schema);
}

/** 执行工具，永远返回字符串，永远不抛异常 */
export async function execute(name: string, args: Record<string, any>): Promise<string> {
  if (!(name in TOOLS)) {
    return `Error: 不存在工具 '${name}'，可用工具：${Object.keys(TOOLS).join(", ")}`;
  }
  let result: string;
  try {
    result = String(await TOOLS[name].func(args));
  } catch (e) {
    result = `Error: ${(e as Error).name}: ${(e as Error).message}`;
  }
  if (result.length > MAX_OUTPUT) {
    result = result.slice(0, MAX_OUTPUT) + `\n...（已截断，共 ${result.length} 字符）`;
  }
  return result;
}
