// M4 S6 端到端验收：grant 生命周期的人机链路（fake streamFn 驱动真实 pi-agent-core Agent）。
// 不经命令行对话：每个任务直接调 adapter.run；审批由按脚本作答的人答（scriptedApprovalHandler——与终端界面
// 同一个审批 handler、同一份放权语义与结论行）；斜杠命令直接走真实 runGrantCommand。
// 测试一（会话生命周期）：审批 [a] 建 grant → 第二次调用免审（approvedBy=human:grant）→
//   /grants 列出 → /revoke 立即停免审（重新弹人工）；授权建立与撤销、各次调用的审批闸决定落进会话存储。
// 测试二（升格 + 冷恢复）：/grants save 写项目个人设置 .pigeon/settings.local.json（promotedFrom 出处）→
//   模拟新进程：从会话文件还原生效的会话 grant（决策 3b 静默续命）→ 撤销后配置规则命中
//   （approvedBy=policy:config）。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { test } from "vitest";
import { SessionGrantStore } from "../approvals/grant-store.ts";
import { loadGrantConfig } from "../persistence/grants-config.ts";
import { acquireSessionFileLock } from "../persistence/session-lock.ts";
import { locateSessionFile } from "../persistence/session-reader.ts";
import { loadStoreSession } from "../persistence/session-view.ts";
import { PiRuntimeAdapter, type RunResult } from "../pi-runtime/adapter.ts";
import { createFakeStreamFn, type FakeReply } from "../pi-runtime/fixtures.ts";
import { openSessionStoreWriter, type SessionStoreWriter } from "../pi-runtime/session-store.ts";
import { INJECTION_SNAPSHOT_VERSION } from "../pi-runtime/snapshot.ts";
import type { ConfigGrantRule } from "../state/grants.ts";
import { asSessionId, type SessionId } from "../state/ids.ts";
import { storeActiveGrants, toolResultMark } from "../state/session-judge.ts";
import { createEditFileTool, type EditFileParams } from "../tools/edit-file.ts";
import { lineTag, snapshotTag } from "../tools/hashline.ts";
import { createReadFileTool } from "../tools/read-file.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { scriptedApprovalHandler } from "../tui/approval-fixtures.ts";
import { createToolGovernance } from "./governance.ts";
import { type GrantsCommandContext, runGrantCommand } from "./grants.ts";
import { grantEventSink } from "./session-store.ts";

const SESSION_A = asSessionId("sess_01J5Z7K8W9ABCDEFGHJKMNPRAA");
const SESSION_B = asSessionId("sess_01J5Z7K8W9ABCDEFGHJKMNPRBB");

function editCall(content: string, oldLine: string, newLine: string): EditFileParams {
  return {
    path: "a.ts",
    snapshot: snapshotTag(content),
    edits: [{ op: "replace", anchor: `1#${lineTag(oldLine)}`, lines: [newLine] }],
  };
}

// 模型的一条回复：带一次 edit_file 调用（单行替换）
function editReply(text: string, content: string, oldLine: string, newLine: string): FakeReply {
  return {
    text,
    toolCalls: [{ name: "edit_file", args: { ...editCall(content, oldLine, newLine) } }],
  };
}

// 会话存储写者（同生产：取跨进程单写者锁；已有会话文件即续写）；写入故障收进 faults
function openStore(root: string, sessionId: SessionId, faults: unknown[]): SessionStoreWriter {
  const sessionsDir = join(root, ".pigeon", "state", "sessions");
  const existing = locateSessionFile(sessionsDir, sessionId);
  return openSessionStoreWriter({
    sessionsRoot: sessionsDir,
    sessionId,
    cwd: root,
    lock: acquireSessionFileLock,
    ...(existing !== undefined ? { existingPath: existing.path } : {}),
    onFault: (fault) => faults.push(fault),
  });
}

// 会话文件里各工具结果上审批闸的批准来源（按出现顺序）
function gateSources(root: string, sessionId: SessionId): Array<string | undefined> {
  const loaded = loadStoreSession(join(root, ".pigeon", "state", "sessions"), sessionId);
  assert.ok(loaded !== undefined, "会话文件应在会话存储里");
  return loaded.view.runs.flatMap((run) =>
    run.messages
      .filter((ref) => ref.message.role === "toolResult")
      .map((ref) => toolResultMark(ref.message)?.gate?.approvedBy)
  );
}

