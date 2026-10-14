// run_command 端到端（M5.5 S5，决策 048）：真实装配根 + 按脚本作答的审批（终端界面同一个审批 handler，approval-fixtures.ts）。
// prompt 模式下 exec 每次都问，面板显示完整命令；[a] 创建精确命令放权，同一条命令再来免审
// （human:grant），参数不同重新问；执行证据随工具结果的 details 记进会话存储。tester 角色只能跑 commands.json 为它登记的命令。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { loadStoreSession } from "../persistence/session-view.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { type StoreMessage, toolResultMark } from "../state/session-judge.ts";
import type { ExecEvidence } from "../tools/run-command.ts";
import { REASON_PROMPT, scriptedApprovalHandler } from "../tui/approval-fixtures.ts";
import { buildRuntime } from "./runtime.ts";

const NODE = `"${process.execPath}"`;
const COMMAND_A = `${NODE} -e "process.stdout.write('a')"`;
const COMMAND_B = `${NODE} -e "process.stdout.write('b')"`;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// 读会话存储里本会话的全部工具结果消息（按顺序）与授权条目
function storeFacts(root: string, sessionId: string) {
  const loaded = loadStoreSession(join(root, ".pigeon", "state", "sessions"), sessionId);
  assert.ok(loaded !== undefined, "会话存储里应有本会话");
  const toolResults = loaded.view.runs
    .flatMap((run) => run.messages.map((ref) => ref.message))
    .filter((message) => message.role === "toolResult");
  return { toolResults, grants: loaded.view.grants.map((record) => record.data) };
}

// 成功执行的工具结果 details 就是执行证据（外加运行面标记）；出错路径不带证据
function execOf(message: StoreMessage | undefined): Partial<ExecEvidence> {
  return (message?.details ?? {}) as Partial<ExecEvidence>;
}

function runCommandCall(command: string, text: string) {
  return { text, toolCalls: [{ name: "run_command", args: { command } }] };
}

test("run_command：exec 每次都问且显示完整命令；[a] 精确命令放权后同一命令免审、改参数重新问；工具结果带执行证据", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-run-command-e2e-"));
  try {
    const sessionId = newSessionId();
    const prompts: string[] = [];
    let screen = "";
    let asked = 0;
    const bundle = buildRuntime({
      streamFn: createFakeStreamFn({
        replies: [
          runCommandCall(COMMAND_A, "第一次"),
          runCommandCall(COMMAND_A, "同一条"),
          runCommandCall(COMMAND_B, "换参数"),
          { text: "完成" },
        ],
      }),
      workspaceRoot: root,
      homeDir: root,
      sessionId,
      yolo: false,
      provider: "fake-provider",
      modelId: "fake-model-1",
      createApprovalHandler: (grants) =>
        scriptedApprovalHandler(
          async (prompt) => {
            prompts.push(prompt);
            if (prompt === REASON_PROMPT) {
              return "不跑 b";
            }
            asked += 1;
            return asked === 1 ? "a" : "n";
          },
          (text) => {
            screen += text;
          },
          { grants }
        ),
    });
    let executions: ReturnType<typeof bundle.adapter.toolExecutions>;
    try {
      assert.ok(bundle.adapter.snapshot().tools.policy.allow.includes("run_command"));
      const result = await bundle.adapter.run("跑命令");
      assert.equal(result.status, "completed");
      executions = result.toolExecutions;
    } finally {
      await bundle.adapter.dispose();
      await bundle.sessionStore.close();
    }

    // 两次人工审批：第一次的 A 与换参数的 B；同一条 A 免审
    assert.equal(asked, 2);
    assert.ok(prompts[0]?.includes("[a] allow this exact command for this session"), prompts[0]);
    assert.ok(screen.includes(`"command": ${JSON.stringify(COMMAND_A)}`), screen);
    assert.ok(screen.includes(`✓ allowed for this session: run_command ${COMMAND_A}`), screen);
    assert.deepEqual(
      executions.map((record) => record.decision?.approvedBy),
      ["human", "human:grant", "human"]
    );
    assert.equal(executions[1]?.decision?.grantRef?.kind, "session-grant");
    assert.equal(executions[2]?.decision?.outcome, "rejected");
    assert.equal(executions[2]?.decision?.reason, "不跑 b");

    const { toolResults, grants } = storeFacts(root, sessionId);
    assert.equal(grants.length, 1);
    assert.equal(grants[0]?.event, "created");
    assert.equal(grants[0]?.event === "created" ? grants[0].command : undefined, COMMAND_A);
    assert.equal(toolResults.length, 3);
    const [first, second, third] = toolResults;
    // 工具结果上的审批闸标记与内存里的决定一致
    assert.deepEqual(
      toolResults.map((message) => toolResultMark(message)?.gate),
      [
        { outcome: "approved", approvedBy: "human" },
        { outcome: "approved", approvedBy: "human:grant" },
        { outcome: "rejected", approvedBy: "human" },
      ]
    );
    for (const message of [first, second]) {
      assert.equal(message?.isError, false);
      const exec = execOf(message);
      assert.equal(exec.command, COMMAND_A);
      assert.equal(exec.exitCode, 0);
      assert.equal(exec.output, "a");
      assert.equal(exec.outputHash, sha256("a"));
    }
    // 被拒的调用没有执行：工具结果是错误、不带执行证据
    assert.equal(third?.isError, true);
    assert.equal(execOf(third).command, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
