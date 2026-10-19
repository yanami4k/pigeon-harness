// 决策 505：子 agent 视图里代理级命令作用于正在看的这个子 agent——/status、/compact、/rename、/tasks、/hooks、/grants、
// /revoke、/grants save 的数据都取它自己的运行面（它也是 openSessionRuntime 开出的完整会话）。程序级命令与只对主代理的
// 四条由壳分流，不经这里。
import { homedir } from "node:os";
import { tildePath } from "../application/format.ts";
import { sessionCostTally } from "../application/session-cost.ts";
import { validSessionName } from "../application/session-name.ts";
import { inspectSubagent } from "../application/subagent-runtime.ts";
import type { AgentHub, SubagentRecord } from "../application/subagents.ts";
import { renderTaskList } from "../application/task-list-tool.ts";
import { treesHomeOf } from "../orchestration/worktree.ts";
import { agentStateWord } from "./agent-panel.ts";
import type { TuiAgentCommands, TuiAgentsFace } from "./shell.ts";
import { totalTokens } from "./status-bar.ts";
import { agentStatusText, statusCwd } from "./status-report.ts";

export interface AgentCommandsDeps {
  hub: Pick<AgentHub, "compacting" | "rename">;
  // 它的会话所在的会话根（同 TuiAgentsFace.historyDir）
  historyDir(record: SubagentRecord): string | undefined;
  // 它所属会话的项目根（工作目录相对它写）
  projectOf(record: SubagentRecord): string;
  homeDir?: string;
  // 运行面上给命令用的那一面（缺省按运行面登记的取；测试替换）
  inspect?: typeof inspectSubagent;
}

export function agentCommandsFace(
  deps: AgentCommandsDeps
): Required<Pick<TuiAgentsFace, "commands" | "status" | "compact" | "rename">> {
  const home = deps.homeDir ?? homedir();
  const inspectOf = deps.inspect ?? inspectSubagent;
  const commands = (record: SubagentRecord): TuiAgentCommands | undefined => {
    const inspect = inspectOf(record.runtime);
    if (inspect === undefined) return undefined;
    const bundle = inspect.bundle;
    return {
      contextUsage: () => bundle.adapter.contextUsage(),
      grants: {
        root: inspect.governanceRoot,
        store: bundle.grantStore,
        configRules: bundle.configGrants,
        layeredRules: bundle.settings.grants,
      },
      ...(bundle.hooks !== undefined ? { hooks: bundle.hooks } : {}),
      tasks: () => {
        const list = bundle.taskList;
        return list !== undefined ? renderTaskList(list.items()) : undefined;
      },
    };
  };
  return {
    commands,
    status: async (record) => {
      const inspect = inspectOf(record.runtime);
      const project = inspect?.governanceRoot ?? deps.projectOf(record);
      const workspace = record.runtime?.workspaceRoot?.() ?? record.workspace ?? project;
      let file: string | undefined;
      try {
        file = await inspect?.bundle.sessionStore.filePath();
      } catch {
        file = undefined;
      }
      const dir = deps.historyDir(record);
      let tokens: number | undefined;
      try {
        tokens =
          dir !== undefined && record.sessionId !== undefined
            ? totalTokens(sessionCostTally(dir, record.sessionId))
            : undefined;
      } catch {
        tokens = undefined;
      }
      const context = commands(record)?.contextUsage();
      const topName = record.top.name();
      return agentStatusText({
        name: record.agentName,
        ...(record.displayName !== undefined ? { displayName: record.displayName } : {}),
        type: record.type.name,
        state: agentStateWord(record.state),
        session: {
          id: record.top.endpoint.sessionId,
          ...(topName !== "" ? { name: topName } : {}),
        },
        cwd: statusCwd(project, workspace, home, treesHomeOf(project)),
        ...(file !== undefined ? { record: tildePath(file, home) } : {}),
        ...(inspect !== undefined ? { model: inspect.modelId } : {}),
        ...(tokens !== undefined
          ? {
              usage: {
                ...(context !== undefined
                  ? { context: { tokens: context.tokens, window: context.contextWindow } }
                  : {}),
                tokens,
              },
            }
          : {}),
      });
    },
    compact: (record, focus) => {
      const adapter = inspectOf(record.runtime)?.bundle.adapter;
      if (adapter === undefined) {
        return Promise.reject(new Error(`${record.agentName} isn't open right now`));
      }
      return deps.hub.compacting(record, () => adapter.compact(focus));
    },
    rename: (record, name) => {
      if (!validSessionName(name)) return "invalid name: use letters, digits, _, - and . (max 40)";
      deps.hub.rename(record, name);
      return `renamed to ${name} (still addressed as ${record.agentName})`;
    },
  };
}
