// 日常沙箱的会话接线（决策 237、245–248）：两个入口（终端界面、pigeon run）开沙箱、接执行端、
// 收尾交回都经这里；容器生命周期本身在 execution/sandbox.ts。Actor（cli / tui）不直连执行层，所需的符号从这里取。
// 沙箱里暂不支持分叉（/fork、失败自动分叉重试）、派 worker 与终端界面的 /resume 换绑：它们作用在宿主的 git 工作区或
// 工作树上，会越出容器。会话验证命令经执行端在容器里运行。MCP 服务不启动（决策 252）：它们在宿主上运行，开沙箱时
// 列出已配置却不可用的服务名。
import {
  cleanResidualSandboxes,
  clearCacheVolume,
  exportNotice,
  findResidualSandboxes,
  inspectCacheVolume,
  type OpenSandboxOptions,
  openSandbox,
  residualNotice,
  SANDBOX_CLEAN_COMMAND,
  type Sandbox,
  type SandboxExport,
} from "../execution/sandbox.ts";
import type { SessionId } from "../state/ids.ts";
import { sandboxLimitSettingsOf } from "../state/sandbox-config.ts";
import {
  emptySettingsSnapshot,
  mcpConfigOf,
  type SettingsSnapshot,
  sandboxConfigOf,
  untrackedLimitsOfSettings,
} from "../state/settings.ts";
import type { SessionJobs } from "../tools/background-jobs.ts";
import { handbackJobsNotice } from "./background-jobs.ts";
import { plural } from "./format.ts";
import { type HeadlessRunOptions, type HeadlessRunResult, runHeadless } from "./headless-core.ts";
import type { LaunchFlags } from "./launch-flags.ts";
import { noMcpSession } from "./mcp.ts";
import type { StatusFacts } from "./status-sources.ts";

export { exportNotice, SANDBOX_CLEAN_COMMAND, type Sandbox, type SandboxExport };

export const SANDBOX_FORK_UNSUPPORTED = "/fork not available in the sandbox";
export const SANDBOX_TAKE_UNSUPPORTED = "/take not available in the sandbox";
export const SANDBOX_RESUME_UNSUPPORTED =
  "/resume not available in the sandbox; use pigeon --sandbox --resume <session ID>";

// 测试注入：docker 调用前缀、镜像来源、容器内工作区根与缓存卷
export type SandboxOverrides = Pick<
  OpenSandboxOptions,
  "docker" | "image" | "containerRoot" | "cacheVolume" | "cacheRoot"
>;

export interface StartSandboxInput {
  flags: Pick<LaunchFlags, "sandbox">;
  governanceRoot: string;
  sessionId: string;
  // 续跑：从该会话交回过的分支起步
  resume?: boolean;
  // 决策 325：本会话的设置快照（镜像配置取 sandbox 一节，MCP 服务名取合并后的配置）
  settings?: SettingsSnapshot;
  // progress：等待中的进度（拉镜像、建镜像），其余是告警
  log: (line: string, progress?: boolean) => void;
  // 运行中给人看的提示（命令超出沙箱内存上限等）；缺省同 log
  notice?: (line: string) => void;
  overrides?: SandboxOverrides;
}

// 按启动参数开沙箱；没给 --sandbox 返回 undefined。与沙箱不相容的参数在起容器之前报错
export async function startSandbox(input: StartSandboxInput): Promise<Sandbox | undefined> {
  const launch = input.flags.sandbox;
  if (launch === undefined) {
    return undefined;
  }
  // 决策 252：沙箱会话不启动 MCP 服务；配置了的列出来说明不可用，没配不提示
  const settings = input.settings ?? emptySettingsSnapshot(input.governanceRoot);
  const mcpServers = mcpConfigOf(settings).servers.map((server) => server.name);
  if (mcpServers.length > 0) {
    input.log(mcpUnavailableNotice(mcpServers));
  }
  const sandbox = await openSandbox({
    repoRoot: input.governanceRoot,
    sessionId: input.sessionId,
    network: launch.network,
    sandboxConfig: sandboxConfigOf(settings),
    // 决策 333：资源上限取自设置的 sandbox 一节（缺项取缺省）
    limits: sandboxLimitSettingsOf(sandboxConfigOf(settings)),
    // 决策 381：开工快照里未跟踪文件的上限取自设置的 snapshot 一节
    untrackedLimits: untrackedLimitsOfSettings(settings),
    ...(input.resume === true ? { resume: true } : {}),
    // 决策 278：--sandbox-from-head 只从最新提交开工
    ...(launch.fromHead === true ? { fromHead: true } : {}),
    log: input.log,
    ...(input.notice !== undefined ? { notice: input.notice } : {}),
    ...input.overrides,
  });
  return sandbox;
}

export function mcpUnavailableNotice(servers: readonly string[]): string {
  return `MCP servers don't run in the sandbox: ${servers.join(", ")} unavailable`;
}

