// skills.ts —— 第 5 课：技能（按需加载的能力说明书）
import fs from "node:fs";
import path from "node:path";
import { SKILLS_DIR, WORKSPACE } from "./permissions";
import { tool } from "./tools";

const SKILL_MARK = "[skill]";
const MAX_NOTES_CHARS = 3000;

export interface SkillInfo {
  description: string;
  path: string;
}

/** 拆出 frontmatter（--- 之间的 key: value）和正文。 */
export function parseSkill(text: string): [Record<string, string>, string] {
  const lines = text.split("\n");
  if (!lines.length || lines[0].trim() !== "---") return [{}, text.trim()];
  const meta: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      return [meta, lines.slice(i + 1).join("\n").trim()];
    }
    const idx = lines[i].indexOf(":");
    if (idx > 0) meta[lines[i].slice(0, idx).trim()] = lines[i].slice(idx + 1).trim();
  }
  return [{}, text.trim()]; // 没有闭合的 ---，当作没有 frontmatter
}

export function discover(skillsDir?: string): Record<string, SkillInfo> {
  const dir = skillsDir || SKILLS_DIR;
  const found: Record<string, SkillInfo> = {};
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(dir, entry.name, "SKILL.md");
    if (!fs.existsSync(skillFile)) continue;
    const [meta] = parseSkill(fs.readFileSync(skillFile, "utf-8"));
    const name = meta.name || entry.name;
    if (!meta.description) {
      console.log(`[skills] 跳过 ${skillFile}：缺少 description`);
      continue;
    }
    found[name] = { description: meta.description, path: skillFile };
  }
  return found;
}

export function skillsSection(found?: Record<string, SkillInfo>): string {
  const all = found ?? discover();
  if (!Object.keys(all).length) return "";
  const lines = [
    "",
    "## 可用技能",
    "下面只列出技能的名字和用途。当任务和某个技能的用途匹配时，先调用 load_skill 读取完整说明，再按说明执行。",
  ];
  for (const [n, s] of Object.entries(all)) lines.push(`- ${n}：${s.description}`);
  return lines.join("\n");
}

/** AGENTS.md：项目级说明，每次都放进 system prompt。 */
export function projectNotes(): string {
  const p = path.join(WORKSPACE, "AGENTS.md");
  if (!fs.existsSync(p)) return "";
  const text = fs.readFileSync(p, "utf-8").slice(0, MAX_NOTES_CHARS);
  return `\n\n## 项目说明（来自 AGENTS.md）\n${text}`;
}

export const load_skill = tool(
  "load_skill",
  "读取一个技能的完整说明。任务和「可用技能」列表里某个技能的用途匹配时调用。",
  {
    type: "object",
    properties: { name: { type: "string", description: "技能名" } },
    required: ["name"],
  },
)(async ({ name }: { name: string }) => {
  const found = discover();
  if (!(name in found)) {
    return `Error: 没有名为 ${JSON.stringify(name)} 的技能，可用：${
      Object.keys(found).join(", ") || "无"
    }`;
  }
  const info = found[name];
  const [, body] = parseSkill(fs.readFileSync(info.path, "utf-8"));
  const extras = fs
    .readdirSync(path.dirname(info.path))
    .filter((f) => f !== "SKILL.md")
    .sort();
  const rel = path.relative(WORKSPACE, path.dirname(info.path));
  const note = extras.length ? `\n\n（技能目录 ${rel}/ 下还有：${extras.join(", ")}）` : "";
  return `${SKILL_MARK} ${name}\n${body}${note}`;
});
