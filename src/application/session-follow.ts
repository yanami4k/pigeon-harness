// 决策 501：别的进程开着的会话在本进程里只看它的会话记录——跟着记录的追加更新内容与状态栏（模式、上下文与用量）。
// 只读追加的部分：记住读到的偏移，新追加的整行喂进解析器（写了一半的末行留到下次）；文件变小、修改时刻倒退、或换了一个文件
//（打开后的句柄上 dev:ino 变了）才从头重读。记录本身异步读，不卡界面。用量：复盘会话只在第一次读时扫一遍会话根；它的
// 子 agent 在记录每次有变化时重算（只扫它自己名下的 subagents 文件夹，大小与修改时刻没变的文件不再读）；会话自己的只从
// 读进来的条目算（各分支，计过的不再计）
import { statSync } from "node:fs";
import { open } from "node:fs/promises";
import { listSessionRefs, sessionBranchViews } from "../persistence/session-catalog.ts";
import {
  branchEntries,
  locateSessionFile,
  SessionFileParser,
} from "../persistence/session-reader.ts";
import { contextTokens } from "../pi-runtime/compaction.ts";
import { sessionContextMessages } from "../pi-runtime/session-store.ts";
import { sessionsDirOf, subagentSessionsDir } from "../state/paths.ts";
import { buildSessionView } from "../state/session-view.ts";
import { DEFAULT_HISTORY_ENTRY_CHARS, type HistoryLine, historyLinesOfView } from "./history.ts";
import {
  type CostTally,
  costTallyOfView,
  emptyCostTally,
  mergeCostTally,
  reviewForksCost,
  subagentFileCost,
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
  // 读的是哪一个文件（换了文件即从头读）
  private identity = "";
  // 写了一半的末行（字节，等下次补齐）
  private tail: Buffer = Buffer.alloc(0);
  // 复盘会话的花费（第一次读时算）与会话自己的累计（按条目，计过的不再计）
  private reviews: CostTally | undefined;
  private own: CostTally = emptyCostTally();
  private counted = new Set<string>();
  // 子 agent 会话文件的花费，按文件的大小与修改时刻缓存（没变的不再读）
  private readonly agentCosts = new Map<string, { stamp: string; tally: CostTally }>();
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
    this.reviews = undefined;
    this.own = emptyCostTally();
    this.counted = new Set<string>();
  }

  // 它名下 subagents 文件夹里各子 agent 的花费：只重读大小或修改时刻变了的文件；读不成的这次不计
  private subagentsCost(): CostTally {
    const tally = emptyCostTally();
    let refs: ReturnType<typeof listSessionRefs>;
    try {
      refs = listSessionRefs(subagentSessionsDir(this.path, this.sessionId));
    } catch {
      return tally;
    }
    for (const ref of refs) {
      try {
        const info = statSync(ref.path);
        const stamp = `${info.size}:${info.mtimeMs}`;
        let known = this.agentCosts.get(ref.path);
        if (known?.stamp !== stamp) {
          known = { stamp, tally: subagentFileCost(ref) };
          this.agentCosts.set(ref.path, known);
        }
        mergeCostTally(tally, known.tally);
      } catch {
        // 这个文件这次读不成：不计，下次再看
      }
    }
    return tally;
  }

  // 看一次：没有新的整行为 undefined；读不到（文件没了、目录被删）照常抛，调用方停在原样、下次再看
  async poll(): Promise<FollowUpdate | undefined> {
    const handle = await open(this.path, "r");
    let chunk: Buffer;
    let restarted: boolean;
    try {
      // 在打开的这个文件上取样子：换了文件按 dev:ino 认（创建时刻在没有 statx 的系统上随每次追加变，不用）
      const info = await handle.stat();
      const identity = `${info.dev}:${info.ino}`;
      const first = this.offset === 0 && this.reviews === undefined;
      restarted =
        first ||
        info.size < this.offset ||
        info.mtimeMs < this.mtimeMs ||
        identity !== this.identity;
      if (restarted && !first) this.restart();
      this.mtimeMs = info.mtimeMs;
      this.identity = identity;
      if (!restarted && info.size === this.offset) return undefined;
      const length = info.size - this.offset;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
      chunk = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    this.readBytes += chunk.length;
    this.offset += chunk.length;
    const data = Buffer.concat([this.tail, chunk]);
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
    // 用量（同续接时的起算）：复盘只在第一次读时扫一遍会话根；子 agent 每次重算（只扫它名下的文件夹）；会话自己的
    // 从读进来的各分支算，计过的条目不再计
    if (this.reviews === undefined) {
      try {
        this.reviews = reviewForksCost(sessionsDirOf(this.root), this.sessionId);
      } catch {
        this.reviews = emptyCostTally();
      }
    }
    for (const branch of sessionBranchViews(file)) {
      mergeCostTally(this.own, costTallyOfView(branch, this.counted));
    }
    const agents = this.subagentsCost();
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
    mergeCostTally(cost, this.reviews);
    mergeCostTally(cost, this.own);
    mergeCostTally(cost, agents);
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
