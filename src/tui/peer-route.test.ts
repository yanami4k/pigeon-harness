// 决策 450：别的会话发来的消息一律送主会话——查看 worker 会话期间攒着、不进 worker 的运行面，回到主会话再递并叫醒。
import assert from "node:assert/strict";
import { test } from "vitest";
import { MainPeerRoute } from "./peer-route.ts";

function target() {
  const notices: string[] = [];
  return {
    notices,
    notify: (text: string) => notices.push(text),
    pendingNotices: () => notices.length,
  };
}

test("在主会话时直接递并叫醒；查看 worker 期间攒着、计入待读条数；回到主会话递过去再叫醒", () => {
  const main = target();
  const worker = target();
  let wakes = 0;
  const route = new MainPeerRoute(main, () => {
    wakes += 1;
  });
  route.deliver("one");
  assert.deepEqual(main.notices, ["one"]);
  assert.equal(wakes, 1);
  route.switched(undefined);
  route.deliver("two");
  route.deliver("three");
  assert.deepEqual(worker.notices, []);
  assert.deepEqual(main.notices, ["one"]);
  assert.equal(route.pendingCount(), 2);
  const back = target();
  route.switched(back);
  assert.deepEqual(back.notices, ["two", "three"]);
  assert.equal(wakes, 2);
  assert.equal(route.pendingCount(), 2);
});
