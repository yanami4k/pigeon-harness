// /reload 重读设置（决策 340）：终端界面在会话中途重读三层设置，形成新快照。
// - 执行命令类配置（命令短名、沙箱配置连同 Dockerfile、MCP 启动定义）与项目共享层的放行规则（决策 341）相对当前快照
//   有变化（含首次出现）、且未经确认的条目，照启动时的确认流程列出请人确认；确认的记下指纹并生效，不确认的沿用当前快照里的内容（原来没有的就不启用）。
// - 新快照自下一轮起生效：此后派出的 worker、新开的脚本编排用新快照；运行面按新快照重建，MCP 只动有变化的服务（启动定义
//   改了的重启、删掉的停止、新加的启动，结果行里分别列出；未变的沿用原连接），系统提示逐字节不变；人写的说明、推送的记忆、
//   Skill 目录在开工状态块里，不靠重读设置，每个 Run 照常重读（决策 363）。正在跑的沙箱容器不重建，sandbox 一节有变化时另给一行提示。
// - pigeon run 不设重载。
// 本模块只算"读出什么、要问什么、改了哪些节"；问人与重建运行面在终端界面入口。
import { homedir } from "node:os";
import {
  recordTrustedEntries,
  sandboxDockerfileContent,
} from "../persistence/config-trust-store.ts";
import { loadSettings } from "../persistence/settings.ts";
import {
  describeTrustEntry,
  revertTrustEntries,
  type TrustEntry,
  trustEntriesOf,
  trustKeyOf,
} from "../state/config-trust.ts";
import { canonicalJson } from "../state/hashing.ts";
import { mergeMcpConfig } from "../state/mcp-config.ts";
import { SETTINGS_SECTIONS, type SettingsSnapshot, withHooksDisabled } from "../state/settings.ts";
import { localSettingsTracked, pendingTrustEntries } from "./session-settings.ts";

// 重读设置的结果行：终端界面按这两句认出"已重读""没有变化"（不另写进消息区）
export const SETTINGS_RELOADED_PREFIX = "settings reloaded";
export const SETTINGS_UNCHANGED = "settings unchanged";

export interface SettingsReloadPlan {
  current: SettingsSnapshot;
  next: SettingsSnapshot;
  // 有变化且未经确认、须人确认的条目
  pending: TrustEntry[];
}

export interface SettingsReloadResult {
  snapshot: SettingsSnapshot;
  // 内容有变的节（含 trustedDirectories）；为空即没有变化
  changedSections: string[];
  mcp: { started: string[]; stopped: string[]; restarted: string[] };
  sandboxChanged: boolean;
  // 给人看的结果行
  lines: string[];
}

function entriesOf(snapshot: SettingsSnapshot): TrustEntry[] {
  const content = sandboxDockerfileContent(snapshot);
  return trustEntriesOf({
    snapshot,
    ...(content !== undefined ? { dockerfileContent: content } : {}),
    // 决策 342：项目个人层被 git 跟踪时按共享层确认
    ...(localSettingsTracked(snapshot.root) ? { localLayerTracked: true } : {}),
  });
}

// 读新设置，算出须人确认的条目（读不出即抛错，当前快照不变）。
// hooksDisabled：--no-hooks 是本次运行的进程级开关，重读出的新快照同样停用钩子（复审 P2）
export function planSettingsReload(
  current: SettingsSnapshot,
  options: { homeDir?: string; hooksDisabled?: boolean } = {}
): SettingsReloadPlan {
  const homeDir = options.homeDir ?? homedir();
  const loaded = loadSettings(current.root, {
    homeDir,
    ...(localSettingsTracked(current.root) ? { localLayerTracked: true } : {}),
  });
  const next = options.hooksDisabled === true ? withHooksDisabled(loaded) : loaded;
  const before = new Map(entriesOf(current).map((entry) => [trustKeyOf(entry), entry.fingerprint]));
  const changed = new Set(
    entriesOf(next)
      .filter((entry) => before.get(trustKeyOf(entry)) !== entry.fingerprint)
      .map((entry) => trustKeyOf(entry))
  );
  const pending = pendingTrustEntries(next, homeDir).filter((entry) =>
    changed.has(trustKeyOf(entry))
  );
  return { current, next, pending };
}

function sectionValue(snapshot: SettingsSnapshot, name: string): unknown {
  if (name === "permissions") return snapshot.grants.map((entry) => entry.rule);
  // hooks 一节合并成快照的钩子清单（merged 里没有这一节），比较按合并结果
  if (name === "hooks") return snapshot.hooks;
  if (name === "mcp") return { section: snapshot.merged.mcp, dotMcp: snapshot.dotMcp };
  return (snapshot.merged as unknown as Record<string, unknown>)[name];
}

