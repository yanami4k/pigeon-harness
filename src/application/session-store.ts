// 会话存储接线（决策 176 / 177 / 184）：application 层各写入点经这里写新会话存储。
// - 打开：每个运行面按会话号列目录找到已有的会话文件（续跑、分支、收尾后补写验证），有即打开续写，没有即新建；
//   worker 与分支会话的来历在新建时写进文件头（父会话号与 metadata，177）。
// - 写入点：运行面自己写消息、Run 开始与收尾（pi-runtime/adapter.ts）；验证记录、代码快照、worker 派出与收尾、分叉、
//   授权建立与撤销由各写入点经这里的转换写入。
// - 故障：会话存储的任何失败都是内部故障——向标准错误输出去重告警（同一个运行面里同一类故障只报一次，文案说明后果），
//   不中断运行（178：接受宕机时丢失最后几条记录）；口径与快照器的告警一致。
import { acquireSessionFileLock } from "../persistence/session-lock.ts";
import {
  branchEntries,
  locateSessionFile,
  messageEntryAt,
  readSessionFile,
} from "../persistence/session-reader.ts";
import {
  forkSessionFile,
  openSessionStoreWriter,
  SessionStoreFault,
  type SessionStoreWriter,
} from "../pi-runtime/session-store.ts";
import type { RunId } from "../state/ids.ts";
import {
  type CheckpointMarkState,
  type RewindData,
  type RewindStepData,
  SESSION_ENTRY_VERSION,
  type SessionCustomEntry,
  type SessionEntrySink,
  SessionEntryType,
  type SessionHeaderMetadata,
} from "../state/session-entries.ts";
import type {
  BranchHeaderInput,
  GrantCreatedInput,
  GrantRevokedInput,
  SessionForkedInput,
} from "../state/session-payloads.ts";
import { dedupedWarner, failureDetail, type WarnSink } from "./warnings.ts";

export type { SessionStoreWriter } from "../pi-runtime/session-store.ts";

export type StoreFaultHandler = (fault: SessionStoreFault) => void;

// 新存储故障的告警器：同一类（同一动作）只报一次
export function storeFaultWarner(sink?: WarnSink): StoreFaultHandler {
  const warn = dedupedWarner(sink);
  return (fault) => warn(fault, `session store warning: ${failureDetail(fault)}`);
}

// worker 与分支会话的来历（新建会话文件时写进文件头）
export interface StoreLineage {
  branch?: BranchHeaderInput;
}

function headerOf(lineage: StoreLineage | undefined): {
  parentSessionId?: string;
  metadata?: SessionHeaderMetadata;
} {
  const branch = lineage?.branch;
  if (branch === undefined) {
    return {};
  }
  return {
    parentSessionId: branch.sourceSessionId,
    metadata: { version: SESSION_ENTRY_VERSION, branch: branchMetadata(branch) },
  };
}

function branchMetadata(branch: BranchHeaderInput): NonNullable<SessionHeaderMetadata["branch"]> {
  return {
    sourceSessionId: branch.sourceSessionId,
    forkPoint: branch.forkPoint,
    checkpoint: branch.checkpoint,
    workspace: branch.workspace,
    trigger: branch.trigger,
    startedAt: branch.startedAt,
  };
}

// 打开一个会话的写者：已有会话文件即打开续写，否则以 cwd 新建
export function openSessionStore(input: {
  sessionsDir: string;
  sessionId: string;
  cwd: string;
  lineage?: StoreLineage;
  onFault: StoreFaultHandler;
  // 思考是否持久化（045）：透传给写者
  persistThinking?: boolean;
  // 决策 432：没有会话文件时推迟到第一次真要落盘才建（透传给写者）
  deferCreate?: boolean;
  // 决策 444：新建会话文件之前调用（透传给写者）
  beforeCreate?: () => void;
}): SessionStoreWriter {
  let existingPath: string | undefined;
  try {
    existingPath = locateSessionFile(input.sessionsDir, input.sessionId)?.path;
  } catch (error) {
    input.onFault(new SessionStoreFault("locating the session file", error));
  }
  return openSessionStoreWriter({
    sessionsRoot: input.sessionsDir,
    sessionId: input.sessionId,
    cwd: input.cwd,
    ...(existingPath !== undefined ? { existingPath } : {}),
    ...headerOf(input.lineage),
    lock: acquireSessionFileLock,
    onFault: input.onFault,
    ...(input.persistThinking !== undefined ? { persistThinking: input.persistThinking } : {}),
    ...(input.deferCreate === true ? { deferCreate: true } : {}),
    ...(input.beforeCreate !== undefined ? { beforeCreate: input.beforeCreate } : {}),
  });
}

