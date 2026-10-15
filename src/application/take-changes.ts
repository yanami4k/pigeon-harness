// 决策 486：take_changes——把自己派出的子 agent 临时工作树里自起点以来的改动（含未提交、新建的文件）三方叠进调用方自己的
// 工作目录，与 /take 同一套叠回（叠不上的留在对方工作树并列出，对方删了的不删、只列出）。完整取回之后起点前移（钉在
// refs/pigeon/agent/<工作树名> 下），下次只取之后的改动；释放时取回之后再没有改动的同样算没有改动（见 agent-worktree.ts）。
import { realpathSync } from "node:fs";
import { agentWorktreeAt } from "./agent-worktree.ts";
import { advanceTakeBase, takePooledChanges } from "./session-pool.ts";

function sameDir(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

export interface AgentTakeResult {
  text: string;
  // 出错（没有工作树、落点就是它的工作树等）：作工具错误交回
  error?: boolean;
  // 完整取回后前移的起点（调用方记下，下次取与释放时用）
  takenBase?: string;
}

export function takeFromAgent(input: {
  name: string;
  sessionId: string | undefined;
  // 它的工作目录（在临时工作树里干活的即工作树）
  workspace: string | undefined;
  // 取回的落点：调用方自己的工作目录
  into: string;
  // 上次完整取回后前移的起点
  takenBase?: string;
}): AgentTakeResult {
  const worktree =
    input.workspace !== undefined && input.sessionId !== undefined
      ? agentWorktreeAt({
          workspace: input.workspace,
          sessionId: input.sessionId,
          name: input.name,
        })
      : undefined;
  if (worktree === undefined) {
    return {
      text: `${input.name} has no worktree; its changes are already in its working directory`,
      error: true,
    };
  }
  if (sameDir(input.into, worktree.path)) {
    return { text: `you are working in ${input.name}'s worktree; nothing to take`, error: true };
  }
  const result = takePooledChanges({
    label: "sub-agent",
    name: input.name,
    repoRoot: input.into,
    base: input.takenBase ?? worktree.base,
    worktreePath: worktree.path,
  });
  if (!result.complete) return { text: result.text };
  try {
    return { text: result.text, takenBase: advanceTakeBase(worktree.path, worktree.key, "agent") };
  } catch (error) {
    return {
      text: `${result.text}\nadvancing the base failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
