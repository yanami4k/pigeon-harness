// M4 S3：CLI trace 命令（只读静态报告）测试——读新会话存储（决策 180 / 181）。中文标签、id 短哈希、参数截断、
// 分类徽章（通俗措辞）、工具调用与结果配对、崩溃残留与读取告警可见、只读性（读正被写入的文件不改文件、不触碰工作区）。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { test } from "vitest";
import { createToolGovernance } from "../application/governance.ts";
import {
  appendRawLine,
  createFixtureSession,
  forkFixture,
  tearTail,
} from "../application/session-store-fixtures.ts";
import { writeLegacySessionFile } from "../application/session-view-fixtures.ts";
import { LEGACY_READER_HINT } from "../persistence/session-catalog.ts";
import { acquireSessionFileLock } from "../persistence/session-lock.ts";
import { locateSessionFile } from "../persistence/session-reader.ts";
import { PiRuntimeAdapter } from "../pi-runtime/adapter.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { openSessionStoreWriter } from "../pi-runtime/session-store.ts";
import { INJECTION_SNAPSHOT_VERSION, type InjectionSnapshot } from "../pi-runtime/snapshot.ts";
import { newSessionId, type RunId, type SessionId } from "../state/ids.ts";
import { createEditFileTool, type EditFileParams } from "../tools/edit-file.ts";
import { lineTag, snapshotTag } from "../tools/hashline.ts";
import { createReadFileTool } from "../tools/read-file.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { runTraceCommand } from "./trace.ts";

const SYSTEM_PROMPT = "你是 Pigeon 测试助手。";

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

function makeSnapshot(): InjectionSnapshot {
  return {
    version: INJECTION_SNAPSHOT_VERSION,
    model: { provider: "fake-provider", id: "fake-model-1" },
    tools: {
      policy: { allow: ["read_file", "edit_file"], deny: [], approvalMode: "prompt" },
      advertised: [],
    },
    context: { systemPrompt: SYSTEM_PROMPT },
    memory: [],
    skills: [],
    createdAt: 1700000000000,
  };
}

function editCall(content: string): EditFileParams {
  return {
    path: "a.ts",
    snapshot: snapshotTag(content),
    edits: [{ op: "replace", anchor: `2#${lineTag("beta")}`, lines: ["BETA"] }],
  };
}

// 经真实 Adapter 跑一次（写进会话存储）：读一次、改一次（批准）、再改一次（人工拒绝）、收尾
async function scriptSession(
  root: string,
  replies: Parameters<typeof createFakeStreamFn>[0]["replies"],
  sessionId: SessionId = newSessionId()
): Promise<{ sessionId: SessionId; runId: RunId }> {
  const sessionsDir = join(root, ".pigeon", "state", "sessions");
  const existing = locateSessionFile(sessionsDir, sessionId);
  const store = openSessionStoreWriter({
    sessionsRoot: sessionsDir,
    sessionId,
    cwd: root,
    lock: acquireSessionFileLock,
    ...(existing !== undefined ? { existingPath: existing.path } : {}),
  });
  let editApprovals = 0;
  const adapter = new PiRuntimeAdapter({
    snapshot: makeSnapshot(),
    streamFn: createFakeStreamFn({ replies }),
    governance: createToolGovernance({
      registry: makeRegistry(),
      approvalHandler: async ({ toolName }) => {
        if (toolName === "edit_file") {
          editApprovals += 1;
          return editApprovals === 1
            ? { approved: true }
            : { approved: false, reason: "先别动这个文件" };
        }
        return { approved: true };
      },
    }),
    tools: [createReadFileTool(root), createEditFileTool(root)],
    sessionId,
    sessionStore: store,
  });
  const result = await adapter.run("改文件");
  await adapter.dispose();
  await store.close();
  return { sessionId, runId: result.runId };
}

const EDIT_SCRIPT = [
  { text: "先读", toolCalls: [{ name: "read_file", args: { path: "a.ts" } }] },
  { text: "再改", toolCalls: [{ name: "edit_file", args: editCall("alpha\nbeta\ngamma\n") }] },
  { text: "继续改", toolCalls: [{ name: "edit_file", args: editCall("alpha\nbeta\ngamma\n") }] },
  { text: "完成" },
];

