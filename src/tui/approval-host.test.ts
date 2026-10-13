// TUI 审批面板对网络档请求（决策 290）：审批块显示网站行与“以后都允许访问 <网站>”键，不提供 [d]；[a] 建按网站的放权。
import assert from "node:assert/strict";
import { test } from "vitest";
import { SessionGrantStore } from "../approvals/grant-store.ts";
import type { ApprovalRequest } from "../approvals/handler.ts";
import { asRunId } from "../state/ids.ts";
import { approvalBlockText, createTuiApprovalHandler, type TuiApprovalFace } from "./approval.ts";

const request: ApprovalRequest = {
  toolName: "web_fetch",
  toolCallId: "toolu_01",
  args: { url: "https://docs.example/a", prompt: "找什么" },
  tier: "network",
  host: "docs.example",
  runId: asRunId("run_01J5Z7K8W9ABCDEFGHJKMNPQRS"),
};

test("审批块：网站行 + 以后都允许访问该网站；不提供 [d]", () => {
  const text = approvalBlockText(request);
  assert.match(text, /tool: web_fetch\nsite: docs\.example\nargs:/);
  assert.match(text, /\[a\] allow docs\.example for this session$/);
  assert.doesNotMatch(text, /\[d\]/);
});

test("[a] 建按网站的放权，结果行点名网站；[y] 只批准一次", async () => {
  const store = new SessionGrantStore({ workspaceRoot: "/nonexistent" });
  const notes: string[] = [];
  let key: "a" | "y" = "a";
  const face: TuiApprovalFace = {
    askApproval: async (_request, directoryGrant) => {
      assert.equal(directoryGrant, false, "网络档不提供 [d]");
      return { key };
    },
    noteApproval: (line) => notes.push(line),
  };
  const handler = createTuiApprovalHandler(store, () => face);
  assert.deepEqual(await handler(request), { approved: true });
  assert.deepEqual(
    store.list().map((grant) => [grant.tool, grant.host]),
    [["web_fetch", "docs.example"]]
  );
  assert.equal(notes.join("\n"), "✓ allowed for this session: web_fetch docs.example");
  key = "y";
  assert.deepEqual(await handler(request), { approved: true });
  assert.equal(store.list().length, 1);
});

// 自 cli/approval-ui.test.ts 移来（决策 461）：放权条目写盘失败 = 放权不生效
test("授权建立条目写盘失败 = grant 不生效（fail-closed：免审授权必须留证后才存在）", async () => {
  const store = new SessionGrantStore({
    workspaceRoot: "/nonexistent",
    sink: {
      appendGrantCreated: () => {
        throw new Error("磁盘故障");
      },
      appendGrantRevoked: () => {},
    },
  });
  const face: TuiApprovalFace = {
    askApproval: async () => ({ key: "a" }),
    noteApproval: () => {},
  };
  const handler = createTuiApprovalHandler(store, () => face);
  await assert.rejects(() => handler(request), /磁盘故障/);
  assert.equal(store.list().length, 0, "未落盘的 grant 不得生效");
});
