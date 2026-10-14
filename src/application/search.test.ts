// 决策 466：/resume 列表的"打字即筛选"——按会话内容筛，只留列表里给的会话，按相关度排；只搜对话正文；片段经 036 净化、
// 压成一行；空的筛选词不检索。会话数据写在新会话存储里。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createSessionFilter } from "./search.ts";
import { createFixtureSession } from "./session-store-fixtures.ts";

function withRoot(run: (root: string, sessionsDir: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pigeon-session-filter-"));
  return run(root, join(root, ".pigeon", "state", "sessions")).finally(() =>
    rmSync(root, { recursive: true, force: true })
  );
}

async function seed(sessionsDir: string, task: string, toolResult?: string): Promise<string> {
  const session = createFixtureSession({ sessionsDir });
  session.startRun({ task });
  if (toolResult !== undefined) session.toolTurn({ name: "read_file", result: toolResult });
  session.endRun();
  const { sessionId } = await session.close();
  return sessionId;
}

test("按内容筛：只留给定的会话、按相关度排，带一行命中片段；只搜对话正文；空词不检索", () =>
  withRoot(async (root, sessionsDir) => {
    const gateway = await seed(sessionsDir, "部署网关\n第二行 网关 网关");
    const once = await seed(sessionsDir, "看一下网关");
    const hidden = await seed(sessionsDir, "网关也在这里");
    const toolOnly = await seed(sessionsDir, "读个文件", "网关配置");
    const filter = createSessionFilter(root);
    const among = new Set([gateway, once, toolOnly]);
    const hits = await filter("网关", among);
    assert.deepEqual(
      hits.map((hit) => hit.sessionId),
      [gateway, once],
      "不在列表里的、只在工具输出里命中的都不列"
    );
    assert.ok(!hits.some((hit) => hit.sessionId === hidden));
    assert.ok(hits[0]?.snippet.includes("网关"));
    assert.ok(!hits[0]?.snippet.includes("\n"), "片段压成一行");
    assert.deepEqual(await filter("   ", among), []);
    assert.deepEqual(await filter("没有的词", among), []);
  }));

test("片段净化：正文里的终端控制序列可见化，原始 ESC 与 BEL 不出这一层", () =>
  withRoot(async (root, sessionsDir) => {
    const id = await seed(sessionsDir, "注入\x1b]52;c;ZXZpbA==\x07部署\x1b[2J");
    const [hit] = await createSessionFilter(root)("部署", new Set([id]));
    assert.ok(hit !== undefined);
    assert.ok(hit.snippet.includes("␛]52"), hit.snippet);
    assert.ok(!hit.snippet.includes("\x1b"));
    assert.ok(!hit.snippet.includes("\x07"));
  }));
