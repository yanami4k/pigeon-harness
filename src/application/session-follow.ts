// 决策 501：别的进程开着的会话在本进程里只看它的会话记录——跟着记录的追加更新内容与状态栏（模式、上下文与用量）。
// 只读追加的部分：记住读到的偏移，新追加的整行喂进解析器（写了一半的末行留到下次）；文件变小或修改时刻倒退（被截断、换了）
// 才从头重读。读文件是异步的，不卡界面。子会话与复盘的花费只在第一次读时扫一遍项目，之后只累加这个文件新增的用量
import { open, stat } from "node:fs/promises";
import {
  branchEntries,
  locateSessionFile,
  SessionFileParser,
} from "../persistence/session-reader.ts";
import { contextTokens } from "../pi-runtime/compaction.ts";
import { sessionContextMessages } from "../pi-runtime/session-store.ts";
import { sessionsDirOf } from "../state/paths.ts";
import { buildSessionView } from "../state/session-view.ts";
import { DEFAULT_HISTORY_ENTRY_CHARS, type HistoryLine, historyLinesOfView } from "./history.ts";
import {
  accumulatedSessionCost,
  type CostTally,
  costTallyOfView,
  emptyCostTally,
  mergeCostTally,
} from "./session-cost.ts";

export interface RecordedStatus {
  // 最近一次运行开始时的审批模式，其后又切换过的取最后一次切换
  mode?: "prompt" | "yolo";
  // 同运行面的口径：最后一条正常助手回复的用量加其后消息的估算；窗口取最近一次运行的压缩配置（没有即不写）
  context?: { tokens: number; contextWindow: number };
  // 会话自己连同它的子 agent 累计的用量（同续接时的起算）
  cost: CostTally;
}

export interface FollowUpdate {
  // 从头读的（第一次、文件被截断或换了）：调用方整份重画
  restarted: boolean;
  // 全部历史行（不折叠）
  lines: HistoryLine[];
  status: RecordedStatus;
}

// 会话记录文件的位置（root 为项目根）；没有为 undefined
export function recordedSessionPath(root: string, sessionId: string): string | undefined {
  return locateSessionFile(sessionsDirOf(root), sessionId)?.path;
}

export class SessionFollower {
  private readonly root: string;
  private readonly sessionId: string;
  private readonly path: string;
  private readonly entryChars: number;
  private parser: SessionFileParser;
  private offset = 0;
  private mtimeMs = 0;
  // 写了一半的末行（字节，等下次补齐）
  private tail: Buffer = Buffer.alloc(0);
  private cost: CostTally | undefined;
  private counted = new Set<string>();
  // 累计读过的字节数（测试看只读了增量）
  readBytes = 0;

  constructor(options: { root: string; sessionId: string; path: string; entryChars?: number }) {
    this.root = options.root;
    this.sessionId = options.sessionId;
    this.path = options.path;
    this.entryChars = options.entryChars ?? DEFAULT_HISTORY_ENTRY_CHARS;
    this.parser = new SessionFileParser(options.path);
  }

  private restart(): void {
    this.parser = new SessionFileParser(this.path);
    this.offset = 0;
    this.tail = Buffer.alloc(0);
    this.cost = undefined;
    this.counted = new Set<string>();
  }

  // 看一次：没有新的整行为 undefined；读不到（文件没了、目录被删）照常抛，调用方停在原样、下次再看
  async poll(): Promise<FollowUpdate | undefined> {
    const info = await stat(this.path);
    const first = this.offset === 0 && this.cost === undefined;
    const restarted = first || info.size < this.offset || info.mtimeMs < this.mtimeMs;
    if (restarted && !first) this.restart();
    if (!restarted && info.size === this.offset) return undefined;
    const length = info.size - this.offset;
    const chunk = Buffer.alloc(length);
    const handle = await open(this.path, "r");
    let read: number;
    try {
      ({ bytesRead: read } = await handle.read(chunk, 0, length, this.offset));
    } finally {
      await handle.close();
    }
    this.readBytes += read;
    this.offset += read;
    this.mtimeMs = info.mtimeMs;
    const data = Buffer.concat([this.tail, chunk.subarray(0, read)]);
    const end = data.lastIndexOf(0x0a);
    if (end < 0) {
      this.tail = data;
      if (!restarted) return undefined;
    } else {
      this.tail = data.subarray(end + 1);
      this.parser.feed(data.subarray(0, end).toString("utf8").split("\n"));
    }
    const file = this.parser.view();
    if (file === undefined) return undefined;
    const entries = branchEntries(file, file.lanes.get("main") ?? null);
    const view = buildSessionView({ header: file.header, entries });
    // 用量：第一次读时连同子会话与复盘扫一遍项目（同续接时的起算），这个文件里已有的条目记为计过；之后只累加新增的
    const own = costTallyOfView(view, this.counted);
    if (this.cost === undefined) {
      try {
        this.cost = accumulatedSessionCost(sessionsDirOf(this.root), this.sessionId);
      } catch {
        this.cost = own;
      }
    } else {
      mergeCostTally(this.cost, own);
    }
    let mode: RecordedStatus["mode"];
    let contextWindow: number | undefined;
    for (const item of view.items) {
      if (item.kind === "run-start") {
        mode = item.data.policy.approvalMode;
        contextWindow = item.data.compaction?.contextWindow ?? contextWindow;
      } else if (item.kind === "approval-mode") {
        mode = item.data.to;
      }
    }
    const cost = emptyCostTally();
    mergeCostTally(cost, this.cost);
    return {
      restarted,
      lines: historyLinesOfView(view, this.entryChars),
      status: {
        ...(mode !== undefined ? { mode } : {}),
        ...(contextWindow !== undefined
          ? {
              context: {
                tokens: contextTokens(sessionContextMessages(entries)),
                contextWindow,
              },
            }
          : {}),
        cost,
      },
    };
  }
}

// 新的历史行与已画的比：已画的是前段（工具行可以补上结果），返回要改的行号与新增的行；对不上（主分支换了等）为 undefined
export function historyDelta(
  drawn: readonly HistoryLine[],
  next: readonly HistoryLine[]
): { changed: number[]; added: HistoryLine[] } | undefined {
  if (next.length < drawn.length) return undefined;
  const changed: number[] = [];
  for (let index = 0; index < drawn.length; index++) {
    const before = drawn[index] as HistoryLine;
    const after = next[index] as HistoryLine;
    if (before.kind !== after.kind) return undefined;
    if (before.text === after.text && before.failed === after.failed) continue;
    if (before.kind === "tool" && after.text.startsWith(before.text)) {
      changed.push(index);
      continue;
    }
    return undefined;
  }
  return { changed, added: next.slice(drawn.length) };
}
