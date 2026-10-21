// 决策 491、495：/status 的一行行文本（纯函数，数据由装配方现取）。
// 字段与措辞全英文，与状态栏一致（`ctx 23% (46k/200k)`、`idle`、`clean` 都沿用）；`—` 表示这一项没有。
import { isAbsolute, relative, sep } from "node:path";
import { compactNumber } from "../application/format.ts";
import type { SandboxApproval } from "../application/launch-flags.ts";
import { modeLabel } from "./status-bar.ts";
import { tildePath } from "./welcome.ts";

export interface StatusSettingsLayer {
  layer: "user" | "project" | "local";
  path: string;
  present: boolean;
}

export interface StatusReport {
  sessionId: string;
  // 会话的显示名（缺省是「目录名 + 会话号末 4 位」；`/rename` 过的是那个名字）
  name?: string;
  // 界面这一侧的活动：idle、running、waiting、stopped……
  activity?: string;
  // 项目（~ 缩写后的项目根）：设置、会话记录、记忆按它算
  project: string;
  // 工作目录，相对项目写（见 statusCwd）：与项目根相同为空串
  cwd: string;
  // 会话记录文件；拿不到即不写
  record?: string;
  settings: readonly StatusSettingsLayer[];
  // 内部值照旧是 prompt / yolo；决策 499：显示成 ask / bypass（同状态栏），不括注内部值
  mode: "prompt" | "yolo";
  model?: string;
  usage?: { context?: { tokens: number; window: number } | undefined; tokens: number };
  git?: { branch?: string; commit: string; dirty: boolean };
  // approval 是沙箱的审批档（--sandbox-approval 的值），显示与 mode 同一写法（决策 499）
  sandbox?: { image?: string; network?: string; approval?: SandboxApproval };
  // 在跑的子 agent 的个数与（知道时）名字
  agents?: { count: number; names?: readonly string[] };
}

const LABEL_WIDTH = 9;

// 决策 495：工作目录相对项目根写（树里如 .pigeon/trees/feature-x，子目录如 packages/web，分隔符一律 /）；与项目根相同为空串，
// 不在项目里（不该有，照写）为 ~ 缩写的原路径
export function statusCwd(project: string, cwd: string, home: string): string {
  const key = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);
  const rel = relative(key(project), key(cwd));
  if (rel === "") return "";
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return tildePath(cwd, home);
  return relative(project, cwd).split(sep).join("/");
}

function line(label: string, value: string): string {
  return `${label.padEnd(LABEL_WIDTH)}${value}`;
}

function usageText(usage: NonNullable<StatusReport["usage"]>): string {
  const tokens = `${compactNumber(usage.tokens)} tokens`;
  const context = usage.context;
  if (context === undefined || context.window <= 0) return tokens;
  const percent = Math.min(999, Math.round((context.tokens / context.window) * 100));
  return `ctx ${percent}% (${compactNumber(context.tokens)}/${compactNumber(context.window)}) · ${tokens}`;
}

export function statusReportText(report: StatusReport): string {
  const lines: string[] = [];
  const session = [report.sessionId, report.name, report.activity]
    .filter((part): part is string => part !== undefined && part !== "")
    .join(" · ");
  lines.push(line("session", session));
  lines.push(line("project", report.project));
  // cwd 与项目根相同时写 = project——在树里、在子目录里一眼可辨
  lines.push(line("cwd", report.cwd === "" ? "= project" : report.cwd));
  if (report.record !== undefined) lines.push(line("record", report.record));
  const settings = report.settings
    .map((entry) => `${entry.layer} ${entry.present ? entry.path : "—"}`)
    .join(" · ");
  lines.push(line("settings", settings));
  const git = report.git;
  lines.push(
    line(
      "git",
      git === undefined
        ? "not a git repository"
        : [git.branch ?? git.commit, git.dirty ? "dirty" : "clean"]
            .filter((part) => part !== "")
            .join(" · ")
    )
  );
  const sandbox = report.sandbox;
  lines.push(
    line(
      "sandbox",
      sandbox === undefined
        ? "off"
        : [
            sandbox.image ?? "on",
            `network ${sandbox.network ?? "?"}`,
            `approval ${sandbox.approval !== undefined ? modeLabel(sandbox.approval) : "?"}`,
          ].join(" · ")
    )
  );
  const agents = report.agents ?? { count: 0 };
  const agentNames = agents.names ?? [];
  lines.push(
    line(
      "agents",
      agents.count === 0
        ? "none"
        : [
            `${agents.count} running`,
            ...(agentNames.length > 0 ? [agentNames.join(", ")] : []),
          ].join(" · ")
    )
  );
  if (report.usage !== undefined) lines.push(line("usage", usageText(report.usage)));
  const mode =
    report.model !== undefined
      ? `${modeLabel(report.mode)} · model ${report.model}`
      : modeLabel(report.mode);
  lines.push(line("mode", mode));
  return lines.join("\n");
}