function withRoot(run: (root: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pigeon-trace-cli-"));
  writeFileSync(join(root, "a.ts"), "alpha\nbeta\ngamma\n");
  return Promise.resolve()
    .then(() => run(root))
    .finally(() => rmSync(root, { recursive: true, force: true }));
}

test("trace 报告（真实运行）：会话头、启动快照、逐轮 stopReason、工具调用参数、结果、审批结果与分类徽章；不再有回执", () =>
  withRoot(async (root) => {
    const { sessionId, runId } = await scriptSession(root, EDIT_SCRIPT);
    const output = runTraceCommand({ root, sessionId });
    const lines = output.split("\n");
    assert.equal(lines[0], `session ${sessionId.slice(0, 13)}… | 1 run | 3 tool calls`);
    assert.ok(!output.includes(sessionId), "会话 id 必须短哈希");
    assert.ok(!output.includes(runId), "Run id 同样短哈希");
    assert.ok(lines.includes(`Run ${runId.slice(0, 12)}… | stopReason=stop | class: ok`), output);
    const hash = createHash("sha256").update(SYSTEM_PROMPT).digest("hex").slice(0, 12);
    assert.ok(
      output.includes(
        `  start: model fake-provider/fake-model-1 | effort off | approval mode prompt | tools read_file, edit_file | memory 0 (0 injected) | skills 0 | system prompt ${hash} | 4 model requests`
      ),
      output
    );
    assert.ok(output.includes("  ended: completed (8 messages)"), output);
    for (const index of [1, 2, 3, 4]) {
      assert.ok(output.includes(`  turn ${index} | `), `第 ${index} 轮缺失\n${output}`);
    }
    assert.match(output, /turn 1 \| \d\d:\d\d:\d\d\(UTC\) \| stopReason=toolUse/);
    assert.match(output, /turn 4 \| \d\d:\d\d:\d\d\(UTC\) \| stopReason=stop/);
    assert.ok(output.includes('      args: {"path":"a.ts"}'), output);
    assert.equal(output.split("      result: ok").length - 1, 2, output);
    assert.equal(output.split("      result: error").length - 1, 1, output);
    // 审批结果与工具级分类取自运行面挂在工具结果消息上的标记：读档自动放行、第一次改人工批准、第二次改人工拒绝
    assert.deepEqual(
      output.split("\n").filter((line) => line.startsWith("      approval: ")),
      [
        "      approval: auto-allowed by policy (policy:auto)",
        "      approval: approved by human (human)",
        "      approval: rejected by human (human)",
      ],
      output
    );
    assert.ok(!output.includes("error kind:"), output);
    assert.equal(output.split("      class: ok").length - 1, 3, output);
    for (const retired of ["拒绝理由", "Receipt", "待对账", "哈希证据", "落盘缺口", "确证"]) {
      assert.ok(!output.includes(retired), `不应再出现"${retired}"\n${output}`);
    }
  }));

test("trace 报告：大参数截断，超长内容不完整外泄", () =>
  withRoot(async (root) => {
    const longPath = `dir/${"x".repeat(400)}.ts`;
    const { sessionId } = await scriptSession(root, [
      { text: "读", toolCalls: [{ name: "read_file", args: { path: longPath } }] },
      { text: "好" },
    ]);
    const output = runTraceCommand({ root, sessionId });
    assert.ok(!output.includes(longPath), "超长参数不得完整外泄");
    assert.ok(output.includes(" chars)"), "截断必须带长度标注");
    assert.ok(output.includes("      result: error"), output);
  }));

test("trace 报告：有开始无收尾的 Run 徽章为未知，会话头计崩溃残留；未配对的工具调用标无结果", () =>
  withRoot(async (root) => {
    const sessionsDir = join(root, ".pigeon", "state", "sessions");
    const session = createFixtureSession({ sessionsDir });
    session.startRun({ task: "改" });
    session.assistant({ toolCalls: [{ name: "edit_file", args: { path: "a.ts" } }] });
    const { sessionId } = await session.close();
    const output = runTraceCommand({ root, sessionId });
    assert.ok(output.includes("1 unfinished run (possible crash)"), output);
    const runHeader = output.split("\n").find((line) => line.startsWith("Run "));
    assert.ok(runHeader?.includes("stopReason=toolUse | class: unknown"), runHeader);
    assert.ok(runHeader?.endsWith("| no run end (possible crash)"), runHeader);
    assert.ok(output.includes("      result: none (process may have been interrupted)"), output);
    assert.ok(!output.includes("  ended: "), output);
  }));

test("trace 报告：撞上限、上游合成失败、代码快照与验证记录照实呈现", () =>
  withRoot(async (root) => {
    const sessionsDir = join(root, ".pigeon", "state", "sessions");
    const session = createFixtureSession({ sessionsDir, cwd: root });
    session.startRun({ task: "改" });
    session.toolTurn({ name: "edit_file", args: { path: "a.ts" }, checkpoint: true });
    session.assistant({ text: "", stopReason: "error", errorMessage: "provider 故障" });
    session.endRun({ ending: "error", errorMessage: "provider 故障" });
    session.verification({ verdict: "fail", exitCode: 1 });
    session.startRun({ task: "再来" });
    session.assistant({ text: "", stopReason: "aborted" });
    session.endRun({ ending: "turn-limit" });
    const { sessionId } = await session.close();
    const output = runTraceCommand({ root, sessionId });
    assert.ok(output.includes("class: infrastructure error"), output);
    assert.ok(output.includes("class: cancelled"), output);
    assert.match(
      output,
      /turn 2 \| \d\d:\d\d:\d\d\(UTC\) \| stopReason=error \(synthetic upstream failure\)/
    );
    assert.ok(
      output.includes(`      checkpoint: ${"a".repeat(12)} (refs/pigeon/checkpoints/`),
      output
    );
    assert.ok(output.includes("  ended: error (4 messages)"), output);
    assert.ok(output.includes("  ended: turn-limit (2 messages)"), output);
    assert.ok(output.includes("  verification: fail | exit 1 | command npm test | 10 ms"), output);
  }));

test("trace 报告：空回复异常结束分类为业务失败；验证记录里工具故障的步单列（决策 170 ② ③）", () =>
  withRoot(async (root) => {
    const sessionsDir = join(root, ".pigeon", "state", "sessions");
    const session = createFixtureSession({ sessionsDir, cwd: root });
    session.startRun({ task: "改" });
    session.assistant({ text: "" });
    session.assistant({ text: "" });
    session.endRun({ ending: "empty-reply", errorMessage: "空回复" });
    session.verification({
      verdict: "pass",
      exitCode: 0,
      steps: [
        { name: "mypy", verdict: "fail", toolFault: true },
        { name: "pytest", verdict: "pass" },
      ],
    });
    const { sessionId } = await session.close();
    const output = runTraceCommand({ root, sessionId });
    const runHeader = output.split("\n").find((line) => line.startsWith("Run "));
    assert.ok(runHeader?.includes("class: business failure"), runHeader);
    assert.ok(output.includes("  ended: empty-reply (3 messages)"), output);
    assert.ok(output.includes("| tool fault (not counted): mypy"), output);
  }));

test("trace 命令只读：正被写入（末行撕裂）的会话照常出报告，全部会话文件字节与工作区不变", () =>
  withRoot(async (root) => {
    const { sessionId } = await scriptSession(root, EDIT_SCRIPT);
    const sessionsDir = join(root, ".pigeon", "state", "sessions");
    const files = readdirSync(sessionsDir, { recursive: true })
      .map((file) => join(sessionsDir, String(file)))
      .filter((path) => path.endsWith(".jsonl"));
    const newFile = files.find((path) => path.includes(`_${sessionId}.jsonl`));
    assert.ok(newFile !== undefined);
    tearTail(newFile);
    const snapshot = () => files.map((path) => readFileSync(path, "utf8"));
    const before = snapshot();
    const listing = readdirSync(sessionsDir, { recursive: true });
    const workspaceBefore = readFileSync(join(root, "a.ts"), "utf8");

    const first = runTraceCommand({ root, sessionId });
    assert.equal(runTraceCommand({ root, sessionId }), first, "连跑两次结果一致");
    assert.ok(first.includes("3 tool calls"), first);
    assert.deepEqual(readdirSync(sessionsDir, { recursive: true }), listing, "不得新增/删除文件");
    assert.deepEqual(snapshot(), before, "会话文件字节不得变化（撕裂末行不被修掉）");
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), workspaceBefore, "工作区不得变化");
  }));

