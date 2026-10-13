// 决策 441 审查修正：PowerShell 5.1 的输出按 UTF-8 取（中文系统缺省代码页 936 会乱码）。只在 Windows 上跑；不碰真实剪贴板。
import assert from "node:assert/strict";
import { test } from "vitest";
import { readPowerShellText } from "./clipboard.ts";

test.skipIf(process.platform !== "win32")("PowerShell 输出的中文按 UTF-8 解码不乱码", async () => {
  const text = await readPowerShellText(
    'Write-Output ([string][char]0x4E2D + [char]0x6587 + " ok")'
  );
  assert.equal(text, "中文 ok");
});
