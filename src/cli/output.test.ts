// 命令行输出的终端边界净化（决策 036；自 approval-ui.test.ts 移来）
import assert from "node:assert/strict";
import { test } from "vitest";
import { sanitizedWriter } from "./output.ts";

test("终端边界净化（决策 036）：写出的内容携带 CSI 时可见化为 ␛，原始序列不落终端", () => {
  const outputs: string[] = [];
  const write = sanitizedWriter((text: string) => outputs.push(text));
  write("@@ -1 +1 @@\n-旧的\n\u001b[2J+伪造的屏幕\n");
  const out = outputs.join("");
  assert.ok(out.includes("␛[2J+伪造的屏幕"), `CSI 应可见化，实际：${JSON.stringify(out)}`);
  assert.ok(!out.includes("\u001b"), "原始 ESC 字节不得写出");
});
