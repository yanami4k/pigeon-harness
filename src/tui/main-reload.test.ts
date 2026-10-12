// 终端界面 /reload 的实际重建路径（main-reload.ts，main.ts 的 apply 调它）：重建后 update_memory 仍注册且可写、
// /memory 的上限随新快照更新、重建失败时上限不变；新开的会话推迟建会话文件时的 /reload 与不发消息就释放（决策 432）。
// 用户级一律指到临时目录。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, test } from "vitest";
import { parseLaunchFlags } from "../application/launch-flags.ts";
import type { McpSession } from "../application/mcp.ts";
import { disposeRuntime, type RuntimeBundle } from "../application/runtime.ts";
import { openSessionRuntime } from "../application/session-runtime.ts";
import { openSessionSettings } from "../application/session-settings.ts";
import { createSettingsReloader } from "../application/settings-reload.ts";
import { globalExcludesFile } from "../persistence/global-ignore.ts";
import { listSessionFiles } from "../persistence/session-reader.ts";
import { loadStoreSession } from "../persistence/session-view.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { projectSettingsPath, sessionsDirOf } from "../state/paths.ts";
import { memoryLimitsOf, type SettingsSnapshot } from "../state/settings.ts";
import { type MainReloadContext, reopenMainSessionForReload } from "./main-reload.ts";

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

