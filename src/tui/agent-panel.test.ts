// 子 agent 面板（决策 482、503）：最上层第一行 main、一次一层、下层标 (+N)、钻进下层写回到会话的路径、已结束的保留约 30 秒、x 清掉、
// 在跑与已中断的一直列着、正在看的那个加粗且一直列着
import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentState, SubagentRecord } from "../application/subagents.ts";
import { AGENT_ROW_RETAIN_MS, AgentPanel, MAIN_ROW } from "./agent-panel.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: 去掉暗色样式的转义序列
const plain = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

// 加粗的转义序列（正在看的那一行）
const BOLD = "\x1b[1m";

function fixture() {
  let now = 100_000;
  const session = { kind: "session", name: () => "main" };
  const agents: SubagentRecord[] = [];
  const add = (
    name: string,
    state: AgentState,
    parent: SubagentRecord | undefined,
    type = "general"
  ): SubagentRecord => {
    const record = {
      kind: "agent",
      agentName: name,
      name: () => name,
      type: { name: type },
      path: parent === undefined ? name : `${parent.path} › ${name}`,
      parent: parent ?? session,
      state,
      updatedAt: now,
      startedAt: now,
    } as unknown as SubagentRecord;
    agents.push(record);
    return record;
  };
  const waiting = new Set<string>();
  let viewing: SubagentRecord | undefined;
  const panel = new AgentPanel({
    agents: () => agents,
    sessionName: () => "main",
    waiting: () => waiting,
    viewing: () => viewing,
    now: () => now,
  });
  return {
    panel,
    add,
    waiting,
    advance: (ms: number) => (now += ms),
    view: (record: SubagentRecord | undefined) => {
      viewing = record;
    },
  };
}

test("最上层第一行 main；一次一层，下层标 (+N)；→ 钻进去写回到会话的路径，← 回上层，最上层再 ← 回输入框", () => {
  const { panel, add } = fixture();
  assert.deepEqual(panel.render(80), [], "没有子 agent 不占地方");
  const general = add("general-1", "running", undefined);
  add("explore-1", "running", general, "explore");
  add("explore-2", "idle", general, "explore");
  add("explore-3", "running", undefined, "explore");
  assert.deepEqual(plain(panel.render(80)), [
    "  main",
    "  general-1  general · running (+2)",
    "  explore-3  explore · running",
  ]);
  assert.equal(panel.focus(), true);
  assert.equal(
    plain(panel.render(80))[1],
    "› general-1  general · running (+2)",
    "主视图里进来先选第一个子 agent"
  );
  assert.equal(panel.drillIn(), true);
  assert.deepEqual(plain(panel.render(80)), [
    "main › general-1",
    "› explore-1  explore · running",
    "  explore-2  explore · done",
  ]);
  panel.down();
  assert.equal((panel.selected() as SubagentRecord).agentName, "explore-2");
  assert.equal(panel.drillIn(), false, "没有下层不钻");
  assert.equal(panel.drillOut(), true);
  assert.equal((panel.selected() as SubagentRecord).agentName, "general-1");
  panel.up();
  assert.equal(panel.selected(), MAIN_ROW);
  assert.equal(panel.drillIn(), false, "main 没有下层");
  assert.equal(panel.drillOut(), false);
  assert.equal(panel.isFocused(), false);
});

test("决策 503：子 agent 视图里正在看的那个加粗、一直列着，进来先选 main", () => {
  const { panel, add, advance, view } = fixture();
  const done = add("general-1", "idle", undefined);
  add("explore-1", "running", undefined, "explore");
  view(done);
  panel.clear(done);
  advance(AGENT_ROW_RETAIN_MS * 2);
  const lines = panel.render(80);
  assert.deepEqual(plain(lines), [
    "  main",
    "  general-1  general · done",
    "  explore-1  explore · running",
  ]);
  assert.ok(lines[1]?.includes(`${BOLD}general-1`), "正在看的加粗");
  assert.ok(!lines[0]?.includes(BOLD));
  panel.focus();
  assert.equal(panel.selected(), MAIN_ROW);
  view(undefined);
  assert.ok(panel.render(80)[0]?.includes(`${BOLD}main`), "主视图里 main 加粗");
});

test("决策 505：改过显示名的行写显示名", () => {
  const { panel, add } = fixture();
  const record = add("general-1", "running", undefined);
  record.displayName = "fixer";
  assert.deepEqual(plain(panel.render(80)), ["  main", "  fixer  general · running"]);
});

test("已结束的保留约 30 秒，x 提前清掉；已中断的一直列着；等审批的写明", () => {
  const { panel, add, waiting, advance } = fixture();
  const done = add("general-1", "idle", undefined);
  const failed = add("general-2", "failed", undefined);
  (failed as { error?: string }).error = "boom";
  add("explore-1", "interrupted", undefined, "explore");
  const running = add("general-3", "running", undefined);
  waiting.add(running.path);
  assert.deepEqual(plain(panel.render(80)), [
    "  main",
    "  general-1  general · done",
    "  general-2  general · failed: boom",
    "  explore-1  explore · interrupted",
    "  general-3  general · waiting for approval",
  ]);
  assert.equal(panel.hasRetained(), true);
  panel.clear(done);
  advance(AGENT_ROW_RETAIN_MS);
  assert.deepEqual(plain(panel.render(80)), [
    "  main",
    "  explore-1  explore · interrupted",
    "  general-3  general · waiting for approval",
  ]);
  assert.equal(panel.hasRetained(), false);
});

test("已结束的保留期过了、下层还有在跑的：照样列着才钻得进去；↑ 在第一行即回输入框", () => {
  const { panel, add, advance } = fixture();
  const parent = add("general-1", "idle", undefined);
  advance(AGENT_ROW_RETAIN_MS * 2);
  add("explore-1", "running", parent, "explore");
  assert.deepEqual(plain(panel.render(80)), ["  main", "  general-1  general · done (+1)"]);
  panel.focus();
  assert.equal(panel.up(), true, "第一个子 agent 往上是 main");
  assert.equal(panel.up(), false);
  assert.equal(panel.isFocused(), false);
});

test("x 清掉的行再有变化（又干起来）即重新列出", () => {
  const { panel, add, advance } = fixture();
  const done = add("general-1", "idle", undefined);
  panel.clear(done);
  assert.deepEqual(panel.render(80), []);
  advance(1000);
  done.state = "running";
  done.updatedAt += 1000;
  assert.deepEqual(plain(panel.render(80)), ["  main", "  general-1  general · running"]);
});
