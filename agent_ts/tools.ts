// 工具注册表：用 tool() 把函数注册为工具，自动生成 schema 并挂到 TOOLS 上
import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { FunctionParameters } from "openai/resources/shared";
import { WORKSPACE, resolveInWorkspace } from "./permissions";

const MAX_OUTPUT = 8000; // 工具返回给模型的最大字符数

type ToolFunc = (args: any) => string | Promise<string>;
const TOOLS: Record<string, { schema: ChatCompletionTool; func: ToolFunc }> = {};

export function tool(name: string, description: string, parameters: FunctionParameters) {
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
  const p = resolveInWorkspace(path);
  if (p === null) return "[错误] 路径在工作区之外";
  const entries = fs.readdirSync(p, { withFileTypes: true });
  return (
    entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => e.name + (e.isDirectory() ? "/" : ""))
      .join("\n") || "(空目录)"
  );
});

const read_file = tool("read_file", "读取一个文本文件的内容。", params({ path: "文件路径" }))(
  ({ path }) => {
    const p = resolveInWorkspace(path); // 双保险：即使有人绕过了 perms，这里还会拦
    if (p === null) return "[错误] 路径在工作区之外";
    return fs.readFileSync(p, "utf-8");
  },
);

const write_file = tool(
  "write_file",
  "把内容写入文件，已存在则覆盖。",
  params({ path: "文件路径", content: "完整内容" }),
)(({ path: filePath, content }) => {
  const p = resolveInWorkspace(filePath);
  if (p === null) return "[错误] 路径在工作区之外";
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf-8");
  return `已写入 ${path.relative(WORKSPACE, p)}（${content.length} 字符）`;
});

const edit_file = tool(
  "edit_file",
  "编辑修改文件，旧字符在文件里恰好出现一次才替换，出现零次或多次都返回错误，需要给出更长的被替换原文",
  params({ path: "文件路径", old: "被替换的旧字符", new: "替换成的新字符" }),
)(({ path, old, new: newStr }) => {
  const p = resolveInWorkspace(path);
  if (p === null) return "[错误] 路径在工作区之外";
  if (!old) return "old 不能为空字符串";
  // Node 读写不做换行转换，文件原有换行符保持不变
  const content = fs.readFileSync(p, "utf-8");
  const count = content.split(old).length - 1;
  if (count > 1) return `${JSON.stringify(old)}出现了${count}次，需要给出更长的被替换原文`;
  if (count < 1) return `${JSON.stringify(old)}不存在，无法替换`;
  fs.writeFileSync(p, content.replace(old, newStr), "utf-8");
  return "已完成内容修改";
});

const run_shell = tool(
  "run_shell",
  "在工作区执行一条 shell 命令。",
  params({ command: "要执行的命令" }),
)(
  ({ command, timeout = 30 }) =>
    new Promise((resolve) => {
      exec(
        command,
        { cwd: WORKSPACE, timeout: timeout * 1000, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err?.killed) return resolve(`[超时] 命令执行超过 ${timeout} 秒，已终止。`);
          const code = err && typeof err.code === "number" ? err.code : (err ? 1 : 0);
          resolve(`[exit ${code}]\n${stdout}${stderr}`);
        },
      );
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

const get_time = tool("get_time", "返回当前时间", params({}))(
  () => new Date().toLocaleString("zh-CN", { hour12: false }),
);

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
