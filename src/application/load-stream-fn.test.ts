// 模型接入模块的加载（自 cli.test.ts 移来：命令行对话去掉之后，这条只测 application/runtime.ts 的 loadStreamFn）
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { loadStreamFn } from "./runtime.ts";

test("loadStreamFn：加载默认导出函数的模块；坏路径与缺默认导出给清晰报错", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-streamfn-"));
  try {
    writeFileSync(join(dir, "ok.mjs"), "export default function fakeStreamFn() {}\n");
    writeFileSync(join(dir, "no-default.mjs"), "export const x = 1;\n");
    const fn = await loadStreamFn(join(dir, "ok.mjs"));
    assert.equal(typeof fn, "function");
    await assert.rejects(() => loadStreamFn(join(dir, "不存在.mjs")), /无法加载 streamFn 模块/);
    await assert.rejects(() => loadStreamFn(join(dir, "no-default.mjs")), /没有默认导出函数/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
