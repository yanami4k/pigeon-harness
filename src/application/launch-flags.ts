// 启动参数（决策 067）：cli、tui 与 headless 共用一份模型与运行参数解析，缺省值单一来源。
// 背景：三个入口此前各写一份，模型占位缺省已漂移成三种（进注入快照与 Run 开始条目，会把同一模型
// 按入口分成三组，影响 Eval 按模型分组）；`PIGEON_STREAM_FN` 只有 tui 读取，而 cli 的报错
// 文案称支持该变量。本模块统一占位缺省为 custom/custom，并把环境变量回退放进同一处。
// 真实模型元数据由 streamFn 插件提供，占位只是身份标签；历史会话标签不做映射。

import { SANDBOX_NETWORKS, type SandboxNetwork } from "../execution/sandbox.ts";

import type { CompactionConfigInput } from "../pi-runtime/compaction.ts";
import { isThinkingLevel, THINKING_LEVELS, type ThinkingLevel } from "../state/runtime-events.ts";
import { type SettingsSnapshot, webSectionOf } from "../state/settings.ts";
import type { WebSection } from "../state/web-config.ts";
import { resolveWebTools, type WebToolsConfig } from "./web-tools.ts";

// 三个入口共用的模型占位缺省（决策 067）
export const DEFAULT_MODEL_PLACEHOLDER = { provider: "custom", modelId: "custom" } as const;

// 无取值的开关型 flag（resume 的参数切分按此判断是否吞下一个参数）
export const VALUELESS_FLAGS = new Set([
  "--yolo",
  "--no-persist-thinking",
  "--no-pushed-memory",
  "--no-session-search",
  "--no-subagents",
  "--no-hooks",
  "--no-web",
  "--sandbox",
  "--sandbox-from-head",
]);

// 日常沙箱的审批档（决策 248）：缺省全部放行（复用 yolo），可改回逐条询问
export const SANDBOX_APPROVALS = ["yolo", "prompt"] as const;
export type SandboxApproval = (typeof SANDBOX_APPROVALS)[number];

// 决策 237、246、248：--sandbox 在一次性容器里工作；--sandbox-network on|off 联网档（缺省 on，以后可加"只放行包管理源"
// 一档而不改用法）；--sandbox-approval yolo|prompt 审批档（缺省 yolo）。
// 决策 278：缺省把工作目录里未提交的改动（含未被忽略的新文件）拍成快照带进容器；--sandbox-from-head 改为只从当前分支的
// 最新提交开工（续跑不受影响：照旧从该会话交回过的分支开工）
export interface SandboxLaunch {
  network: SandboxNetwork;
  approval: SandboxApproval;
  // 给了 --sandbox-from-head 时为 true；缺省带快照
  fromHead?: boolean;
}

export interface LaunchFlags {
  root: string;
  // 模型接入模块说明符：--stream-fn 优先，其次环境变量 PIGEON_STREAM_FN
  streamFnSpec?: string;
  yolo: boolean;
  // 决策 324：--no-hooks 只对本次运行停用全部钩子（清空清单并置 disableAllHooks）；各入口一律接受
  noHooks: boolean;
  // 决策 346：--no-web 只对本次运行不给联网工具（web_search、web_fetch 不注册，系统提示不带联网那句）；各入口一律接受
  noWeb: boolean;
  provider: string;
  modelId: string;
  // M5 S1（决策 045）：--no-persist-thinking 关闭 thinking 正文持久化（缺省开）
  persistThinking: boolean;
  // M5.5 S5（决策 050）：--thinking <档位> 推理档位全局值（不给即取设置，设置也没写按模型信息：支持推理的 high，决策 390）
  thinkingLevel?: ThinkingLevel;
  // 决策 063、347：--max-output-tokens <n> 单轮输出上限（缺省不设：跟模型，按模型定义的上限发、由 provider 按剩余上下文收窄）
  maxOutputTokens?: number;
  // M5 S2（决策 045）：--history-limit <n> /resume 历史渲染安全上限（仅 TUI 接受）
  historyLimit?: number;
  // 决策 191、244：推送记忆——日常入口缺省开着，--no-pushed-memory 关掉（关掉即不推送、不注册记忆工具）。
  // 对称的会话检索开关是 --no-session-search（决策 382，见下）。两层上限在设置的 memory 一节（决策 332），不设启动参数
  pushedMemory: boolean;
  // 决策 382：会话检索——日常入口缺省开着，--no-session-search 关掉（关掉即不注册检索三件，开局记录写明原因）；
  // 接受入口同 --no-pushed-memory。设置里另有 sessionSearch.enabled 一项（缺省开）；跑批按条件开关，不接受这个参数
  sessionSearch: boolean;
  // 决策 188、218：--context-window <n>、--compact-threshold <n>、--compact-keep <n>——上下文压缩的模型窗口、
  // 触发点与保留量（缺省为产品缺省：1M 窗口减预留、保留 20000）；各入口都接受，给了哪项带哪项
  compaction?: CompactionConfigInput;
  // 决策 237：--sandbox 及其参数；不开沙箱时缺省
  sandbox?: SandboxLaunch;
  // 决策 457：派子 agent——终端界面与 pigeon run 缺省开着，--no-subagents 关掉（关掉即不注册派生与通讯的工具）；
  // 沙箱会话不派，不看这一项
  subagents: boolean;
}

