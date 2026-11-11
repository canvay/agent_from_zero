// 权限系统：硬规则 → 风险分级 → 人工确认（对应 agent_py/permissions.py）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as readline from "node:readline/promises";

// Agent 只允许碰这个目录。默认是启动时的当前目录。
export const WORKSPACE = path.resolve(process.env.NAMI_WORKSPACE ?? process.cwd());

// 允许"本次会话一直允许"的工具。run_shell 不在里面：每条命令都要过目。
const REMEMBERABLE = new Set(["write_file"]);

// 明显的灾难性命令。注意：这是安全带，不是边界（见文章第八节）。
const SHELL_DENY_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(\/|~|\*)/, // rm -rf / ~ *
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /:\(\)\s*\{/, // fork bomb
  /(curl|wget)\b.*\|\s*(sh|bash)\b/, // curl ... | sh
  />\s*\/dev\/sd/,
];

export enum Risk {
  SAFE = "safe", // 只读：直接放行
  CONFIRM = "confirm", // 有副作用：问人
  DENY = "deny", // 永远不允许
}

// 工具风险登记表。没登记的工具一律按 CONFIRM 处理。
const TOOL_RISK: Record<string, Risk> = {
  list_dir: Risk.SAFE,
  read_file: Risk.SAFE,
  write_file: Risk.CONFIRM,
  run_shell: Risk.CONFIRM,
  fetch_url: Risk.CONFIRM,
};

/** 把路径解析成绝对路径；不在工作区内返回 null。
 * realpath 会展开 .. 和符号链接，所以 ../../etc/passwd 和指向外部的软链接都会被识别。 */
export function resolveInWorkspace(pathStr: string): string | null {
  let p = pathStr.replace(/^~(?=$|[\\/])/, os.homedir()); // 对应 Python 的 expanduser()
  if (!path.isAbsolute(p)) p = path.join(WORKSPACE, p);
  p = path.resolve(p);
  try {
    p = fs.realpathSync(p); // 展开符号链接；路径尚不存在时保持解析结果
  } catch {
    /* ignore */
  }
  return p === WORKSPACE || p.startsWith(WORKSPACE + path.sep) ? p : null;
}

/** 确认界面：展示将要执行的真实内容，而不是模型的自述。 */
function renderCall(name: string, args: Record<string, any>, maxChars = 400): string {
  if (name === "run_shell") return `  $ ${args.command ?? ""}`;
  if (name === "write_file") {
    const content = String(args.content ?? "");
    let preview = content.slice(0, maxChars);
    if (content.length > maxChars)
      preview += `\n...（已截断，共 ${content.length} 字符）`;
    return `  路径：${args.path ?? ""}\n${preview
      .split("\n")
      .map((l) => "    " + l)
      .join("\n")}`;
  }
  return `  ${JSON.stringify(args)}`;
}

export interface Decision {
  allowed: boolean;
  reason: string;
}

type Answer = "y" | "n" | "a";
type Ask = (name: string, args: Record<string, any>) => Promise<[Answer, string]>;

// 全局共享一个 readline 接口：多处各建一个会导致同一输入被回显两次
let sharedRl: readline.Interface | null = null;
export function getSharedRl(): readline.Interface {
  sharedRl ??= readline.createInterface({ input: process.stdin, output: process.stdout });
  return sharedRl;
}

export class PermissionManager {
  alwaysAllowed = new Set<string>();
  ask: Ask;

  constructor(ask?: Ask) {
    // ask 可注入：ask(name, args) -> ("y" | "n" | "a", 拒绝原因)
    // 方便测试，后续会换成聊天确认和无人值守的预授权
    this.ask = ask ?? PermissionManager.askTerminal;
  }

  async check(name: string, args: Record<string, any>): Promise<Decision> {
    // 第 1 关：硬规则，人也无法放行
    const reason = this.hardLimits(name, args);
    if (reason) return { allowed: false, reason };
    // 第 2 关：风险分级
    const risk = TOOL_RISK[name] ?? Risk.CONFIRM;
    if (risk === Risk.DENY)
      return { allowed: false, reason: `工具 ${name} 被策略禁用。` };
    if (risk === Risk.SAFE || this.alwaysAllowed.has(name))
      return { allowed: true, reason: "" };
    // 第 3 关：人工确认
    return this.confirm(name, args);
  }

  private hardLimits(name: string, args: Record<string, any>): string | null {
    if (["read_file", "write_file", "list_dir"].includes(name)) {
      const p = String(args.path ?? ".");
      if (resolveInWorkspace(p) === null) {
        return `路径 ${JSON.stringify(p)} 在工作区 ${WORKSPACE} 之外，禁止访问。`;
      }
    }
    if (name === "run_shell") {
      const cmd = String(args.command ?? "");
      for (const pat of SHELL_DENY_PATTERNS) {
        if (pat.test(cmd))
          return `命令命中危险模式，已被策略拦截：${JSON.stringify(cmd)}`;
      }
    }
    return null;
  }

  private async confirm(name: string, args: Record<string, any>): Promise<Decision> {
    const [answer, note] = await this.ask(name, args);
    if (answer === "a" && REMEMBERABLE.has(name)) {
      this.alwaysAllowed.add(name);
      return { allowed: true, reason: "" };
    }
    if (answer === "y" || answer === "a") return { allowed: true, reason: "" };
    let msg = "用户拒绝了这次操作。";
    if (note) msg += `原因：${note}。`;
    msg += "不要重试同一操作；请换一种方式，或向用户说明你想做什么、为什么。";
    return { allowed: false, reason: msg };
  }

  private static async askTerminal(
    name: string,
    args: Record<string, any>,
  ): Promise<[Answer, string]> {
    if (!process.stdin.isTTY) {
      // 非交互环境（管道、脚本）没有人可以确认，默认拒绝
      return ["n", "当前是非交互环境，无法确认"];
    }
    console.log(`\n⚠️  Agent 想执行：${name}`);
    console.log(renderCall(name, args));
    const options =
      "[y]允许 / [n]拒绝" + (REMEMBERABLE.has(name) ? " / [a]本次会话一直允许" : "");
    const rl = getSharedRl();
    let ans = "";
    for (;;) {
      ans = (await rl.question(`${options} > `)).trim().toLowerCase();
      if (ans === "y" || ans === "n" || (ans === "a" && REMEMBERABLE.has(name))) break;
    }
    const note =
      ans === "n" ? (await rl.question("拒绝原因（可选，回车跳过）> ")).trim() : "";
    return [ans as Answer, note];
  }
}
