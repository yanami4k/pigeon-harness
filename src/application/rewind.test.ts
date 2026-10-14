// 决策 433–438：会话回退与切换分支（运行面与终端界面同一条装配路径，假模型，临时 git 仓库）。
// 发消息时拍快照；消息树列出人发的消息与分支末端；退两者：只还原 agent 改过的文件、agent 新建的删掉、手改不碰、
// 对话换成目标分支；切回原分支后文件逐字节一致（行尾转换开与不开都是）；agent 改后又被手改的列为冲突、缺省保留；
// 被忽略的文件不动；没有快照的会话只退对话；授权沿用切换前的状态并在目标分支补记；花费按全部分支。
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { SnapshotTrees } from "../orchestration/rewind-restore.ts";
import type { SessionFileView } from "../persistence/session-reader.ts";
import { pruneSeedFromEntries } from "../pi-runtime/context-prune.ts";
import type { FakeReply } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { TRUNCATION_RESUME_PROMPT } from "../state/runaway-config.ts";
import { SessionEntryType } from "../state/session-entries.ts";
import type { SettingsSnapshot } from "../state/settings.ts";
import {
  JOB_NOTICE_PREFIX,
  LEGACY_JOB_NOTICE_PREFIX,
  previousJobsOfSession,
} from "./background-jobs.ts";
import { PROGRAM_NOTE_PREFIX, worktreeContinueNotice } from "./enter-worktree-tool.ts";
import { noMcpSession } from "./mcp.ts";
import type { NamedWorktree } from "./named-worktree.ts";
import {
  applyRewind,
  checkCode,
  classifyPlan,
  humanInputText,
  isHumanInput,
  loadRewindTree,
  planRewind,
  prepareRewind,
  prepareUndo,
  type RewindHost,
  type RewindNode,
  rewindTree,
} from "./rewind.ts";
import { sessionCostTally } from "./session-cost.ts";
import { type OpenedSessionRuntime, openSessionRuntime } from "./session-runtime.ts";
import { statusFromEntries } from "./status-block.ts";
import {
  git,
  initRepo,
  mainEntries,
  routedModel,
  tempRoot,
  textOf,
} from "./tui-session-fixtures.ts";
import { sessionsDirOf } from "./workspace.ts";

