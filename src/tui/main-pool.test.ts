// 决策 443：会话面板的会话池接上真实运行面（与终端界面同一条装配路径，假模型，临时 git 仓库）。派出的会话进自己的独立
// 工作树、在那里改文件（主工作目录不动），开着期间持有在用锁；起点按 worktree.baseRef（head 时不取远端）；审批经同一个
// 处理口、写明来源会话，挂着时卡片在"等待回应"；/take 把工作树里的改动取回主工作目录、完整取回后起点前移（再取不重复），
// 决策 483：停下不释放、撤回主 agent 挂着的审批，去掉才释放（完整取回之后再没有改动的工作树删掉，有改动的保留）；
// 钩子：SessionStart 与 SessionEnd 跑、UserPromptSubmit 拦下即这一轮失败并写明原因。决策 484：同一个会话核在面板与当前
// 之间换手，审批的来源标记、卡片的等待标记与叫醒跟着角色走。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { afterEach, test } from "vitest";
import { reopenNamedWorktree } from "../application/named-worktree.ts";
import { git, initRepo, routedModel, tempRoot } from "../application/tui-session-fixtures.ts";
import type { ApprovalRequest } from "../approvals/handler.ts";
import { loadSettings } from "../persistence/settings.ts";
import type { LayeredHook } from "../state/hooks.ts";
import type { SessionId } from "../state/ids.ts";
import { worktreesDirOf } from "../state/paths.ts";
import { emptySettingsSnapshot, type SettingsSnapshot } from "../state/settings.ts";
import {
  coreBundle,
  createSessionPool,
  pooledRuntimeOf,
  type SessionCore,
  type SessionPoolContext,
  setCoreRole,
  takeFromPanel,
} from "./main-pool.ts";

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400 && !check(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(check(), what);
}

function lockCount(home: string): number {
  const dir = join(home, ".pigeon", "state", "worktree-use");
  return existsSync(dir) ? readdirSync(dir).length : 0;
}

