// 决策 450：别的会话发来的消息一律送主会话当下的运行面——/reload 或移进工作树重建运行面之后进新的那个（不进已释放的旧运行面）；
// 查看 worker 会话期间攒着、不进 worker 的运行面，回到主会话再递并叫醒。
import assert from "node:assert/strict";
import { test } from "vitest";
import { MainPeerRoute, type PeerRouteTarget } from "./peer-route.ts";

function target(): PeerRouteTarget & { notices: string[] } {
  const notices: string[] = [];
  return {
    notices,
    notify: (text: string) => {
      notices.push(text);
    },
    pendingNotices: () => notices.length,
  };
}

test("重建运行面之后（/reload、移进工作树）来信进新的运行面，旧的不再收", () => {
  const slot = { bundle: target(), isMain: true };
  let wakes = 0;
  const route = new MainPeerRoute(
    () => (slot.isMain ? slot.bundle : undefined),
    () => {
      wakes += 1;
    }
  );
  route.deliver("before");
  const old = slot.bundle;
  // /reload：同一会话换上新的运行面，旧的释放
  slot.bundle = target();
  route.deliver("after reload");
  // 移进工作树：同样重建
  const second = slot.bundle;
  slot.bundle = target();
  route.deliver("after worktree move");
  assert.deepEqual(old.notices, ["before"]);
  assert.deepEqual(second.notices, ["after reload"]);
  assert.deepEqual(slot.bundle.notices, ["after worktree move"]);
  assert.equal(wakes, 3);
  assert.equal(route.pendingCount(), 1);
});

test("查看 worker 会话期间攒着、计入待读条数；回到主会话递过去再叫醒", () => {
  const slot = { bundle: target(), isMain: true };
  let wakes = 0;
  const route = new MainPeerRoute(
    () => (slot.isMain ? slot.bundle : undefined),
    () => {
      wakes += 1;
    }
  );
  const worker = target();
  slot.bundle = worker;
  slot.isMain = false;
  route.deliver("two");
  route.deliver("three");
  assert.deepEqual(worker.notices, []);
  assert.equal(route.pendingCount(), 2);
  assert.equal(wakes, 0);
  const back = target();
  slot.bundle = back;
  slot.isMain = true;
  route.flush();
  assert.deepEqual(back.notices, ["two", "three"]);
  assert.equal(wakes, 1);
  assert.equal(route.pendingCount(), 2);
});
