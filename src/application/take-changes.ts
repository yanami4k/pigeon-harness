// 决策 486：take_changes——把自己派出的子 agent 临时工作树里自起点以来的改动（含未提交、新建的文件）三方叠进调用方自己的
// 工作目录，与 /take 同一套叠回（叠不上的留在对方工作树并列出，对方删了的不删、只列出；受保护的 .pigeon/ 不写、只列出）。
// 完整取回之后起点前移（钉在 refs/pigeon/agent/<分支名去掉 pigeon/> 下，跨重启与续接），下次只取之后的改动；释放时取回之后
// 再没有改动的同样算没有改动（见 agent-worktree.ts）。
import { realpathSync } from "node:fs";
import { agentWorktreeAt } from "./agent-worktree.ts";
import { advanceTakeBase, takePooledChanges } from "./session-pool.ts";

// （Windows 上不分大小写）
function sameDir(left: string, right: string): boolean {
  try {
    const a = realpathSync.native(left);
    const b = realpathSync.native(right);
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

export interface AgentTakeResult {
  text: string;
  // 出错（没有工作树、工作树没了、落点就是它的工作树等）：作工具错误交回
  error?: boolean;
}

export function takeFromAgent(input: {
  name: string;
  sessionId: string | undefined;
  // 它的工作目录（在临时工作树里干活的即工作树）
  workspace: string | undefined;
  // 派出时记下的起点（本进程派出的才有）
  base?: string | undefined;
  // 取回的落点：调用方自己的工作目录
  into: string;
}): AgentTakeResult {
  const found =
    input.sessionId !== undefined
      ? agentWorktreeAt({
          workspace: input.workspace,
          sessionId: input.sessionId,
          ...(input.base !== undefined ? { base: input.base } : {}),
        })
      : ({ ok: false, reason: "none" } as const);
  if (!found.ok) {
    const text =
      found.reason === "gone"
        ? `${input.name}'s worktree is gone (${input.workspace ?? ""})`
        : found.reason === "off-branch"
          ? `${input.name}'s worktree is not on its own branch (it is on ${found.head ?? "another branch"}); nothing taken`
          : found.reason === "no-base"
            ? `the starting point of ${input.name}'s worktree can't be found; nothing taken`
            : `${input.name} did not work in a worktree; its changes are already in its working directory`;
    return { text, error: true };
  }
  if (sameDir(input.into, found.path)) {
    return { text: `you are working in ${input.name}'s worktree; nothing to take`, error: true };
  }
  const result = takePooledChanges({
    label: "sub-agent",
    name: input.name,
    repoRoot: input.into,
    base: found.base,
    worktreePath: found.path,
    protectPigeon: true,
  });
  if (result.error === true) return { text: result.text, error: true };
  if (!result.complete) return { text: result.text };
  try {
    advanceTakeBase(found.path, found.key, "agent");
    return { text: result.text };
  } catch (error) {
    return {
      text: `${result.text}\nadvancing the base failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
