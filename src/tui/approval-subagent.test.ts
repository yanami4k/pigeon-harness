// 子 agent 的审批（决策 480）：来源行写子 agent 的路径（所属会话是面板里的会话时一并写明），放权的按键说明写 for this sub-agent；
// 会话自己的请求照旧写 for this session
import assert from "node:assert/strict";
import { test } from "vitest";
import type { ApprovalRequest } from "../approvals/handler.ts";
import { approvalBlockText, approvedLine } from "./approval.ts";

const base: ApprovalRequest = {
  toolName: "edit_file",
  toolCallId: "t1",
  args: { path: "src/a.ts" },
  tier: "write",
};

test("子 agent 的请求：来源行带路径，[a]、[d] 写 for this sub-agent；答完的一行前面标路径", () => {
  const text = approvalBlockText({ ...base, subagent: { path: "general-1 › explore-2" } }, true);
  assert.match(text, /source: sub-agent general-1 › explore-2/);
  assert.match(
    text,
    /\[a\] allow for this sub-agent \/ \[d\] allow for this sub-agent \(this directory\)/
  );
  assert.ok(!text.includes("for this session"));
  assert.match(
    approvedLine({ ...base, subagent: { path: "general-1" } }),
    /^\[general-1\] ✓ approved edit_file: src\/a\.ts/
  );
  const exec = approvalBlockText(
    {
      ...base,
      toolName: "run_command",
      tier: "exec",
      args: { command: "ls" },
      subagent: { path: "x" },
    },
    false
  );
  assert.match(exec, /\[a\] allow this exact command for this sub-agent/);
});

test("会话自己的请求照旧写 for this session", () => {
  assert.match(approvalBlockText(base, false), /\[a\] allow for this session$/m);
});
