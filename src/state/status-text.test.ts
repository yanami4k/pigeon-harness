// 消息上的结构化标记（决策 363、480）：开工状态块与 agent 之间的传话的标记随消息存下，交给模型之前一并去掉
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  AGENT_MESSAGE_MARKER,
  agentMessageMarkOf,
  STATUS_MARKER,
  withoutStatusMarker,
} from "./status-text.ts";

test("交给模型之前去掉两种标记；按标记认出 agent 的传话", () => {
  const message = {
    role: "user",
    content: [{ type: "text", text: "x" }],
    timestamp: 1,
    [AGENT_MESSAGE_MARKER]: { from: "general-1", to: "main", kind: "result" },
  };
  assert.deepEqual(agentMessageMarkOf(message), { from: "general-1", to: "main", kind: "result" });
  assert.deepEqual(withoutStatusMarker(message), {
    role: "user",
    content: [{ type: "text", text: "x" }],
    timestamp: 1,
  });
  assert.deepEqual(withoutStatusMarker({ role: "user", [STATUS_MARKER]: true }), { role: "user" });
  assert.equal(agentMessageMarkOf({ role: "user", content: [] }), undefined);
});
