// 模型自己建工作树的工具 enter_worktree（决策 446）：按 445 同一套建立（.pigeon/wt/<名字>、分支 pigeon-wt/<名字>、
// 起点缺省为远端默认分支、.worktreeinclude 复制、全局排除规则），在会话里记一条 pigeon.worktree 条目，由终端界面在本轮结束后
// 按 /reload 的先建后换把会话移进去，并自动递一条通知让 agent 接着做。普通会话只在使用者明确要求时用（工具说明写明）；
// 只给终端界面的主会话注册（pigeon run、worker、沙箱都不注册）。写档：建目录与分支，按本会话的审批模式请示。
// 工具说明、参数说明与返回文字面向模型，用英文（决策 428）。
import { type Static, Type } from "typebox";
import { pigeonRel } from "../state/paths.ts";
import {
  SESSION_ENTRY_VERSION,
  type SessionEntrySink,
  SessionEntryType,
} from "../state/session-entries.ts";
import type { ToolRegistration } from "../tools/registry.ts";
import type { PigeonAgentTool, PigeonToolResult } from "../tools/wrap.ts";
import {
  insideNamedWorktree,
  type NamedWorktree,
  openNamedWorktree,
  uncommittedCount,
  type WorktreeBaseMode,
} from "./named-worktree.ts";

export const ENTER_WORKTREE_TOOL = "enter_worktree";

export const ENTER_WORKTREE_DESCRIPTION = [
  'Create a git worktree for this session and move the session into it. Use this ONLY when the user explicitly asks you to work in a worktree (for example "work in a worktree" or "do this in a separate worktree"); never use it on your own initiative.',
  `The worktree is created at ${pigeonRel("worktrees")}/<name> in the main repository on a new branch pigeon-wt/<name>, starting from the latest remote default branch (or HEAD when there is no remote or the fetch fails); if a worktree with that name already exists, it is reused. Uncommitted changes in the current checkout are NOT carried over.`,
  "The move happens when the current turn ends: after calling this tool, finish the turn with a brief reply and do not edit files in the current checkout; the session then continues inside the worktree automatically.",
].join("\n");

// 系统提示里的一句（注册了这件工具时加）
export const ENTER_WORKTREE_PROMPT_SENTENCE =
  "Only call enter_worktree when the user explicitly asks you to work in a separate git worktree; never move the session into a worktree on your own initiative.";

export const EnterWorktreeParamsSchema = Type.Object({
  name: Type.String({
    description:
      "Worktree name: lowercase letters, digits, underscores and hyphens, starting with a letter or digit (at most 64 characters)",
  }),
});
export type EnterWorktreeParams = Static<typeof EnterWorktreeParamsSchema>;

// 终端界面绑定的宿主：治理根、当前工作区（判断是否已在工作树里、数未带过去的改动）、起点档位、建好后的回调（本轮结束后换运行面）
export interface EnterWorktreeHost {
  governanceRoot: string;
  workspaceRoot: () => string;
  baseMode: () => WorktreeBaseMode;
  // 现在不能移（有 worker 在跑或等补批、本轮已有待移入的）：给出英文原因；能移给 undefined
  blocked?: () => string | undefined;
  onEntered: (worktree: NamedWorktree, uncommitted: number) => void;
}

export class EnterWorktreeSlot {
  host: EnterWorktreeHost | undefined;

  bind(host: EnterWorktreeHost): void {
    this.host = host;
  }
}

export interface EnterWorktreeDetails {
  worktree?: { name: string; path: string; branch: string; baseLabel: string; created: boolean };
  uncommitted?: number;
  rejected?: "unbound" | "already-in-worktree" | "blocked" | "failed";
}

export const ENTER_WORKTREE_TEXTS = {
  unbound: "This session cannot move into a worktree (no terminal UI host is attached).",
  already: (path: string) =>
    `This session is already working in the worktree ${path}; it cannot move into another one.`,
  failed: (reason: string) => `Creating the worktree failed: ${reason}`,
  blocked: (reason: string) =>
    `Not now: ${reason}. Wait until that is resolved, then call enter_worktree again.`,
  entered: (worktree: NamedWorktree, uncommitted: number) =>
    `${
      worktree.created
        ? `Created the worktree ${worktree.path} on branch ${worktree.branch}, starting from ${worktree.baseLabel}.`
        : `Reusing the existing worktree ${worktree.path} on branch ${worktree.branch}.`
    }${
      uncommitted > 0
        ? ` The ${uncommitted} uncommitted ${uncommitted === 1 ? "file" : "files"} in the current checkout were NOT carried over; the worktree does not have those changes.`
        : ""
    } When this turn ends, the session moves into the worktree and continues there. End this turn now with a brief reply, and do not edit files in the current checkout.`,
} as const;

