import subprocess
import urllib.request
from datetime import datetime

from permissions import WORKSPACE, resolve_in_workspace

MAX_OUTPUT = 8000  # 工具返回给模型的最大字符数
TOOLS = {}


def tool(name: str, description: str, parameters):
    def decorate(func):
        """装饰器：把一个函数注册为工具"""
        TOOLS[name] = {
            "schema": {
                "type": "function",
                "function": {
                    "name": name,
                    "description": description,
                    "parameters": parameters,
                },
            },
            "func": func,
        }
        return func

    return decorate


def _params(**props):
    """简写：所有参数都是必填的字符串"""
    return {
        "type": "object",
        "properties": {
            k: {"type": "string", "description": v} for k, v in props.items()
        },
        "required": list(props),
    }


@tool(
    "list_dir", "列出某个目录下的文件和子目录。", _params(path="目录路径，当前目录写 .")
)
def list_dir(path="."):
    p = resolve_in_workspace(path)
    if p is None:
        return "[错误] 路径在工作区之外"
    return (
        "\n".join(sorted(x.name + ("/" if x.is_dir() else "") for x in p.iterdir()))
        or "(空目录)"
    )


@tool("read_file", "读取一个文本文件的内容。", _params(path="文件路径"))
def read_file(path):
    p = resolve_in_workspace(path)
    if p is None:  # 双保险：即使有人绕过了 perms，这里还会拦
        return "[错误] 路径在工作区之外"
    return p.read_text(encoding="utf-8")


@tool(
    "write_file",
    "把内容写入文件，已存在则覆盖。",
    _params(path="文件路径", content="完整内容"),
)
def write_file(path, content):
    p = resolve_in_workspace(path)
    if p is None:
        return "[错误] 路径在工作区之外"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    return f"已写入 {p.relative_to(WORKSPACE)}（{len(content)} 字符）"


@tool(
    "edit_file",
    "编辑修改文件，旧字符在文件里恰好出现一次才替换，出现零次或多次都返回错误，需要给出更长的被替换原文",
    _params(path="文件路径", old="被替换的旧字符", new="替换成的新字符"),
)
def edit_file(path, old, new):
    p = resolve_in_workspace(path)
    if p is None:
        return "[错误] 路径在工作区之外"
    if not old:
        return "old 不能为空字符串"
    # newline="" 禁用换行转换，避免编辑时把文件原有换行符改写成本平台风格
    with p.open("r", encoding="utf-8", newline="") as f:
        content = f.read()
    count = content.count(old)
    if count > 1:
        return f"{old!r}出现了{count}次，需要给出更长的被替换原文"
    elif count < 1:
        return f"{old!r}不存在，无法替换"
    new_content = content.replace(old, new)
    with p.open("w", encoding="utf-8", newline="") as f:
        f.write(new_content)
    return "已完成内容修改"


@tool("run_shell", "在工作区执行一条 shell 命令。", _params(command="要执行的命令"))
def run_shell(command, timeout=30):
    try:
        p = subprocess.run(
            command,
            shell=True,
            cwd=WORKSPACE,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return f"[超时] 命令执行超过 {timeout} 秒，已终止。"
    return f"[exit {p.returncode}]\n{p.stdout}{p.stderr}"


@tool(
    "fetch_url",
    "抓取一个网页或接口的文本内容。url 必须以 http 或 https 开头。",
    _params(url="完整的 URL"),
)
def fetch_url(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": "canvay-agent"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.read().decode("utf-8", errors="replace")


@tool(
    "get_time",
    "返回当前时间",
    _params(),
)
def get_time():
    return datetime.now()


def get_schemas():
    """返回给模型看的全部工具说明书"""
    return [t["schema"] for t in TOOLS.values()]


def execute(name, args):
    """执行工具，永远返回字符串，永远不抛异常"""
    if name not in TOOLS:
        return f"Error: 不存在工具 '{name}'，可用工具：{', '.join(TOOLS)}"
    func = TOOLS[name]["func"]
    try:
        result = str(func(**args))
    except Exception as e:  # noqa: BLE001
        return f"Error: {type(e).__name__}: {e}"
    if len(result) > MAX_OUTPUT:
        result = result[:MAX_OUTPUT] + f"\n...（已截断，共 {len(result)} 字符）"
    return result
