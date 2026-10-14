// 决策 473、474：续接列表的一行（相对时间、会话名、git 分支、轮数、首条输入）与会话最后记的分支；在续接视图里给别处没开着的
// 会话改名——名字规则同 /rename，会话文件被别的进程持有时不改、说明原因。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { sessionFileLockPath } from "../persistence/session-lock.ts";
import { locateSessionFile } from "../persistence/session-reader.ts";
import { SESSION_ENTRY_VERSION, SessionEntryType } from "../state/session-entries.ts";
import {
  listRecentMainSessions,
  type RecentSession,
  recentSessionLine,
  relativeTime,
} from "./recent-sessions.ts";
import { storedSessionName } from "./session-name.ts";
import { INVALID_NAME, renameStoredSession } from "./session-rename.ts";
import { createFixtureSession } from "./session-store-fixtures.ts";

async function withSession(
  run: (root: string, sessionId: string) => Promise<void>,
  branches: string[] = []
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pigeon-session-rename-"));
  try {
    const session = createFixtureSession({
      sessionsDir: join(root, ".pigeon", "state", "sessions"),
    });
    session.startRun({ task: "修登录" });
    session.endRun();
    for (const branch of branches) {
      session.writer.append({
        customType: SessionEntryType.GitHead,
        data: { version: SESSION_ENTRY_VERSION, branch, recordedAt: Date.now() },
      });
    }
    const { sessionId } = await session.close();
    await run(root, sessionId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("相对时间：just now、几分钟、几小时、几天；超过约一个月写日期", () => {
  const now = new Date(2026, 9, 14, 12, 0, 0).getTime();
  assert.equal(relativeTime(now - 30_000, now), "just now");
  assert.equal(relativeTime(now - 5 * 60_000, now), "5m ago");
  assert.equal(relativeTime(now - 3 * 3_600_000, now), "3h ago");
  assert.equal(relativeTime(now - 2 * 86_400_000, now), "2d ago");
  assert.equal(relativeTime(new Date(2026, 7, 1, 9).getTime(), now), "2026-08-01");
});

test("列表的一行：时间、名字、分支、轮数、首条输入；没记分支的不写；可以省掉分支", () => {
  const now = Date.now();
  const session: RecentSession = {
    sessionId: "s1" as RecentSession["sessionId"],
    name: "fix-login",
    lastActiveAt: now - 5 * 60_000,
    firstInput: "修登录",
    turns: 2,
    sandbox: false,
    branch: "feature/login",
  };
  assert.equal(
    recentSessionLine(session, { now }),
    "5m ago  fix-login  feature/login  2 turns  修登录"
  );
  assert.equal(
    recentSessionLine(session, { now, branch: false }),
    "5m ago  fix-login  2 turns  修登录"
  );
  const { branch: _branch, ...noBranch } = session;
  assert.equal(recentSessionLine(noBranch, { now }), "5m ago  fix-login  2 turns  修登录");
});

test("会话最后记的分支进列表；旧会话没记即没有", () =>
  withSession(
    async (root) => {
      const [listed] = listRecentMainSessions(root);
      assert.equal(listed?.branch, "feature/b");
    },
    ["main", "feature/b"]
  ).then(() =>
    withSession(async (root) => {
      const [listed] = listRecentMainSessions(root);
      assert.equal(listed?.branch, undefined);
    })
  ));

test("改名：合规的名字记进会话文件；不合规的不写；会话文件被别的进程持有时不改、说明原因", () =>
  withSession(async (root, sessionId) => {
    assert.equal(await renameStoredSession(root, sessionId, "a/b"), INVALID_NAME);
    assert.equal(storedSessionName(root, sessionId)?.name, undefined);
    assert.equal(await renameStoredSession(root, sessionId, "login-fix"), undefined);
    assert.equal(storedSessionName(root, sessionId)?.name, "login-fix");
    // 别的进程持有：锁文件写着一个还活着的进程（父进程）
    const path = locateSessionFile(join(root, ".pigeon", "state", "sessions"), sessionId)?.path;
    assert.ok(path !== undefined);
    writeFileSync(
      sessionFileLockPath(path),
      `${JSON.stringify({ pid: process.ppid, acquiredAt: Date.now() })}\n`
    );
    assert.match(
      (await renameStoredSession(root, sessionId, "other-name")) ?? "",
      /open in another Pigeon \(pid \d+\)/
    );
    assert.equal(storedSessionName(root, sessionId)?.name, "login-fix");
    assert.match((await renameStoredSession(root, "sess_missing", "x")) ?? "", /session not found/);
  }));