test("trace 命令：会话不存在时报错并列出已有会话；旧格式会话单独说明；--run 过滤只渲染目标 Run", () =>
  withRoot(async (root) => {
    const { sessionId, runId } = await scriptSession(root, EDIT_SCRIPT);
    await scriptSession(root, [{ text: "嗯" }], sessionId);

    const missing = newSessionId();
    assert.throws(
      () => runTraceCommand({ root, sessionId: missing }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(`session not found: ${missing}`));
        assert.ok(error.message.includes(sessionId), "必须列出已有会话帮助定位");
        return true;
      }
    );
    const legacy = writeLegacySessionFile(join(root, ".pigeon", "state", "sessions"));
    assert.throws(
      () => runTraceCommand({ root, sessionId: legacy }),
      (error: unknown) =>
        error instanceof Error &&
        error.message === `session ${legacy} is an old-format session; ${LEGACY_READER_HINT}`
    );

    const filtered = runTraceCommand({ root, sessionId, runId });
    const runHeaders = filtered.split("\n").filter((line) => line.startsWith("Run "));
    assert.equal(runHeaders.length, 1, "过滤后只渲染一个 Run");
    assert.ok(filtered.includes("edit_file"), "目标 Run 的内容在场");
    const full = runTraceCommand({ root, sessionId });
    assert.equal(full.split("\n").filter((line) => line.startsWith("Run ")).length, 2);
    assert.throws(
      () => runTraceCommand({ root, sessionId, runId: "run_nope" }),
      /run not found in this session: run_nope; runs: /
    );
  }));