// 上下文压缩参数名 → 配置字段
const COMPACTION_FLAGS: Readonly<Record<string, keyof CompactionConfigInput>> = {
  "--context-window": "contextWindow",
  "--compact-threshold": "thresholdTokens",
  "--compact-keep": "keepRecentTokens",
};

export interface ParseLaunchFlagsOptions {
  // 参数错误时附在报错里的用法说明（各入口自己的用法行）
  usage: string;
  // 环境变量来源（缺省 process.env；测试注入）
  env?: Record<string, string | undefined>;
  // 工作区根缺省（缺省 process.cwd()）
  cwd?: string;
  // 是否接受 --history-limit（只有 TUI 有历史渲染）
  historyLimit?: boolean;
  // 是否接受 --no-pushed-memory（日常入口：cli / tui 主会话与 pigeon run；跑批器按条件指定，不接受）
  pushedMemory?: boolean;
  // 是否接受 --no-session-search（决策 382；接受入口同 --no-pushed-memory）
  sessionSearch?: boolean;
  // 是否接受 --sandbox 及其参数（终端界面、pigeon run）
  sandbox?: boolean;
  // 是否接受 --no-subagents（能派子 agent 的入口：终端界面与 pigeon run）
  subagents?: boolean;
}

export function parseLaunchFlags(argv: string[], options: ParseLaunchFlagsOptions): LaunchFlags {
  const env = options.env ?? process.env;
  const { usage } = options;
  const flags: LaunchFlags = {
    root: options.cwd ?? process.cwd(),
    yolo: false,
    noHooks: false,
    noWeb: false,
    provider: DEFAULT_MODEL_PLACEHOLDER.provider,
    modelId: DEFAULT_MODEL_PLACEHOLDER.modelId,
    persistThinking: true,
    pushedMemory: true,
    sessionSearch: true,
    subagents: true,
  };
  // 环境变量回退：--stream-fn 未给时用 PIGEON_STREAM_FN（决策 067：cli 补齐，与既有报错文案一致）
  // 沙箱参数：先收下，循环后与 --sandbox 对齐
  let sandbox = false;
  let sandboxNetwork: SandboxNetwork | undefined;
  let sandboxApproval: SandboxApproval | undefined;
  let sandboxFromHead = false;
  const fromEnv = env.PIGEON_STREAM_FN;
  if (fromEnv !== undefined && fromEnv !== "") {
    flags.streamFnSpec = fromEnv;
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--yolo") {
      flags.yolo = true;
    } else if (flag === "--no-hooks") {
      flags.noHooks = true;
    } else if (flag === "--no-web") {
      flags.noWeb = true;
    } else if (flag === "--sandbox" && options.sandbox === true) {
      sandbox = true;
    } else if (flag === "--sandbox-from-head" && options.sandbox === true) {
      sandboxFromHead = true;
    } else if (flag === "--sandbox-network" && options.sandbox === true) {
      const value = argv[++i];
      if (value === undefined || !(SANDBOX_NETWORKS as readonly string[]).includes(value)) {
        throw new Error(`--sandbox-network takes ${SANDBOX_NETWORKS.join("/")} (${usage})`);
      }
      sandboxNetwork = value as SandboxNetwork;
    } else if (flag === "--sandbox-approval" && options.sandbox === true) {
      const value = argv[++i];
      if (value === undefined || !(SANDBOX_APPROVALS as readonly string[]).includes(value)) {
        throw new Error(`--sandbox-approval takes ${SANDBOX_APPROVALS.join("/")} (${usage})`);
      }
      sandboxApproval = value as SandboxApproval;
    } else if (flag === "--no-persist-thinking") {
      flags.persistThinking = false;
    } else if (flag === "--no-subagents" && options.subagents === true) {
      flags.subagents = false;
    } else if (flag === "--no-pushed-memory" && options.pushedMemory === true) {
      flags.pushedMemory = false;
    } else if (flag === "--no-session-search" && options.sessionSearch === true) {
      flags.sessionSearch = false;
    } else if (flag === "--thinking") {
      const value = argv[++i];
      if (value === undefined || !isThinkingLevel(value)) {
        throw new Error(`--thinking takes ${THINKING_LEVELS.join("/")} (${usage})`);
      }
      flags.thinkingLevel = value;
    } else if (flag === "--max-output-tokens") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`--max-output-tokens needs a positive integer (${usage})`);
      }
      flags.maxOutputTokens = value;
    } else if (flag === "--history-limit" && options.historyLimit === true) {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`--history-limit needs a positive integer (${usage})`);
      }
      flags.historyLimit = value;
    } else if (flag !== undefined && COMPACTION_FLAGS[flag] !== undefined) {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`${flag} needs a positive token count (${usage})`);
      }
      flags.compaction = { ...flags.compaction, [COMPACTION_FLAGS[flag]]: value };
    } else if (flag === "--root") {
      flags.root = argv[++i] ?? flags.root;
    } else if (flag === "--stream-fn") {
      const value = argv[++i];
      if (value === undefined) {
        throw new Error(`--stream-fn needs a module path (${usage})`);
      }
      flags.streamFnSpec = value;
    } else if (flag === "--provider") {
      flags.provider = argv[++i] ?? flags.provider;
    } else if (flag === "--model") {
      flags.modelId = argv[++i] ?? flags.modelId;
    } else {
      throw new Error(`unknown option: ${flag} (${usage})`);
    }
  }
  if (sandbox) {
    flags.sandbox = {
      network: sandboxNetwork ?? "on",
      approval: sandboxApproval ?? "yolo",
      ...(sandboxFromHead ? { fromHead: true } : {}),
    };
    // 沙箱里的审批（决策 248）：缺省全部放行，复用 yolo；--sandbox-approval prompt 改回逐条询问（另给 --yolo 仍放行）
    flags.yolo = flags.yolo || flags.sandbox.approval === "yolo";
  } else if (sandboxNetwork !== undefined || sandboxApproval !== undefined || sandboxFromHead) {
    throw new Error(
      `--sandbox-network, --sandbox-approval and --sandbox-from-head need --sandbox (${usage})`
    );
  }
  return flags;
}