// 决策 354：沙箱会话写进开工状态块环境一节的确知事实——沙箱档位；断网档时网络确知不可用（联网档不算确知能用）
// 决策 381：开工快照没带进来的文件一并写进去
export function sandboxStatusFacts(
  sandbox: Pick<Sandbox, "network" | "startSkipped">
): StatusFacts {
  const skipped =
    sandbox.startSkipped !== undefined && sandbox.startSkipped.length > 0
      ? { skipped: sandbox.startSkipped }
      : {};
  return sandbox.network === "on"
    ? { sandbox: "container sandbox (network on)", ...skipped }
    : {
        sandbox: "container sandbox (network off)",
        network: "not available (the sandbox has no network)",
        ...skipped,
      };
}

// 收尾交回：成功给出分支与查看命令，失败给出原因（容器保留）；两者都是给人看的一行
export async function closeSandbox(
  sandbox: Sandbox
): Promise<{ notice: string; exported?: SandboxExport }> {
  try {
    const exported = await sandbox.close();
    return { notice: exportNotice(exported), exported };
  } catch (error) {
    return { notice: error instanceof Error ? error.message : String(error) };
  }
}

// /export：会话中手动交回；决策 365：有后台作业在跑时先提示一句
export async function exportSandbox(
  sandbox: Sandbox,
  jobs?: Pick<SessionJobs, "running">
): Promise<string> {
  const warning = handbackJobsNotice(jobs, "export");
  const prefix = warning !== undefined ? `${warning}\n` : "";
  try {
    return `${prefix}${exportNotice(await sandbox.exportChanges())}`;
  } catch (error) {
    return `${prefix}export failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export interface SandboxedHeadlessResult extends HeadlessRunResult {
  // 交回的分支（交回失败时缺省，原因见 sandboxNotice）
  sandbox?: SandboxExport;
  sandboxNotice?: string;
}

// pigeon run --sandbox：开沙箱、在容器里跑完，返回前交回并删除容器
export async function runHeadlessInSandbox(
  options: Omit<HeadlessRunOptions, "workspaceHost" | "sessionId"> & { sessionId: SessionId },
  input: Omit<StartSandboxInput, "sessionId" | "governanceRoot" | "settings">
): Promise<SandboxedHeadlessResult> {
  const sandbox = await startSandbox({
    ...input,
    sessionId: options.sessionId,
    governanceRoot: options.governanceRoot,
    ...(options.settings !== undefined ? { settings: options.settings } : {}),
  });
  if (sandbox === undefined) {
    throw new Error("runHeadlessInSandbox needs --sandbox");
  }
  let result: HeadlessRunResult;
  try {
    // 决策 252：不启动 MCP 服务
    result = await runHeadless({
      ...options,
      workspaceHost: sandbox.host,
      statusFacts: sandboxStatusFacts(sandbox),
      startMcp: noMcpSession,
    });
  } catch (error) {
    // 装配前就被拒（参数不相容等）：没有改动可交回，直接删容器
    await sandbox.discard().catch(() => {});
    throw error;
  }
  const closed = await closeSandbox(sandbox);
  // 决策 409：沙箱容器随收尾删除，里面保留的作业随之结束，不列为保留中
  const { keptJobs: _kept, ...rest } = result;
  return {
    ...rest,
    ...(closed.exported !== undefined ? { sandbox: closed.exported } : {}),
    sandboxNotice: closed.notice,
  };
}

export const SANDBOX_COMMAND_USAGE = "usage: pigeon sandbox list | clean | cache | clear-cache";

// pigeon sandbox list | clean：列出或清理进程异常退出留下的沙箱容器（在用的不动）；
// pigeon sandbox cache | clear-cache（决策 280）：查看共用下载缓存卷的占用、清空缓存
export async function runSandboxCommand(
  argv: readonly string[],
  overrides: Pick<SandboxOverrides, "docker" | "cacheVolume"> = {}
): Promise<string> {
  if (argv.length !== 1) {
    throw new Error(SANDBOX_COMMAND_USAGE);
  }
  if (argv[0] === "list") {
    const residual = await findResidualSandboxes(overrides.docker);
    return residual.length === 0
      ? "no leftover sandbox containers\n"
      : `${residualNotice(residual)}\n`;
  }
  if (argv[0] === "clean") {
    const removed = await cleanResidualSandboxes(overrides.docker);
    return removed.length === 0
      ? "no leftover sandbox containers\n"
      : `removed ${plural(removed.length, "leftover sandbox container")}: ${removed.join(", ")}\n`;
  }
  if (argv[0] === "cache") {
    const info = await inspectCacheVolume(overrides.docker, overrides.cacheVolume);
    if (!info.exists) {
      return `sandbox cache volume ${info.volume} does not exist\n`;
    }
    const inUse =
      info.links !== undefined && info.links > 0
        ? `, used by ${plural(info.links, "sandbox container")}`
        : "";
    return `sandbox cache volume ${info.volume}: ${info.size}${inUse}\n`;
  }
  if (argv[0] === "clear-cache") {
    const outcome = await clearCacheVolume(overrides.docker, overrides.cacheVolume);
    return outcome === "removed" ? "sandbox cache cleared\n" : "sandbox cache already empty\n";
  }
  throw new Error(SANDBOX_COMMAND_USAGE);
}
