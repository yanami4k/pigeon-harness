// 决策 466：/resume 列表的"打字即筛选"——打字后停一下才检索，按相关度列命中的会话、行尾接暗色片段；迟到的旧结果不用；
// Backspace 删字、删空恢复全列表；Esc 先清筛选词再退；没命中写一行；回车进的是筛出来的那一个；片段与筛选词经 036 净化。
import assert from "node:assert/strict";
import { test } from "vitest";
import type { RecentSession } from "../application/recent-sessions.ts";
import type { SessionFilterHit } from "../application/search.ts";
import type { SessionId } from "../state/ids.ts";
import { PICKER_FILTER_DELAY_MS, SessionPicker } from "./session-picker.ts";
import { settle, withoutStyles } from "./testing.ts";

function session(id: string, name: string, firstInput: string): RecentSession {
  return {
    sessionId: id as SessionId,
    name,
    lastActiveAt: new Date(2026, 9, 14, 10, 0).getTime(),
    firstInput,
    turns: 2,
    sandbox: false,
  };
}

const SESSIONS = [
  session("s1", "alpha", "部署网关"),
  session("s2", "beta", "写文档"),
  session("s3", "gamma", "看看网关日志"),
];

function open(search: (query: string) => Promise<SessionFilterHit[]>) {
  const picker = new SessionPicker();
  const queries: string[] = [];
  let picked: RecentSession | undefined | "none" = "none";
  let updates = 0;
  picker.open(
    SESSIONS,
    (value) => {
      picked = value;
    },
    () => 10,
    {
      search: (query) => {
        queries.push(query);
        return search(query);
      },
      updated: () => {
        updates += 1;
      },
    }
  );
  const lines = () => picker.view.render(100).map(withoutStyles);
  const type = (text: string) => {
    for (const char of [...text]) picker.handleInput(char);
  };
  return {
    picker,
    queries,
    lines,
    type,
    picked: () => picked,
    updates: () => updates,
  };
}

const wait = () => settle(PICKER_FILTER_DELAY_MS + 50);

test("打字即筛：停一下才检索（连打只检索一次），按相关度列命中的、行尾接暗色片段；回车进筛出来的那一个", async () => {
  const p = open(async () => [
    { sessionId: "s3", snippet: "看看网关日志" },
    { sessionId: "s1", snippet: "部署网关" },
    { sessionId: "elsewhere", snippet: "不在列表里" },
  ]);
  p.type("网关");
  assert.deepEqual(p.queries, [], "打字时不检索");
  assert.match(p.lines()[0] ?? "", /resume a session · filter: 网关/);
  await wait();
  assert.deepEqual(p.queries, ["网关"]);
  assert.equal(p.updates(), 1);
  const rows = p.lines().slice(1);
  assert.equal(rows.length, 2, rows.join("\n"));
  assert.match(rows[0] ?? "", /gamma .* {2}看看网关日志$/);
  assert.match(rows[1] ?? "", /alpha .* {2}部署网关$/);
  assert.ok(p.picker.view.render(100)[1]?.includes("\x1b[2m看看网关日志"), "片段暗色");
  p.picker.handleInput("\r");
  assert.equal((p.picked() as RecentSession).sessionId, "s3");
});

test("Backspace 删字、删空恢复全列表；Esc 先清筛选词、再按才退；没命中写一行", async () => {
  const p = open(async (query) => (query === "x" ? [] : [{ sessionId: "s2", snippet: "写文档" }]));
  p.type("文档");
  await wait();
  assert.equal(p.lines().length, 2);
  p.picker.handleInput("\x7f");
  assert.equal(p.picker.filterText(), "文");
  p.picker.handleInput("\x7f");
  assert.equal(p.picker.filterText(), "");
  assert.equal(p.lines().length, 1 + SESSIONS.length, "删空恢复全列表");
  p.type("x");
  await wait();
  assert.match(p.lines()[1] ?? "", /no matching sessions/);
  p.picker.handleInput("\x1b");
  assert.equal(p.picker.isOpen(), true, "第一次 Esc 只清筛选词");
  assert.equal(p.picker.filterText(), "");
  assert.equal(p.lines().length, 1 + SESSIONS.length);
  p.picker.handleInput("\x1b");
  assert.equal(p.picker.isOpen(), false);
  assert.equal(p.picked(), undefined);
});

test("迟到的旧结果不用：先打的词检索慢，后打的先回来，以后打的为准", async () => {
  const gates = new Map<string, (hits: SessionFilterHit[]) => void>();
  const p = open(
    (query) =>
      new Promise((resolve) => {
        gates.set(query, resolve);
      })
  );
  p.type("网");
  await wait();
  p.type("关");
  await wait();
  gates.get("网关")?.([{ sessionId: "s1", snippet: "部署网关" }]);
  await settle(10);
  gates.get("网")?.([{ sessionId: "s2", snippet: "旧的" }]);
  await settle(10);
  const rows = p.lines().slice(1);
  assert.equal(rows.length, 1);
  assert.match(rows[0] ?? "", /alpha/);
});

test("片段与筛选词里的控制序列可见化，不写进终端", async () => {
  const p = open(async () => [{ sessionId: "s1", snippet: "注入\x1b[2J" }]);
  p.type("注入\u009b");
  await wait();
  const raw = p.picker.view.render(100).join("\n");
  assert.ok(!raw.includes("\x1b[2J"), raw);
  assert.ok(!raw.includes("\u009b"), raw);
});
