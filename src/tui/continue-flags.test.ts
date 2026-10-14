// 决策 286 第 5 项：续接会话不用抄 ID——pigeon --continue 接本项目最近的主会话；/resume 与 pigeon --resume 不带 ID 时
// 弹出会话列表（↑↓ 选、回车进、Esc 退；每行时间、首条输入摘要、轮数，沙箱会话加标记；worker 与复盘会话不列）；
// 带 ID 的用法保持不变。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { listRecentMainSessions } from "../application/recent-sessions.ts";
import { createFixtureSession, spawnFixtureWorker } from "../application/session-store-fixtures.ts";
import { git, initRepo } from "../application/tui-session-fixtures.ts";
import { newSessionId, type SessionId } from "../state/ids.ts";
import { resolveStartTarget, takeContinueFlags } from "./continue-flags.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell, type TuiSessionBinding } from "./shell.ts";
import { MockTerminal, screenFlat, screenText, settle, squashSpaces } from "./testing.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

// 一个主会话：跑 turns 轮，每轮一条输入
async function mainSession(
  sessionsDir: string,
  inputs: string[]
): Promise<{ sessionId: SessionId; path: string }> {
  const session = createFixtureSession({ sessionsDir });
  for (const input of inputs) {
    session.startRun({ task: input });
    session.assistant({ text: "好" });
    session.endRun();
  }
  await tick();
  return session.close();
}

