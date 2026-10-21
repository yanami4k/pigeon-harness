// 决策 485：会话面板的工作清单——会话池里开着的加上用户级清单里本进程没开的（不分工作区，当前会话不列）；本进程没开的写 idle、
// 摘要取会话记录最后一条回复，别的项目里的标目录，别的进程开着的标 open elsewhere（发不了话）；发话先开起来再发；偷看取会话记录
// 最近几句；去掉即删出清单；Ctrl+X 第一下不做事。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, test } from "vitest";
import { LocalSessionPool, type PooledRuntime } from "../application/session-pool.ts";
import { createFixtureSession } from "../application/session-store-fixtures.ts";
import { sessionsDirOf } from "../application/workspace.ts";
import {
  addToSessionIndex,
  type ListedSession,
  listSessionIndex,
} from "../persistence/session-index.ts";
import { WorkList } from "./work-list.ts";

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

async function storedSession(root: string, task: string, reply: string): Promise<string> {
  const session = createFixtureSession({ sessionsDir: sessionsDirOf(root), cwd: root });
  session.startRun({ task });
  session.assistant({ text: reply });
  return (await session.close()).sessionId;
}

function harness(home: string, currentRoot: string) {
  const runs: Array<[string, string]> = [];
  const opened: ListedSession[] = [];
  const tasks: string[] = [];
  const pool = new LocalSessionPool({
    open: async () => {
      throw new Error("unused");
    },
  });
  const list = new WorkList({
    pool,
    currentId: () => "sess_current",
    currentRoot: () => currentRoot,
    open: async (entry, task) => {
      opened.push(entry);
      tasks.push(task);
      const runtime: PooledRuntime = {
        sessionId: entry.sessionId,
        run: async (text) => {
          runs.push([entry.sessionId, text]);
        },
        interrupt: () => {},
        isRunning: () => false,
        transcript: () => [],
        close: async () => {},
      };
      pool.adopt(runtime, { name: "opened", task });
      return undefined;
    },
    placeOf: (id) => (id === "sess_far_open" ? "~/far" : undefined),
    notice: () => {},
    homeDir: home,
  });
  return { list, pool, runs, opened, tasks };
}

test("本进程没开的会话列成 idle 卡片：摘要取最后一条回复，别的项目的标目录；当前会话不列；发话先开起来再发；偷看取最近几句；去掉删出清单", async () => {
  const home = temp("pigeon-worklist-home-");
  const here = temp("pigeon-worklist-here-");
  const there = temp("pigeon-worklist-there-");
  const local = await storedSession(here, "修登录", "登录修好了");
  const remote = await storedSession(there, "查日志", "日志看过了");
  addToSessionIndex({ sessionId: local, governanceRoot: here, workspaceRoot: here }, home);
  addToSessionIndex({ sessionId: remote, governanceRoot: there, workspaceRoot: there }, home);
  addToSessionIndex({ sessionId: "sess_current", governanceRoot: here, workspaceRoot: here }, home);
  const { list, pool, runs, opened, tasks } = harness(home, here);
  list.refresh();
  const cards = list.list();
  assert.deepEqual(
    cards.map((card) => [card.id, card.state, card.task, card.summary]),
    [
      [local, "idle", "修登录", "登录修好了"],
      [remote, "idle", "查日志", "日志看过了"],
    ]
  );
  // 决策 489：每张卡都写它干活的目录（与当前会话的工作区相同时由面板省掉）
  const workspaceOf = (id: string) => cards.find((card) => card.id === id)?.workspace ?? "";
  assert.ok(workspaceOf(local).endsWith(basename(here)));
  assert.ok(workspaceOf(remote).endsWith(basename(there)));
  assert.ok(cards.every((card) => card.dormant === true));
  const peek = await list.peek(remote);
  assert.ok(peek.includes("> 查日志"));
  assert.ok(peek.includes("  日志看过了"));
  // Ctrl+X 第一下：没什么可停
  await list.stop(local);
  assert.equal(await list.send(local, "接着做"), undefined);
  assert.deepEqual(
    opened.map((entry) => entry.sessionId),
    [local]
  );
  assert.deepEqual(runs, [[local, "接着做"]]);
  assert.deepEqual(tasks, ["修登录"], "开起来的卡片带着首条输入");
  // 开着的别的项目的会话同样标目录
  pool.adopt(
    {
      sessionId: "sess_far_open",
      run: async () => {},
      interrupt: () => {},
      isRunning: () => false,
      transcript: () => [],
      close: async () => {},
    },
    { name: "far", task: "" }
  );
  assert.equal(list.list().find((card) => card.id === "sess_far_open")?.place, "~/far");
  await list.remove(remote);
  assert.ok(!listSessionIndex(home).some((entry) => entry.sessionId === remote));
  assert.ok(!list.list().some((card) => card.id === remote));
});

test("别的 Pigeon 进程开着的会话标 open elsewhere，发不了话", async () => {
  const home = temp("pigeon-worklist-home-");
  const root = temp("pigeon-worklist-root-");
  const id = await storedSession(root, "跑测试", "测试过了");
  addToSessionIndex({ sessionId: id, governanceRoot: root, workspaceRoot: root }, home);
  const file = listSessionIndex(home)[0]?.sessionFile ?? "";
  // 会话锁在一个还活着的别的进程手里（父进程）
  writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.ppid, acquiredAt: Date.now() }));
  const { list, opened } = harness(home, root);
  list.refresh();
  assert.equal(list.list()[0]?.elsewhere, true);
  assert.match((await list.send(id, "接着做")) ?? "", /is open elsewhere/);
  assert.deepEqual(opened, []);
});
