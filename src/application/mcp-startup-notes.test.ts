// MCP 启动提示（M5.7，决策 052）：注解与配置冲突除记进 run.started 外，启动时进程内同时警告；启动问题（server 起不来、
// 映射跳过、prompt 不登记）一并给出。Actor 只负责把这些行打出去。
import assert from "node:assert/strict";
import { test } from "vitest";
import { describeMcpStartup } from "./mcp.ts";

test("MCP 启动提示：启动问题原样列出，注解与配置冲突逐项警告，无冲突无问题时为空", () => {
  const notes = describeMcpStartup({
    problems: ["starting MCP server fs failed: spawn ENOENT"],
    summary: () => ({
      mcpTools: [
        {
          name: "mcp__fx__echo",
          server: "fx",
          tool: "echo",
          configuredTier: "write",
          effectiveTier: "write",
          declaredHint: { readOnlyHint: true },
          conflict: true,
        },
        {
          name: "mcp__fx__peek",
          server: "fx",
          tool: "peek",
          configuredTier: "read",
          effectiveTier: "write",
          declaredHint: { destructiveHint: true },
          conflict: true,
        },
        {
          name: "mcp__fx__look",
          server: "fx",
          tool: "look",
          configuredTier: "read",
          effectiveTier: "read",
        },
      ],
      mcpServers: [],
    }),
  });
  assert.deepEqual(notes, [
    "starting MCP server fs failed: spawn ENOENT",
    "MCP annotation conflicts with settings: mcp__fx__echo declares read-only, set to write, using write",
    "MCP annotation conflicts with settings: mcp__fx__peek declares destructive, set to read, using write",
  ]);
  assert.deepEqual(
    describeMcpStartup({ problems: [], summary: () => ({ mcpTools: [], mcpServers: [] }) }),
    []
  );
});
