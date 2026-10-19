// 子 agent 的运行面装配（决策 457、480）：会话文件在所属会话名下的子文件夹、文件头记来历、收件方记谁发给谁；
// explore 只给读与搜；前台直接带回回复；临时工作树从派出方的工作目录快照起步，有改动的结果附位置与分支、关掉时保留，
// 没有改动的关掉即删；决策 486：take_changes 把子 agent 工作树里的改动取回派出方的工作目录，完整取回后再没改的关掉即删
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { readSessionView } from "../persistence/session-catalog.ts";
import { listSessionFiles, readSessionFile } from "../persistence/session-reader.ts";
import { createFakeStreamFn, type FakeReply } from "../pi-runtime/fixtures.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import type { LayeredHook } from "../state/hooks.ts";
import { newSessionId } from "../state/ids.ts";
import { sessionsDirOf, subagentSessionsDir } from "../state/paths.ts";
import { SessionEntryType } from "../state/session-entries.ts";
import { emptySettingsSnapshot, type SettingsSnapshot } from "../state/settings.ts";
import { MailGate } from "./agent-mail.ts";
import { agentToolRegistrations, TAKE_CHANGES_TOOL } from "./agent-tools.ts";
import { loadAgentTypes } from "./agent-types.ts";
import { loadSessionHistory } from "./history.ts";
import type { McpSession } from "./mcp.ts";
import { humanInputText } from "./rewind.ts";
import { disposeRuntime } from "./runtime.ts";
import { accumulatedSessionCost, sessionCostTally } from "./session-cost.ts";
import { openSessionRuntime } from "./session-runtime.ts";
import { agentMessageEntry } from "./session-store.ts";
import { createSubagentOpener, inspectSubagent, restoredAgentsOf } from "./subagent-runtime.ts";
import { AGENT_TRUST_SENTENCE, AgentHub, type AgentToolsHost } from "./subagents.ts";
import { takeFromAgent } from "./take-changes.ts";
import { listLeftoverWorktrees } from "./worktree-cleanup.ts";