test("trace 报告：读取时跳过的行归异常项；分支会话标来源、不重复画复制来的历史", () =>
  withRoot(async (root) => {
    const sessionsDir = join(root, ".pigeon", "state", "sessions");
    const source = createFixtureSession({ sessionsDir });
    const runId = source.startRun({ task: "来源" });
    source.assistant({ text: "来源回复" });
    source.endRun();
    const { sessionId: sourceId } = await source.close();
    // 不认识的条目类型：上游读盘会整文件拒绝，只读读取器跳过并告警
    const odd = createFixtureSession({ sessionsDir });
    odd.startRun({ task: "另一个" });
    const { sessionId: oddId, path } = await odd.close();
    appendRawLine(path, { kind: "entry", seq: 999, type: "mystery", id: "x1", parentId: null });
    const oddTrace = runTraceCommand({ root, sessionId: oddId });
    assert.ok(oddTrace.includes("anomalies:"), oddTrace);
    assert.match(oddTrace, / {2}read warning: line \d+: unknown entry type mystery; skipped/);

    const branch = await forkFixture({ sessionsDir, sourceSessionId: sourceId, runId, runSeq: 2 });
    branch.startRun({ task: "分支" });
    branch.endRun();
    const { sessionId: branchId } = await branch.close();
    const branchTrace = runTraceCommand({ root, sessionId: branchId });
    assert.ok(
      branchTrace.includes(
        `branch session: from session ${sourceId} run ${runId.slice(0, 12)}… entry 2 | branch fork-`
      ),
      branchTrace
    );
    assert.ok(branchTrace.includes("| 1 run |"), branchTrace);
    const headers = branchTrace.split("\n").filter((line) => line.startsWith("Run "));
    assert.equal(headers.length, 1, branchTrace);
    // 复制来的来源 Run 不算分支会话的 Run
    assert.throws(
      () => runTraceCommand({ root, sessionId: branchId, runId }),
      /run not found in this session/
    );
  }));

test("旧会话含复盘与旧推送记忆字段（决策 331 之前的 Run 开始条目）：trace 照常渲染、不报错", () =>
  withRoot(async (root) => {
    const sessionsDir = join(root, ".pigeon", "state", "sessions");
    const fixture = createFixtureSession({ sessionsDir });
    fixture.startRun({ task: "旧会话" });
    fixture.assistant({ text: "旧回复" });
    fixture.endRun();
    const { sessionId, path } = await fixture.close();
    // 复盘删除前的 Run 开始条目：data 里带 memoryReview 与旧的 learnedMemory 字段
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const entry = JSON.parse(line) as {
          type?: string;
          customType?: string;
          data?: Record<string, unknown>;
        };
        if (entry.type === "custom" && entry.customType === "pigeon.run-start" && entry.data) {
          entry.data.memoryReview = { kind: "closing", template: "v1" };
          entry.data.learnedMemory = {
            path: ".pigeon/state/learned/MEMORY.md",
            hash: "0".repeat(64),
            bytes: 1,
            entries: 1,
            limitChars: 4000,
          };
        }
        return JSON.stringify(entry);
      });
    writeFileSync(path, `${lines.join("\n")}\n`);
    const trace = runTraceCommand({ root, sessionId });
    assert.ok(trace.includes("1 run"), trace);
  }));