// 联网工具给不给（决策 291、346）：判定只在这一处。三者任一成立就不给——
// 本次运行带 --no-web；设置的 web.enabled 为 false（三层按标量覆盖，缺省 true）；沙箱开断网档（两件工具由宿主代为联网，
// 不受容器断网约束，选断网就一并关掉）。其余情形都给
export function webToolsEnabled(
  flags: Pick<LaunchFlags, "sandbox" | "noWeb">,
  web: WebSection | undefined
): boolean {
  if (flags.noWeb) return false;
  if (web?.enabled === false) return false;
  return flags.sandbox?.network !== "off";
}

// 交给装配根的联网工具选项：给就按快照的 web 一节建出配置（配置畸形在此响亮失败），不给就不带 webTools。
// 各入口启动与终端界面 /reload 后都经这里，按当时的设置快照重算
export function webToolsOptionOf(
  flags: Pick<LaunchFlags, "sandbox" | "noWeb">,
  snapshot: SettingsSnapshot,
  env?: Record<string, string | undefined>
): { webTools?: WebToolsConfig } {
  const web = webSectionOf(snapshot);
  return webToolsEnabled(flags, web)
    ? { webTools: resolveWebTools({ config: web, ...(env !== undefined ? { env } : {}) }) }
    : {};
}

// 模型接入必须显式配置：缺失时响亮失败（措辞与两个入口此前一致）
export function resolveStreamFnSpec(flags: LaunchFlags, usage: string): string {
  if (flags.streamFnSpec === undefined || flags.streamFnSpec === "") {
    throw new Error(`no model configured: use --stream-fn <module> or PIGEON_STREAM_FN (${usage})`);
  }
  return flags.streamFnSpec;
}