// 本次 Run 各工具调用的审批闸决定：[结论, 批准来源]
function approvals(result: RunResult): Array<[string | undefined, string | undefined]> {
  return result.toolExecutions.map((record) => [
    record.decision?.outcome,
    record.decision?.approvedBy,
  ]);
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "read_file",
    description: "读取工作区内文件内容",
    parameters: Type.Object({ path: Type.String() }),
    tier: "read",
    pathConfinement: { kind: "workspace" },
    executionMode: "parallel",
  });
  registry.register({
    name: "edit_file",
    description: "hashline 锚定稀疏编辑",
    parameters: Type.Object({}),
    tier: "write",
    pathConfinement: { kind: "workspace" },
    executionMode: "sequential",
  });
  return registry;
}

interface TestAdapter {
  adapter: PiRuntimeAdapter;
  // 按脚本作答的人被问到的（审批块的按键提示行、拒绝理由提示），按顺序
  prompts: string[];
  // 审批块与答完的一行结论（终端界面里看到的）
  screen: () => string;
}

// answers：按脚本作答的人依次给出的回答（按键或拒绝理由）；答完了还被问即按 n 单按拒绝
function makeAdapter(
  root: string,
  replies: FakeReply[],
  store: SessionGrantStore,
  configRules: readonly ConfigGrantRule[],
  sessionId: SessionId,
  sessionStore: SessionStoreWriter,
  answers: string[]
): TestAdapter {
  const prompts: string[] = [];
  let screen = "";
  const ask = async (prompt: string): Promise<string | null> => {
    prompts.push(prompt);
    return answers.shift() ?? null;
  };
  const adapter = new PiRuntimeAdapter({
    snapshot: {
      version: INJECTION_SNAPSHOT_VERSION,
      model: { provider: "fake-provider", id: "fake-model-1" },
      tools: {
        policy: { allow: ["read_file", "edit_file"], deny: [], approvalMode: "prompt" },
        advertised: [],
      },
      context: { systemPrompt: "你是 Pigeon 测试助手。" },
      memory: [],
      skills: [],
      createdAt: 1700000000000,
    },
    streamFn: createFakeStreamFn({ replies }),
    governance: createToolGovernance({
      registry: makeRegistry(),
      approvalHandler: scriptedApprovalHandler(
        ask,
        (text) => {
          screen += text;
        },
        { grants: store }
      ),
      sessionGrants: store,
      configGrants: configRules,
      workspaceRoot: root,
    }),
    tools: [createReadFileTool(root), createEditFileTool(root)],
    sessionId,
    sessionStore,
  });
  return { adapter, prompts, screen: () => screen };
}

