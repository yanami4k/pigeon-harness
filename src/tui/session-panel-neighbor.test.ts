// 决策 507：去掉当前会话之后换到面板里的下一个会话——按面板顺序取它下面的那张，没有取上面的；挑不上的（准备中、别的进程开着的）跳过
import assert from "node:assert/strict";
import { test } from "vitest";
import type { PooledSessionCard } from "../application/session-pool.ts";
import { SessionPanel } from "./session-panel.ts";

function card(
  id: string,
  state: PooledSessionCard["state"],
  extra: Partial<PooledSessionCard> = {}
) {
  return { id, name: id, state, task: "", summary: "", startedAt: 0, updatedAt: 0, ...extra };
}

function panel(cards: PooledSessionCard[], main: PooledSessionCard) {
  return new SessionPanel({
    height: () => 20,
    cards: () => cards,
    peek: () => [],
    main: () => main,
  });
}

const usable = (other: PooledSessionCard) =>
  other.elsewhere !== true && !other.id.startsWith("pending:");

test("取它下面的那张；跳过挑不上的；下面没有即取上面的；只有它自己即没有", () => {
  const main = card("main", "idle");
  // 按状态分组：running 在 idle 之前，idle 组里当前会话排最前
  const cards = [
    card("r1", "running"),
    card("pending:x", "preparing"),
    card("far", "idle", { elsewhere: true }),
    card("i2", "idle"),
  ];
  assert.equal(
    panel(cards, main).neighborOf("main", usable)?.id,
    "i2",
    "下面的那张，跳过别的进程开着的"
  );
  assert.equal(
    panel([card("r1", "running"), card("pending:x", "preparing")], main).neighborOf("main", usable)
      ?.id,
    "r1",
    "下面没有：取上面的（跳过准备中的）"
  );
  assert.equal(panel([], main).neighborOf("main", usable), undefined);
});