async function makeProject(): Promise<{
  root: string;
  older: SessionId;
  olderPath: string;
  middle: SessionId;
  newest: SessionId;
  sandboxed: SessionId;
  cleanup: () => void;
}> {
  const root = mkdtempSync(join(tmpdir(), "pigeon-tui-continue-"));
  initRepo(root, { "a.txt": "a\n" });
  const sessionsDir = join(root, ".pigeon", "state", "sessions");
  const older = await mainSession(sessionsDir, ["最早的任务：修登录页\n第二行不显示"]);
  const middle = await mainSession(sessionsDir, ["中间的任务", "又一轮"]);
  // 中间的会话派过 worker（worker 会话不列）
  const withWorker = createFixtureSession({
    sessionsDir,
    sessionId: middle.sessionId,
    existingPath: middle.path,
  });
  withWorker.startRun({ task: "第三轮" });
  const worker = spawnFixtureWorker(withWorker, { sessionsDir, name: "w1", task: "worker 的任务" });
  worker.startRun({ task: "worker 的任务" });
  worker.endRun();
  await worker.close();
  withWorker.endRun();
  await withWorker.close();
  await tick();
  const sandboxed = await mainSession(sessionsDir, ["沙箱里的任务"]);
  git(root, ["branch", `pigeon/sandbox-${sandboxed.sessionId}`]);
  const newest = await mainSession(sessionsDir, ["最新的任务"]);
  // 复盘会话（从最新会话分叉，不列）
  const review = createFixtureSession({ sessionsDir, parentSessionId: newest.sessionId });
  review.startRun({ task: "复盘", config: { memoryReview: { kind: "closing", template: "t" } } });
  review.endRun();
  await review.close();
  return {
    root,
    older: older.sessionId,
    olderPath: older.path,
    middle: middle.sessionId,
    newest: newest.sessionId,
    sandboxed: sandboxed.sessionId,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("启动参数：--continue、--resume <id>、--resume 不带 id；两者互斥，其余参数原样交出", () => {
  assert.deepEqual(takeContinueFlags(["--yolo", "--continue", "--model", "m"]), {
    argv: ["--yolo", "--model", "m"],
    mode: { kind: "continue" },
  });
  assert.deepEqual(takeContinueFlags(["--resume", "01ABC", "--yolo"]), {
    argv: ["--yolo"],
    mode: { kind: "resume", sessionId: "01ABC" },
  });
  assert.deepEqual(takeContinueFlags(["--resume", "--yolo"]), {
    argv: ["--yolo"],
    mode: { kind: "resume" },
  });
  assert.deepEqual(takeContinueFlags(["--yolo"]), { argv: ["--yolo"], mode: { kind: "new" } });
  assert.throws(() => takeContinueFlags(["--continue", "--resume"]), /can't be used with/);
});

test("会话列表只列主会话（worker、复盘不列），按最近活动从新到旧，带首条输入、轮数与沙箱标记", async () => {
  const project = await makeProject();
  try {
    const sessions = listRecentMainSessions(project.root);
    assert.deepEqual(
      sessions.map((session) => session.sessionId),
      [project.newest, project.sandboxed, project.middle, project.older]
    );
    const middle = sessions.find((session) => session.sessionId === project.middle);
    assert.equal(middle?.turns, 3);
    assert.equal(middle?.firstInput, "中间的任务");
    const older = sessions.find((session) => session.sessionId === project.older);
    assert.equal(older?.firstInput, "最早的任务：修登录页 第二行不显示");
    assert.deepEqual(
      sessions.filter((session) => session.sandbox).map((session) => session.sessionId),
      [project.sandboxed]
    );
  } finally {
    project.cleanup();
  }
});

test("--continue 接本项目最近的主会话（本机启动不接沙箱会话，--sandbox 只接沙箱会话）；没有时开新会话", async () => {
  const project = await makeProject();
  try {
    const host = resolveStartTarget(project.root, { kind: "continue" }, false);
    assert.equal(host.kind, "resume");
    assert.equal(host.kind === "resume" ? host.sessionId : "", project.newest);
    // 续接报告只在有悬空的工具调用时写一行（这里没有）
    assert.deepEqual(host.kind === "resume" ? host.report : undefined, []);
    const sandbox = resolveStartTarget(project.root, { kind: "continue" }, true);
    assert.equal(sandbox.kind === "resume" ? sandbox.sessionId : "", project.sandboxed);

    // 最旧的会话又被续聊：它成了最近的
    const sessionsDir = join(project.root, ".pigeon", "state", "sessions");
    const reopened = createFixtureSession({
      sessionsDir,
      sessionId: project.older,
      existingPath: project.olderPath,
    });
    await tick();
    reopened.startRun({ task: "续聊一轮" });
    reopened.endRun();
    await reopened.close();
    const after = resolveStartTarget(project.root, { kind: "continue" }, false);
    assert.equal(after.kind === "resume" ? after.sessionId : "", project.older);
  } finally {
    project.cleanup();
  }
  const empty = mkdtempSync(join(tmpdir(), "pigeon-tui-continue-empty-"));
  try {
    const target = resolveStartTarget(empty, { kind: "continue" }, false);
    assert.deepEqual(target, {
      kind: "new",
      picker: false,
      note: "no session to continue; started a new session",
    });
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("--resume <id> 照旧直接续接；沙箱与本机不混用；不存在的会话在启动前报错；--resume 不带 id 开壳后弹列表", async () => {
  const project = await makeProject();
  try {
    const target = resolveStartTarget(
      project.root,
      { kind: "resume", sessionId: project.middle },
      false
    );
    assert.equal(target.kind === "resume" ? target.sessionId : "", project.middle);
    assert.throws(
      () =>
        resolveStartTarget(project.root, { kind: "resume", sessionId: project.sandboxed }, false),
      /is a sandbox session; resume with: pigeon --sandbox --resume/
    );
    assert.throws(
      () => resolveStartTarget(project.root, { kind: "resume", sessionId: project.middle }, true),
      /is not a sandbox session/
    );
    assert.throws(
      () => resolveStartTarget(project.root, { kind: "resume", sessionId: newSessionId() }, false),
      /session not found/
    );
    assert.deepEqual(resolveStartTarget(project.root, { kind: "resume" }, false), {
      kind: "new",
      picker: true,
    });
    assert.throws(
      () => resolveStartTarget(project.root, { kind: "resume" }, true),
      /needs a session ID/
    );
  } finally {
    project.cleanup();
  }
});

function makeResumeShell(
  root: string,
  rows = 80
): {
  shell: PigeonTuiShell;
  term: MockTerminal;
  rebinds: SessionId[];
  cleanup: () => void;
} {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-picker-log-"));
  const sessionId = newSessionId();
  const term = new MockTerminal(120, rows);
  const rebinds: SessionId[] = [];
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime: new ScriptedRuntime(sessionId),
    sessionId,
    logDir,
    sessions: { root },
    resume: {
      root,
      rebind: (target): TuiSessionBinding => {
        rebinds.push(target);
        return { runtime: new ScriptedRuntime(target) };
      },
    },
  });
  return {
    shell,
    term,
    rebinds,
    cleanup: () => {
      shell.stop();
      rmSync(logDir, { recursive: true, force: true });
    },
  };
}

test("矮窗口里 /resume 的列表不被布局按比例压掉：提示行与各会话都在，行数不够时随选中项滚动", async () => {
  const project = await makeProject();
  // 16 行：标题、状态行、输入框与状态栏之外只够放提示行和几行列表（此前选择器被压到只剩提示行）
  const { shell, term, rebinds, cleanup } = makeResumeShell(project.root, 16);
  try {
    shell.start();
    await settle();
    term.input("/resume");
    term.input("\r");
    await settle();
    const listed = screenText(term);
    assert.ok(listed.includes("resume a session"), listed);
    assert.ok(listed.includes("> "), listed);
    assert.ok(listed.includes("1 turns  最新的任务"), listed);
    assert.ok(listed.includes("3 turns  中间的任务"), listed);
    // 12 行：列表只剩几行，往下选时跟着滚，选中的那项照样看得见、回车照样进
    cleanup();
    const short = makeResumeShell(project.root, 12);
    try {
      short.shell.start();
      await settle();
      short.term.input("/resume");
      short.term.input("\r");
      await settle();
      assert.ok(screenText(short.term).includes("> "), screenText(short.term));
      short.term.input("\x1b[B");
      short.term.input("\x1b[B");
      short.term.input("\x1b[B");
      await settle();
      assert.ok(screenText(short.term).includes("最早的任务"), screenText(short.term));
      short.term.input("\r");
      await settle();
      assert.deepEqual(short.rebinds, [project.older]);
    } finally {
      short.cleanup();
    }
    assert.deepEqual(rebinds, []);
  } finally {
    project.cleanup();
  }
});

test("决策 471：续接视图打开之后窗口变矮：行数按当前窗口高度现取，选中项保留、往下选照样看得见；回车续接并回到主视图", async () => {
  const project = await makeProject();
  // 再加 8 个会话（共 12 个可选）：40 行时列表显示 10 行，缩到 14 行后只放得下 6 行
  for (let index = 0; index < 8; index += 1) {
    await mainSession(join(project.root, ".pigeon", "state", "sessions"), [`补充的任务 ${index}`]);
  }
  const { shell, term, rebinds, cleanup } = makeResumeShell(project.root, 40);
  try {
    shell.start();
    await settle();
    term.input("/resume");
    term.input("\r");
    await settle();
    term.input("\x1b[B");
    await settle();
    const selected = term.screen.contentLines().find((line) => line.startsWith("> "));
    assert.ok(selected !== undefined);
    term.resize(120, 14);
    await settle();
    const lines = term.screen.contentLines();
    // 整屏视图：没有输入框
    assert.equal(shell.currentView(), "resume");
    assert.equal(lines.filter((line) => /^-{20,}/.test(line)).length, 0, lines.join("\n"));
    // 选中项保留
    assert.ok(lines.includes(selected), lines.join("\n"));
    for (let index = 0; index < 10; index += 1) term.input("\x1b[B");
    await settle();
    assert.ok(screenText(term).includes("最早的任务"), screenText(term));
    term.input("\r");
    await settle();
    assert.deepEqual(rebinds, [project.older]);
    assert.equal(shell.currentView(), "main");
  } finally {
    cleanup();
    project.cleanup();
  }
});

test("决策 471：/resume 打开整屏的续接视图；打字即筛选；Esc 先清筛选词、再回主视图（不续接）", async () => {
  const project = await makeProject();
  const { shell, term, rebinds, cleanup } = makeResumeShell(project.root, 30);
  try {
    shell.start();
    await settle();
    term.input("/resume");
    term.input("\r");
    await settle();
    assert.equal(shell.currentView(), "resume");
    assert.match(screenText(term), /resume a session/);
    assert.equal(term.screen.contentLines().filter((line) => /^-{20,}/.test(line)).length, 0);
    term.input("最早");
    await settle(300);
    assert.match(screenText(term), /filter: 最早/);
    assert.match(screenText(term), /最早的任务/);
    term.input("\x1b");
    await settle();
    assert.equal(shell.currentView(), "resume", "第一下 Esc 只清筛选词");
    assert.doesNotMatch(screenText(term), /filter:/);
    term.input("\x1b");
    await settle();
    assert.equal(shell.currentView(), "main");
    assert.deepEqual(rebinds, []);
    // 再打开照样是整屏视图
    term.input("/resume");
    term.input("\r");
    await settle();
    assert.equal(shell.currentView(), "resume");
  } finally {
    cleanup();
    project.cleanup();
  }
});

test("/resume 不带 ID 弹出会话列表：↑↓ 选、回车进（照 /resume <id> 换绑）、Esc 退；沙箱会话标记且不在本机续接", async () => {
  const project = await makeProject();
  const { shell, term, rebinds, cleanup } = makeResumeShell(project.root);
  try {
    shell.start();
    await settle();
    term.input("/resume");
    term.input("\r");
    await settle();
    const listed = screenText(term);
    assert.ok(listed.includes("resume a session"), listed);
    assert.ok(!listed.includes("up/down"), "列表头不写按键");
    assert.ok(listed.includes("> "), listed);
    assert.ok(listed.includes("1 turns  最新的任务"), listed);
    assert.ok(listed.includes("1 turns [sandbox]  沙箱里的任务"), listed);
    assert.ok(listed.includes("3 turns  中间的任务"), listed);
    assert.ok(!listed.includes("worker 的任务"), "worker 会话不列");
    assert.ok(!listed.includes("复盘"), "复盘会话不列");

    // Esc 退出：不换绑
    term.input("\x1b");
    await settle();
    assert.ok(!screenFlat(term).includes("已取消选择会话"), "Esc 退出不说");
    assert.deepEqual(rebinds, []);

    // ↓ 两次到"中间的任务"，回车进
    term.input("/resume");
    term.input("\r");
    await settle();
    term.input("\x1b[B");
    term.input("\x1b[B");
    term.input("\x1b[A");
    term.input("\x1b[B");
    term.input("\r");
    await settle();
    assert.deepEqual(rebinds, [project.middle]);
    assert.ok(screenFlat(term).includes("--- resumed ---"), screenText(term));

    // 选沙箱会话：给出用法，不换绑
    term.input("/resume");
    term.input("\r");
    await settle();
    term.input("\x1b[B");
    term.input("\r");
    await settle();
    assert.ok(
      squashSpaces(screenFlat(term)).includes(
        squashSpaces(`resume with: pigeon --sandbox --resume ${project.sandboxed}`)
      ),
      screenText(term)
    );
    assert.deepEqual(rebinds, [project.middle]);

    // 带 ID 的用法保持不变
    term.input(`/resume ${project.older}`);
    term.input("\r");
    await settle();
    assert.deepEqual(rebinds, [project.middle, project.older]);
  } finally {
    cleanup();
    project.cleanup();
  }
});

test("启动时 --resume 不带 ID：壳一开就弹列表；没有可续接的会话时如实说明", async () => {
  const empty = mkdtempSync(join(tmpdir(), "pigeon-tui-picker-empty-"));
  const { shell, term, cleanup } = makeResumeShell(empty);
  try {
    shell.start();
    shell.openSessionPicker();
    await settle();
    assert.ok(screenFlat(term).includes("no sessions to resume"));
  } finally {
    cleanup();
    rmSync(empty, { recursive: true, force: true });
  }
});