// 按人的选择形成新快照：确认即生效（指纹在运行面重建成功后由调用方记下）；不确认即这些条目沿用当前快照的内容
export function applySettingsReload(
  plan: SettingsReloadPlan,
  choice: "trust" | "skip",
  options: { homeDir?: string } = {}
): SettingsReloadResult {
  void options;
  let snapshot = plan.next;
  if (plan.pending.length > 0 && choice === "skip") {
    snapshot = revertTrustEntries(plan.next, plan.current, plan.pending, {
      localLayerTracked: localSettingsTracked(plan.current.root),
    });
  }
  // 顶层标量也在比较之列（整体审查修复：disableAllHooks 与 stopHookBlockCap 不在任何节里）
  const changedSections = [
    ...Object.keys(SETTINGS_SECTIONS),
    "trustedDirectories",
    "disableAllHooks",
    "stopHookBlockCap",
  ].filter(
    (name) =>
      canonicalJson(sectionValue(plan.current, name) ?? null) !==
      canonicalJson(sectionValue(snapshot, name) ?? null)
  );
  // 按启动定义比较：只改风险档的服务沿用连接、不重启（与 MCP 会话的沿用判定一致）
  const servers = (target: SettingsSnapshot) =>
    new Map(
      mergeMcpConfig(target.dotMcp, target.merged.mcp).config.servers.map((server) => [
        server.name,
        canonicalJson(server.launch),
      ])
    );
  const oldServers = servers(plan.current);
  const newServers = servers(snapshot);
  const mcp = {
    started: [...newServers.keys()].filter((name) => !oldServers.has(name)),
    stopped: [...oldServers.keys()].filter((name) => !newServers.has(name)),
    restarted: [...newServers.keys()].filter(
      (name) => oldServers.has(name) && oldServers.get(name) !== newServers.get(name)
    ),
  };
  const sandboxChanged = changedSections.includes("sandbox");
  const lines: string[] = [];
  if (changedSections.length === 0) {
    lines.push(SETTINGS_UNCHANGED);
  } else {
    lines.push(`${SETTINGS_RELOADED_PREFIX}: ${changedSections.join(", ")} changed`);
    const mcpParts = [
      ...(mcp.restarted.length > 0 ? [`restarted ${mcp.restarted.join(", ")}`] : []),
      ...(mcp.stopped.length > 0 ? [`stopped ${mcp.stopped.join(", ")}`] : []),
      ...(mcp.started.length > 0 ? [`started ${mcp.started.join(", ")}`] : []),
    ];
    if (mcpParts.length > 0) {
      lines.push(`MCP servers: ${mcpParts.join("; ")}`);
    }
  }
  if (plan.pending.length > 0 && choice === "skip") {
    lines.push(
      `unconfirmed, kept as before: ${plan.pending.map((entry) => trustKeyOf(entry)).join(", ")}`
    );
  }
  return { snapshot, changedSections, mcp, sandboxChanged, lines };
}

export const RELOAD_USAGE = "usage: /reload | /reload confirm | /reload skip";

export interface SettingsReloaderDeps {
  // 当前快照
  current(): SettingsSnapshot;
  apply(snapshot: SettingsSnapshot): Promise<void>;
  // --no-hooks（本次运行停用全部钩子）：重读出的新快照也停用，reload 不把钩子带回来
  hooksDisabled?: boolean;
  // 现在不能重载的原因（有 worker 在跑等）；可以即 undefined
  busy?(): string | undefined;
  // 沙箱会话的会话号（在沙箱里才给）：sandbox 一节有变化时提示退出后续跑才对容器生效
  sandboxSessionId?(): string | undefined;
  homeDir?: string;
}

// /reload 的命令逻辑：返回给人看的行。有须确认的条目时先列出、等 /reload confirm 或 /reload skip
export function createSettingsReloader(
  deps: SettingsReloaderDeps
): (args: readonly string[]) => Promise<string[]> {
  let pending: SettingsReloadPlan | undefined;
  const homeOption = {
    ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
    ...(deps.hooksDisabled === true ? { hooksDisabled: true } : {}),
  };
  return async (args) => {
    const busy = deps.busy?.();
    if (busy !== undefined) return [busy];
    const sub = args[0];
    let plan: SettingsReloadPlan;
    let choice: "trust" | "skip" = "skip";
    if (sub === "confirm" || sub === "skip") {
      if (pending === undefined) return ["nothing pending to confirm"];
      plan = pending;
      choice = sub === "confirm" ? "trust" : "skip";
    } else if (sub !== undefined) {
      return [RELOAD_USAGE];
    } else {
      plan = planSettingsReload(deps.current(), homeOption);
      if (plan.pending.length > 0) {
        pending = plan;
        return [
          "changed settings that run commands or grant permissions:",
          ...plan.pending.map((entry) => `  ${describeTrustEntry(entry)}`),
          "/reload confirm to apply | /reload skip to skip",
        ];
      }
    }
    pending = undefined;
    const result = applySettingsReload(plan, choice, homeOption);
    if (result.changedSections.length > 0) {
      await deps.apply(result.snapshot);
    }
    // 重建成功才记下确认指纹：重建失败时保持未确认状态，/reload 会再列出这些条目（复审 P2）
    if (choice === "trust" && plan.pending.length > 0) {
      recordTrustedEntries(plan.current.root, plan.pending, homeOption.homeDir ?? homedir());
    }
    const sandboxSession = deps.sandboxSessionId?.();
    return [
      ...result.lines,
      ...(result.sandboxChanged && sandboxSession !== undefined
        ? [
            `sandbox settings changed; takes effect after: pigeon --sandbox --resume ${sandboxSession}`,
          ]
        : []),
    ];
  };
}