// 已删除的 /orchestrate 当年交给模型的包装（旧会话里的样子）
function commandInputText(task: string): string {
  return `(The user started this with /orchestrate, asking for it to be done with script orchestration, "script orchestration".)\n${task}`;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const write = (path: string, content: string) => ({
  text: "写",
  toolCalls: [{ name: "write_file", args: { path, content } }],
});

// 覆盖已有文件：write_file 要求本会话先读过
const overwrite = (path: string, content: string) => ({
  text: "改",
  toolCalls: [
    { name: "read_file", args: { path } },
    { name: "write_file", args: { path, content } },
  ],
});

const lastText = (messages: readonly unknown[]) =>
  textOf((messages.at(-1) ?? {}) as { content?: unknown });

async function openSession(
  root: string,
  replies: FakeReply[],
  options: { turnSnapshots?: boolean; settings?: SettingsSnapshot } = {}
) {
  const { streamFn, calls } = routedModel({ main: replies });
  const sessionId = newSessionId();
  const opened: OpenedSessionRuntime = await openSessionRuntime({
    governanceRoot: root,
    sessionId,
    streamFn,
    turnSnapshots: options.turnSnapshots ?? true,
    ...(options.settings !== undefined ? { settings: options.settings } : {}),
    flags: { yolo: true, provider: "custom", modelId: "custom", persistThinking: true },
    homeDir: root,
    startMcp: noMcpSession,
  });
  const bundle = opened.bundle;
  cleanups.push(async () => {
    await opened.checkpoints?.close();
    await bundle.sessionStore.close();
  });
  const host: RewindHost = {
    workspaceRoot: root,
    sessionStore: bundle.sessionStore,
    ...(opened.checkpoints !== undefined ? { checkpoints: opened.checkpoints } : {}),
    adapter: bundle.adapter,
    status: bundle.status,
    prune: bundle.prune,
    ...(bundle.taskList !== undefined ? { taskList: bundle.taskList } : {}),
    grants: bundle.grantStore,
  };
  return { sessionId, bundle, opened, host, calls };
}

function repo(autocrlf: boolean): string {
  const { root, cleanup } = tempRoot("pigeon-rewind-");
  cleanups.push(cleanup);
  initRepo(root, { "a.txt": "one\n", "m.txt": "mine\n" });
  git(root, ["config", "core.autocrlf", autocrlf ? "true" : "false"]);
  return root;
}

const bytes = (root: string, path: string) => readFileSync(join(root, path));

function messageNode(nodes: RewindNode[], text: string): RewindNode {
  const node = nodes.find((item) => item.kind === "message" && item.text === text);
  assert.ok(node !== undefined, `消息树里有"${text}"`);
  return node;
}

for (const autocrlf of [false, true]) {
  test(`改—退—切回：只退 agent 改过的、新建的删掉、手改不碰；切回原分支文件逐字节一致（core.autocrlf=${autocrlf}）`, async () => {
    const root = repo(autocrlf);
    const { bundle, host } = await openSession(root, [
      overwrite("a.txt", "two\n"),
      { text: "第一条做完" },
      overwrite("a.txt", "three\n"),
      write("d/new.txt", "N\r\nmixed\n"),
      { text: "第二条做完" },
    ]);
    await bundle.adapter.run("first");
    // 两条消息之间的手改：agent 没碰过的文件（等第一条的快照拍完，手改不混进 agent 的改动）
    await host.checkpoints?.settle();
    writeFileSync(join(root, "m.txt"), "mine, edited\n");
    writeFileSync(join(root, "c.txt"), "hand made\n");
    await bundle.adapter.run("second");
    await host.checkpoints?.settle();
    const after = {
      a: bytes(root, "a.txt"),
      n: bytes(root, "d/new.txt"),
    };
    // 发消息时的快照记在各自的 Run 上
    const turns = mainEntries(root, bundle.adapter.sessionId).filter(
      (entry) => entry.type === "custom" && entry.customType === SessionEntryType.TurnSnapshot
    );
    assert.equal(turns.length, 2);

    const tree = await loadRewindTree(host);
    assert.deepEqual(
      tree.map((node) => [node.kind, node.text, node.current]),
      [
        ["message", "first", false],
        ["message", "second", false],
        ["tip", "第二条做完", true],
      ]
    );
    const second = messageNode(tree, "second");
    assert.equal(second.prefill, "second");
    const prepared = await prepareRewind(host, second.target);
    assert.deepEqual(
      prepared.plan.files.map((file) => file.path),
      ["a.txt", "d/new.txt"]
    );
    const code = await checkCode(host, prepared);
    assert.equal(code.classified.conflicts.length, 0);
    const outcome = await applyRewind(host, prepared, { mode: "both", code });
    assert.deepEqual(outcome.restore?.written, ["a.txt"]);
    assert.deepEqual(outcome.restore?.removed, ["d/new.txt"]);
    assert.equal(readFileSync(join(root, "a.txt"), "utf8").replace(/\r\n/g, "\n"), "two\n");
    assert.equal(existsSync(join(root, "d")), false, "agent 新建的目录删空即删");
    assert.equal(readFileSync(join(root, "m.txt"), "utf8"), "mine, edited\n", "手改不碰");
    assert.equal(readFileSync(join(root, "c.txt"), "utf8"), "hand made\n", "手建不碰");
    // 对话换成目标分支：最后一条是第一条的回复
    const transcript = bundle.adapter.transcript();
    assert.equal(lastText(transcript), "第一条做完");
    assert.ok(!transcript.some((message) => textOf(message as { content?: unknown }) === "second"));

    // 切回原分支的末端
    const back = (await loadRewindTree(host)).find(
      (node) => node.kind === "tip" && node.text === "第二条做完"
    );
    assert.ok(back !== undefined && !back.current);
    const again = await prepareRewind(host, back.target);
    const againCode = await checkCode(host, again);
    assert.equal(againCode.classified.conflicts.length, 0);
    await applyRewind(host, again, { mode: "both", code: againCode });
    assert.deepEqual(bytes(root, "a.txt"), after.a, "a.txt 逐字节一致");
    assert.deepEqual(bytes(root, "d/new.txt"), after.n, "d/new.txt 逐字节一致");
    assert.equal(readFileSync(join(root, "m.txt"), "utf8"), "mine, edited\n");
    assert.equal(lastText(bundle.adapter.transcript()), "第二条做完");
  });
}

test("agent 改后又被手改的列为冲突：缺省保留，选了才退；被忽略的文件不动", async () => {
  const root = repo(false);
  writeFileSync(join(root, ".gitignore"), ".pigeon/\nbuild/\n");
  const { bundle, host } = await openSession(root, [
    { text: "第一条做完" },
    overwrite("a.txt", "agent\n"),
    write("b.txt", "agent b\n"),
    write("build/out.log", "ignored output\n"),
    { text: "第二条做完" },
  ]);
  await bundle.adapter.run("first");
  await bundle.adapter.run("second");
  await host.checkpoints?.settle();
  writeFileSync(join(root, "a.txt"), "agent, then hand\n");
  const tree = await loadRewindTree(host);
  const prepared = await prepareRewind(host, messageNode(tree, "second").target);
  assert.ok(!prepared.plan.files.some((file) => file.path.startsWith("build/")));
  const code = await checkCode(host, prepared);
  assert.deepEqual(
    code.classified.conflicts.map((action) => action.path),
    ["a.txt"]
  );
  const outcome = await applyRewind(host, prepared, { mode: "code", code });
  assert.deepEqual(outcome.kept, ["a.txt"]);
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "agent, then hand\n", "缺省保留");
  assert.equal(existsSync(join(root, "b.txt")), false);
  assert.equal(readFileSync(join(root, "build/out.log"), "utf8"), "ignored output\n");
  // 只退代码：对话不动
  assert.equal(lastText(bundle.adapter.transcript()), "第二条做完");

  // 再退一次、选了退回：手改的那份也退
  const again = await prepareRewind(host, messageNode(await loadRewindTree(host), "second").target);
  const againCode = await checkCode(host, again);
  assert.deepEqual(
    againCode.classified.conflicts.map((action) => action.path),
    ["a.txt"]
  );
  await applyRewind(host, again, { mode: "code", code: againCode, revert: new Set(["a.txt"]) });
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "one\n");
});

