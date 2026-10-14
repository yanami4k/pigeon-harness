// M4 S5：session list 命令层测试（D5：列表默认安静）。M2 S4：命令层自 cli/session.ts 归位 application/session-list.ts。
// 读新会话存储：覆盖安静行、从旧到新的顺序、过滤器（工具、Run 级失败分类、时间）、旧格式会话只给计数提示；
// 决策 456（验收修改）：每行带会话名，没改过名的显示缺省名。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { LEGACY_READER_HINT } from "../persistence/session-catalog.ts";
import { asSessionId, type SessionId } from "../state/ids.ts";
import { sessionCreatedAt } from "../state/session-summary.ts";
import { defaultPeerName } from "./peer-messaging.ts";
import { runSessionListCommand } from "./session-list.ts";
import { createFixtureSession, type FixtureSession } from "./session-store-fixtures.ts";

const FIRST = asSessionId("sess_01JAAAAAA10000000000000000");
const SECOND = asSessionId("sess_01JAAAAAA20000000000000000");

function makeRoot(): { root: string; sessionsDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pigeon-session-cmd-"));
  return {
    root,
    sessionsDir: join(root, ".pigeon", "state", "sessions"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function seed(
  sessionsDir: string,
  sessionId: SessionId,
  write: (session: FixtureSession) => void
): Promise<void> {
  const session = createFixtureSession({
    sessionsDir,
    sessionId,
    cwd: resolve(sessionsDir, "../../.."),
  });
  write(session);
  await session.close();
}

// 会话列表行的时间：UTC ISO 切到分钟
function minute(sessionId: SessionId): string {
  return new Date(sessionCreatedAt(sessionId)).toISOString().slice(0, 16).replace("T", " ");
}

test("session list：一会话一行安静行（时间 + Run 数 + 会话 id），从旧到新，无突出行与徽章", async () => {
  const { root, sessionsDir, cleanup } = makeRoot();
  try {
    // 先写新的、再写旧的：顺序按会话创建时间，不按写入先后
    await seed(sessionsDir, SECOND, (s) => {
      s.startRun({ task: "a" });
      s.toolTurn({ name: "edit_file" });
      s.endRun();
    });
    await seed(sessionsDir, FIRST, (s) => {
      s.startRun({ task: "b" });
      s.endRun();
      s.startRun({ task: "c" });
    });
    assert.equal(
      runSessionListCommand({ root }),
      `${minute(FIRST)}  ${defaultPeerName(root, FIRST)}  2 runs  ${FIRST}\n${minute(SECOND)}  ${defaultPeerName(root, SECOND)}  1 run  ${SECOND}\n`
    );
  } finally {
    cleanup();
  }
});

test("session list：过滤器透传（tool / class / since / until）与空目录文案", async () => {
  const { root, sessionsDir, cleanup } = makeRoot();
  try {
    assert.equal(runSessionListCommand({ root }), "no sessions\n");
    await seed(sessionsDir, FIRST, (s) => {
      s.startRun({ task: "a" });
      s.toolTurn({ name: "read_file" });
      s.assistant({ text: "", stopReason: "aborted" });
      s.endRun({ ending: "aborted" });
    });
    await seed(sessionsDir, SECOND, (s) => {
      s.startRun({ task: "b" });
      s.toolTurn({ name: "edit_file" });
      // 有开始无收尾：崩溃残留，分类为未知
    });

    const byTool = runSessionListCommand({ root, filters: { tool: "read_file" } });
    assert.ok(byTool.includes(FIRST) && !byTool.includes(SECOND));
    const cancelled = runSessionListCommand({ root, filters: { class: "cancelled" } });
    assert.ok(cancelled.includes(FIRST) && !cancelled.includes(SECOND));
    const unknown = runSessionListCommand({ root, filters: { class: "unknown" } });
    assert.ok(unknown.includes(SECOND) && !unknown.includes(FIRST));
    const until = runSessionListCommand({ root, filters: { until: sessionCreatedAt(FIRST) } });
    assert.ok(until.includes(FIRST) && !until.includes(SECOND));
    const sinceFuture = runSessionListCommand({
      root,
      filters: { since: Date.now() + 86_400_000 },
    });
    assert.equal(sinceFuture, "no sessions\n");
  } finally {
    cleanup();
  }
});

test("session list：旧格式会话（会话根下平铺的 sess_<ULID>.jsonl）不列出，末尾给一行计数提示", async () => {
  const { root, sessionsDir, cleanup } = makeRoot();
  try {
    await seed(sessionsDir, SECOND, (s) => s.startRun({ task: "a" }));
    // 新存储里有同号文件的平铺文件不算旧格式会话；旁置文件名不合 sess_<ULID>.jsonl 的也不算
    writeFileSync(join(sessionsDir, `${SECOND}.jsonl`), "");
    writeFileSync(join(sessionsDir, `${FIRST}.jsonl`), "");
    writeFileSync(join(sessionsDir, `${FIRST}.messages.jsonl`), "");
    const notice = `1 old-format session not listed; ${LEGACY_READER_HINT}`;
    assert.equal(
      runSessionListCommand({ root }),
      `${minute(SECOND)}  ${defaultPeerName(root, SECOND)}  1 run  ${SECOND}\n${notice}\n`
    );
    assert.equal(
      runSessionListCommand({ root, filters: { tool: "无此工具" } }),
      `no sessions\n${notice}\n`
    );
  } finally {
    cleanup();
  }
});

test("决策 456（验收修改）：改过名的会话在列表里显示它的名字，没改过名的显示缺省名", async () => {
  const { root, sessionsDir, cleanup } = makeRoot();
  try {
    await seed(sessionsDir, FIRST, (s) => {
      s.writer.setName("api-fix");
      s.startRun({ task: "a" });
    });
    await seed(sessionsDir, SECOND, (s) => s.startRun({ task: "b" }));
    const lines = runSessionListCommand({ root }).trimEnd().split("\n");
    assert.equal(lines[0], `${minute(FIRST)}  api-fix  1 run  ${FIRST}`);
    assert.equal(lines[1], `${minute(SECOND)}  ${defaultPeerName(root, SECOND)}  1 run  ${SECOND}`);
  } finally {
    cleanup();
  }
});
