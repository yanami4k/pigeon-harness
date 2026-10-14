// 子 agent 面板（决策 457、482）：输入框下方，列当前会话派出的子 agent，一次只列一层；还有下层的行标 (+N)；钻进下层时
// 第一行写回到会话的路径（"main › general-1"）。在跑的、已中断的（续接后没干完的）一直列着，干完、失败、停下的保留约
// 30 秒（按 x 提前清掉）。没有可列的行即不占地方。按键由壳路由：输入框为空时 ↓ 进入面板，↑↓ 选，→ 进下层，← 回上层
//（最上层即回输入框），Enter 进入它的会话，x 停下在跑的或清掉已结束的，Esc 回输入框。只写状态，不写按键说明。
// 名字与类型来自模型与类型文件（半信任）：显示前一律净化、压成一行。
import type { Component } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../application/format.ts";
import type { AgentState, SubagentRecord } from "../application/subagents.ts";
import { clipToWidth } from "./status-bar.ts";
import { secondary } from "./style.ts";

// 已结束的行保留多久
export const AGENT_ROW_RETAIN_MS = 30_000;

const STATE_WORD: Record<AgentState, string> = {
  starting: "starting",
  running: "running",
  idle: "done",
  failed: "failed",
  stopped: "stopped",
  interrupted: "interrupted",
};

function oneLine(text: string): string {
  return sanitizeTerminalText(text.replace(/\s+/g, " ").trim());
}

export function agentStateWord(state: AgentState): string {
  return STATE_WORD[state];
}

export function agentActive(record: Pick<SubagentRecord, "state">): boolean {
  return record.state === "starting" || record.state === "running";
}

export interface AgentPanelSource {
  // 当前会话（连同各层）的全部子 agent
  agents(): readonly SubagentRecord[];
  // 当前会话的名字（路径的开头）
  sessionName(): string;
  // 在等审批的子 agent（路径）
  waiting?(): ReadonlySet<string>;
  now(): number;
}

export class AgentPanel implements Component {
  private readonly source: AgentPanelSource;
  // 当前列的是谁的下层；undefined 为会话这一层
  private level: SubagentRecord | undefined;
  private selectedRecord: SubagentRecord | undefined;
  private focused = false;
  // x 清掉的行与清掉时它最后的变化时刻（之后又有变化即重新列出）
  private readonly cleared = new WeakMap<SubagentRecord, number>();

  constructor(source: AgentPanelSource) {
    this.source = source;
  }

  private isCleared(record: SubagentRecord): boolean {
    const at = this.cleared.get(record);
    return at !== undefined && record.updatedAt <= at;
  }

  private shown(record: SubagentRecord): boolean {
    if (this.isCleared(record)) return false;
    if (agentActive(record) || record.state === "interrupted") return true;
    if (this.source.now() - record.updatedAt < AGENT_ROW_RETAIN_MS) return true;
    // 已结束的保留期过了，下层还有可列的照样列着（不然钻不进去）
    return this.descendants(record) > 0;
  }

  private childrenOf(parent: SubagentRecord | undefined): SubagentRecord[] {
    return this.source
      .agents()
      .filter(
        (record) =>
          (parent === undefined ? record.parent.kind === "session" : record.parent === parent) &&
          this.shown(record)
      );
  }

  // 下层（各层）里可列的行数
  private descendants(record: SubagentRecord): number {
    let count = 0;
    for (const child of this.source.agents()) {
      if (child.parent !== record || this.isCleared(child)) continue;
      const below = this.descendants(child);
      const visible =
        agentActive(child) ||
        child.state === "interrupted" ||
        this.source.now() - child.updatedAt < AGENT_ROW_RETAIN_MS ||
        below > 0;
      if (visible) count += 1 + below;
    }
    return count;
  }

  rows(): SubagentRecord[] {
    // 所在的那一层没有可列的了：回到上层
    while (this.level !== undefined && this.childrenOf(this.level).length === 0) {
      this.level =
        this.level.parent.kind === "agent" ? (this.level.parent as SubagentRecord) : undefined;
    }
    return this.childrenOf(this.level);
  }

  // 有没有可列的（没有即不占地方）
  hasRows(): boolean {
    return this.rows().length > 0;
  }

  // 有没有保留期内、要按时撤下的行（壳据此定时重画）
  hasRetained(): boolean {
    return this.source
      .agents()
      .some(
        (record) =>
          !agentActive(record) &&
          record.state !== "interrupted" &&
          !this.isCleared(record) &&
          this.source.now() - record.updatedAt < AGENT_ROW_RETAIN_MS
      );
  }

  isFocused(): boolean {
    return this.focused;
  }

  focus(): boolean {
    const rows = this.rows();
    if (rows.length === 0) return false;
    this.focused = true;
    if (this.selectedRecord === undefined || !rows.includes(this.selectedRecord)) {
      this.selectedRecord = rows[0];
    }
    return true;
  }

  blur(): void {
    this.focused = false;
  }

  selected(): SubagentRecord | undefined {
    const rows = this.rows();
    if (this.selectedRecord !== undefined && rows.includes(this.selectedRecord)) {
      return this.selectedRecord;
    }
    this.selectedRecord = rows[0];
    return this.selectedRecord;
  }

  // ↑：第一行再往上即回输入框（返回 false）
  up(): boolean {
    const rows = this.rows();
    const index = rows.indexOf(this.selected() as SubagentRecord);
    if (index <= 0) {
      this.focused = false;
      return false;
    }
    this.selectedRecord = rows[index - 1];
    return true;
  }

  down(): void {
    const rows = this.rows();
    const index = rows.indexOf(this.selected() as SubagentRecord);
    if (index >= 0 && index < rows.length - 1) this.selectedRecord = rows[index + 1];
  }

  // →：选中的有下层即钻进去
  drillIn(): boolean {
    const record = this.selected();
    if (record === undefined || this.childrenOf(record).length === 0) return false;
    this.level = record;
    this.selectedRecord = this.childrenOf(record)[0];
    return true;
  }

  // ←：回上层；已在会话这一层即回输入框（返回 false）
  drillOut(): boolean {
    const level = this.level;
    if (level === undefined) {
      this.focused = false;
      return false;
    }
    this.level = level.parent.kind === "agent" ? (level.parent as SubagentRecord) : undefined;
    this.selectedRecord = level;
    return true;
  }

  // x 清掉已结束的一行（在跑的由壳先停下）
  clear(record: SubagentRecord): void {
    this.cleared.set(record, record.updatedAt);
  }

  // 换会话：回到最上层、不选中
  reset(): void {
    this.level = undefined;
    this.selectedRecord = undefined;
    this.focused = false;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const rows = this.rows();
    if (rows.length === 0) return [];
    const lines: string[] = [];
    if (this.level !== undefined) {
      lines.push(
        clipToWidth(secondary(oneLine(`${this.source.sessionName()} › ${this.level.path}`)), width)
      );
    }
    const waiting = this.source.waiting?.() ?? new Set<string>();
    const selected = this.focused ? this.selected() : undefined;
    for (const record of rows) {
      const below = this.descendants(record);
      const state = waiting.has(record.path) ? "waiting for approval" : STATE_WORD[record.state];
      const detail =
        record.state === "failed" && record.error !== undefined ? `: ${oneLine(record.error)}` : "";
      const text =
        `${record === selected ? "› " : "  "}${oneLine(record.agentName)}  ` +
        secondary(`${oneLine(record.type.name)} · ${state}${detail}`) +
        (below > 0 ? secondary(` (+${below})`) : "");
      lines.push(clipToWidth(text, width));
    }
    return lines;
  }
}