test("没有快照的会话（非 git 工作区）只退对话；退对话后原消息可再发；切回再退不留多余的末端；状态块与裁剪起点按目标分支重设", async () => {
  const { root, cleanup } = tempRoot("pigeon-rewind-plain-");
  cleanups.push(cleanup);
  mkdirSync(join(root, "src"));
  const { bundle, host } = await openSession(root, [
    { text: "第一条做完" },
    { text: "第二条做完" },
    { text: "第三条" },
    { text: "重发之后" },
  ]);
  const reseeds: string[] = [];
  const watched: RewindHost = {
    ...host,
    status: {
      reseed: (value) => {
        reseeds.push(`status:${JSON.stringify(value)}`);
        host.status.reseed(value);
      },
    },
    prune: {
      reseed: (value) => {
        reseeds.push(`prune:${JSON.stringify(value)}`);
        host.prune.reseed(value);
      },
    },
  };
  assert.equal(host.checkpoints, undefined);
  await bundle.adapter.run("first");
  await bundle.adapter.run("second");
  const tree = await loadRewindTree(watched);
  const prepared = await prepareRewind(watched, messageNode(tree, "second").target);
  assert.deepEqual(prepared.plan.files, []);
  await assert.rejects(() => checkCode(watched, prepared), /conversation only/);
  // 选点之后又有了新内容：不按旧规划做
  await bundle.adapter.run("third");
  await assert.rejects(
    () => applyRewind(watched, prepared, { mode: "conversation" }),
    /session changed after/
  );
  const fresh = await prepareRewind(
    watched,
    messageNode(await loadRewindTree(watched), "second").target
  );
  await applyRewind(watched, fresh, { mode: "conversation" });
  const main = mainEntries(root, bundle.adapter.sessionId);
  assert.deepEqual(reseeds, [
    `status:${JSON.stringify(statusFromEntries(main))}`,
    `prune:${JSON.stringify(pruneSeedFromEntries(main))}`,
  ]);
  // 切回原分支的末端再退回来：中间留下的回退条目不成为多余的末端
  const tip = (await loadRewindTree(watched)).find((node) => node.kind === "tip" && !node.current);
  assert.ok(tip !== undefined);
  await applyRewind(watched, await prepareRewind(watched, tip.target), { mode: "conversation" });
  await applyRewind(
    watched,
    await prepareRewind(watched, messageNode(await loadRewindTree(watched), "second").target),
    { mode: "conversation" }
  );
  await bundle.adapter.run("second, rewritten");
  const nodes = await loadRewindTree(watched);
  // 两条分支：原来的 second（与 third）与重发的
  assert.deepEqual(
    nodes.map((node) => [node.kind, node.text, node.depth]),
    [
      ["message", "first", 0],
      ["message", "second", 1],
      ["message", "third", 1],
      ["tip", "第三条", 1],
      ["message", "second, rewritten", 1],
      ["tip", "重发之后", 1],
    ]
  );
  // 同一深度分不出分叉与链：parent 记上一条消息（界面按它画连接线）
  const textOf = new Map(nodes.map((node) => [node.key, node.text]));
  assert.deepEqual(
    nodes.map((node) => [node.text, node.parent === null ? null : textOf.get(node.parent)]),
    [
      ["first", null],
      ["second", "first"],
      ["third", "second"],
      ["第三条", "third"],
      ["second, rewritten", "first"],
      ["重发之后", "second, rewritten"],
    ]
  );
  assert.equal(nodes.at(-1)?.current, true);
});

test("一个 Run 最后那份快照的条目落在下一个 Run 之后也认得：退到最早一条之前时它改的照样退", async () => {
  const root = repo(false);
  const { bundle, host } = await openSession(root, [
    write("x.txt", "x\n"),
    { text: "一" },
    write("y.txt", "y\n"),
    { text: "二" },
    { text: "重发" },
  ]);
  // 两条之间不等快照：第一条的快照条目通常写在第二条开始之后
  await bundle.adapter.run("first");
  await bundle.adapter.run("second");
  const second = messageNode(await loadRewindTree(host), "second");
  let prepared = await prepareRewind(host, second.target);
  await applyRewind(host, prepared, { mode: "both", code: await checkCode(host, prepared) });
  assert.equal(existsSync(join(root, "y.txt")), false);
  assert.equal(existsSync(join(root, "x.txt")), true);
  await bundle.adapter.run("second again");
  prepared = await prepareRewind(host, messageNode(await loadRewindTree(host), "first").target);
  assert.deepEqual(
    prepared.plan.files.map((file) => file.path),
    ["x.txt"]
  );
  await applyRewind(host, prepared, { mode: "both", code: await checkCode(host, prepared) });
  assert.equal(existsSync(join(root, "x.txt")), false);
});

test("授权沿用切换前的状态：回退点之后给的照样有效、撤过的照样撤销，目标分支上补记", async () => {
  const { root, cleanup } = tempRoot("pigeon-rewind-grants-");
  cleanups.push(cleanup);
  const { bundle, host } = await openSession(root, [{ text: "一" }, { text: "二" }]);
  const early = bundle.grantStore.create({
    tool: "run_command",
    command: "npm test",
    firstCall: { toolCallId: "c0", args: { command: "npm test" } },
  });
  await bundle.adapter.run("first");
  const late = bundle.grantStore.create({
    tool: "run_command",
    command: "npm run build",
    firstCall: { toolCallId: "c1", args: { command: "npm run build" } },
  });
  bundle.grantStore.revoke(early.grantId);
  await bundle.adapter.run("second");
  const prepared = await prepareRewind(
    host,
    messageNode(await loadRewindTree(host), "first").target
  );
  const outcome = await applyRewind(host, prepared, { mode: "conversation" });
  assert.equal(outcome.grantsAdded, 1);
  assert.equal(outcome.grantsRevoked, 1);
  const { loadStoreSession } = await import("../persistence/session-view.ts");
  const { storeActiveGrants } = await import("../state/session-judge.ts");
  const loaded = loadStoreSession(sessionsDirOf(root), bundle.adapter.sessionId);
  assert.ok(loaded !== undefined);
  assert.deepEqual(
    storeActiveGrants(loaded.view).map((grant) => grant.grantId),
    [late.grantId]
  );
  assert.deepEqual(
    bundle.grantStore.list().map((grant) => grant.grantId),
    [late.grantId]
  );
});