const noMcp = async (): Promise<McpSession> => ({
  tools: [],
  prompts: [],
  problems: [],
  connections: [],
  summary: () => ({ mcpTools: [], mcpServers: [] }),
  close: async () => {},
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function repo(): { dir: string; home: string; cleanup: () => void } {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-subagent-")));
  const home = mkdtempSync(join(tmpdir(), "pigeon-subagent-home-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "t"]);
  git(dir, ["config", "user.email", "t@example.invalid"]);
  writeFileSync(join(dir, ".gitignore"), ".pigeon/\n");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return {
    dir,
    home,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

// 派出方与子 agent 各一串回复：按系统提示里有没有子 agent 那一段分流
function routed(parent: FakeReply[], child: FakeReply[]) {
  const top = createFakeStreamFn({ replies: parent });
  const sub = createFakeStreamFn({ replies: child });
  const streamFn: StreamFn = (model, context, options) =>
    (context.systemPrompt ?? "").includes("You are a sub-agent named")
      ? sub(model, context, options)
      : top(model, context, options);
  return { streamFn, top, sub };
}

async function openTop(
  root: { dir: string; home: string },
  streamFn: StreamFn,
  delivered: string[],
  settings?: SettingsSnapshot,
  compaction?: { thresholdTokens: number; keepRecentTokens: number }
) {
  const hub = new AgentHub({ mail: new MailGate() });
  const sessionId = newSessionId();
  const flags = {
    yolo: true,
    provider: "custom",
    modelId: "custom",
    persistThinking: true,
    ...(compaction !== undefined ? { compaction } : {}),
  };
  let opened: Awaited<ReturnType<typeof openSessionRuntime>> | undefined;
  const bundle = () => {
    if (opened === undefined) throw new Error("not open");
    return opened.bundle;
  };
  const catalog = loadAgentTypes({ governanceRoot: root.dir, homeDir: root.home });
  const { host } = hub.registerSession({
    sessionId,
    name: () => "main",
    deliver: (text, mark) => {
      delivered.push(text);
      bundle().adapter.notify(text, mark);
    },
    pendingNotices: () => bundle().adapter.pendingNotices(),
    workspaceRoot: () => root.dir,
    record: (entry) =>
      bundle().sessionStore.append(agentMessageEntry(entry, bundle().adapter.currentRunId())),
    open: createSubagentOpener({
      governanceRoot: root.dir,
      streamFn,
      flags,
      warn: () => {},
      topSessionId: () => sessionId,
      topSessionFile: () => bundle().sessionStore.filePath(),
      topContext: () => ({
        sessionId,
        settings: bundle().settings,
        approvalModeCell: { current: "yolo" },
        workspaceRoot: root.dir,
        grants: [],
        modelId: "custom",
        transcript: () => bundle().adapter.transcript(),
      }),
      createApprovalHandler: () => async () => ({ approved: true }),
      notice: () => {},
      homeDir: root.home,
    }),
    catalog: () => catalog,
    limits: () => ({ maxConcurrent: 20, maxDepth: 3 }),
  });
  opened = await openSessionRuntime({
    governanceRoot: root.dir,
    sessionId,
    streamFn,
    flags,
    startMcp: noMcp,
    homeDir: root.home,
    agents: host,
    ...(settings !== undefined ? { settings } : {}),
  });
  return { hub, sessionId, opened };
}

test("前台派 explore：回复直接带回；会话文件在所属会话名下的 subagents 里，文件头记来历；只给读与搜；任务附信任说明并记谁发给谁", async () => {
  const root = repo();
  const delivered: string[] = [];
  const { streamFn, sub } = routed(
    [
      {
        text: "",
        toolCalls: [
          {
            name: "spawn_agent",
            args: { task: "find where a.txt is read", type: "explore", background: false },
          },
        ],
      },
      { text: "parent done" },
    ],
    [{ text: "found it in a.txt" }]
  );
  const { hub, sessionId, opened } = await openTop(root, streamFn, delivered);
  try {
    const result = await opened.bundle.adapter.run("go");
    assert.equal(result.status, "completed");
    const toolResult = opened.bundle.adapter
      .transcript()
      .find((message) => message.role === "toolResult");
    const text = JSON.stringify(toolResult);
    assert.match(text, /explore-1 finished\./);
    assert.ok(text.includes(AGENT_TRUST_SENTENCE), "前台的结果同样附信任说明");
    assert.match(text, /<<<BEGIN AGENT-MESSAGE [0-9a-f]{16}>>>/);
    assert.match(text, /found it in a\.txt/);
    assert.deepEqual(delivered, [], "前台的不另发消息");
    // 子 agent 只拿到读与搜的工具
    const advertised = (sub.calls[0]?.context.tools ?? []).map((tool) => tool.name);
    assert.ok(advertised.includes("read_file"), advertised.join(","));
    assert.ok(!advertised.includes("edit_file") && !advertised.includes("run_command"));
    assert.ok(!advertised.includes("spawn_agent"), "只读的不能再派子 agent");
    assert.ok(advertised.includes("send_message"));
    assert.match(sub.calls[0]?.context.systemPrompt ?? "", /read-only exploration agent/);
    assert.match(
      sub.calls[0]?.context.systemPrompt ?? "",
      /sub-agent named explore-1, started by session \S+ \(main\)/
    );
    const firstInput = JSON.stringify(sub.calls[0]?.context.messages.at(-1));
    assert.ok(firstInput.includes(AGENT_TRUST_SENTENCE));
    // 会话文件的位置与文件头
    await opened.bundle.sessionStore.flush();
    const topFile = await opened.bundle.sessionStore.filePath();
    assert.ok(topFile !== undefined);
    const childDir = subagentSessionsDir(topFile, sessionId);
    assert.equal(childDir, join(dirname(topFile), sessionId, "subagents"));
    const child = hub.agentsOf(sessionId)[0];
    assert.ok(child?.sessionId !== undefined);
    await hub.close();
    const files = listSessionFiles(childDir);
    assert.deepEqual(
      files.map((file) => file.sessionId),
      [child.sessionId]
    );
    const view = readSessionFile(files[0]?.path ?? "");
    assert.equal(view?.header.parentSessionId, sessionId);
    assert.deepEqual(view?.header.metadata?.pigeon, {
      version: 1,
      agent: { name: "explore-1", type: "explore", path: "explore-1", topSessionId: sessionId },
    });
    // 派出方的会话里记一条交回的结果
    assert.match(
      readFileSync(topFile, "utf8"),
      /"customType":"pigeon.agent-message"[^\n]*"kind":"result"/
    );
    const records = readFileSync(files[0]?.path ?? "", "utf8")
      .split("\n")
      .filter((line) => line.includes(SessionEntryType.AgentMessage));
    assert.equal(records.length, 1);
    assert.match(records[0] ?? "", /"from":"main","to":"explore-1","kind":"task"/);
  } finally {
    await disposeRuntime(opened.bundle).catch(() => {});
    root.cleanup();
  }
});

test("临时工作树：从派出方工作目录的快照起步（含未提交的改动）；有改动的结果附位置与分支，关掉时保留；没有改动的关掉即删", async () => {
  const root = repo();
  // 未提交的改动也要带进子 agent 的工作树
  writeFileSync(join(root.dir, "a.txt"), "uncommitted\n");
  const delivered: string[] = [];
  const { streamFn } = routed(
    [
      {
        text: "",
        toolCalls: [
          { name: "spawn_agent", args: { task: "write b.txt", worktree: true }, id: "s1" },
          {
            name: "spawn_agent",
            args: { task: "just read", name: "idle", worktree: true },
            id: "s2",
          },
        ],
      },
      { text: "waiting" },
    ],
    [
      { text: "", toolCalls: [{ name: "write_file", args: { path: "b.txt", content: "hi\n" } }] },
      { text: "wrote b.txt" },
    ]
  );
  const { hub, sessionId, opened } = await openTop(root, streamFn, delivered);
  try {
    await opened.bundle.adapter.run("go");
    // 两个后台子 agent 干完
    for (let i = 0; i < 200 && delivered.length < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const [writer, idle] = hub.agentsOf(sessionId);
    assert.ok(writer !== undefined && idle !== undefined);
    assert.equal(writer.state, "idle");
    const wt = writer.worktree;
    assert.ok(wt !== undefined, "有改动：结果附工作树");
    assert.match(wt.branch, /^pigeon\/general-1$/);
    // Windows 上检出按 autocrlf 转换行尾
    assert.equal(
      readFileSync(join(wt.path, "a.txt"), "utf8").replace(/\r\n/g, "\n"),
      "uncommitted\n"
    );
    assert.equal(readFileSync(join(wt.path, "b.txt"), "utf8"), "hi\n");
    const notice = delivered.find((text) => text.includes("general-1 finished."));
    assert.ok(
      notice?.includes(`Its changes are in the worktree at ${wt.path} (branch ${wt.branch}).`)
    );
    assert.equal(idle.worktree, undefined, "没有改动：不附工作树");
    await hub.close();
    // 决策 494：退出不删工作树，有没有改动都留着（收尾交给 /worktrees clean）
    assert.ok(existsSync(wt.path), "有改动的留着");
    assert.equal(existsSync(join(root.dir, "b.txt")), false, "派出方的工作目录不动");
  } finally {
    await disposeRuntime(opened.bundle).catch(() => {});
    root.cleanup();
  }
});

test("带上下文起步：复制派出方截到这一轮之前的对话（文件头记条数，视图与花费都跳过这一段）；续接时从会话记录认回它", async () => {
  const root = repo();
  const delivered: string[] = [];
  const { streamFn, sub } = routed(
    [
      { text: "hi there", contextTokens: 100 },
      {
        text: "",
        toolCalls: [
          {
            name: "spawn_agent",
            args: { task: "carry on", inherit_context: true, background: false },
          },
        ],
      },
      { text: "done" },
    ],
    [{ text: "child reply", contextTokens: 7 }]
  );
  const { hub, sessionId, opened } = await openTop(root, streamFn, delivered);
  try {
    await opened.bundle.adapter.run("hello");
    await opened.bundle.adapter.run("spawn one");
    const seen = JSON.stringify(sub.calls[0]?.context.messages);
    assert.ok(seen.includes("hello") && seen.includes("hi there"), "带着派出方的对话");
    assert.ok(!seen.includes("spawn_agent"), "派出它的那条助手消息不带");
    await opened.bundle.sessionStore.flush();
    const topFile = await opened.bundle.sessionStore.filePath();
    assert.ok(topFile !== undefined);
    await hub.close();
    const [file] = listSessionFiles(subagentSessionsDir(topFile, sessionId));
    assert.ok(file !== undefined);
    const view = readSessionView(file);
    // 复制了 hello、hi there、spawn one 与派出方的开工状态块
    assert.ok((view?.agent?.inheritedEntries ?? 0) >= 3);
    assert.equal(view?.copiedEntries, view?.agent?.inheritedEntries);
    assert.ok(!JSON.stringify(view?.messages).includes("hi there"), "复制段不进视图");
    // 花费：续接累计 = 会话自己 + 子 agent 自己的（复制段不重复计）
    const sessionsRoot = sessionsDirOf(root.dir);
    const own = sessionCostTally(sessionsRoot, sessionId);
    const total = accumulatedSessionCost(sessionsRoot, sessionId);
    assert.equal(total.unpricedTokens - own.unpricedTokens, 7);
    // 续接认回：干完了的标空闲
    assert.deepEqual(
      restoredAgentsOf(topFile, sessionId).map((agent) => ({
        name: agent.name,
        type: agent.type,
        parent: agent.parentSessionId,
        interrupted: agent.interrupted,
      })),
      [{ name: "general-1", type: "general", parent: sessionId, interrupted: false }]
    );
  } finally {
    await disposeRuntime(opened.bundle).catch(() => {});
    root.cleanup();
  }
});

test("决策 505：子 agent 的运行面给命令用的那一面——它自己的放权、上下文与手动压缩；改名记进它的会话记录，续接认回显示名", async () => {
  const root = repo();
  const delivered: string[] = [];
  const { streamFn } = routed(
    [
      {
        text: "",
        toolCalls: [{ name: "spawn_agent", args: { task: "carry on", background: false } }],
      },
      { text: "done" },
    ],
    [
      { text: `first ${"x".repeat(2000)}`, contextTokens: 50 },
      { text: `second ${"y".repeat(2000)}`, contextTokens: 80 },
      { text: "summary of the work so far" },
    ]
  );
  const { hub, sessionId, opened } = await openTop(root, streamFn, delivered, undefined, {
    thresholdTokens: 900_000,
    keepRecentTokens: 5,
  });
  try {
    await opened.bundle.adapter.run("spawn one");
    const [record] = hub.agentsOf(sessionId);
    assert.ok(record !== undefined);
    // 第二轮：使用者在它的视图里打的话
    assert.equal(hub.sendFromUser(record, "go on"), undefined);
    await record.activity;
    const inspect = inspectSubagent(record?.runtime);
    assert.ok(record !== undefined && inspect !== undefined);
    assert.equal(inspect.governanceRoot, root.dir);
    assert.notEqual(inspect.bundle.grantStore, opened.bundle.grantStore, "放权是它自己的");
    assert.ok(inspect.bundle.adapter.contextUsage() !== undefined, "上下文用量");
    const outcome = await hub.compacting(record, () => inspect.bundle.adapter.compact());
    assert.equal(outcome.kind, "compacted", "压成了");
    assert.ok(
      JSON.stringify(inspect.bundle.adapter.transcript()).includes("summary of the work so far")
    );
    hub.rename(record, "carrier");
    await inspect.bundle.sessionStore.flush();
    await opened.bundle.sessionStore.flush();
    const topFile = await opened.bundle.sessionStore.filePath();
    assert.ok(topFile !== undefined);
    assert.deepEqual(
      restoredAgentsOf(topFile, sessionId).map((agent) => [agent.name, agent.displayName]),
      [["general-1", "carrier"]]
    );
    await hub.close();
  } finally {
    await disposeRuntime(opened.bundle).catch(() => {});
    root.cleanup();
  }
});

test("钩子：SubagentStart 补的上下文作任务的前缀；SubagentStop 拦下即再跑一轮；两者都给 agent_name 与 agent_type", async () => {
  const root = repo();
  const start = join(root.home, "start.mjs");
  const stop = join(root.home, "stop.mjs");
  writeFileSync(
    start,
    [
      "import { writeFileSync } from 'node:fs';",
      "let data = '';",
      "process.stdin.on('data', (c) => (data += c)).on('end', () => {",
      `  writeFileSync(${JSON.stringify(join(root.home, "start.json"))}, data);`,
      "  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: 'CTX-FROM-HOOK' } }));",
      "});",
    ].join("\n")
  );
  writeFileSync(
    stop,
    [
      "import { writeFileSync } from 'node:fs';",
      "let data = '';",
      "process.stdin.on('data', (c) => (data += c)).on('end', () => {",
      `  writeFileSync(${JSON.stringify(join(root.home, "stop.json"))}, data);`,
      "  if (!JSON.parse(data).stop_hook_active) { process.stderr.write('check again'); process.exit(2); }",
      "});",
    ].join("\n")
  );
  const hook = (event: LayeredHook["event"], file: string): LayeredHook => ({
    event,
    command: `node "${file}"`,
    host: false,
    layer: "project",
    matcher: "general",
  });
  const base = emptySettingsSnapshot(root.dir);
  const settings: SettingsSnapshot = {
    ...base,
    hooks: [hook("SubagentStart", start), hook("SubagentStop", stop)],
  };
  const { streamFn, sub } = routed(
    [
      {
        text: "",
        toolCalls: [{ name: "spawn_agent", args: { task: "do it", background: false } }],
      },
      { text: "ok" },
    ],
    [{ text: "first" }, { text: "second" }]
  );
  const { hub, opened } = await openTop(root, streamFn, [], settings);
  try {
    await opened.bundle.adapter.run("go");
    assert.equal(sub.calls.length, 2, "SubagentStop 拦下一次即再跑一轮");
    assert.match(JSON.stringify(sub.calls[0]?.context.messages.at(-1)), /CTX-FROM-HOOK/);
    assert.match(JSON.stringify(sub.calls[1]?.context.messages.at(-1)), /check again/);
    const startInput = JSON.parse(readFileSync(join(root.home, "start.json"), "utf8"));
    assert.equal(startInput.hook_event_name, "SubagentStart");
    assert.equal(startInput.agent_name, "general-1");
    assert.equal(startInput.agent_type, "general");
    const stopInput = JSON.parse(readFileSync(join(root.home, "stop.json"), "utf8"));
    assert.equal(stopInput.stop_hook_active, true);
    assert.equal(stopInput.last_assistant_message, "second");
    const toolResult = JSON.stringify(
      opened.bundle.adapter.transcript().find((message) => message.role === "toolResult")
    );
    assert.match(toolResult, /second/);
    await hub.close();
  } finally {
    await disposeRuntime(opened.bundle).catch(() => {});
    root.cleanup();
  }
});

test("回看、回退与续接列表按消息上的标记认出 agent 的传话：后台交回的结果显示成系统行，不算人说的话，不成为回退点", async () => {
  const root = repo();
  const delivered: string[] = [];
  const { streamFn } = routed(
    [
      { text: "", toolCalls: [{ name: "spawn_agent", args: { task: "look" } }] },
      { text: "started" },
      { text: "thanks" },
    ],
    [{ text: "child says hi" }]
  );
  const { hub, sessionId, opened } = await openTop(root, streamFn, delivered);
  try {
    await opened.bundle.adapter.run("first human words");
    for (let i = 0; i < 200 && delivered.length < 1; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await opened.bundle.adapter.runNotices();
    await opened.bundle.sessionStore.flush();
    const agentTurn = opened.bundle.adapter
      .transcript()
      .find(
        (message) => JSON.stringify(message).includes("child says hi") && message.role === "user"
      );
    assert.ok(agentTurn !== undefined);
    assert.equal(humanInputText(agentTurn), undefined, "不是人说的话");
    const lines = loadSessionHistory(root.dir, sessionId);
    const users = lines.filter((line) => line.kind === "user").map((line) => line.text);
    assert.ok(users.some((text) => text.includes("first human words")));
    assert.ok(!users.some((text) => text.includes("child says hi")), users.join(" | "));
    assert.ok(lines.some((line) => line.kind === "notice" && line.text.includes("child says hi")));
    await hub.close();
  } finally {
    await disposeRuntime(opened.bundle).catch(() => {});
    root.cleanup();
  }
});

test("决策 486：take_changes 把子 agent 工作树里的改动（含新建文件）叠进派出方的工作目录；再取只取之后的；不认识的名字报错；完整取回后再没改的关掉即删", async () => {
  const root = repo();
  const delivered: string[] = [];
  const { streamFn } = routed(
    [
      {
        text: "",
        toolCalls: [
          {
            name: "spawn_agent",
            args: { task: "write b.txt", worktree: true, background: false },
            id: "s1",
          },
        ],
      },
      { text: "", toolCalls: [{ name: "take_changes", args: { target: "general-1" }, id: "t1" }] },
      { text: "", toolCalls: [{ name: "take_changes", args: { target: "general-1" }, id: "t2" }] },
      { text: "", toolCalls: [{ name: "take_changes", args: { target: "nobody" }, id: "t3" }] },
      { text: "done" },
    ],
    [
      { text: "", toolCalls: [{ name: "write_file", args: { path: "b.txt", content: "hi\n" } }] },
      { text: "wrote b.txt" },
    ]
  );
  const { hub, sessionId, opened } = await openTop(root, streamFn, delivered);
  try {
    await opened.bundle.adapter.run("go");
    const [writer] = hub.agentsOf(sessionId);
    const wt = writer?.worktree;
    assert.ok(wt !== undefined);
    assert.equal(
      readFileSync(join(root.dir, "b.txt"), "utf8").replace(/\r\n/g, "\n"),
      "hi\n",
      "新建的文件叠进派出方的工作目录"
    );
    const transcript = JSON.stringify(opened.bundle.adapter.transcript());
    assert.ok(transcript.includes("Use take_changes with its name"), "交回结果里写明用它取回");
    assert.ok(transcript.includes("took 1 file: b.txt"));
    assert.ok(transcript.includes("no changes to take from sub-agent general-1"), "再取只取之后的");
    assert.ok(transcript.includes("no sub-agent named nobody that you started"));
    await hub.close();
    // 子 agent 的工作树随它自己收尾清理（决策 494 说的是会话退出不删，不含临时分身）
    assert.equal(existsSync(wt.path), false, "完整取回之后再没改：关掉即删");
  } finally {
    await disposeRuntime(opened.bundle).catch(() => {});
    root.cleanup();
  }
});

// 决策 494：项目开在仓库子目录里时，经派出流程（createSubagentOpener）建的子 agent 临时工作树也在主仓库根的 .pigeon/trees 下，
// 从子目录项目跑 /worktrees 列得出
test("子目录项目派出带工作树的子 agent：树建在主仓库根下，/worktrees 从子目录列得出", async () => {
  const root = repo();
  const project = join(root.dir, "packages", "web");
  mkdirSync(project, { recursive: true });
  const delivered: string[] = [];
  const { streamFn } = routed(
    [
      {
        text: "",
        toolCalls: [
          {
            name: "spawn_agent",
            args: { task: "write b.txt", worktree: true, background: false },
            id: "s1",
          },
        ],
      },
      { text: "done" },
    ],
    [
      { text: "", toolCalls: [{ name: "write_file", args: { path: "b.txt", content: "hi\n" } }] },
      { text: "wrote b.txt" },
    ]
  );
  const { hub, sessionId, opened } = await openTop(
    { dir: project, home: root.home },
    streamFn,
    delivered
  );
  try {
    await opened.bundle.adapter.run("go");
    const [writer] = hub.agentsOf(sessionId);
    const wt = writer?.worktree;
    assert.ok(wt !== undefined);
    assert.equal(dirname(wt.path), join(root.dir, ".pigeon", "trees"), "树在主仓库根下");
    const items = listLeftoverWorktrees({ workspaceRoot: project, homeDir: root.home });
    assert.ok(items.some((item) => item.path !== undefined && samePath(item.path, wt.path)));
    await hub.close();
  } finally {
    await disposeRuntime(opened.bundle).catch(() => {});
    root.cleanup();
  }
});

test("决策 486：take_changes 按写档注册（ask 模式下审批；只读类型的工具范围不收它）", () => {
  const host = { canSpawn: () => false } as unknown as AgentToolsHost;
  const take = agentToolRegistrations(host).find((item) => item.name === TAKE_CHANGES_TOOL);
  assert.equal(take?.tier, "write");
});

test("决策 486：派出方有未提交改动时按起点快照引用取回；取回起点钉在引用上，从引用读回；派出方自己改过的块不被重新叠回", async () => {
  const root = repo();
  writeFileSync(join(root.dir, "a.txt"), "uncommitted\n");
  const delivered: string[] = [];
  const { streamFn } = routed(
    [
      {
        text: "",
        toolCalls: [
          {
            name: "spawn_agent",
            args: { task: "write c.txt", worktree: true, background: false },
            id: "s1",
          },
        ],
      },
      { text: "", toolCalls: [{ name: "take_changes", args: { target: "general-1" }, id: "t1" }] },
      { text: "done" },
    ],
    [
      { text: "", toolCalls: [{ name: "write_file", args: { path: "c.txt", content: "c\n" } }] },
      { text: "wrote c.txt" },
    ]
  );
  const { hub, sessionId, opened } = await openTop(root, streamFn, delivered);
  try {
    await opened.bundle.adapter.run("go");
    const [writer] = hub.agentsOf(sessionId);
    const wt = writer?.worktree;
    assert.ok(wt !== undefined);
    assert.equal(readFileSync(join(root.dir, "c.txt"), "utf8").replace(/\r\n/g, "\n"), "c\n");
    assert.equal(
      readFileSync(join(root.dir, "a.txt"), "utf8").replace(/\r\n/g, "\n"),
      "uncommitted\n",
      "派出方未提交的改动不受影响"
    );
    const tail = wt.branch.replace(/^pigeon\//, "");
    const pinned = git(root.dir, [
      "for-each-ref",
      "--format=%(refname)",
      `refs/pigeon/agent/${tail}`,
    ]);
    assert.match(pinned, /refs\/pigeon\/agent\//, "取回起点钉在引用上");
    // 派出方撤掉取回来的文件：再取（起点从引用读回，已前移）不重新叠回
    rmSync(join(root.dir, "c.txt"));
    const again = takeFromAgent({
      name: "general-1",
      sessionId: writer?.sessionId,
      workspace: wt.path,
      into: root.dir,
    });
    assert.equal(again.text, "no changes to take from sub-agent general-1");
    assert.equal(existsSync(join(root.dir, "c.txt")), false);
  } finally {
    await hub.close();
    await disposeRuntime(opened.bundle).catch(() => {});
    root.cleanup();
  }
});

function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
