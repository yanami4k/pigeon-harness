// 决策 485：用户级的会话工作清单——加入（已在的更新、加入时刻不变）、删出、列出时剔除会话文件已不在的、文件畸形按空清单、
// 与按加入先后排列。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { newSessionId } from "../state/ids.ts";
import { sessionIndexPathOf, sessionsDirOf, userStateDir } from "../state/paths.ts";
import {
  addToSessionIndex,
  listSessionIndex,
  removeFromSessionIndex,
  sessionIndexed,
} from "./session-index.ts";
import { sessionFileName } from "./session-reader.ts";

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

// 在治理根下放一个会话文件
function sessionFile(root: string): { id: string; file: string } {
  const id = newSessionId();
  const dir = join(sessionsDirOf(root), "--work--");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, sessionFileName(Date.now(), id));
  writeFileSync(file, "");
  return { id, file };
}

test("加入、更新、删出；列出带会话文件，会话文件已不在的剔除", () => {
  const home = temp("pigeon-index-home-");
  const rootA = temp("pigeon-index-a-");
  const rootB = temp("pigeon-index-b-");
  const first = sessionFile(rootA);
  const second = sessionFile(rootB);
  addToSessionIndex(
    { sessionId: first.id, governanceRoot: rootA, workspaceRoot: rootA, addedAt: 1 },
    home
  );
  addToSessionIndex(
    { sessionId: second.id, governanceRoot: rootB, workspaceRoot: rootB, addedAt: 2 },
    home
  );
  // 已在的：工作区更新，加入时刻不变
  addToSessionIndex(
    { sessionId: first.id, governanceRoot: rootA, workspaceRoot: join(rootA, "wt"), addedAt: 9 },
    home
  );
  const listed = listSessionIndex(home);
  assert.deepEqual(
    listed.map((item) => [item.sessionId, item.addedAt, item.sessionFile]),
    [
      [first.id, 1, first.file],
      [second.id, 2, second.file],
    ]
  );
  assert.equal(listed[0]?.workspaceRoot, join(rootA, "wt"));
  // 会话文件没了：列出时不再有它
  rmSync(second.file);
  assert.deepEqual(
    listSessionIndex(home).map((item) => item.sessionId),
    [first.id]
  );
  removeFromSessionIndex(first.id, home);
  removeFromSessionIndex("no_such", home);
  assert.deepEqual(listSessionIndex(home), []);
});

test("文件畸形按空清单，下次写入即重写", () => {
  const home = temp("pigeon-index-home-");
  const root = temp("pigeon-index-root-");
  mkdirSync(userStateDir(home), { recursive: true });
  writeFileSync(sessionIndexPathOf(home), "{not json");
  assert.deepEqual(listSessionIndex(home), []);
  const session = sessionFile(root);
  addToSessionIndex({ sessionId: session.id, governanceRoot: root, workspaceRoot: root }, home);
  assert.deepEqual(
    listSessionIndex(home).map((item) => item.sessionId),
    [session.id]
  );
});

test("记进清单时，会话文件已不在的别的行顺手去掉", () => {
  const home = temp("pigeon-index-home-");
  const root = temp("pigeon-index-root-");
  const gone = sessionFile(root);
  const kept = sessionFile(root);
  addToSessionIndex({ sessionId: gone.id, governanceRoot: root, workspaceRoot: root }, home);
  addToSessionIndex({ sessionId: kept.id, governanceRoot: root, workspaceRoot: root }, home);
  rmSync(gone.file);
  assert.equal(sessionIndexed(gone.id, home), true, "只是列出时不列，行还在");
  const fresh = sessionFile(root);
  addToSessionIndex({ sessionId: fresh.id, governanceRoot: root, workspaceRoot: root }, home);
  assert.equal(sessionIndexed(gone.id, home), false);
  assert.equal(sessionIndexed(kept.id, home), true);
});