function write(file: string, value: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

const noMcp = async (): Promise<McpSession> => ({
  tools: [],
  prompts: [],
  problems: [],
  connections: [],
  summary: () => ({ mcpTools: [], mcpServers: [] }),
  close: async () => {},
});

test("/reload 经终端界面的重建路径：update_memory 仍注册且可写，/memory 的上限随新快照更新", async () => {
  const root = temp("pigeon-main-reload-");
  const home = temp("pigeon-main-reload-home-");
  const flags = parseLaunchFlags(["--root", root, "--provider", "fake", "--model", "fake"], {
    usage: "u",
    pushedMemory: true,
    spawnWorkers: true,
  });
  const streamFn = createFakeStreamFn({
    replies: [
      {
        text: "记",
        toolCalls: [
          {
            name: "update_memory",
            args: { action: "add", layer: "project", content: "提交信息用英文" },
          },
        ],
      },
      { text: "好" },
    ],
  });
  let settings: SettingsSnapshot = await openSessionSettings(root, {
    homeDir: home,
    confirmation: { kind: "interactive", ask: async () => "trust" },
  });
  const memoryContext = { limits: memoryLimitsOf(settings) };
  const context: MainReloadContext = {
    governanceRoot: root,
    streamFn,
    flags,
    warn: () => {},
    createApprovalHandler: () => async () => ({ approved: true }),
    memoryWrite: { source: "tui" },
    memoryContext,
    webToolsFor: () => ({}),
    hooksNotice: () => {},
    onMcpNote: () => {},
    homeDir: home,
    startMcp: noMcp,
  };
  const sessionId = newSessionId();
  let bundle: RuntimeBundle = (
    await openSessionRuntime({
      governanceRoot: root,
      settings,
      sessionId,
      streamFn,
      flags,
      memoryWrite: context.memoryWrite,
      createApprovalHandler: context.createApprovalHandler,
      homeDir: home,
      startMcp: noMcp,
    })
  ).bundle;
  const reload = createSettingsReloader({
    current: () => settings,
    homeDir: home,
    apply: async (snapshot) => {
      const reloaded = await reopenMainSessionForReload(context, snapshot, { sessionId, bundle });
      settings = snapshot;
      const previous = bundle;
      bundle = reloaded.opened.bundle;
      await disposeRuntime(previous);
    },
  });
  try {
    assert.ok(bundle.adapter.snapshot().tools.advertised.includes("update_memory"), "开局就注册");
    write(projectSettingsPath(root), { memory: { projectLimitChars: 5000 } });
    await reload([]);
    assert.ok(bundle.adapter.snapshot().tools.advertised.includes("update_memory"), "重建后仍注册");
    assert.equal(memoryContext.limits.project, 5000, "/memory 的上限按新快照");
    const run = await bundle.adapter.run("记一下");
    assert.equal(run.status, "completed", JSON.stringify(run.errorMessage));
    assert.equal(run.toolExecutions.at(-1)?.state, "settled");
    const memoryFile = join(root, ".pigeon", "state", "memory.md");
    assert.ok(
      existsSync(memoryFile) && readFileSync(memoryFile, "utf8").includes("提交信息用英文")
    );
  } finally {
    await disposeRuntime(bundle);
  }
});

test("/reload 重建失败：/memory 的上限不变（先建后换）", async () => {
  const root = temp("pigeon-main-reload-fail-");
  const home = temp("pigeon-main-reload-fail-home-");
  const flags = parseLaunchFlags(["--root", root, "--provider", "fake", "--model", "fake"], {
    usage: "u",
    pushedMemory: true,
  });
  const streamFn = createFakeStreamFn({ replies: [{ text: "好" }] });
  const settings = await openSessionSettings(root, {
    homeDir: home,
    confirmation: { kind: "interactive", ask: async () => "trust" },
  });
  const memoryContext = { limits: memoryLimitsOf(settings) };
  const sessionId = newSessionId();
  const bundle = (
    await openSessionRuntime({
      governanceRoot: root,
      settings,
      sessionId,
      streamFn,
      flags,
      homeDir: home,
      startMcp: noMcp,
    })
  ).bundle;
  write(projectSettingsPath(root), { memory: { projectLimitChars: 5000 } });
  const next = await openSessionSettings(root, {
    homeDir: home,
    confirmation: { kind: "interactive", ask: async () => "trust" },
  });
  try {
    await assert.rejects(
      reopenMainSessionForReload(
        {
          governanceRoot: root,
          streamFn,
          flags,
          warn: () => {},
          createApprovalHandler: () => async () => ({ approved: true }),
          memoryWrite: { source: "tui" },
          memoryContext,
          webToolsFor: () => ({}),
          hooksNotice: () => {},
          onMcpNote: () => {},
          homeDir: home,
          startMcp: async () => {
            throw new Error("MCP 起不来");
          },
        },
        next,
        { sessionId, bundle }
      ),
      /MCP 起不来/
    );
    assert.equal(memoryContext.limits.project, memoryLimitsOf(settings).project, "上限不变");
  } finally {
    await disposeRuntime(bundle);
  }
});

// 决策 432：终端界面新开的会话推迟建会话文件
async function deferredMain(root: string, home: string, replies: Array<{ text: string }>) {
  const flags = parseLaunchFlags(["--root", root, "--provider", "fake", "--model", "fake"], {
    usage: "u",
    pushedMemory: true,
    spawnWorkers: true,
  });
  const streamFn = createFakeStreamFn({ replies });
  const settings: SettingsSnapshot = await openSessionSettings(root, {
    homeDir: home,
    confirmation: { kind: "interactive", ask: async () => "trust" },
  });
  const context: MainReloadContext = {
    governanceRoot: root,
    streamFn,
    flags,
    warn: () => {},
    createApprovalHandler: () => async () => ({ approved: true }),
    memoryWrite: { source: "tui" },
    memoryContext: { limits: memoryLimitsOf(settings) },
    webToolsFor: () => ({}),
    hooksNotice: () => {},
    onMcpNote: () => {},
    homeDir: home,
    startMcp: noMcp,
  };
  const sessionId = newSessionId();
  const opened = await openSessionRuntime({
    governanceRoot: root,
    settings,
    sessionId,
    streamFn,
    flags,
    deferSessionFile: true,
    memoryWrite: context.memoryWrite,
    createApprovalHandler: context.createApprovalHandler,
    homeDir: home,
    startMcp: noMcp,
  });
  return { context, settings, sessionId, bundle: opened.bundle };
}

const sessionFiles = (root: string) => listSessionFiles(sessionsDirOf(root));

test("推迟建会话文件（决策 432）：第一条消息之前 /reload 不出错也不建文件；发出消息才建出唯一的会话文件", async () => {
  const root = temp("pigeon-main-deferred-");
  const home = temp("pigeon-main-deferred-home-");
  const start = await deferredMain(root, home, [{ text: "好" }]);
  let settings = start.settings;
  let bundle = start.bundle;
  const reload = createSettingsReloader({
    current: () => settings,
    homeDir: home,
    apply: async (snapshot) => {
      const reloaded = await reopenMainSessionForReload(start.context, snapshot, {
        sessionId: start.sessionId,
        bundle,
      });
      settings = snapshot;
      const previous = bundle;
      bundle = reloaded.opened.bundle;
      await disposeRuntime(previous);
    },
  });
  try {
    assert.deepEqual(sessionFiles(root), [], "开局不建会话文件");
    write(projectSettingsPath(root), { memory: { projectLimitChars: 5000 } });
    await reload([]);
    assert.equal(bundle.sessionStore.fileDeferred?.(), true);
    assert.deepEqual(sessionFiles(root), [], "/reload 之后仍未建");
    const run = await bundle.adapter.run("你好");
    assert.equal(run.status, "completed", JSON.stringify(run.errorMessage));
    await bundle.sessionStore.flush();
    const files = sessionFiles(root);
    assert.deepEqual(
      files.map((file) => file.sessionId),
      [start.sessionId]
    );
    assert.equal(loadStoreSession(sessionsDirOf(root), start.sessionId)?.view.runs.length, 1);
  } finally {
    await disposeRuntime(bundle);
  }
});

test("推迟建会话文件（决策 432）：打开后不发消息就释放，不留会话文件与锁", async () => {
  const root = temp("pigeon-main-deferred-idle-");
  const home = temp("pigeon-main-deferred-idle-home-");
  const { bundle } = await deferredMain(root, home, [{ text: "好" }]);
  await disposeRuntime(bundle);
  assert.deepEqual(sessionFiles(root), []);
  const dir = sessionsDirOf(root);
  assert.ok(
    !existsSync(dir) || readdirSync(dir, { recursive: true }).length === 0,
    "会话根下没有任何文件或子目录"
  );
});

// 决策 444：启动不再建 .pigeon/state/、不写 .pigeon/.gitignore；git 仓库里第一次真写程序状态（第一条消息建会话文件）时，
// 忽略规则写进全局排除文件（测试总装已把全局配置与 XDG 目录指到临时位置，这里再核一遍）
function gitRepo(prefix: string): string {
  const root = temp(prefix);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  return root;
}

function globalIgnore(): { file: string; text: string } {
  const file = globalExcludesFile(tmpdir());
  assert.ok(
    realpathSync.native(dirname(dirname(file))).startsWith(realpathSync.native(tmpdir())),
    file
  );
  return { file, text: existsSync(file) ? readFileSync(file, "utf8") : "" };
}

test("决策 444：git 仓库里打开终端界面的会话、不发消息就释放，不留 .pigeon，也不写全局排除文件", async () => {
  const root = gitRepo("pigeon-main-noop-");
  const home = temp("pigeon-main-noop-home-");
  const before = globalIgnore().text;
  const { bundle } = await deferredMain(root, home, [{ text: "好" }]);
  assert.equal(existsSync(join(root, ".pigeon")), false, "打开之后就没有 .pigeon");
  await disposeRuntime(bundle);
  assert.equal(existsSync(join(root, ".pigeon")), false, "释放之后仍没有 .pigeon");
  assert.equal(globalIgnore().text, before);
});

test("决策 444：第一条消息建会话文件时才建 .pigeon/state/，忽略规则进全局排除文件，不写 .pigeon/.gitignore", async () => {
  const root = gitRepo("pigeon-main-first-");
  const home = temp("pigeon-main-first-home-");
  const { bundle } = await deferredMain(root, home, [{ text: "好" }]);
  try {
    const run = await bundle.adapter.run("你好");
    assert.equal(run.status, "completed", JSON.stringify(run.errorMessage));
    await bundle.sessionStore.flush();
    assert.ok(existsSync(join(root, ".pigeon", "state", "sessions")));
    assert.equal(existsSync(join(root, ".pigeon", ".gitignore")), false);
    const { text } = globalIgnore();
    for (const rule of [
      "**/.pigeon/state/",
      "**/.pigeon/settings.local.json",
      "**/.pigeon/worktrees/",
    ]) {
      assert.ok(text.split("\n").includes(rule), text);
    }
    // 程序状态不出现在 git status 里
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.ok(!status.includes(".pigeon"), status);
  } finally {
    await disposeRuntime(bundle);
  }
});