test("端到端（会话生命周期）：[a] 建 grant → human:grant 免审 → /grants → /revoke 立即停免审", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-grants-e2e-a-"));
  writeFileSync(join(root, "a.ts"), "alpha\n");
  const faults: unknown[] = [];
  const sessionStore = openStore(root, SESSION_A, faults);
  try {
    const store = new SessionGrantStore({
      workspaceRoot: root,
      sink: grantEventSink(sessionStore),
    });
    const commandOutput: string[] = [];
    const commands: GrantsCommandContext = {
      root,
      store,
      configRules: [],
      sessionId: SESSION_A,
      write: (t) => commandOutput.push(t),
    };

    // 同一会话：任务一审批 [a] 建 grant；任务二免审；/grants 列出；/revoke 后任务三重新弹人工（剧本给 n + 逐字理由）
    const r = makeAdapter(
      root,
      [
        editReply("改1", "alpha\n", "alpha", "STEP1"),
        { text: "好" },
        editReply("改2", "STEP1\n", "STEP1", "STEP2"),
        { text: "完成" },
        editReply("改3", "STEP2\n", "STEP2", "STEP3"),
        { text: "被拒绝了" },
      ],
      store,
      [],
      SESSION_A,
      sessionStore,
      ["a", "n", "先别动这个文件"]
    );

    const run1 = await r.adapter.run("任务一");
    assert.equal(run1.status, "completed");
    assert.deepEqual(approvals(run1), [["approved", "human"]]);
    assert.equal(r.prompts.length, 1);
    assert.ok(
      r.prompts[0]?.includes("[a] allow for this session"),
      `四键提示在场\n${r.prompts[0]}`
    );
    assert.ok(
      r.screen().includes("✓ allowed for this session: edit_file"),
      `[a] 建会话放权\n${r.screen()}`
    );
    const grant = store.list()[0];
    assert.ok(grant);
    assert.equal(grant.tool, "edit_file");

    // 第二次调用免审：不再问人、不弹审批块，批准来源记 human:grant 并回指该 grant
    const screenAfterRun1 = r.screen();
    const run2 = await r.adapter.run("任务二");
    assert.equal(run2.status, "completed");
    assert.deepEqual(approvals(run2), [["approved", "human:grant"]]);
    assert.deepEqual(run2.toolExecutions[0]?.decision?.grantRef, {
      kind: "session-grant",
      id: grant.grantId,
    });
    assert.equal(r.prompts.length, 1, "免审调用不问人");
    assert.equal(r.screen(), screenAfterRun1, "免审调用不弹审批块");
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "STEP2\n");

    // /grants 列出
    assert.equal(runGrantCommand(["grants"], commands), true);
    const listing = commandOutput.join("");
    assert.ok(listing.includes(grant.grantId), `/grants 列出 grant id\n${listing}`);
    assert.ok(listing.includes("1 hit"), listing);

    // /revoke：立即停免审——同一会话的下一任务重新弹人工
    commandOutput.length = 0;
    assert.equal(runGrantCommand(["revoke", grant.grantId], commands), true);
    assert.equal(commandOutput.join(""), `revoked ${grant.grantId}\n`);
    assert.equal(store.list().length, 0);

    const run3 = await r.adapter.run("任务三");
    await r.adapter.dispose();
    assert.equal(run3.status, "completed");
    assert.deepEqual(
      approvals(run3),
      [["rejected", "human"]],
      "撤销后重新弹人工，批准来源回到 human"
    );
    assert.equal(run3.toolExecutions[0]?.decision?.reason, "先别动这个文件");
    assert.equal(run3.toolExecutions[0]?.decision?.reasonSource, "human");
    assert.equal(r.prompts.length, 3, "撤销后重新问人（按键 + 拒绝理由）");
    assert.ok(r.prompts[1]?.includes("[a] allow for this session"), r.prompts[1]);
    assert.ok(r.prompts[2]?.startsWith("拒绝理由"), r.prompts[2]);
    assert.ok(
      r.screen().includes("✗ rejected edit_file: a.ts (先别动这个文件)"),
      `拒绝结论带逐字理由\n${r.screen()}`
    );
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "STEP2\n", "拒绝后副作用未发生");

    // 会话存储：授权建立与撤销各一条（撤销后生效集为空）；三次调用的审批闸决定依次是人工、会话放权、人工
    await sessionStore.flush();
    assert.deepEqual(faults, []);
    const loaded = loadStoreSession(join(root, ".pigeon", "state", "sessions"), SESSION_A);
    assert.ok(loaded !== undefined);
    assert.deepEqual(
      loaded.view.grants.map(({ data }) => [data.event, data.grantId]),
      [
        ["created", grant.grantId],
        ["revoked", grant.grantId],
      ]
    );
    assert.deepEqual(storeActiveGrants(loaded.view), []);
    assert.deepEqual(gateSources(root, SESSION_A), ["human", "human:grant", "human"]);
    // 被拒的那次调用：工具结果出错，拒绝理由逐字在正文里
    const rejected = loaded.view.runs
      .flatMap((run) => run.messages)
      .filter((ref) => ref.message.role === "toolResult")
      .at(-1)?.message;
    assert.equal(rejected?.isError, true);
    assert.equal(toolResultMark(rejected ?? { role: "none" })?.gate?.outcome, "rejected");
    assert.ok(
      JSON.stringify(rejected?.content).includes("先别动这个文件"),
      JSON.stringify(rejected)
    );
  } finally {
    await sessionStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("端到端（升格 + 冷恢复）：/grants save 写配置 → 新进程会话 grant 静默续命 → 撤销后 policy:config", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-grants-e2e-b-"));
  writeFileSync(join(root, "a.ts"), "alpha\n");
  const sessionsDir = join(root, ".pigeon", "state", "sessions");
  const faults: unknown[] = [];
  let sessionStore = openStore(root, SESSION_B, faults);
  try {
    const store = new SessionGrantStore({
      workspaceRoot: root,
      sink: grantEventSink(sessionStore),
    });

    // 第一个进程：审批 [a] 建 grant；第二次调用免审
    const r1 = makeAdapter(
      root,
      [
        editReply("改1", "alpha\n", "alpha", "STEP1"),
        { text: "好" },
        editReply("改2", "STEP1\n", "STEP1", "STEP2"),
        { text: "完成" },
      ],
      store,
      [],
      SESSION_B,
      sessionStore,
      ["a"]
    );
    const run1 = await r1.adapter.run("任务一");
    const run2 = await r1.adapter.run("任务二");
    await r1.adapter.dispose();
    assert.equal(run1.status, "completed");
    assert.equal(run2.status, "completed");
    assert.deepEqual(approvals(run1), [["approved", "human"]]);
    assert.deepEqual(approvals(run2), [["approved", "human:grant"]], "第二次调用免记 human:grant");
    assert.equal(r1.prompts.length, 1, "只有第一次调用问人");
    assert.ok(r1.screen().includes("✓ allowed for this session: edit_file"), r1.screen());
    const grant = store.list()[0];
    assert.ok(grant);

    // /grants save：升格写项目个人设置 .pigeon/settings.local.json（promotedFrom 出处）
    const outputs2: string[] = [];
    const commands: GrantsCommandContext = {
      root,
      store,
      configRules: [],
      sessionId: SESSION_B,
      write: (t) => outputs2.push(t),
    };
    assert.equal(runGrantCommand(["grants", "save", grant.grantId], commands), true);
    assert.equal(outputs2.join(""), `saved ${grant.grantId} → .pigeon/settings.local.json\n`);
    assert.ok(existsSync(join(root, ".pigeon", "settings.local.json")));
    const configRules = loadGrantConfig(root);
    assert.equal(configRules.length, 1);
    assert.equal(configRules[0]?.tool, "edit_file");
    assert.equal(configRules[0]?.promotedFrom.grantId, grant.grantId);
    assert.equal(configRules[0]?.promotedFrom.sessionId, SESSION_B);

    // 模拟新进程：旧写者关闭，从会话文件还原生效 grant（决策 3b：静默续命，无重复确认），新写者续写同一文件
    await sessionStore.close();
    assert.deepEqual(faults, []);
    const restoredView = loadStoreSession(sessionsDir, SESSION_B)?.view;
    assert.ok(restoredView !== undefined);
    const restoredGrants = storeActiveGrants(restoredView);
    assert.deepEqual(
      restoredGrants.map((restored) => restored.grantId),
      [grant.grantId],
      "升格前的会话 grant 在冷恢复生效集内"
    );
    sessionStore = openStore(root, SESSION_B, faults);
    const freshStore = new SessionGrantStore({
      workspaceRoot: root,
      sink: grantEventSink(sessionStore),
      restored: restoredGrants,
    });
    // 新进程里没人答也不该被问（答完了还被问即按 n 拒绝，下面的断言会抓到）
    const r3 = makeAdapter(
      root,
      [
        editReply("改3", "STEP2\n", "STEP2", "STEP3"),
        { text: "完成" },
        editReply("改4", "STEP3\n", "STEP3", "STEP4"),
        { text: "完成" },
      ],
      freshStore,
      loadGrantConfig(root),
      SESSION_B,
      sessionStore,
      []
    );
    const run3 = await r3.adapter.run("任务三");
    assert.equal(run3.status, "completed");
    assert.deepEqual(
      approvals(run3),
      [["approved", "human:grant"]],
      "冷恢复后会话 grant 继续免记 human:grant"
    );
    assert.deepEqual(run3.toolExecutions[0]?.decision?.grantRef, {
      kind: "session-grant",
      id: grant.grantId,
    });
    assert.equal(r3.prompts.length, 0, "静默续命：不重复确认");

    // 撤销会话 grant（在续命的 freshStore 上撤）：配置规则接管，命中记 policy:config
    const outputs4: string[] = [];
    assert.equal(
      runGrantCommand(["revoke", grant.grantId], {
        root,
        store: freshStore,
        configRules: loadGrantConfig(root),
        sessionId: SESSION_B,
        write: (t) => outputs4.push(t),
      }),
      true
    );
    assert.equal(outputs4.join(""), `revoked ${grant.grantId}\n`);
    assert.equal(freshStore.list().length, 0);
    const run4 = await r3.adapter.run("任务四");
    await r3.adapter.dispose();
    assert.equal(run4.status, "completed");
    assert.deepEqual(
      approvals(run4),
      [["approved", "policy:config"]],
      "固化规则命中记 policy:config"
    );
    assert.deepEqual(run4.toolExecutions[0]?.decision?.grantRef, {
      kind: "config-rule",
      id: grant.grantId,
    });
    assert.equal(r3.prompts.length, 0, "固化规则命中不问人");
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "STEP4\n");
    // 会话存储：四次调用的审批闸决定依次是人工、会话放权、冷恢复后的会话放权、配置规则；撤销后生效集为空
    await sessionStore.flush();
    assert.deepEqual(faults, []);
    assert.deepEqual(gateSources(root, SESSION_B), [
      "human",
      "human:grant",
      "human:grant",
      "policy:config",
    ]);
    const finalView = loadStoreSession(sessionsDir, SESSION_B)?.view;
    assert.ok(finalView !== undefined);
    assert.deepEqual(storeActiveGrants(finalView), []);
  } finally {
    await sessionStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});
