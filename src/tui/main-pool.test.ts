// 决策 443：会话面板的会话池接上真实运行面（与终端界面同一条装配路径，假模型，临时 git 仓库）。派出的会话进自己的独立
// 工作树、在那里改文件（主工作目录不动）；审批经同一个处理口、写明来源会话，挂着时卡片在"等待回应"；/take 把工作树里的
// 改动取回主工作目录；停下释放运行面，有改动的工作树保留。
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { initRepo, routedModel, tempRoot } from "../application/tui-session-fixtures.ts";
import type { ApprovalRequest } from "../approvals/handler.ts";
import { loadSettings } from "../persistence/settings.ts";
import { createSessionPool } from "./main-pool.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("派出的会话进自己的工作树改文件；审批写明来源、挂着时在等待回应；/take 取回；停下释放运行面", async () => {
  const { root, cleanup } = tempRoot("pigeon-pool-");
  cleanups.push(cleanup);
  initRepo(root, { "a.txt": "one\n" });
  const { streamFn } = routedModel({
    main: [
      {
        text: "写",
        toolCalls: [{ name: "write_file", args: { path: "made.txt", content: "made\n" } }],
      },
      { text: "写好了" },
    ],
  });
  const requests: ApprovalRequest[] = [];
  const states: string[] = [];
  const notices: string[] = [];
  let release: (() => void) | undefined;
  const { pool, face } = createSessionPool({
    governanceRoot: root,
    streamFn,
    flags: { provider: "custom", modelId: "custom" } as never,
    settings: () => loadSettings(root, { homeDir: root }),
    warn: () => {},
    createApprovalHandler: () => async (request) => {
      requests.push(request);
      states.push(pool.list()[0]?.state ?? "?");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { approved: true };
    },
    mainWorkspace: () => root,
    notice: (line) => notices.push(line),
  });
  cleanups.push(() => pool.closeAll());
  const card = await pool.spawn("建一个文件");
  assert.equal(card.error, undefined);
  assert.match(card.worktree?.path ?? "", /s1-/);
  for (let i = 0; i < 200 && release === undefined; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(release !== undefined, "审批到了");
  assert.equal(requests[0]?.pooled?.name, "s1");
  assert.equal(requests[0]?.sessionId, card.id);
  assert.deepEqual(states, ["waiting"]);
  assert.match(pool.list()[0]?.waiting ?? "", /^write_file/);
  release?.();
  for (let i = 0; i < 200 && pool.list()[0]?.state !== "idle"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(pool.list()[0]?.state, "idle");
  assert.equal(pool.list()[0]?.summary, "写好了");
  const worktree = card.worktree?.path ?? "";
  assert.equal(readFileSync(join(worktree, "made.txt"), "utf8"), "made\n");
  assert.equal(existsSync(join(root, "made.txt")), false, "主工作目录不动");
  assert.ok(face.live?.(card.id) !== undefined);
  assert.match(pool.take(card.id), /已取回 1 个文件：made\.txt/);
  // 取回沿用 worker 的叠回（行尾按检出规则）
  assert.equal(readFileSync(join(root, "made.txt"), "utf8").replace(/\r\n/g, "\n"), "made\n");
  await pool.stop(card.id);
  assert.equal(pool.list()[0]?.state, "stopped");
  assert.ok(existsSync(worktree), "有改动的工作树保留");
  assert.ok(notices.some((line) => line.includes("保留")));
});
