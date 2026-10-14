// 按环境只注册用得上的工具（决策 359）：会话开始时做几项便宜的本地检查——工作区是不是 git 仓库、本会话所在的会话树以外
// 有没有会话——不发请求；另记搜索后端可不可用。结果随开局冻结的内容沿用到
// /reload（一次会话内工具清单固定），新开会话重查；key 取自进程环境，改了要重启进程才生效。没注册的工具与原因记进
// Run 开始条目。
import { sessionFamily } from "../memory/session-search.ts";
import { isGitWorkspace } from "../orchestration/checkpoint.ts";
import {
  listSessionFiles,
  readSessionHeader,
  sessionHasContent,
} from "../persistence/session-reader.ts";

// 各项检查的结果；只查用得上的，没查的缺省
export interface ToolEnvironment {
  gitWorkspace?: boolean;
  sessionHistory?: boolean;
  webSearch?: boolean;
}

export interface SkippedTools {
  tools: string[];
  reason: string;
}

// 会话检索能不能搜到东西：与检索同一口径，排除本会话所在的整棵会话树（决策 339）；读文件头拼家谱，没有合法文件头的（空文件、
// 写了一半）不算；决策 432：除文件头与钩子运行记录外没有条目的（从没开始过对话）也不算，只对家谱外的逐个看到第一个有内容的为止
export function hasSessionHistory(
  sessionsDir: string,
  current: { sessionId: string; parentSessionId?: string }
): boolean {
  const parentOf = new Map<string, string | undefined>();
  const pathOf = new Map<string, string>();
  for (const file of listSessionFiles(sessionsDir)) {
    const header = file.sessionId === current.sessionId ? undefined : readSessionHeader(file.path);
    if (header !== undefined) {
      parentOf.set(file.sessionId, header.parentSessionId);
      pathOf.set(file.sessionId, file.path);
    }
  }
  parentOf.set(current.sessionId, current.parentSessionId);
  const family = sessionFamily(current.sessionId, parentOf);
  return [...pathOf].some(([id, file]) => !family.has(id) && sessionHasContent(file));
}

// 按需检查：已有结果的（/reload 沿用开局的）不重查
export function toolEnvironmentProbe(input: {
  frozen?: ToolEnvironment;
  // 决策 359 的"工作区是 git 仓库"探的是工作区根（worker 的 git 工作树从它分出来）；
  // 治理根与工作区根分开（--governance-root）时两者不同，探治理根会误判
  workspaceRoot: string;
  governanceRoot: string;
  sessionsDir: string;
  current: { sessionId: string; parentSessionId?: string };
  searchBackend: boolean;
}): { check: (key: keyof ToolEnvironment) => boolean; result: () => ToolEnvironment } {
  const environment: ToolEnvironment = { ...input.frozen };
  const probes: Record<keyof ToolEnvironment, () => boolean> = {
    gitWorkspace: () => isGitWorkspace(input.workspaceRoot),
    sessionHistory: () => hasSessionHistory(input.sessionsDir, input.current),
    webSearch: () => input.searchBackend,
  };
  return {
    check: (key) => {
      environment[key] ??= probes[key]();
      return environment[key];
    },
    result: () => ({ ...environment }),
  };
}
