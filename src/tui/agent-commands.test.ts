// 决策 505：子 agent 视图里的代理级命令面——/status 写这个子 agent 的名字、类型、所属会话、工作目录、模型、状态、用量与会话记录；
// /rename 只改显示名（不合规的名字照会话名的规矩拒绝）；还没有运行面的子 agent 没有命令面
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import type { inspectSubagent } from "../application/subagent-runtime.ts";
import type { SubagentRecord } from "../application/subagents.ts";
import { agentCommandsFace } from "./agent-commands.ts";

const HOME = join("/", "home", "u");
const PROJECT = join(HOME, "proj");

function record(open: boolean): SubagentRecord {
  return {
    kind: "agent",
    agentName: "general-1",
    name: () => "general-1",
    type: { name: "general" },
    path: "general-1",
    state: "idle",
    sessionId: "sess_child",
    top: { name: () => "proj-ab12", endpoint: { sessionId: "sess_top" } },
    startedAt: 0,
    updatedAt: 0,
    ...(open
      ? {
          runtime: {
            workspaceRoot: () => join(PROJECT, ".pigeon", "worktrees", "general-1"),
            inspect: {
              governanceRoot: PROJECT,
              modelId: "deepseek-chat",
              bundle: {
                adapter: { contextUsage: () => ({ tokens: 3000, contextWindow: 100_000 }) },
                sessionStore: {
                  filePath: async () => join(PROJECT, ".pigeon", "state", "sessions", "c.jsonl"),
                },
                grantStore: {},
                configGrants: [],
                settings: { grants: [] },
                taskList: { items: () => [] },
                thinking: { get: () => "high", set: () => {}, supported: true },
              },
            },
          },
        }
      : {}),
  } as unknown as SubagentRecord;
}

function face() {
  const renamed: string[] = [];
  return {
    renamed,
    face: agentCommandsFace({
      hub: {
        compacting: async (_record, work) => work(),
        rename: (target, name) => {
          renamed.push(name);
          target.displayName = name;
        },
      },
      historyDir: () => undefined,
      projectOf: () => PROJECT,
      homeDir: HOME,
      inspect: (runtime) =>
        (runtime as { inspect?: ReturnType<typeof inspectSubagent> } | undefined)?.inspect,
    }),
  };
}

test("/status 写这个子 agent 的名字、类型、状态、所属会话、工作目录、模型、会话记录与上下文", async () => {
  const { face: commands } = face();
  const target = record(true);
  target.displayName = "fixer";
  const text = await commands.status(target);
  assert.match(text, /^agent {4}fixer \(general-1\) · general · done$/m);
  assert.match(text, /^session {2}proj-ab12 · sess_top$/m);
  assert.match(text, /^cwd {6}\.pigeon\/worktrees\/general-1$/m);
  assert.match(text, /^record {3}~[/\\]proj[/\\]\.pigeon[/\\]state[/\\]sessions[/\\]c\.jsonl$/m);
  // 决策 513：它的思考强度写在 model 行
  assert.match(text, /^model {4}deepseek-chat · effort high$/m);
});

test("还没有运行面（续接认回、没重开）：没有命令面，/status 照写记得的；/compact 说明打不开", async () => {
  const { face: commands } = face();
  const target = record(false);
  assert.equal(commands.commands(target), undefined);
  const text = await commands.status(target);
  assert.match(text, /^agent {4}general-1 · general · done$/m);
  assert.match(text, /^cwd {6}= project$/m);
  assert.match(text, /^model {4}—$/m);
  await assert.rejects(commands.compact(target, undefined), /isn't open right now/);
});

test("/rename 只改显示名、只回改名的结果；不合规的名字拒绝", () => {
  const { face: commands, renamed } = face();
  const target = record(true);
  assert.equal(commands.rename(target, "fixer"), "renamed to fixer");
  assert.equal(target.displayName, "fixer");
  assert.match(commands.rename(target, "bad name!"), /^invalid name/);
  assert.deepEqual(renamed, ["fixer"]);
  assert.equal(commands.commands(target)?.tasks(), "The task list is empty.");
});
