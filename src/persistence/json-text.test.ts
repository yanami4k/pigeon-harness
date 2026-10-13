// 读使用者手写的 JSON 配置时去掉开头的 BOM（PowerShell 5.1 的 Set-Content -Encoding utf8 写的文件带它）。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { parseJsonText } from "./json-text.ts";
import { loadSettings } from "./settings.ts";

const BOM = String.fromCharCode(0xfeff);

test("parseJsonText 去掉开头的 BOM；中间的不动", () => {
  assert.deepEqual(parseJsonText(`${BOM}{"a":1}`), { a: 1 });
  assert.deepEqual(parseJsonText('{"a":1}'), { a: 1 });
  assert.throws(() => parseJsonText(`{"a":1}${BOM}x`));
});

test("带 BOM 的用户级设置文件照常读出（不再报不是合法 JSON）", () => {
  const home = mkdtempSync(join(tmpdir(), "pigeon-bom-home-"));
  const root = mkdtempSync(join(tmpdir(), "pigeon-bom-root-"));
  try {
    mkdirSync(join(home, ".pigeon"), { recursive: true });
    writeFileSync(join(home, ".pigeon", "settings.json"), `${BOM}{ "web": { "enabled": false } }`);
    assert.equal(loadSettings(root, { homeDir: home }).merged.web?.enabled, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
