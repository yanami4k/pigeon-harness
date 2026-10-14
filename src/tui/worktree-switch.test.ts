// 决策 446：enter_worktree 之后本轮收尾时移进工作树的流程（替身）：先换工作区再重建（重建时看到的就是工作树）；
// 成功才记条目、递通知；本轮被中止、有 worker 在跑不移并告诉模型；重建失败换回原工作区；同一轮再调即拒绝。
import assert from "node:assert/strict";
import { test } from "vitest";
import type { NamedWorktree } from "../application/named-worktree.ts";
import { createWorktreeSwitch, type WorktreeSwitchDeps } from "./worktree-switch.ts";

const WT: NamedWorktree = {
  name: "feat",
  repoRoot: "/repo",
  path: "/repo/.pigeon/wt/feat",
  branch: "pigeon-wt/feat",
  base: "a".repeat(40),
  baseLabel: "HEAD",
  created: true,
};

function harness(options: { busy?: string; rebuildFails?: boolean } = {}) {
  const log: string[] = [];
  let workspace = "/repo";
  let busy = options.busy;
  const deps: WorktreeSwitchDeps = {
    workspace: () => workspace,
    setWorkspace: (root) => {
      workspace = root;
      log.push(`workspace ${root}`);
    },
    workersBusy: () => busy,
    rebuild: async () => {
      log.push(`rebuild in ${workspace}`);
      if (options.rebuildFails === true) throw new Error("boom");
    },
    adopt: (worktree) => log.push(`adopt ${worktree.path}`),
    system: (line) => log.push(`system ${line}`),
    notify: (text) => log.push(`notify ${text}`),
    noteForNextInput: (text) => log.push(`note ${text}`),
    continueNotice: (worktree) => `continue in ${worktree.path}`,
  };
  return {
    log,
    sw: createWorktreeSwitch(deps),
    workspace: () => workspace,
    setBusy: (value: string | undefined) => {
      busy = value;
    },
  };
}

test("成功：先换工作区再重建（重建按工作树），之后记条目、递通知；没有待移入时收尾不做事", async () => {
  const h = harness();
  assert.equal(h.sw.afterTurn({ cancelled: false }), undefined);
  h.sw.entered(WT, 2);
  // 本轮当中不写（验收修改）；移进后那一行带上没带过去的改动数
  assert.equal(h.log.length, 0);
  await h.sw.afterTurn({ cancelled: false });
  const tail = h.log;
  assert.deepEqual(tail.slice(0, 3), [
    `workspace ${WT.path}`,
    `rebuild in ${WT.path}`,
    `adopt ${WT.path}`,
  ]);
  assert.ok(
    tail.some(
      (line) =>
        line.startsWith("system moved into worktree") &&
        line.includes("2 uncommitted changes left in the main checkout")
    ),
    tail.join("\n")
  );
  assert.equal(tail.at(-1), `notify continue in ${WT.path}`);
  assert.equal(h.sw.pending(), false);
});

test("同一轮再调即拒绝；有 worker 在跑时工具也拒绝", () => {
  const h = harness();
  assert.equal(h.sw.blocked(), undefined);
  h.sw.entered(WT, 0);
  assert.match(h.sw.blocked() ?? "", /already pending this turn/);
  const busy = harness({ busy: "workers are still running or waiting for approval" });
  assert.match(busy.sw.blocked() ?? "", /workers are still running/);
});

test("本轮被中止（Esc）：不移、不重建、不记条目，告诉人与模型，工作树留着", async () => {
  const h = harness();
  h.sw.entered(WT, 0);
  await h.sw.afterTurn({ cancelled: true });
  assert.equal(h.workspace(), "/repo");
  assert.ok(!h.log.some((line) => line.startsWith("rebuild") || line.startsWith("adopt")));
  assert.ok(
    h.log.some((line) => /^system didn't move into worktree .*turn interrupted/.test(line))
  );
  assert.ok(h.log.some((line) => /^note .*the turn was interrupted.*stays in \/repo/.test(line)));
  assert.equal(h.sw.pending(), false);
});

test("收尾时有 worker 在跑或等补批：不移并说明", async () => {
  const h = harness();
  h.sw.entered(WT, 0);
  h.setBusy("workers are still running or waiting for approval");
  await h.sw.afterTurn({ cancelled: false });
  assert.equal(h.workspace(), "/repo");
  assert.ok(!h.log.some((line) => line.startsWith("rebuild")));
  assert.ok(h.log.some((line) => /^note .*workers are still running/.test(line)));
});

test("重建失败：工作区换回原处、不记条目，告诉人与模型", async () => {
  const h = harness({ rebuildFails: true });
  h.sw.entered(WT, 0);
  await h.sw.afterTurn({ cancelled: false });
  assert.equal(h.workspace(), "/repo");
  assert.ok(!h.log.some((line) => line.startsWith("adopt")));
  assert.ok(
    h.log.some((line) =>
      /^system didn't move into worktree .*rebuilding the runtime failed: boom/.test(line)
    )
  );
  assert.ok(h.log.some((line) => /^note .*rebuilding the runtime failed/.test(line)));
  assert.ok(!h.log.some((line) => line.startsWith("notify")), "不移时不叫醒 agent");
});
