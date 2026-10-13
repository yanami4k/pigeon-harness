// 终端界面的钩子面与只读视图（决策 323 / 324）：壳跑会话级事件（SessionStart / UserPromptSubmit /
// Stop / SessionEnd / Notification）时用的窄接口，以及 /hooks 的清单排版。
// 面由装配方给（运行面里的 SessionHooks——清单随会话开始时的设置快照冻结；/resume 换绑与 /reload
// 重建后换成新会话的面）。本模块零治理语义：只调面、只排版。
import type { HookEventReport } from "../application/hooks.ts";
import { type HookEventName, hookTimeoutMs, type LayeredHook } from "../state/hooks.ts";
import { SETTINGS_LAYER_LABELS } from "../state/settings.ts";

// 会话级事件的钩子面（SessionHooks 结构上满足；测试可注入替身）
export interface TuiHooksFace {
  // 执行一次事件：命中的钩子并行跑，返回汇合结果（拦下、上下文、系统消息、是否跑过）
  runEvent(
    event: HookEventName,
    matcherTarget: string,
    fields: Record<string, unknown>,
    options?: { signal?: AbortSignal }
  ): Promise<HookEventReport>;
  // 本会话生效的钩子清单（停用时为空）
  list(): readonly LayeredHook[];
  // 顶层开关：本会话是否停用了全部钩子
  readonly disabled: boolean;
}

// /hooks 的输出：停用开关 + 生效的钩子逐条（事件、matcher、命令、来自哪一层、在哪执行、超时秒数）
export function renderHooksView(hooks: TuiHooksFace): string {
  const lines = ["== hooks =="];
  lines.push(hooks.disabled ? "disableAllHooks: on" : "disableAllHooks: off");
  const effective = hooks.list();
  if (effective.length === 0) {
    lines.push("active hooks: none");
    return lines.join("\n");
  }
  for (const hook of effective) {
    lines.push(
      `- ${hook.event}${
        hook.matcher !== undefined && hook.matcher !== "" ? ` (matcher: ${hook.matcher})` : ""
      } | ${hook.command} | ${SETTINGS_LAYER_LABELS[hook.layer]} | ${
        hook.host ? "runs on host" : "runs in workspace"
      } | timeout ${hookTimeoutMs(hook.event, hook) / 1000}s`
    );
  }
  lines.push(`${effective.length} ${effective.length === 1 ? "hook" : "hooks"}`);
  return lines.join("\n");
}
