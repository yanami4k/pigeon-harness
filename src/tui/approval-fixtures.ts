// 测试用的"按脚本作答的人"（决策 461：命令行对话与它的内联审批去掉之后，application 层的治理测试改用它）：
// 审批走终端界面同一个 handler（同一份审批块、放权语义与答完的一行结论）。ask 收到审批块的按键提示行，返回按键；
// 按 n 之后再问一次拒绝理由（REASON_PROMPT 开头），给了理由即按 [r] 拒绝并说明，留空即单按拒绝；write 收到审批块与结论
import type { SessionGrantStore } from "../approvals/grant-store.ts";
import type { ApprovalHandler } from "../approvals/handler.ts";
import {
  type ApprovalPanelKey,
  type ApprovalPanelResult,
  approvalBlockText,
  createTuiApprovalHandler,
} from "./approval.ts";

export const REASON_PROMPT = "拒绝理由：";

const KEYS: readonly string[] = ["y", "n", "a", "d", "s"];

export function scriptedApprovalHandler(
  ask: (prompt: string) => Promise<string | null>,
  write: (text: string) => void,
  options: { grants?: SessionGrantStore } = {}
): ApprovalHandler {
  const grants = options.grants;
  return createTuiApprovalHandler(
    // 没给放权存储时按会话放权不可用：[a]/[d] 收不到（同终端界面缺省）
    grants ??
      ({
        create: () => {
          throw new Error("没有放权存储");
        },
      } as unknown as SessionGrantStore),
    () => ({
      askApproval: async (request, directoryGrant): Promise<ApprovalPanelResult> => {
        const block = approvalBlockText(request, grants !== undefined && directoryGrant !== false);
        write(`${block}\n`);
        const keyLine = block.split("\n").at(-1) ?? "";
        const answer = (await ask(keyLine))?.trim().toLowerCase() ?? "n";
        const key = KEYS.includes(answer) ? (answer as ApprovalPanelKey) : "n";
        if (key !== "n") return { key };
        const reason = (await ask(REASON_PROMPT))?.trim() ?? "";
        return reason !== "" ? { key: "r", reason } : { key: "n" };
      },
      noteApproval: (line) => write(`${line}\n`),
    })
  );
}