test("派出的会话进自己的工作树改文件、持有在用锁；审批写明来源、挂着时在等待回应；/take 取回、起点前移；停下不释放、去掉才释放（取回之后没再改的工作树删掉）", async () => {
  const { root, cleanup } = tempRoot("pigeon-pool-");
  cleanups.push(cleanup);
  const home = join(root, ".home");
  mkdirSync(home);
  initRepo(root, { "a.txt": "one\n" });
  writeFileSync(join(root, ".gitignore"), ".pigeon/\n.home/\n");
  const { streamFn } = routedModel({
    main: [
      {
        text: "写",
        toolCalls: [{ name: "write_file", args: { path: "made.txt", content: "made\n" } }],
      },
      { text: "写好了" },
    ],
  });
  const requests: ApprovalRequest[] = [];
  const states: string[] = [];
  const notices: string[] = [];
  let release: (() => void) | undefined;
  const context: SessionPoolContext = {
    governanceRoot: root,
    streamFn,
    flags: { provider: "custom", modelId: "custom" } as never,
    settings: () => loadSettings(root, { homeDir: root }),
    warn: () => {},
    homeDir: home,
    createApprovalHandler: () => async (request) => {
      requests.push(request);
      states.push(pool.list()[0]?.state ?? "?");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { approved: true };
    },
    mainWorkspace: () => root,
    notice: (line) => notices.push(line),
  };
  const { pool } = createSessionPool(context);
  cleanups.push(() => pool.closeAll());
  const card = await pool.spawn("建一个文件");
  assert.equal(card.state, "preparing");
  await until(() => release !== undefined, "审批到了");
  const opened = pool.list()[0];
  // 决策 490：缺省显示名是「目录名 + 会话号末 4 位」，工作树名跟着它
  assert.match(opened?.worktree?.path ?? "", new RegExp(`${opened?.name.toLowerCase()}-?`));
  assert.equal(lockCount(home), 1, "开着期间持有在用锁");
  assert.equal(requests[0]?.pooled?.name, opened?.name);
  assert.equal(requests[0]?.sessionId, opened?.id);
  assert.deepEqual(states, ["waiting"]);
  assert.match(pool.list()[0]?.waiting ?? "", /^write_file/);
  release?.();
  await until(() => pool.list()[0]?.state === "idle", "跑完空闲");
  assert.equal(pool.list()[0]?.summary, "写好了");
  const id = opened?.id ?? "";
  const worktree = opened?.worktree?.path ?? "";
  assert.equal(readFileSync(join(worktree, "made.txt"), "utf8"), "made\n");
  assert.equal(existsSync(join(root, "made.txt")), false, "主工作目录不动");
  assert.equal(pool.runtimeOf(id)?.live?.core.sessionId, id, "运行面带着它的会话核");
  assert.match(await pool.take(id), /took 1 file: made\.txt/);
  // 取回沿用 worker 的叠回（行尾按检出规则）
  assert.equal(readFileSync(join(root, "made.txt"), "utf8").replace(/\r\n/g, "\n"), "made\n");
  // 起点已前移：主工作目录里那份之后又被手改，再取不重复、不冲突
  writeFileSync(join(root, "made.txt"), "edited by hand\n");
  assert.match(await pool.take(id), /no changes to take/);
  assert.equal(readFileSync(join(root, "made.txt"), "utf8"), "edited by hand\n");
  // 决策 483：停下不释放（在用锁留着）；去掉才释放，完整取回之后再没有改动的工作树与分支删掉
  await pool.stop(id);
  assert.equal(pool.list()[0]?.state, "stopped");
  assert.equal(lockCount(home), 1, "停下不释放在用锁");
  assert.match(await pool.take(id), /no changes to take/);
  const branch = opened?.worktree?.branch ?? "";
  await pool.remove(id);
  assert.equal(pool.list().length, 0);
  assert.equal(lockCount(home), 0, "去掉即释放在用锁");
  // 决策 494：退出不删工作树，树、分支与取回起点都留着（取回起点只在清理工作树时删）
  assert.equal(existsSync(worktree), true, "工作树留着");
  assert.match(git(root, ["branch", "--list", branch]).trim(), new RegExp(branch));
  assert.notEqual(git(root, ["for-each-ref", "refs/pigeon/panel/"]).trim(), "", "取回起点留着");
  // 审计 10：取回—退出—重开—再取：重开的会话按钉在引用上的起点取，不按最初的起点重新叠回（手改的不被写回）
  const reopened = reopenNamedWorktree(root, worktree);
  assert.ok(reopened !== undefined);
  const core: SessionCore = {
    sessionId: id as SessionId,
    governanceRoot: root,
    name: opened?.name ?? "",
    task: "",
    modeCell: { current: "prompt" },
    workspaceRoot: worktree,
    worktree: reopened,
    current: false,
    approvals: new AbortController(),
    startContexts: [],
  };
  const again = pooledRuntimeOf(context, core);
  assert.match((await Promise.resolve(again.take?.())) ?? "", /no changes to take/);
  assert.equal(readFileSync(join(root, "made.txt"), "utf8"), "edited by hand\n");
});