// ---- 写入输入 → 条目 ----

// 决策 436：发消息时的工作区快照
export function turnSnapshotEntry(
  runId: RunId,
  payload: {
    ref: string;
    commit: string;
    tree: string;
    untrackedSkipped?: Array<{ path: string; bytes: number }>;
    infoAttributes?: string;
  }
): SessionCustomEntry {
  return {
    customType: SessionEntryType.TurnSnapshot,
    data: {
      version: SESSION_ENTRY_VERSION,
      runId,
      ...(payload.infoAttributes !== undefined ? { infoAttributes: payload.infoAttributes } : {}),
      ref: payload.ref,
      commit: payload.commit,
      tree: payload.tree,
      ...(payload.untrackedSkipped !== undefined && payload.untrackedSkipped.length > 0
        ? { untrackedSkipped: payload.untrackedSkipped }
        : {}),
    },
  };
}

// 决策 433–437：会话回退或切换分支
export function rewindEntry(payload: Omit<RewindData, "version">): SessionCustomEntry {
  return {
    customType: SessionEntryType.Rewind,
    data: { version: SESSION_ENTRY_VERSION, ...payload },
  };
}

// 退代码的一个文件的结果
export function rewindStepEntry(payload: Omit<RewindStepData, "version">): SessionCustomEntry {
  return {
    customType: SessionEntryType.RewindStep,
    data: { version: SESSION_ENTRY_VERSION, ...payload },
  };
}

export function checkpointEntry(
  runId: RunId,
  payload: {
    ref: string;
    commit: string;
    tree: string;
    baseCommit?: string;
    toolCallId: string;
    runSeq?: number;
    // 决策 365：拍摄时在跑的后台作业
    backgroundJobs?: string[];
    // 决策 381：过大而没进快照的未跟踪文件
    untrackedSkipped?: Array<{ path: string; bytes: number }>;
  }
): SessionCustomEntry {
  return {
    customType: SessionEntryType.Checkpoint,
    data: {
      version: SESSION_ENTRY_VERSION,
      runId,
      toolCallId: payload.toolCallId,
      ...(payload.runSeq !== undefined ? { runSeq: payload.runSeq } : {}),
      ref: payload.ref,
      commit: payload.commit,
      tree: payload.tree,
      ...(payload.baseCommit !== undefined ? { baseCommit: payload.baseCommit } : {}),
      ...(payload.backgroundJobs !== undefined ? { backgroundJobs: payload.backgroundJobs } : {}),
      ...(payload.untrackedSkipped !== undefined
        ? { untrackedSkipped: payload.untrackedSkipped }
        : {}),
    },
  };
}

// 快照的拍摄标记（决策 350）
export function checkpointMarkEntry(
  runId: RunId,
  payload: { toolCallId: string; runSeq: number; state: CheckpointMarkState; reason?: string }
): SessionCustomEntry {
  return {
    customType: SessionEntryType.CheckpointMark,
    data: {
      version: SESSION_ENTRY_VERSION,
      runId,
      toolCallId: payload.toolCallId,
      runSeq: payload.runSeq,
      state: payload.state,
      ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
    },
  };
}

export function forkEntry(
  input: SessionForkedInput & { runId: RunId },
  forkEntryId: string | undefined
): SessionCustomEntry {
  return {
    customType: SessionEntryType.Fork,
    data: {
      version: SESSION_ENTRY_VERSION,
      runId: input.runId,
      branchSessionId: input.branchSessionId,
      forkPoint: input.forkPoint,
      ...(forkEntryId !== undefined ? { forkEntryId } : {}),
      checkpoint: input.checkpoint,
      trigger: input.trigger,
      forkedAt: input.forkedAt,
    },
  };
}

export function grantCreatedEntry(input: GrantCreatedInput): SessionCustomEntry {
  return {
    customType: SessionEntryType.Grant,
    data: {
      version: SESSION_ENTRY_VERSION,
      event: "created",
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      grantId: input.grantId,
      tool: input.tool,
      ...(input.pathPrefix !== undefined ? { pathPrefix: input.pathPrefix } : {}),
      ...(input.command !== undefined ? { command: input.command } : {}),
      ...(input.shell !== undefined ? { shell: input.shell } : {}),
      ...(input.host !== undefined ? { host: input.host } : {}),
      firstCall: input.firstCall,
      createdAt: input.createdAt,
    },
  };
}