function reply(
  text: string,
  details: EnterWorktreeDetails
): PigeonToolResult<EnterWorktreeDetails> {
  return { content: [{ type: "text", text }], details };
}

export function createEnterWorktreeTool(
  slot: EnterWorktreeSlot
): PigeonAgentTool<typeof EnterWorktreeParamsSchema, EnterWorktreeDetails> {
  return {
    name: ENTER_WORKTREE_TOOL,
    label: ENTER_WORKTREE_TOOL,
    description: ENTER_WORKTREE_DESCRIPTION,
    parameters: EnterWorktreeParamsSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params): Promise<PigeonToolResult<EnterWorktreeDetails>> {
      const host = slot.host;
      if (host === undefined) return reply(ENTER_WORKTREE_TEXTS.unbound, { rejected: "unbound" });
      const current = host.workspaceRoot();
      if (insideNamedWorktree(host.governanceRoot, current)) {
        return reply(ENTER_WORKTREE_TEXTS.already(current), { rejected: "already-in-worktree" });
      }
      const blocked = host.blocked?.();
      if (blocked !== undefined) {
        return reply(ENTER_WORKTREE_TEXTS.blocked(blocked), { rejected: "blocked" });
      }
      let worktree: NamedWorktree;
      try {
        worktree = openNamedWorktree({
          cwd: host.governanceRoot,
          name: params.name,
          baseMode: host.baseMode(),
        });
      } catch (error) {
        return reply(
          ENTER_WORKTREE_TEXTS.failed(error instanceof Error ? error.message : String(error)),
          { rejected: "failed" }
        );
      }
      const uncommitted = uncommittedCount(current);
      host.onEntered(worktree, uncommitted);
      return reply(ENTER_WORKTREE_TEXTS.entered(worktree, uncommitted), {
        worktree: {
          name: worktree.name,
          path: worktree.path,
          branch: worktree.branch,
          baseLabel: worktree.baseLabel,
          created: worktree.created,
        },
        uncommitted,
      });
    },
  };
}

// 移进工作树成功之后记一条 pigeon.worktree（续接、/reload 按主分支最后一条回到工作树）；换不成就不记
export function recordWorktreeEntry(sink: SessionEntrySink, worktree: NamedWorktree): void {
  sink.append({
    customType: SessionEntryType.Worktree,
    data: {
      version: SESSION_ENTRY_VERSION,
      name: worktree.name,
      path: worktree.path,
      branch: worktree.branch,
      ...(worktree.base !== undefined ? { base: worktree.base } : {}),
      baseLabel: worktree.baseLabel,
      created: worktree.created,
      enteredAt: Date.now(),
    },
  });
}

// 装配根注册用的元数据：写档（建目录与分支，按本会话的审批模式请示）、串行
export function enterWorktreeRegistration(): ToolRegistration {
  return {
    name: ENTER_WORKTREE_TOOL,
    description:
      "create a worktree and move the session into it after this turn (only when the user asks)",
    parameters: EnterWorktreeParamsSchema,
    tier: "write",
    // 参数是名字不是路径：位置由工具自己定在主仓库的 .pigeon/wt 下
    pathConfinement: { kind: "none" },
    executionMode: "sequential",
  };
}

// 移进工作树之后递给 agent 的通知（新的一轮由它开头）
export function worktreeContinueNotice(worktree: NamedWorktree, uncommitted: number): string {
  return `[Pigeon] This session has moved into the worktree ${worktree.path} (branch ${worktree.branch}); your working directory is now that worktree.${
    uncommitted > 0
      ? ` The ${uncommitted} uncommitted ${uncommitted === 1 ? "file" : "files"} from the previous checkout are not here.`
      : ""
  } Continue the task you were working on.`;
}
