// 决策 446：enter_worktree 之后"本轮结束移进工作树"的流程。工具在轮内只建工作树、记下待移入；轮次收尾时：
// - 本轮被中止（Esc）：不移，告诉人与模型，工作树留着；
// - 否则先把工作区换成工作树，再按 /reload 的先建后换重建运行面；
//   重建失败即换回原工作区并说明；成功才记 pigeon.worktree 条目、递通知让 agent 接着做。
// 不移时给模型的说明随人的下一条输入带上，不自动开新的一轮。
// 同一轮里已有待移入的，再调即拒绝（工具经 blocked 如实回模型）。
import { PROGRAM_NOTE_PREFIX } from "../application/enter-worktree-tool.ts";
import type { NamedWorktree } from "../application/named-worktree.ts";

export interface WorktreeSwitchDeps {
  // 当前工作区与换工作区（同时换 /reload 的上下文）
  workspace(): string;
  setWorkspace(root: string): void;
  // 按当前工作区重建运行面（/reload 的先建后换）
  rebuild(): Promise<void>;
  // 换成功之后：记为当前工作树、写 pigeon.worktree 条目
  adopt(worktree: NamedWorktree): void;
  // 消息区一行；递给模型的通知（空闲时开一轮）；随人的下一条输入带给模型的说明（不开新的一轮）
  // alert：没移成之类的报错，醒目显示
  system(line: string, alert?: boolean): void;
  notify(text: string): void;
  noteForNextInput(text: string): void;
  // 换成功后递给模型接着做的通知
  continueNotice(worktree: NamedWorktree, uncommitted: number): string;
}

export interface WorktreeSwitch {
  // enter_worktree 宿主的 blocked 与 onEntered
  blocked(): string | undefined;
  entered(worktree: NamedWorktree, uncommitted: number): void;
  pending(): boolean;
  // 壳的 afterTurn
  afterTurn(info: { cancelled: boolean }): Promise<void> | undefined;
}

export function createWorktreeSwitch(deps: WorktreeSwitchDeps): WorktreeSwitch {
  let pending: { worktree: NamedWorktree; uncommitted: number } | undefined;

  async function switchInto(
    target: { worktree: NamedWorktree; uncommitted: number },
    info: { cancelled: boolean }
  ): Promise<void> {
    const { worktree } = target;
    const stay = (why: string, forModel: string): void => {
      deps.system(`didn't move into worktree ${worktree.path}: ${why}; session stays here`, true);
      deps.noteForNextInput(
        `${PROGRAM_NOTE_PREFIX}The session did not move into the worktree ${worktree.path}: ${forModel}. It stays in ${deps.workspace()}; the worktree is kept. Call enter_worktree again if the move is still wanted.`
      );
    };
    if (info.cancelled) {
      stay("turn interrupted", "the turn was interrupted");
      return;
    }
    const previous = deps.workspace();
    deps.setWorkspace(worktree.path);
    try {
      await deps.rebuild();
    } catch (error) {
      deps.setWorkspace(previous);
      stay(
        `rebuilding the runtime failed: ${error instanceof Error ? error.message : String(error)}`,
        "rebuilding the runtime failed"
      );
      return;
    }
    deps.adopt(worktree);
    deps.system(
      `moved into worktree ${worktree.path} (branch ${worktree.branch})${
        target.uncommitted > 0
          ? `; ${target.uncommitted} uncommitted ${target.uncommitted === 1 ? "change" : "changes"} left in the main checkout`
          : ""
      }`
    );
    deps.notify(deps.continueNotice(worktree, target.uncommitted));
  }

  return {
    blocked: () =>
      pending !== undefined
        ? `a move into the worktree ${pending.worktree.path} is already pending this turn`
        : undefined,
    entered(worktree, uncommitted) {
      pending = { worktree, uncommitted };
    },
    pending: () => pending !== undefined,
    afterTurn(info) {
      const target = pending;
      pending = undefined;
      return target !== undefined ? switchInto(target, info) : undefined;
    },
  };
}
