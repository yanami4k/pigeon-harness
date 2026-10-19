// 决策 501：别的进程开着的会话在本进程里只看它的会话记录——状态栏的模式、上下文与用量都从记录里取，内容跟着记录的追加更新
// （本进程按文件的大小与修改时刻判断记录有没有变）
import { statSync } from "node:fs";
import { readSessionView } from "../persistence/session-catalog.ts";
import { locateSessionFile } from "../persistence/session-reader.ts";
import { loadStoreSessionFile } from "../persistence/session-view.ts";
import { contextTokens } from "../pi-runtime/compaction.ts";
import { sessionContextMessages } from "../pi-runtime/session-store.ts";
import { sessionsDirOf } from "../state/paths.ts";
import { accumulatedSessionCost, type CostTally, emptyCostTally } from "./session-cost.ts";

export interface RecordedStatus {
  // 最近一次运行开始时的审批模式，其后又切换过的取最后一次切换
  mode?: "prompt" | "yolo";
  // 同运行面的口径：最后一条正常助手回复的用量加其后消息的估算；窗口取最近一次运行的压缩配置（没有即不写）
  context?: { tokens: number; contextWindow: number };
  // 会话自己连同它的子 agent 累计的用量（同续接时的起算）
  cost: CostTally;
}

// 会话记录文件的位置（root 为项目根）；没有为 undefined
export function recordedSessionPath(root: string, sessionId: string): string | undefined {
  return locateSessionFile(sessionsDirOf(root), sessionId)?.path;
}

// 记录文件此刻的样子（大小与修改时刻）；读不到为 undefined
export function recordStamp(path: string): string | undefined {
  try {
    const stat = statSync(path);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return undefined;
  }
}

export function recordedSessionStatus(root: string, sessionId: string): RecordedStatus {
  const sessionsRoot = sessionsDirOf(root);
  let cost: CostTally;
  try {
    cost = accumulatedSessionCost(sessionsRoot, sessionId);
  } catch {
    cost = emptyCostTally();
  }
  const path = locateSessionFile(sessionsRoot, sessionId)?.path;
  const view = path !== undefined ? readSessionView({ path }) : undefined;
  const loaded = path !== undefined ? loadStoreSessionFile(path) : undefined;
  if (view === undefined || loaded === undefined) return { cost };
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
  return {
    ...(mode !== undefined ? { mode } : {}),
    ...(contextWindow !== undefined
      ? {
          context: {
            tokens: contextTokens(sessionContextMessages(loaded.main)),
            contextWindow,
          },
        }
      : {}),
    cost,
  };
}