test("会话花费按全部分支统计：回退之后旧分支上花的照算", async () => {
  const { root, cleanup } = tempRoot("pigeon-rewind-cost-");
  cleanups.push(cleanup);
  const { bundle, host } = await openSession(root, [{ text: "一" }, { text: "二" }]);
  await bundle.adapter.run("first");
  await bundle.adapter.run("second");
  await bundle.sessionStore.flush();
  const before = sessionCostTally(sessionsDirOf(root), bundle.adapter.sessionId);
  const prepared = await prepareRewind(
    host,
    messageNode(await loadRewindTree(host), "second").target
  );
  await applyRewind(host, prepared, { mode: "conversation" });
  const after = sessionCostTally(sessionsDirOf(root), bundle.adapter.sessionId);
  assert.ok(before.pricedTokens + before.unpricedTokens > 0);
  assert.deepEqual(after, before);
});

test("续跑时作业号按全部分支编号，丢失的作业只看主分支", () => {
  const job = (jobId: string, event: "started" | "ended") => ({
    type: "custom",
    customType: SessionEntryType.BackgroundJob,
    data: {
      version: 1,
      event,
      jobId,
      command: "sleep",
      ...(event === "started"
        ? { marker: "m", output: "o" }
        : { state: "exited", exitCode: 0, outputBytes: 0 }),
    },
  });
  const main = [job("j1", "started"), job("j1", "ended"), job("j2", "started")];
  const dead = [job("j5", "started")];
  const seeded = previousJobsOfSession(main, [...main, ...dead]);
  assert.equal(seeded.lastId, 5);
  assert.deepEqual(
    seeded.lost.map((item) => item.jobId),
    ["j2"]
  );
});

// ---- 审查修正 ----

test("agent 改 .gitignore 放出原本被忽略的文件：退代码不删它（列为拿不准、缺省保留）", async () => {
  const root = repo(false);
  writeFileSync(join(root, ".gitignore"), ".pigeon/\n.env\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "ignore env"]);
  writeFileSync(join(root, ".env"), "SECRET=1\n");
  const { bundle, host } = await openSession(root, [
    overwrite(".gitignore", ".pigeon/\n"),
    { text: "改了忽略规则" },
  ]);
  await bundle.adapter.run("first");
  await host.checkpoints?.settle();
  const prepared = await prepareRewind(
    host,
    messageNode(await loadRewindTree(host), "first").target
  );
  const code = await checkCode(host, prepared);
  assert.deepEqual(
    code.classified.conflicts.map((action) => [action.path, action.reason]),
    [[".env", "ignore rules changed in this range; unsure to delete"]]
  );
  const outcome = await applyRewind(host, prepared, { mode: "code", code });
  assert.deepEqual(outcome.restore?.written, [".gitignore"]);
  assert.deepEqual(outcome.kept, [".env"]);
  assert.equal(readFileSync(join(root, ".env"), "utf8"), "SECRET=1\n", "使用者原有的文件不删");
});

test("快照记为过大没收的文件：agent 把它改小之后退代码也不删不写", async () => {
  const root = repo(false);
  mkdirSync(join(root, ".pigeon"), { recursive: true });
  writeFileSync(
    join(root, ".pigeon", "settings.json"),
    JSON.stringify({ snapshot: { untrackedFileMaxBytes: 64 } })
  );
  writeFileSync(join(root, "big.bin"), "x".repeat(200));
  const { loadSettings } = await import("../persistence/settings.ts");
  const { bundle, host } = await openSession(
    root,
    [overwrite("big.bin", "small\n"), { text: "改小了" }],
    { settings: loadSettings(root, { homeDir: root }) }
  );
  await bundle.adapter.run("first");
  await host.checkpoints?.settle();
  const prepared = await prepareRewind(
    host,
    messageNode(await loadRewindTree(host), "first").target
  );
  assert.deepEqual(prepared.plan.untouchable, ["big.bin"]);
  assert.deepEqual(prepared.plan.files, []);
  assert.equal(readFileSync(join(root, "big.bin"), "utf8"), "small\n");
});

test("写回中途出错（只读文件）：停在出错处，已写的照实记下，对话不退；撤销上次退代码回到原样", async () => {
  const root = repo(false);
  writeFileSync(join(root, "b.txt"), "bee\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "b"]);
  const { bundle, host } = await openSession(root, [
    overwrite("a.txt", "agent a\n"),
    overwrite("b.txt", "agent b\n"),
    { text: "改完" },
  ]);
  await bundle.adapter.run("first");
  await host.checkpoints?.settle();
  chmodSync(join(root, "b.txt"), 0o444);
  try {
    const prepared = await prepareRewind(
      host,
      messageNode(await loadRewindTree(host), "first").target
    );
    const outcome = await applyRewind(host, prepared, {
      mode: "both",
      code: await checkCode(host, prepared),
    });
    assert.equal(outcome.failed?.path, "b.txt");
    assert.deepEqual(outcome.restore?.written, ["a.txt"]);
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "one\n");
    assert.equal(lastText(bundle.adapter.transcript()), "改完", "对话没有退");
    const record = mainEntries(root, bundle.adapter.sessionId)
      .filter((entry) => entry.customType === SessionEntryType.Rewind)
      .at(-1)?.data as { written?: string[]; failed?: { path: string } };
    assert.deepEqual(record.written, ["a.txt"]);
    assert.equal(record.failed?.path, "b.txt");
  } finally {
    chmodSync(join(root, "b.txt"), 0o644);
  }
  // 出错之后 b.txt 又被人改过（与出错当时记下的样子不同）：撤销时列为冲突、缺省保留
  writeFileSync(join(root, "b.txt"), "edited after the failure\n");
  const undo = await prepareUndo(host);
  assert.ok(undo !== undefined);
  // 写到一半出错的那个也在撤销范围里
  assert.deepEqual(
    undo.plan.files.map((file) => file.path),
    ["a.txt", "b.txt"]
  );
  const undoCode = await checkCode(host, undo);
  assert.deepEqual(
    undoCode.classified.conflicts.map((action) => action.path),
    ["b.txt"]
  );
  const undone = await applyRewind(host, undo, { mode: "code", code: undoCode });
  assert.equal(undone.undo, true);
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "agent a\n");
  assert.equal(
    readFileSync(join(root, "b.txt"), "utf8"),
    "edited after the failure\n",
    "之后的改动保留"
  );
  assert.equal(await prepareUndo(host), undefined, "撤销之后不再有可撤销的");
});

