// 对应 agent_py/tests/test_permissions.py
import { beforeEach, describe, expect, it } from "vitest";
import { PermissionManager, WORKSPACE } from "../permissions";

function make(answer: "y" | "n" | "a") {
  const calls: string[] = [];
  const pm = new PermissionManager(async (name) => {
    calls.push(name);
    return [answer, ""];
  });
  return { pm, calls };
}

describe("PermissionManager", () => {
  beforeEach(() => {
    // sanity：conftest 已把工作区指到临时目录
    expect(WORKSPACE).toContain(pathSep());
  });

  it("read_needs_no_confirm", async () => {
    const { pm, calls } = make("n");
    expect((await pm.check("read_file", { path: "README.md" })).allowed).toBe(true);
    expect(calls).toEqual([]);
  });

  it("path_escape_denied_even_if_user_would_allow", async () => {
    const { pm, calls } = make("y");
    expect((await pm.check("read_file", { path: "../../etc/passwd" })).allowed).toBe(false);
    expect((await pm.check("write_file", { path: "/etc/hosts", content: "x" })).allowed).toBe(false);
    expect(calls).toEqual([]); // 硬规则拦截，根本没问人
  });

  it("dangerous_shell_denied", async () => {
    const { pm, calls } = make("y");
    expect((await pm.check("run_shell", { command: "sudo rm -rf /" })).allowed).toBe(false);
    expect(calls).toEqual([]);
  });

  it("shell_needs_confirm", async () => {
    const { pm, calls } = make("y");
    expect((await pm.check("run_shell", { command: "ls" })).allowed).toBe(true);
    expect(calls).toEqual(["run_shell"]);
  });

  it("unknown_tool_defaults_to_confirm", async () => {
    const { pm, calls } = make("n");
    expect((await pm.check("send_email", {})).allowed).toBe(false);
    expect(calls).toEqual(["send_email"]);
  });

  it("always_only_applies_to_write_file", async () => {
    const { pm, calls } = make("a");
    await pm.check("write_file", { path: "a.txt", content: "" });
    await pm.check("write_file", { path: "b.txt", content: "" });
    expect(calls).toEqual(["write_file"]); // 第二次没再问
    await pm.check("run_shell", { command: "ls" });
    await pm.check("run_shell", { command: "ls" });
    expect(calls.filter((c) => c === "run_shell")).toHaveLength(2); // run_shell 每次都问
  });
});

/** Windows 路径分隔符（\ 或 /），用于 beforeEach 的 sanity 断言 */
function pathSep(): string {
  return process.platform === "win32" ? "\\" : "/";
}
