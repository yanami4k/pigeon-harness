// 决策 443：会话面板的会话池接上真实运行面（与终端界面同一条装配路径，假模型，临时 git 仓库）。派出的会话进自己的独立
// 工作树、在那里改文件（主工作目录不动），开着期间持有在用锁；起点按 worktree.baseRef（head 时不取远端）；审批经同一个
// 处理口、写明来源会话，挂着时卡片在"等待回应"；/take 把工作树里的改动取回主工作目录、完整取回后起点前移（再取不重复），
// 停下之后完整取回即删工作树；钩子：SessionStart 与 SessionEnd 跑、UserPromptSubmit 拦下即这一轮失败并写明原因。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, test } from "vitest";
import { git, initRepo, routedModel, tempRoot } from "../application/tui-session-fixtures.ts";
import type { ApprovalRequest } from "../approvals/handler.ts";
import { loadSettings } from "../persistence/settings.ts";
import type { LayeredHook } from "../state/hooks.ts";
import { emptySettingsSnapshot, type SettingsSnapshot } from "../state/settings.ts";
import { createSessionPool } from "./main-pool.ts";

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

test("派出的会话进自己的工作树改文件、持有在用锁；审批写明来源、挂着时在等待回应；/take 取回、起点前移；停下后完整取回即删工作树", async () => {
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
  const { pool, face } = createSessionPool({
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
  });
  cleanups.push(() => pool.closeAll());
  const card = await pool.spawn("建一个文件");
  assert.equal(card.state, "preparing");
  await until(() => release !== undefined, "审批到了");
  const opened = pool.list()[0];
  assert.match(opened?.worktree?.path ?? "", /s1-/);
  assert.equal(lockCount(home), 1, "开着期间持有在用锁");
  assert.equal(requests[0]?.pooled?.name, "s1");
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
  assert.ok(face.live?.(id) !== undefined);
  assert.match(await pool.take(id), /已取回 1 个文件：made\.txt/);
  // 取回沿用 worker 的叠回（行尾按检出规则）
  assert.equal(readFileSync(join(root, "made.txt"), "utf8").replace(/\r\n/g, "\n"), "made\n");
  // 起点已前移：主工作目录里那份之后又被手改，再取不重复、不冲突
  writeFileSync(join(root, "made.txt"), "edited by hand\n");
  assert.match(await pool.take(id), /没有要取回的改动/);
  assert.equal(readFileSync(join(root, "made.txt"), "utf8"), "edited by hand\n");
  await pool.stop(id);
  assert.equal(pool.list()[0]?.state, "stopped");
  assert.equal(lockCount(home), 0, "停下即释放在用锁");
  assert.ok(existsSync(worktree), "有改动的工作树保留");
  assert.match(await pool.take(id), /已删除工作树/);
  assert.equal(existsSync(worktree), false);
  assert.match(await pool.take(id), /工作树已删除/);
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
  assert.ok(!(await run("head")).some((line) => line.includes("取远端")));
  assert.ok((await run("fresh")).some((line) => line.includes("取远端默认分支失败")));
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
  assert.match(pool.list()[0]?.error ?? "", /输入被钩子拦下：不许这句/);
  assert.ok(existsSync(join(scripts, "started")), "SessionStart 跑了");
  await pool.closeAll();
  assert.ok(existsSync(join(scripts, "ended")), "SessionEnd 跑了");
});

test("/take：落点就是这个工作树时拒绝；已停但另有会话开着这个工作树时不删", async () => {
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
  assert.match(await pool.take(card?.id ?? ""), /落点与来源是同一处/);
  mainWorkspace = root;
  await pool.stop(card?.id ?? "");
  // 另一个进程开着这个工作树（父进程号代替）
  const key = createHash("sha256")
    .update(process.platform === "win32" ? resolve(worktree).toLowerCase() : resolve(worktree))
    .digest("hex")
    .slice(0, 24);
  const lockDir = join(home, ".pigeon", "state", "worktree-use");
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    join(lockDir, `${key}-${process.ppid}.lock`),
    `${JSON.stringify({ pid: process.ppid, path: resolve(worktree) })}\n`
  );
  const taken = await pool.take(card?.id ?? "");
  assert.match(taken, /已取回 1 个文件/);
  assert.match(taken, /另有会话开着，保留不删/);
  assert.ok(existsSync(worktree));
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
  await until(() => pool.list()[0]?.state === "idle", "跑完空闲");
  const opened = pool.list()[0];
  assert.equal(opened?.worktree, undefined, "没有工作树");
  assert.equal(opened?.sharedDir, true);
  assert.equal(readFileSync(join(root, "made.txt"), "utf8"), "made\n", "改动直接在当前目录里");
  assert.equal(lockCount(home), 0, "不持有工作树的在用锁");
  assert.equal(existsSync(join(root, ".pigeon", "wt")), false, "没有建独立工作树目录");
  const id = opened?.id ?? "";
  assert.match(await pool.take(id), /s1 没有工作树（共用目录）/);
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