test("只退代码之后在当前位置可撤销，回到退之前的样子", async () => {
  const root = repo(false);
  const { bundle, host } = await openSession(root, [
    overwrite("a.txt", "agent\n"),
    write("n.txt", "new\n"),
    { text: "改完" },
  ]);
  await bundle.adapter.run("first");
  await host.checkpoints?.settle();
  const prepared = await prepareRewind(
    host,
    messageNode(await loadRewindTree(host), "first").target
  );
  await applyRewind(host, prepared, { mode: "code", code: await checkCode(host, prepared) });
  assert.equal(existsSync(join(root, "n.txt")), false);
  const undo = await prepareUndo(host);
  assert.ok(undo !== undefined);
  await applyRewind(host, undo, { mode: "code", code: await checkCode(host, undo) });
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "agent\n");
  assert.equal(readFileSync(join(root, "n.txt"), "utf8"), "new\n");
});

test("回退点之后有消息没有发消息时的快照：只给退对话并说明原因", async () => {
  const root = repo(false);
  const { bundle, host } = await openSession(
    root,
    [overwrite("a.txt", "agent\n"), { text: "改完" }],
    { turnSnapshots: false }
  );
  await bundle.adapter.run("first");
  await host.checkpoints?.settle();
  const prepared = await prepareRewind(
    host,
    messageNode(await loadRewindTree(host), "first").target
  );
  assert.match(prepared.plan.codeBlocked ?? "", /has no snapshot/);
  await assert.rejects(() => checkCode(host, prepared), /has no snapshot/);
});

test.skipIf(process.platform === "win32")(
  "写回保持现有文件的权限位（0600 不变成所有人可读）",
  async () => {
    const root = repo(false);
    chmodSync(join(root, "a.txt"), 0o600);
    const { bundle, host } = await openSession(root, [
      overwrite("a.txt", "agent\n"),
      { text: "改完" },
    ]);
    await bundle.adapter.run("first");
    await host.checkpoints?.settle();
    const prepared = await prepareRewind(
      host,
      messageNode(await loadRewindTree(host), "first").target
    );
    await applyRewind(host, prepared, { mode: "code", code: await checkCode(host, prepared) });
    assert.equal(statSync(join(root, "a.txt")).mode & 0o777, 0o600);
  }
);

test("使用者原有的空目录不删：只删这段时间里 agent 新建、删空了的目录", async () => {
  const root = repo(false);
  mkdirSync(join(root, "keep"));
  const { bundle, host } = await openSession(root, [
    write("keep/agent.txt", "a\n"),
    write("fresh/agent.txt", "b\n"),
    { text: "建完" },
  ]);
  await bundle.adapter.run("first");
  await host.checkpoints?.settle();
  const prepared = await prepareRewind(
    host,
    messageNode(await loadRewindTree(host), "first").target
  );
  const outcome = await applyRewind(host, prepared, {
    mode: "code",
    code: await checkCode(host, prepared),
  });
  assert.deepEqual(outcome.restore?.removed, ["fresh/agent.txt", "keep/agent.txt"]);
  assert.deepEqual(outcome.restore?.removedDirs, ["fresh"]);
  assert.equal(existsSync(join(root, "keep")), true);
  assert.equal(existsSync(join(root, "fresh")), false);
});

test("授权补记与挪主分支同一次落盘：之后换上下文出错，续接时撤过的授权仍是撤销", async () => {
  const { root, cleanup } = tempRoot("pigeon-rewind-grants-crash-");
  cleanups.push(cleanup);
  const { bundle, host } = await openSession(root, [{ text: "一" }, { text: "二" }]);
  const grant = bundle.grantStore.create({
    tool: "run_command",
    command: "npm test",
    firstCall: { toolCallId: "c0", args: { command: "npm test" } },
  });
  await bundle.adapter.run("first");
  await bundle.adapter.run("second");
  // 撤销落在第二条之后（旧分支上）：回退到第二条之前，要靠补记才仍是撤销
  bundle.grantStore.revoke(grant.grantId);
  const broken: RewindHost = {
    ...host,
    adapter: {
      replaceMessages: () => {
        throw new Error("模拟换上下文时出错");
      },
    },
  };
  const prepared = await prepareRewind(
    broken,
    messageNode(await loadRewindTree(broken), "second").target
  );
  await assert.rejects(
    () => applyRewind(broken, prepared, { mode: "conversation" }),
    /模拟换上下文时出错/
  );
  const { loadStoreSession } = await import("../persistence/session-view.ts");
  const { storeActiveGrants } = await import("../state/session-judge.ts");
  const loaded = loadStoreSession(sessionsDirOf(root), bundle.adapter.sessionId);
  assert.ok(loaded !== undefined);
  assert.deepEqual(storeActiveGrants(loaded.view), [], "撤过的授权没有复活");
});

