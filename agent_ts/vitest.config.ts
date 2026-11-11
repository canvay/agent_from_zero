import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // setupFiles 在测试文件 import 模块之前运行，
    // 保证 permissions.ts 读到指向临时目录的 NAMI_WORKSPACE
    setupFiles: ["./tests/setup.ts"],
  },
});
