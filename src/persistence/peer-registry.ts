// 本机会话名录（决策 450）：每个开了收件口的会话在用户级程序状态目录下的 peers/ 里放一个文件（名字、会话号、所在目录、
// 进程号、收件口地址、鉴权串、审批模式类别、忙闲）。目录与文件只给本操作系统用户（POSIX 上 0700/0600；Windows 上用户目录
// 本身只给本人）；鉴权串只能从这里读到，连收件口时第一行带上。列出时清掉进程已不在的条目。
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { userStateDir } from "../state/paths.ts";
import { writeFileAtomic } from "./atomic-write.ts";

// 审批模式的两类：放权（yolo）与会审批（其余）
export type PeerModeClass = "permissive" | "approving";

export interface PeerRecord {
  version: 1;
  sessionId: string;
  name: string;
  cwd: string;
  pid: number;
  address: string;
  token: string;
  mode: PeerModeClass;
  busy: boolean;
  startedAt: number;
  updatedAt: number;
}

export function peersDirOf(homeDir: string = homedir()): string {
  return join(userStateDir(homeDir), "peers");
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  if (process.platform !== "win32") {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // 改不了权限：照常用（目录在用户目录下）
    }
  }
}

function recordPath(dir: string, sessionId: string): string {
  return join(dir, `${sessionId}.json`);
}

export function newPeerToken(): string {
  return randomBytes(24).toString("hex");
}

export function writePeerRecord(record: PeerRecord, homeDir?: string): void {
  const dir = peersDirOf(homeDir);
  ensurePrivateDir(dir);
  const file = recordPath(dir, record.sessionId);
  writeFileAtomic(file, `${JSON.stringify(record)}\n`);
  if (process.platform !== "win32") {
    try {
      chmodSync(file, 0o600);
    } catch {
      // 同上
    }
  }
}

export function removePeerRecord(sessionId: string, homeDir?: string): void {
  rmSync(recordPath(peersDirOf(homeDir), sessionId), { force: true });
}

function isRecord(value: unknown): value is PeerRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.sessionId === "string" &&
    typeof record.name === "string" &&
    typeof record.cwd === "string" &&
    typeof record.pid === "number" &&
    typeof record.address === "string" &&
    typeof record.token === "string" &&
    (record.mode === "permissive" || record.mode === "approving") &&
    typeof record.busy === "boolean"
  );
}

// 信号 0 只探测不投递：ESRCH = 进程不在；EPERM = 在但无权限（按在算）
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readPeerRecord(sessionId: string, homeDir?: string): PeerRecord | undefined {
  try {
    const value: unknown = JSON.parse(
      readFileSync(recordPath(peersDirOf(homeDir), sessionId), "utf8")
    );
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

// 列出名录：进程已不在、内容坏掉的条目顺手删掉（alive 可注入，测试用）
export function listPeerRecords(
  options: { homeDir?: string; alive?: (pid: number) => boolean } = {}
): PeerRecord[] {
  const dir = peersDirOf(options.homeDir);
  if (!existsSync(dir)) return [];
  const alive = options.alive ?? processAlive;
  const records: PeerRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (!isRecord(value)) {
      rmSync(file, { force: true });
      continue;
    }
    if (!alive(value.pid)) {
      rmSync(file, { force: true });
      continue;
    }
    records.push(value);
  }
  return records.sort((a, b) => a.startedAt - b.startedAt);
}
