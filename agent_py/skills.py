"""skills.py —— 第 5 课：技能（按需加载的能力说明书）"""

from permissions import SKILLS_DIR, WORKSPACE
from tools import tool

SKILL_MARK = "[skill]"
MAX_NOTES_CHARS = 3000


def parse_skill(text):
    """拆出 frontmatter（--- 之间的 key: value）和正文。"""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, text.strip()
    meta = {}
    for i, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            return meta, "\n".join(lines[i + 1 :]).strip()
        key, sep, value = line.partition(":")
        if sep:
            meta[key.strip()] = value.strip()
    return {}, text.strip()  # 没有闭合的 ---，当作没有 frontmatter


def discover(skills_dir=None):
    skills_dir = skills_dir or SKILLS_DIR
    found = {}
    if not skills_dir.is_dir():
        return found
    for f in sorted(skills_dir.glob("*/SKILL.md")):
        meta, _ = parse_skill(f.read_text(encoding="utf-8"))
        name = meta.get("name") or f.parent.name
        if not meta.get("description"):
            print(f"[skills] 跳过 {f}：缺少 description")
            continue
        found[name] = {"description": meta["description"], "path": f}
    return found


def skills_section(found=None):
    found = discover() if found is None else found
    if not found:
        return ""
    lines = [
        "",
        "## 可用技能",
        (
            "下面只列出技能的名字和用途。当任务和某个技能的用途匹配时，"
            "先调用 load_skill 读取完整说明，再按说明执行。"
        ),
    ]
    lines += [f"- {n}：{s['description']}" for n, s in found.items()]
    return "\n".join(lines)


def project_notes():
    """AGENTS.md：项目级说明，每次都放进 system prompt。"""
    p = WORKSPACE / "AGENTS.md"
    if not p.is_file():
        return ""
    text = p.read_text(encoding="utf-8")[:MAX_NOTES_CHARS]
    return f"\n\n## 项目说明（来自 AGENTS.md）\n{text}"


@tool(
    name="load_skill",
    description="读取一个技能的完整说明。任务和「可用技能」列表里某个技能的用途匹配时调用。",
    parameters={
        "type": "object",
        "properties": {"name": {"type": "string", "description": "技能名"}},
        "required": ["name"],
    },
)
def load_skill(name):
    found = discover()
    if name not in found:
        return f"Error: 没有名为 {name!r} 的技能，可用：{', '.join(found) or '无'}"
    path = found[name]["path"]
    _, body = parse_skill(path.read_text(encoding="utf-8"))
    extras = sorted(p.name for p in path.parent.iterdir() if p.name != "SKILL.md")
    rel = path.parent.relative_to(WORKSPACE)
    note = f"\n\n（技能目录 {rel}/ 下还有：{', '.join(extras)}）" if extras else ""
    return f"{SKILL_MARK} {name}\n{body}{note}"