test("回退跨了移进独立工作树：只给退对话，退后在新位置补记当前的工作树（续接回到同一处）", async () => {
  const root = repo(false);
  const { bundle, host } = await openSession(root, [{ text: "一" }, { text: "二" }]);
  await bundle.adapter.run("first");
  await bundle.adapter.run("second");
  const worktree = {
    version: 1 as const,
    name: "w",
    path: join(root, ".pigeon", "wt", "w"),
    branch: "pigeon-wt/w",
    baseLabel: "HEAD",
    created: true,
    enteredAt: 0,
  };
  bundle.sessionStore.append({ customType: SessionEntryType.Worktree, data: worktree });
  await bundle.sessionStore.flush();
  const prepared = await prepareRewind(
    host,
    messageNode(await loadRewindTree(host), "second").target
  );
  assert.match(prepared.plan.codeBlocked ?? "", /not in the same workspace/);
  await applyRewind(host, prepared, { mode: "conversation" });
  const last = mainEntries(root, bundle.adapter.sessionId)
    .filter((entry) => entry.customType === SessionEntryType.Worktree)
    .at(-1)?.data;
  assert.deepEqual(last, worktree);
});

test("目标分支在独立工作树里、现在在主检出：不能切过去", () => {
  const entry = (
    id: string,
    parentId: string | null,
    seq: number,
    customType: string,
    data: unknown
  ) => ({ type: "custom", id, parentId, seq, timestamp: seq, customType, data });
  const message = (id: string, parentId: string, seq: number, text: string) => ({
    type: "message",
    id,
    parentId,
    seq,
    timestamp: seq,
    message: { role: "user", content: [{ type: "text", text }] },
  });
  const entries = [
    entry("e1", null, 1, SessionEntryType.RunStart, { runId: "run_1" }),
    message("e2", "e1", 2, "first"),
    entry("e3", "e2", 3, SessionEntryType.Worktree, { path: "/wt" }),
    entry("e4", "e3", 4, SessionEntryType.RunStart, { runId: "run_2" }),
    message("e5", "e4", 5, "second"),
  ];
  const file = {
    path: "x",
    header: { id: "sess_x" },
    entries,
    entriesById: new Map(entries.map((item) => [item.id, item])),
    lanes: new Map([["main", "e2"]]),
    labels: new Map(),
    warnings: [],
  } as unknown as SessionFileView;
  const plan = planRewind({ file, trees: undefined, from: "e2", to: "e5" });
  assert.match(plan.conversationBlocked ?? "", /can't switch/);
});

test("切回 agent 删过使用者文件的分支：删掉不是这段里 agent 新建的文件拿不准，列为冲突、缺省保留", async () => {
  const root = repo(false);
  const { bundle, host } = await openSession(root, [
    { text: "删", toolCalls: [{ name: "run_command", args: { command: "git rm -q m.txt" } }] },
    { text: "删完" },
  ]);
  await bundle.adapter.run("first");
  await host.checkpoints?.settle();
  assert.equal(existsSync(join(root, "m.txt")), false);
  const back = await prepareRewind(host, messageNode(await loadRewindTree(host), "first").target);
  await applyRewind(host, back, { mode: "both", code: await checkCode(host, back) });
  assert.equal(readFileSync(join(root, "m.txt"), "utf8"), "mine\n");
  const tip = (await loadRewindTree(host)).find((node) => node.kind === "tip" && !node.current);
  assert.ok(tip !== undefined);
  const again = await prepareRewind(host, tip.target);
  const code = await checkCode(host, again);
  assert.deepEqual(
    code.classified.conflicts.map((action) => [action.path, action.reason]),
    [["m.txt", "not created by the agent in this range; unsure to delete"]]
  );
  await applyRewind(host, again, { mode: "code", code });
  assert.equal(readFileSync(join(root, "m.txt"), "utf8"), "mine\n", "缺省保留");
});

test("写者：主分支的叶子不是预期的即什么都不写", async () => {
  const { root, cleanup } = tempRoot("pigeon-rewind-lane-");
  cleanups.push(cleanup);
  const { bundle } = await openSession(root, [{ text: "一" }]);
  await bundle.adapter.run("first");
  const leaf = await bundle.sessionStore.leafId();
  const before = mainEntries(root, bundle.adapter.sessionId).length;
  const result = await bundle.sessionStore.rewindLane({
    expectLeaf: "not-the-leaf",
    to: null,
    entries: [],
  });
  assert.equal(result, "changed");
  assert.equal(await bundle.sessionStore.leafId(), leaf);
  assert.equal(mainEntries(root, bundle.adapter.sessionId).length, before);
});

// ---- 第二轮复查 ----

test("两次 agent 改动中间夹的手改：退到最早一条之前时列为冲突，缺省保留", async () => {
  const root = repo(false);
  const { bundle, host } = await openSession(root, [
    write("x.txt", "agent 1\n"),
    { text: "建了" },
    overwrite("x.txt", "agent 2\n"),
    { text: "又改了" },
  ]);
  await bundle.adapter.run("first");
  await host.checkpoints?.settle();
  writeFileSync(join(root, "x.txt"), "agent 1\nhand line\n");
  await bundle.adapter.run("second");
  await host.checkpoints?.settle();
  const prepared = await prepareRewind(
    host,
    messageNode(await loadRewindTree(host), "first").target
  );
  const code = await checkCode(host, prepared);
  assert.deepEqual(
    code.classified.conflicts.map((action) => [action.path, action.reason]),
    [["x.txt", "edited by hand between messages"]]
  );
  await applyRewind(host, prepared, { mode: "code", code });
  assert.equal(readFileSync(join(root, "x.txt"), "utf8"), "agent 2\n", "缺省保留");
});

test("退代码先写意图记录、逐个文件写结果，存下的原样字节挂在引用上；撤销中途出错可以再撤", async () => {
  const root = repo(false);
  const { bundle, host } = await openSession(root, [
    overwrite("a.txt", "agent\n"),
    { text: "改完" },
  ]);
  await bundle.adapter.run("first");
  await host.checkpoints?.settle();
  const prepared = await prepareRewind(
    host,
    messageNode(await loadRewindTree(host), "first").target
  );
  await applyRewind(host, prepared, { mode: "code", code: await checkCode(host, prepared) });
  const entries = mainEntries(root, bundle.adapter.sessionId);
  const kinds = entries
    .filter(
      (entry) =>
        entry.customType === SessionEntryType.Rewind ||
        entry.customType === SessionEntryType.RewindStep
    )
    .map((entry) => {
      const data = entry.data as { phase?: string; done?: string; rewindId: string };
      return entry.customType === SessionEntryType.RewindStep
        ? `step:${data.done}`
        : (data.phase ?? "done");
    });
  assert.deepEqual(kinds, ["intent", "step:written", "done"]);
  const rewindId = (entries.at(-1)?.data as { rewindId?: string } | undefined)?.rewindId ?? "";
  const ref = git(root, [
    "for-each-ref",
    "--format=%(refname)",
    `refs/pigeon/rewind/${bundle.adapter.sessionId}/${rewindId}`,
  ]);
  assert.equal(ref, `refs/pigeon/rewind/${bundle.adapter.sessionId}/${rewindId}`);
  // 撤销时 a.txt 只读：撤销没做完，之后仍可再撤
  chmodSync(join(root, "a.txt"), 0o444);
  try {
    const undo = await prepareUndo(host);
    assert.ok(undo !== undefined);
    const failed = await applyRewind(host, undo, {
      mode: "code",
      code: await checkCode(host, undo),
    });
    assert.equal(failed.failed?.path, "a.txt");
  } finally {
    chmodSync(join(root, "a.txt"), 0o644);
  }
  const retry = await prepareUndo(host);
  assert.ok(retry !== undefined, "撤销中途出错之后可以再撤");
  await applyRewind(host, retry, { mode: "code", code: await checkCode(host, retry) });
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "agent\n");
  assert.equal(await prepareUndo(host), undefined);
});

