// resume 续跑流程（M4 S5；M2 S1 决策 025 从 cli/session.ts 抽到 Controller 层；账本重构决策 183）：
// 核对会话在会话存储里有文件 → 报告末条助手消息里悬空的工具调用（没有即不写）→ 进入调用方注入的续会话入口（终端界面的
// /resume 换绑运行面）。续会话入口装配运行面时（session-runtime.ts 的 resume）由写者打开会话文件、用 pi 的
// buildSessionContext 还原消息，并为每个悬空调用补一条"进程在执行途中中断、结果未知、请自行核实"的工具结果，由 agent 自行核对；
// 程序不再按文件哈希对账、也不再逐条问人（原哈希三方比对与人工确认菜单随之删除）。系统永不自动重新执行（§3.2）。
// 旧格式会话（迁移之前创建）不能续跑，明确报错（187：旧会话由只读的旧版代码读，211）。
// 输出依赖注入（决策 025）：调用方给写出口（终端界面打消息区）。
import { hasLegacySessionFile, LEGACY_READER_HINT } from "../persistence/session-catalog.ts";
import { loadStoreSession } from "../persistence/session-view.ts";
import { sessionContextMessages } from "../pi-runtime/session-store.ts";
import { sessionsDirOf } from "../state/paths.ts";
import { danglingToolCalls, type StoreMessage } from "../state/session-judge.ts";
import { plural } from "./format.ts";

// 输出函数
export type WriteFn = (text: string) => void;

export interface ResumeFlowOptions {
  // 治理根（会话文件在 <root>/.pigeon/state/sessions/）
  root: string;
  sessionId: string;
  write: WriteFn;
  // 续会话入口（测试可 mock/即刻返回；终端界面在此换绑运行面）
  enter: () => Promise<void>;
}

// 续跑前的报告：悬空的工具调用（真正的还原在续会话入口装配运行面时做）
export function describeResume(root: string, sessionId: string): string[] {
  const sessionsDir = sessionsDirOf(root);
  const loaded = loadStoreSession(sessionsDir, sessionId);
  if (loaded === undefined) {
    if (hasLegacySessionFile(sessionsDir, sessionId)) {
      throw new Error(`can't resume ${sessionId}: old-format session; ${LEGACY_READER_HINT}`);
    }
    throw new Error(`session not found: ${sessionId}`);
  }
  const messages = sessionContextMessages(loaded.main);
  const lines: string[] = [];
  const dangling = danglingToolCalls(messages as unknown as StoreMessage[]);
  if (dangling.length > 0) {
    lines.push(
      `${plural(dangling.length, "tool call")} interrupted, results unknown: ${dangling.map((call) => call.name).join(", ")}`
    );
  }
  return lines;
}

export async function runResumeFlow(options: ResumeFlowOptions): Promise<void> {
  for (const line of describeResume(options.root, options.sessionId)) {
    options.write(`${line}\n`);
  }
  await options.enter();
}
