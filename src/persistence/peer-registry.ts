// 本机会话名录（决策 450）：每个开了收件口的会话在用户级程序状态目录下的 peers/ 里放一个文件（名字、会话号、所在目录、
// 进程号与进程启动时刻、收件口地址、鉴权串、审批模式类别、忙闲）。
// - POSIX：目录须是本人所有、不是符号链接、权限 0700（不符即拒绝使用，收件口不开）；名录文件以 0600 创建。
// - Windows：目录在用户目录下，依赖用户目录本身只给本人（Node 不能给文件或命名管道设访问控制表）。
// 鉴权串只在这里，不上连接：双方用它对随机数做 HMAC 互相证明（application/peer-messaging.ts）。
// 列出时清掉进程已不在的条目；进程号被别的进程复用时同样按不在处理：Linux 上核对进程启动时刻，各平台都看心跳
//（收件口开着时每分钟刷新，5 分钟没刷新即陈旧）。
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
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
  // 进程启动时刻（Linux 上为 /proc/<pid>/stat 的启动时钟数；取不到即不记）：防进程号复用
  procStart?: number;
  address: string;
  token: string;
  mode: PeerModeClass;
  busy: boolean;
  startedAt: number;
  updatedAt: number;
}

export class PeerRegistryError extends Error {}

// 会话号的样子（sess_ 加 26 位 ULID）：名录文件名与来源字段都按它校验，不让 ../ 之类混进路径
export const PEER_SESSION_ID = /^sess_[0-9A-HJKMNP-TV-Z]{26}$/;

export function peersDirOf(homeDir: string = homedir()): string {
  return join(userStateDir(homeDir), "peers");
}

// 名录目录：建出来（0700）；POSIX 上核对属主、非链接与权限，不符即抛错
export function ensurePeersDir(homeDir?: string): string {
  const dir = peersDirOf(homeDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return dir;
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new PeerRegistryError(`${dir} is not a regular directory`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new PeerRegistryError(`${dir} is not owned by the current user`);
  }
  if ((stat.mode & 0o077) !== 0) {
    chmodSync(dir, 0o700);
    if ((lstatSync(dir).mode & 0o077) !== 0) {
      throw new PeerRegistryError(`can't restrict ${dir} permissions to 0700`);
    }
  }
  return dir;
}

function recordPath(dir: string, sessionId: string): string {
  if (!PEER_SESSION_ID.test(sessionId)) {
    throw new PeerRegistryError(`not a session ID: ${JSON.stringify(sessionId)}`);
  }
  return join(dir, `${sessionId}.json`);
}

export function newPeerToken(): string {
  return randomBytes(24).toString("hex");
}

// 进程启动时刻（Linux）：/proc/<pid>/stat 第 22 个字段；别的平台与取不到时为 undefined
export function processStartOf(pid: number): number | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // 第 2 个字段（进程名）可能含空格与括号：从最后一个右括号之后数
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const value = Number(fields[19]);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function writePeerRecord(record: PeerRecord, homeDir?: string): void {
  const dir = ensurePeersDir(homeDir);
  writeFileAtomic(
    recordPath(dir, record.sessionId),
    `${JSON.stringify(record)}\n`,
    undefined,
    0o600
  );
}

export function removePeerRecord(sessionId: string, homeDir?: string): void {
  if (!PEER_SESSION_ID.test(sessionId)) return;
  rmSync(recordPath(peersDirOf(homeDir), sessionId), { force: true });
}

function isRecord(value: unknown): value is PeerRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.sessionId === "string" &&
    PEER_SESSION_ID.test(record.sessionId) &&
    typeof record.name === "string" &&
    typeof record.cwd === "string" &&
    typeof record.pid === "number" &&
    (record.procStart === undefined || typeof record.procStart === "number") &&
    typeof record.address === "string" &&
    typeof record.token === "string" &&
    (record.mode === "permissive" || record.mode === "approving") &&
    typeof record.busy === "boolean" &&
    typeof record.updatedAt === "number"
  );
}

// 收件口开着时每分钟刷新一次名录条目（心跳）；超过这么久没刷新的条目算陈旧（进程号可能已被复用）
export const PEER_HEARTBEAT_MS = 60_000;
export const PEER_STALE_MS = 5 * 60_000;

// 信号 0 只探测不投递：ESRCH = 进程不在；EPERM = 在（Windows 上非提权进程探测同一用户的提权进程也是 EPERM）
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// 条目还算数：进程号在、（记了启动时刻时）启动时刻对得上、心跳没过期。保密不靠这里，靠收发两边的双向证明
function recordAlive(record: PeerRecord, alive: (pid: number) => boolean, now: number): boolean {
  if (!alive(record.pid)) return false;
  if (now - record.updatedAt > PEER_STALE_MS) return false;
  if (record.procStart === undefined) return true;
  const start = processStartOf(record.pid);
  return start === undefined || start === record.procStart;
}

export function readPeerRecord(sessionId: string, homeDir?: string): PeerRecord | undefined {
  if (!PEER_SESSION_ID.test(sessionId)) return undefined;
  try {
    const value: unknown = JSON.parse(
      readFileSync(recordPath(peersDirOf(homeDir), sessionId), "utf8")
    );
    return isRecord(value) && value.sessionId === sessionId ? value : undefined;
  } catch {
    return undefined;
  }
}

// 列出名录：进程已不在（或进程号已被复用）的条目顺手删掉；读不懂的条目跳过不删（可能是新版本写的）。alive 可注入，测试用
export function listPeerRecords(
  options: { homeDir?: string; alive?: (pid: number) => boolean; now?: number } = {}
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
    if (!isRecord(value) || name !== `${value.sessionId}.json`) continue;
    if (!recordAlive(value, alive, options.now ?? Date.now())) {
      rmSync(file, { force: true });
      continue;
    }
    records.push(value);
  }
  return records.sort((a, b) => a.startedAt - b.startedAt);
}
