// 决策 485：用户级的会话工作清单（跨工作区、跨重启）：~/.pigeon/state/session-index.json。进过会话面板的会话（在面板里新开的、
// 离开过的）记在这里，从面板去掉才删。每项记会话号、治理根、工作区与加入时刻；会话文件按治理根与会话号现找，已不在的列出时
// 剔除（不报错，也不为此改写文件）。原子写入，读改写在独占锁里做（几个窗口同时改不互相覆盖），锁被占着时稍等重试。
// 文件畸形时按空清单对待（清单是程序状态，下次写入即重写）。
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { sessionIndexPathOf, sessionsDirOf, userStateDir } from "../state/paths.ts";
import { writeFileAtomic } from "./atomic-write.ts";
import { acquireExclusiveLock, ExclusiveLockError } from "./exclusive-lock.ts";
import { locateSessionFile } from "./session-reader.ts";

export const SESSION_INDEX_VERSION = 1;

const EntrySchema = Type.Object({
  sessionId: Type.String(),
  governanceRoot: Type.String(),
  workspaceRoot: Type.String(),
  addedAt: Type.Number(),
});

const SessionIndexFileSchema = Type.Object({
  version: Type.Literal(SESSION_INDEX_VERSION),
  sessions: Type.Array(EntrySchema),
});

export interface SessionIndexEntry {
  sessionId: string;
  // 会话所属项目的治理根（会话记录、设置与记忆所在）
  governanceRoot: string;
  // 会话干活的目录（治理根或独立工作树）
  workspaceRoot: string;
  addedAt: number;
}

export interface ListedSession extends SessionIndexEntry {
  sessionFile: string;
}

// 锁被占着时的重试：每次等这么久，至多这么多次
const LOCK_RETRY_MS = 20;
const LOCK_RETRIES = 50;

function readEntries(file: string): SessionIndexEntry[] {
  if (!existsSync(file)) return [];
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!Value.Check(SessionIndexFileSchema, raw)) return [];
    return (raw as { sessions: SessionIndexEntry[] }).sessions.map((entry) => ({ ...entry }));
  } catch {
    return [];
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// 在独占锁里读改写（锁被别的窗口占着时稍等重试）
function modify(
  homeDir: string,
  change: (entries: SessionIndexEntry[]) => SessionIndexEntry[]
): void {
  const file = sessionIndexPathOf(homeDir);
  mkdirSync(userStateDir(homeDir), { recursive: true });
  let release: (() => void) | undefined;
  for (let attempt = 0; release === undefined; attempt += 1) {
    try {
      release = acquireExclusiveLock(
        `${file}.lock`,
        "session index is being written by another window"
      );
    } catch (error) {
      if (!(error instanceof ExclusiveLockError) || attempt >= LOCK_RETRIES) throw error;
      sleepSync(LOCK_RETRY_MS);
    }
  }
  try {
    const next = change(readEntries(file));
    writeFileAtomic(
      file,
      `${JSON.stringify({ version: SESSION_INDEX_VERSION, sessions: next }, null, 2)}\n`
    );
  } finally {
    release();
  }
}

// 会话文件还在不在（找不到、读不成按不在）
function sessionFileExists(entry: SessionIndexEntry): boolean {
  try {
    const ref = locateSessionFile(sessionsDirOf(entry.governanceRoot), entry.sessionId);
    return ref !== undefined && existsSync(ref.path);
  } catch {
    return false;
  }
}

// 记进清单（已在的更新治理根与工作区，加入时刻不变）；会话文件已不在的别的行顺手去掉
export function addToSessionIndex(
  entry: Omit<SessionIndexEntry, "addedAt"> & { addedAt?: number },
  homeDir: string = homedir()
): void {
  modify(homeDir, (entries) => {
    const existing = entries.find((item) => item.sessionId === entry.sessionId);
    const next: SessionIndexEntry = {
      sessionId: entry.sessionId,
      governanceRoot: path.resolve(entry.governanceRoot),
      workspaceRoot: path.resolve(entry.workspaceRoot),
      addedAt: existing?.addedAt ?? entry.addedAt ?? Date.now(),
    };
    return [
      ...entries.filter((item) => item.sessionId !== entry.sessionId && sessionFileExists(item)),
      next,
    ];
  });
}

// 清单里那条跟着会话的工作目录走（移进工作树、续接回到别处）：只更新已在清单里的，不在的不加；没变即不写
export function updateListedWorkspace(
  sessionId: string,
  workspaceRoot: string,
  homeDir: string = homedir()
): void {
  const next = path.resolve(workspaceRoot);
  const known = readEntries(sessionIndexPathOf(homeDir)).find(
    (item) => item.sessionId === sessionId
  );
  if (known === undefined || known.workspaceRoot === next) return;
  modify(homeDir, (entries) =>
    entries.map((item) => (item.sessionId === sessionId ? { ...item, workspaceRoot: next } : item))
  );
}

// 删出清单（不在也算删掉）
export function removeFromSessionIndex(sessionId: string, homeDir: string = homedir()): void {
  if (!readEntries(sessionIndexPathOf(homeDir)).some((item) => item.sessionId === sessionId)) {
    return;
  }
  modify(homeDir, (entries) => entries.filter((item) => item.sessionId !== sessionId));
}

// 在不在清单里（不看会话文件在不在）
export function sessionIndexed(sessionId: string, homeDir: string = homedir()): boolean {
  return readEntries(sessionIndexPathOf(homeDir)).some((item) => item.sessionId === sessionId);
}

// 清单里会话文件还在的（按加入先后）
export function listSessionIndex(homeDir: string = homedir()): ListedSession[] {
  return listedOf(readEntries(sessionIndexPathOf(homeDir)));
}

// 同上，但清单文件在却读不成或格式不对时抛错（/worktrees clean 据此不删：读不到清单不等于没有面板会话）
export function readableSessionIndex(homeDir: string = homedir()): ListedSession[] {
  const file = sessionIndexPathOf(homeDir);
  if (!existsSync(file)) return [];
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Value.Check(SessionIndexFileSchema, raw)) {
    throw new Error(`unrecognized session index: ${file}`);
  }
  return listedOf(
    (raw as { sessions: SessionIndexEntry[] }).sessions.map((entry) => ({ ...entry }))
  );
}

function listedOf(entries: SessionIndexEntry[]): ListedSession[] {
  return entries
    .sort((left, right) => left.addedAt - right.addedAt)
    .flatMap((entry) => {
      try {
        const ref = locateSessionFile(sessionsDirOf(entry.governanceRoot), entry.sessionId);
        return ref !== undefined && existsSync(ref.path)
          ? [{ ...entry, sessionFile: ref.path }]
          : [];
      } catch {
        return [];
      }
    });
}