test("决策 483：停下即撤回主 agent 挂着的审批（子 agent 的不撤回）", async () => {
  const { root, cleanup } = tempRoot("pigeon-pool-withdraw-");
  cleanups.push(cleanup);
  initRepo(root, { "a.txt": "one\n" });
  writeFileSync(join(root, ".gitignore"), ".pigeon/\n.home/\n");
  const { streamFn } = routedModel({
    main: [
      {
        text: "写",
        toolCalls: [{ name: "write_file", args: { path: "made.txt", content: "made\n" } }],
      },
      { text: "不写了" },
    ],
  });
  const requests: ApprovalRequest[] = [];
  const { pool } = createSessionPool({
    governanceRoot: root,
    streamFn,
    flags: { provider: "custom", modelId: "custom" } as never,
    settings: () => loadSettings(root, { homeDir: root }),
    warn: () => {},
    homeDir: join(root, ".home"),
    createApprovalHandler: () => async (request) => {
      requests.push(request);
      const signal = request.signal;
      await new Promise<void>((resolve) => {
        if (signal?.aborted === true) resolve();
        else signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { approved: false, reason: "withdrawn" };
    },
    mainWorkspace: () => root,
    notice: () => {},
  });
  cleanups.push(() => pool.closeAll());
  await pool.spawn("建一个文件");
  await until(() => requests.length === 1, "审批到了");
  const id = pool.list()[0]?.id ?? "";
  assert.equal(pool.list()[0]?.state, "waiting");
  await pool.stop(id);
  await until(() => requests[0]?.signal?.aborted === true, "审批撤回");
  await until(() => pool.list()[0]?.state === "stopped", "落定后仍是已停");
  const worktree = pool.list()[0]?.worktree?.path ?? "";
  assert.equal(existsSync(join(worktree, "made.txt")), false, "没有写");
});

test("起点按 worktree.baseRef：fresh 时在后台取远端（取不到从 HEAD 起并说明），head 时不取", async () => {
  const { root, cleanup } = tempRoot("pigeon-pool-base-");
  cleanups.push(cleanup);
  initRepo(root, { "a.txt": "one\n" });
  git(root, ["remote", "add", "origin", join(root, "no-such-remote")]);
  git(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  const run = async (baseRef: "fresh" | "head") => {
    const notices: string[] = [];
    const settings: SettingsSnapshot = {
      ...emptySettingsSnapshot(root),
      merged: { ...emptySettingsSnapshot(root).merged, worktree: { baseRef } },
    };
    const { streamFn } = routedModel({ main: [{ text: "好" }] });
    const { pool } = createSessionPool({
      governanceRoot: root,
      streamFn,
      flags: { yolo: true, provider: "custom", modelId: "custom" } as never,
      settings: () => settings,
      warn: () => {},
      homeDir: join(root, ".home"),
      createApprovalHandler: () => async () => ({ approved: true }),
      mainWorkspace: () => root,
      notice: (line) => notices.push(line),
    });
    await pool.spawn("看看");
    await until(() => pool.list()[0]?.state === "idle", "跑完");
    await pool.closeAll();
    return notices;
  };
  // head 先跑（取远端失败也会留下 FETCH_HEAD，让之后 24 小时内不再取）
  assert.ok(!(await run("head")).some((line) => line.includes("remote default branch")));
  assert.ok(
    (await run("fresh")).some((line) => line.includes("fetching the remote default branch failed"))
  );
});

test("钩子：SessionStart 与 SessionEnd 跑；UserPromptSubmit 拦下即这一轮失败并写明原因", async () => {
  const { root, cleanup } = tempRoot("pigeon-pool-hooks-");
  cleanups.push(cleanup);
  initRepo(root, { "a.txt": "one\n" });
  const scripts = join(root, ".hooks");
  mkdirSync(scripts);
  const mark = (name: string) =>
    `process.stdin.resume();process.stdin.on("end",()=>{require("fs").writeFileSync(${JSON.stringify(join(scripts, name))},"x")});`;
  writeFileSync(join(scripts, "start.cjs"), mark("started"));
  writeFileSync(join(scripts, "end.cjs"), mark("ended"));
  writeFileSync(
    join(scripts, "block.cjs"),
    'process.stdin.resume();process.stdin.on("end",()=>{process.stderr.write("不许这句");process.exit(2)});'
  );
  const hook = (event: LayeredHook["event"], file: string): LayeredHook => ({
    event,
    command: `node "${join(scripts, file)}"`,
    host: false,
    layer: "project",
  });
  const settings: SettingsSnapshot = {
    ...emptySettingsSnapshot(root),
    hooks: [
      hook("SessionStart", "start.cjs"),
      hook("SessionEnd", "end.cjs"),
      hook("UserPromptSubmit", "block.cjs"),
    ],
  };
  const { streamFn } = routedModel({ main: [{ text: "不会到这" }] });
  const { pool } = createSessionPool({
    governanceRoot: root,
    streamFn,
    flags: { yolo: true, provider: "custom", modelId: "custom" } as never,
    settings: () => settings,
    warn: () => {},
    homeDir: join(root, ".home"),
    createApprovalHandler: () => async () => ({ approved: true }),
    mainWorkspace: () => root,
    notice: () => {},
  });
  await pool.spawn("随便做点");
  await until(() => pool.list()[0]?.state === "failed", "这一轮被拦下");
  assert.match(pool.list()[0]?.error ?? "", /input blocked by hook: 不许这句/);
  assert.ok(existsSync(join(scripts, "started")), "SessionStart 跑了");
  await pool.closeAll();
  assert.ok(existsSync(join(scripts, "ended")), "SessionEnd 跑了");
});

test("/take：落点就是这个工作树时拒绝；停下的会话按还开着取、工作树不删；取回之后又改了的去掉时保留", async () => {
  const { root, cleanup } = tempRoot("pigeon-pool-take-");
  cleanups.push(cleanup);
  const home = join(root, ".home");
  mkdirSync(home);
  initRepo(root, { "a.txt": "one\n" });
  writeFileSync(join(root, ".gitignore"), ".pigeon/\n.home/\n");
  const { streamFn } = routedModel({
    main: [
      {
        text: "写",
        toolCalls: [{ name: "write_file", args: { path: "made.txt", content: "made\n" } }],
      },
      { text: "写好了" },
    ],
  });
  let mainWorkspace = root;
  const { pool } = createSessionPool({
    governanceRoot: root,
    streamFn,
    flags: { yolo: true, provider: "custom", modelId: "custom" } as never,
    settings: () => loadSettings(root, { homeDir: root }),
    warn: () => {},
    homeDir: home,
    createApprovalHandler: () => async () => ({ approved: true }),
    mainWorkspace: () => mainWorkspace,
    notice: () => {},
  });
  cleanups.push(() => pool.closeAll());
  await pool.spawn("建一个文件");
  await until(() => pool.list()[0]?.state === "idle", "跑完空闲");
  const card = pool.list()[0];
  const worktree = card?.worktree?.path ?? "";
  // 主会话 /resume 过去、进了这个工作树：落点与来源是同一处
  mainWorkspace = worktree;
  assert.match(
    await pool.take(card?.id ?? ""),
    /the current session is in .+'s worktree; nothing to take/
  );
  mainWorkspace = root;
  // 决策 483：停下的会话运行面还开着：取回按还开着取（起点前移），工作树不删
  await pool.stop(card?.id ?? "");
  const taken = await pool.take(card?.id ?? "");
  assert.match(taken, /took 1 file/);
  assert.ok(existsSync(worktree));
  // 决策 486：take_changes 取回到调用方自己的工作目录：别的仓库的不取，落点就是它的工作树的不取
  assert.match(
    pool.takeInto(card?.id ?? "", { workspace: root, root: join(root, "elsewhere") }),
    /is in another repository; nothing to take/
  );
  assert.match(
    pool.takeInto(card?.id ?? "", { workspace: worktree, root }),
    /you are working in .+'s worktree; nothing to take/
  );
  assert.match(
    pool.takeInto(card?.id ?? "", { workspace: root, root }),
    /no changes to take from session/
  );
  writeFileSync(join(worktree, "later.txt"), "later\n");
  await pool.remove(card?.id ?? "");
  assert.ok(existsSync(join(worktree, "later.txt")), "取回之后又改了的工作树保留");
});

test("决策 459：不是 git 仓库时，派出的会话在当前目录里干活（不建工作树、不持有在用锁），卡片标共用目录；/take 说明不用取回；停下不涉及工作树", async () => {
  const { root, cleanup } = tempRoot("pigeon-pool-plain-");
  cleanups.push(cleanup);
  const home = join(root, ".home");
  mkdirSync(home);
  writeFileSync(join(root, "a.txt"), "one\n");
  const { streamFn } = routedModel({
    main: [
      {
        text: "写",
        toolCalls: [{ name: "write_file", args: { path: "made.txt", content: "made\n" } }],
      },
      { text: "写好了" },
    ],
  });
  const { pool } = createSessionPool({
    governanceRoot: root,
    streamFn,
    flags: { provider: "custom", modelId: "custom" } as never,
    settings: () => loadSettings(root, { homeDir: home }),
    warn: () => {},
    homeDir: home,
    createApprovalHandler: () => async () => ({ approved: true }),
    mainWorkspace: () => root,
    notice: () => {},
  });
  cleanups.push(() => pool.closeAll());
  const card = await pool.spawn("建一个文件");
  assert.equal(card.sharedDir, true);
  // 决策 489：共用目录的会话在卡上直接写它用的工作区
  assert.equal(typeof card.workspace, "string");
  assert.notEqual(card.workspace, "");
  await until(() => pool.list()[0]?.state === "idle", "跑完空闲");
  const opened = pool.list()[0];
  assert.equal(opened?.worktree, undefined, "没有工作树");
  assert.equal(opened?.sharedDir, true);
  assert.equal(readFileSync(join(root, "made.txt"), "utf8"), "made\n", "改动直接在当前目录里");
  assert.equal(lockCount(home), 0, "不持有工作树的在用锁");
  assert.equal(existsSync(worktreesDirOf(root)), false, "没有建工作树目录");
  const id = opened?.id ?? "";
  assert.match(await pool.take(id), new RegExp(`${opened?.name} has no worktree; nothing to take`));
  await pool.stop(id);
  assert.equal(pool.list()[0]?.state, "stopped");
  assert.equal(readFileSync(join(root, "made.txt"), "utf8"), "made\n", "停下不动目录里的改动");
  // 会话记录里如实记下它没有工作树：会话文件头的工作目录就是当前目录
  const sessions = join(root, ".pigeon", "state", "sessions");
  const files = readdirSync(sessions, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith(".jsonl"));
  assert.equal(files.length, 1);
  const header = JSON.parse(
    readFileSync(join(sessions, files[0] ?? ""), "utf8").split("\n")[0] ?? "{}"
  ) as {
    cwd?: string;
  };
  assert.equal(resolve(header.cwd ?? ""), resolve(root));
});

test("决策 484：会话核换手——在面板里审批写明来源、卡片标等待；成为当前会话后照直上审批区、叫醒交给壳；退回面板又写明来源", async () => {
  const { root, cleanup } = tempRoot("pigeon-pool-core-");
  cleanups.push(cleanup);
  initRepo(root, { "a.txt": "one\n" });
  writeFileSync(join(root, ".gitignore"), ".pigeon/\n.home/\n");
  const write = (path: string) => ({
    text: "写",
    toolCalls: [{ name: "write_file", args: { path, content: "x\n" } }],
  });
  const { streamFn } = routedModel({
    main: [
      write("a1.txt"),
      { text: "一" },
      write("a2.txt"),
      { text: "二" },
      write("a3.txt"),
      { text: "三" },
    ],
  });
  const requests: ApprovalRequest[] = [];
  const states: string[] = [];
  const wakes: string[] = [];
  let guards = 0;
  const context: SessionPoolContext = {
    governanceRoot: root,
    streamFn,
    flags: { provider: "custom", modelId: "custom" } as never,
    settings: () => loadSettings(root, { homeDir: root }),
    warn: () => {},
    homeDir: join(root, ".home"),
    createApprovalHandler: () => async (request) => {
      requests.push(request);
      states.push(pool.list()[0]?.state ?? "none");
      return { approved: true };
    },
    mainWorkspace: () => root,
    notice: () => {},
    current: {
      wake: () => wakes.push("shell"),
      guard: () => {
        guards += 1;
        return () => {};
      },
    },
  };
  const { pool } = createSessionPool(context);
  cleanups.push(() => pool.closeAll());
  await pool.spawn("写 a1");
  await until(() => pool.list()[0]?.state === "idle", "第一轮跑完");
  assert.equal(requests[0]?.pooled?.name, pool.list()[0]?.name);
  assert.deepEqual(states, ["waiting"]);
  const id = pool.list()[0]?.id ?? "";
  // 取出、成为当前会话：审批不再写来源，打转检测挂到壳上
  const detached = pool.detach(id);
  const core = detached?.runtime.live?.core;
  assert.ok(core !== undefined);
  setCoreRole(context, core, true);
  assert.equal(guards, 1);
  await coreBundle(core).adapter.run("写 a2");
  assert.equal(requests[1]?.pooled, undefined);
  assert.equal(states[1], "none", "当前会话不在面板上");
  // 退回面板：又写明来源、卡片标等待
  setCoreRole(context, core, false);
  pool.adopt(pooledRuntimeOf(context, core), { name: core.name, task: core.task });
  assert.equal(await pool.send(id, "写 a3"), undefined);
  await until(() => requests.length === 3 && pool.list()[0]?.state === "idle", "第三轮跑完");
  assert.equal(requests[2]?.pooled?.name, pool.list()[0]?.name);
  assert.equal(states[2], "waiting");
});

function writingModel() {
  return routedModel({
    main: [
      {
        text: "写",
        toolCalls: [{ name: "write_file", args: { path: "made.txt", content: "made\n" } }],
      },
      { text: "写好了" },
    ],
  }).streamFn;
}

function poolIn(root: string, home: string) {
  return createSessionPool({
    governanceRoot: root,
    streamFn: writingModel(),
    flags: { yolo: true, provider: "custom", modelId: "custom" } as never,
    settings: () => loadSettings(root, { homeDir: home }),
    warn: () => {},
    homeDir: home,
    createApprovalHandler: () => async () => ({ approved: true }),
    mainWorkspace: () => root,
    notice: () => {},
  }).pool;
}

// 决策 486、490：take_changes 取面板里的会话按全量会话号找，不按显示名；不取自己、不取别的仓库的
test("take_changes 取面板会话：按全量会话号取；显示名不认，自己不取，别的仓库不取", async () => {
  const { root, cleanup } = tempRoot("pigeon-pool-panel-take-");
  cleanups.push(cleanup);
  const home = join(root, ".home");
  mkdirSync(home);
  initRepo(root, { "a.txt": "one\n" });
  writeFileSync(join(root, ".gitignore"), ".pigeon/\n.home/\n");
  const pool = poolIn(root, home);
  cleanups.push(() => pool.closeAll());
  await pool.spawn("建一个文件");
  await until(() => pool.list()[0]?.state === "idle", "跑完空闲");
  const card = pool.list()[0];
  assert.ok(card !== undefined);
  const caller = { sessionId: "sess_caller", governanceRoot: root } as unknown as SessionCore;
  const take = (id: string, who = caller) =>
    takeFromPanel({ cards: pool.list(), pool, caller: who, id, into: root });
  assert.equal(take(card.name), undefined, "显示名不认");
  assert.equal(
    take(card.id, { ...caller, sessionId: card.id } as SessionCore),
    undefined,
    "不取自己"
  );
  const elsewhere = join(root, ".home", "elsewhere");
  mkdirSync(elsewhere);
  assert.match(
    take(card.id, { ...caller, governanceRoot: elsewhere } as SessionCore) ?? "",
    /is in another repository; nothing to take/
  );
  assert.match(take(card.id) ?? "", /took 1 file: made\.txt/);
});

// 审计 9：面板派出的树名从缺省显示名派生时先按树名规则清洗——目录名 my.app 的项目照样派得出
test("目录名带点的项目（my.app）：面板派出的树名清洗成 my-app-<尾号>，派得出、跑得完", async () => {
  const { root: base, cleanup } = tempRoot("pigeon-pool-dotted-");
  cleanups.push(cleanup);
  const root = join(base, "my.app");
  mkdirSync(root);
  const home = join(base, ".home");
  mkdirSync(home);
  initRepo(root, { "a.txt": "one\n" });
  writeFileSync(join(root, ".gitignore"), ".pigeon/\n");
  const pool = poolIn(root, home);
  cleanups.push(() => pool.closeAll());
  await pool.spawn("建一个文件");
  await until(() => pool.list()[0]?.state === "idle", "跑完空闲");
  const card = pool.list()[0];
  assert.match(basename(card?.worktree?.path ?? ""), /^my-app-[0-9a-z]{4}$/);
  assert.equal(readFileSync(join(card?.worktree?.path ?? "", "made.txt"), "utf8"), "made\n");
});