export function grantRevokedEntry(input: GrantRevokedInput): SessionCustomEntry {
  return {
    customType: SessionEntryType.Grant,
    data: {
      version: SESSION_ENTRY_VERSION,
      event: "revoked",
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      grantId: input.grantId,
      revokedAt: input.revokedAt,
    },
  };
}

// ---- 不触达 pi-runtime 的层的写入点：它们只认结构化的落盘口，这里把落盘口接到会话存储 ----

// 授权（approvals/grant-store.ts 的落盘口）
export function grantEventSink(store: SessionEntrySink): {
  appendGrantCreated(input: GrantCreatedInput): void;
  appendGrantRevoked(input: GrantRevokedInput): void;
} {
  return {
    appendGrantCreated: (input) => store.append(grantCreatedEntry(input)),
    appendGrantRevoked: (input) => store.append(grantRevokedEntry(input)),
  };
}

// ---- 分叉 ----

export interface StoreFork {
  // 用 pi 的 fork 为分支会话建文件（分叉点之前的历史复制过去，文件头记来源与分支来历），返回分支文件路径；
  // 失败按内部故障告警并返回 undefined（分叉续跑的初始消息读不到，由调用方决定报错）
  forkBranch(input: {
    branchSessionId: string;
    cwd: string;
    branch: BranchHeaderInput;
  }): Promise<string | undefined>;
  // 放弃（分叉中途失败时）：释放本段打开的来源写者
  release(): Promise<void>;
}

// 分叉第一步：来源会话记下分叉条目。来源写者由本进程运行面持有时传入（先 flush 再读），
// 否则按会话号打开来源文件并持锁到分支文件建好。来源在会话存储里没有文件时告警并返回 undefined
export async function beginStoreFork(input: {
  sessionsDir: string;
  sourceSessionId: string;
  sourceStore?: SessionStoreWriter;
  cwd: string;
  forked: SessionForkedInput & { runId: RunId };
  onFault: StoreFaultHandler;
}): Promise<StoreFork | undefined> {
  let store = input.sourceStore;
  let owned = false;
  if (store === undefined) {
    const located = locateSessionFile(input.sessionsDir, input.sourceSessionId);
    if (located === undefined) {
      input.onFault(
        new SessionStoreFault("fork", new Error("source session has no file in the session store"))
      );
      return undefined;
    }
    store = openSessionStoreWriter({
      sessionsRoot: input.sessionsDir,
      sessionId: input.sourceSessionId,
      cwd: input.cwd,
      existingPath: located.path,
      lock: acquireSessionFileLock,
      onFault: input.onFault,
    });
    owned = true;
  }
  const source = store;
  const release = async () => {
    if (owned) {
      await source.close();
    }
  };
  try {
    await source.flush();
    const sourcePath = await source.filePath();
    if (sourcePath === undefined) {
      await release();
      return undefined;
    }
    const view = readSessionFile(sourcePath);
    const main = view !== undefined ? branchEntries(view, view.lanes.get("main") ?? null) : [];
    const forkEntryId = messageEntryAt(
      main,
      input.forked.forkPoint.runId,
      input.forked.forkPoint.runSeq
    );
    source.append(forkEntry(input.forked, forkEntryId));
    await source.flush();
    return {
      forkBranch: async ({ branchSessionId, cwd, branch }) => {
        try {
          if (forkEntryId === undefined) {
            throw new Error("fork point has no matching message in the source session");
          }
          return await forkSessionFile({
            sessionsRoot: input.sessionsDir,
            source: { sessionId: input.sourceSessionId, path: sourcePath },
            entryId: forkEntryId,
            branchSessionId,
            cwd,
            metadata: { version: SESSION_ENTRY_VERSION, branch: branchMetadata(branch) },
          });
        } catch (error) {
          input.onFault(new SessionStoreFault("fork", error));
          return undefined;
        } finally {
          await release();
        }
      },
      release,
    };
  } catch (error) {
    input.onFault(new SessionStoreFault("fork", error));
    await release();
    return undefined;
  }
}
