// 对应 agent_py/tests/conftest.py：
// 测试前把工作区指向临时目录，不碰你的真实文件。
// WORKSPACE 在 permissions.ts 模块加载时求值，所以必须在它被 import 之前设好（vitest 的 setupFiles 保证顺序）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NAMI_WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "nami-ws-"));
process.env.NAMI_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nami-state-"));
process.env.API_KEY ??= "test";
