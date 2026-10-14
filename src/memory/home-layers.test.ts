// 验收修改：在主目录下启动时项目级记忆与用户级记忆是同一个文件——只按用户级一层：推送只推一次；update_memory 写项目级
// 即拒绝并说明（不把同一条写成"两层"）；别的目录照旧两层。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "vitest";
import { availableMemoryLayers, memoryLocation } from "./learned-store.ts";
import { loadPushedMemory } from "./pushed.ts";
import { applyMemoryUpdate } from "./update-memory-tool.ts";

const LIMITS = { project: 4000, user: 3000 };
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

function writeUserMemory(home: string, text: string): string {
  const file = memoryLocation("user", { governanceRoot: home, homeDir: home }).file;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

test("主目录下只有用户级一层；别的目录两层", () => {
  const home = temp("pigeon-memory-home-");
  const project = temp("pigeon-memory-project-");
  assert.deepEqual(availableMemoryLayers({ governanceRoot: home, homeDir: home }), ["user"]);
  assert.deepEqual(availableMemoryLayers({ governanceRoot: project, homeDir: home }), [
    "project",
    "user",
  ]);
});

test("主目录下推送记忆只推用户级一次", () => {
  const home = temp("pigeon-memory-home-");
  writeUserMemory(home, "- [U1] 提交信息用英文（2026-10-13，tui，sess_x）\n");
  const pushed = loadPushedMemory({
    governanceRoot: home,
    homeDir: home,
    limits: LIMITS,
    writable: false,
  });
  assert.deepEqual(
    pushed.manifest.layers.map((layer) => layer.layer),
    ["user"]
  );
  assert.equal(pushed.section.split("提交信息用英文").length - 1, 1, pushed.section);
});

test("主目录下 update_memory 写项目级：拒绝并说明，文件不动；写用户级照常", async () => {
  const home = temp("pigeon-memory-home-");
  const file = writeUserMemory(home, "");
  const options = {
    governanceRoot: home,
    homeDir: home,
    sessionId: "sess_x",
    source: "tui" as const,
    limits: LIMITS,
  };
  const refused = await applyMemoryUpdate(options, {
    action: "add",
    layer: "project",
    content: "只对这个项目成立的事",
  });
  assert.match(refused.text, /^Project memory is not available here/);
  assert.equal(refused.details.rejected, "project-is-user");
  assert.equal(readFileSync(file, "utf8"), "");
  const added = await applyMemoryUpdate(options, {
    action: "add",
    layer: "user",
    content: "对所有项目都成立的事",
  });
  assert.match(added.text, /^Added U1 to the user memory/);
});