test("退代码之后移进过独立工作树：不能撤销（不在同一个工作区）", async () => {
  const root = repo(false);
  const { bundle, host } = await openSession(root, [
    overwrite("a.txt", "agent\n"),
    { text: "改完" },
  ]);
  await bundle.adapter.run("first");
  await host.checkpoints?.settle();
  const prepared = await prepareRewind(
    host,
    messageNode(await loadRewindTree(host), "first").target
  );
  await applyRewind(host, prepared, { mode: "code", code: await checkCode(host, prepared) });
  bundle.sessionStore.append({
    customType: SessionEntryType.Worktree,
    data: {
      version: 1,
      name: "w",
      path: join(root, ".pigeon", "wt", "w"),
      branch: "pigeon-wt/w",
      baseLabel: "HEAD",
      created: true,
      enteredAt: 0,
    },
  });
  await bundle.sessionStore.flush();
  const undo = await prepareUndo(host);
  assert.match(undo?.plan.codeBlocked ?? "", /can't undo/);
  await assert.rejects(async () => checkCode(host, undo as never), /can't undo/);
});

// ---- 终审 ----

test("agent 在这段里改过 .gitattributes：没有原样字节的文件不写，列为无法保真", async () => {
  const root = repo(false);
  writeFileSync(join(root, "notes.txt"), "one\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "notes"]);
  const { bundle, host } = await openSession(root, [
    write(".gitattributes", "*.txt text eol=crlf\n"),
    overwrite("notes.txt", "two\n"),
    { text: "改完" },
  ]);
  await bundle.adapter.run("first");
  await host.checkpoints?.settle();
  const prepared = await prepareRewind(
    host,
    messageNode(await loadRewindTree(host), "first").target
  );
  assert.match(prepared.plan.attributesChanged ?? "", /\.gitattributes changed/);
  const outcome = await applyRewind(host, prepared, {
    mode: "code",
    code: await checkCode(host, prepared),
  });
  assert.deepEqual(outcome.restore?.written, []);
  const skipped = new Map((outcome.restore?.skipped ?? []).map((item) => [item.path, item.reason]));
  assert.match(skipped.get("notes.txt") ?? "", /can't restore faithfully/);
  assert.equal(readFileSync(join(root, "notes.txt"), "utf8"), "two\n", "没有被写成 CRLF");
});

test(".git/info/attributes 在这段里变过：同样只写有原样字节的", async () => {
  const root = repo(false);
  const { bundle, host } = await openSession(root, [
    overwrite("a.txt", "agent\n"),
    { text: "改完" },
  ]);
  await bundle.adapter.run("first");
  await host.checkpoints?.settle();
  writeFileSync(join(root, ".git", "info", "attributes"), "a.txt filter=crypt\n");
  const prepared = await prepareRewind(
    host,
    messageNode(await loadRewindTree(host), "first").target
  );
  assert.match(prepared.plan.attributesChanged ?? "", /info\/attributes/);
});

test("撤销时工作区与退代码时不同：不撤代码并说明", async () => {
  const root = repo(false);
  const { bundle, host } = await openSession(root, [
    overwrite("a.txt", "agent\n"),
    { text: "改完" },
  ]);
  await bundle.adapter.run("first");
  await host.checkpoints?.settle();
  const prepared = await prepareRewind(
    host,
    messageNode(await loadRewindTree(host), "first").target
  );
  await applyRewind(host, prepared, { mode: "code", code: await checkCode(host, prepared) });
  const elsewhere = tempRoot("pigeon-rewind-elsewhere-");
  cleanups.push(elsewhere.cleanup);
  initRepo(elsewhere.root, { "a.txt": "x\n" });
  const undo = await prepareUndo({ ...host, workspaceRoot: elsewhere.root });
  assert.match(undo?.plan.codeBlocked ?? "", /workspace .*differs or is gone/);
});

test("撤销时写到一半出错的文件：现状与出错当时记下的一样即照退，不一样即列为冲突", () => {
  const root = repo(false);
  const commitWith = (content: string): string => {
    writeFileSync(join(root, "b.txt"), content);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", content.trim()]);
    return git(root, ["rev-parse", "HEAD"]);
  };
  const truncated = commitWith("half");
  const original = commitWith("original\n");
  const edited = commitWith("edited later\n");
  const trees = new SnapshotTrees(root);
  const observed = trees.file(truncated, "b.txt")?.blob ?? "";
  const target = trees.file(original, "b.txt");
  assert.ok(target !== undefined);
  const plan = {
    from: null,
    to: null,
    files: [{ path: "b.txt", target, observed }],
    untouchable: [],
    createdAfter: new Map<string, number>(),
  };
  assert.deepEqual(
    classifyPlan(plan, trees, truncated).actions.map((action) => action.path),
    ["b.txt"]
  );
  assert.deepEqual(
    classifyPlan(plan, trees, edited).conflicts.map((action) => action.path),
    ["b.txt"]
  );
});

test("消息树只列人发起的消息：/orchestrate 发起的列成人敲的命令、放回输入框的也是它；后台作业、跨会话、[Pigeon] 附注与续跑提示开头的不列，附注前缀的人话去掉附注", () => {
  const worktree = {
    name: "wt",
    repoRoot: "/repo",
    path: "/repo/.pigeon/wt/wt",
    branch: "pigeon-wt/wt",
    baseLabel: "HEAD",
  } as NamedWorktree;
  const note = `${PROGRAM_NOTE_PREFIX}The session did not move into the worktree /repo/.pigeon/wt/wt: the turn was interrupted.`;
  const inputs = [
    commandInputText("给各模块补测试"),
    `${JOB_NOTICE_PREFIX}Job 1 exited with code 0: $ npm test`,
    `${LEGACY_JOB_NOTICE_PREFIX}作业 1 已结束`,
    `[Cross-session message] from api-fix (session sess_peer). The text between the two PEER-MESSAGE 0123456789abcdef markers was written by another Pigeon session on this machine, not by the user.\n<<<BEGIN PEER-MESSAGE 0123456789abcdef>>>\n改完了\n<<<END PEER-MESSAGE 0123456789abcdef>>>`,
    "[Cross-session idle notice] api-fix is now idle.",
    worktreeContinueNotice(worktree, 0),
    TRUNCATION_RESUME_PROMPT,
    `${note}\n\n接着改`,
    `${note}\n\n${commandInputText("拆分")}`,
  ];
  const entries: Array<Record<string, unknown>> = [];
  let parentId: string | null = null;
  const push = (entry: Record<string, unknown>) => {
    const id = `e${entries.length + 1}`;
    entries.push({
      ...entry,
      id,
      parentId,
      seq: entries.length + 1,
      timestamp: entries.length + 1,
    });
    parentId = id;
  };
  inputs.forEach((text, index) => {
    push({
      type: "custom",
      customType: SessionEntryType.RunStart,
      data: { runId: `run_${index}` },
    });
    push({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
    push({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "好" }] },
    });
    push({ type: "custom", customType: SessionEntryType.RunEnd, data: { runId: `run_${index}` } });
  });
  const file = {
    path: "x",
    header: { id: "sess_x" },
    entries,
    entriesById: new Map(entries.map((item) => [item.id as string, item])),
    lanes: new Map([["main", parentId]]),
    labels: new Map(),
    warnings: [],
  } as unknown as SessionFileView;
  assert.deepEqual(
    rewindTree(file)
      .filter((node) => node.kind === "message")
      .map((node) => [node.text, node.prefill]),
    [
      ["/orchestrate 给各模块补测试", "/orchestrate 给各模块补测试"],
      ["接着改", "接着改"],
      ["/orchestrate 拆分", "/orchestrate 拆分"],
    ]
  );
  const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
  assert.equal(
    humanInputText(user(commandInputText("给各模块补测试"))),
    "/orchestrate 给各模块补测试"
  );
  assert.equal(humanInputText(user(`${note}\n\n接着改`)), "接着改");
  for (const text of inputs.slice(1, 7)) {
    assert.equal(isHumanInput(user(text)), false, text);
  }
  assert.equal(isHumanInput(user("看看 [Pigeon] 的输出")), true);
  assert.equal(isHumanInput({ role: "assistant", content: "好" }), false);
});
