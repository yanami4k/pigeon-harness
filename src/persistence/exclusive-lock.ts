// 独占锁（M8 收口补遗）：一把锁同一时刻只许一个持有者，**不可重入**。现有使用方是固化放权配置的
// 读改写（persistence/grants-config.ts）、配置确认记录的读改写（persistence/config-trust-store.ts）、
// 学到的记忆的写入（memory/learned-store.ts，取不到时轮询等待）；
// 迁移命令（application/migrate-config.ts）只借 lockHeldByLiveProcess 判断锁的持有进程是否仍在。
//
// 与会话打开锁（session-lock.ts，决策 040）的区别正在这里：会话锁按进程内计数重入，因为同一个
// 进程里可以有多处打开同一个会话文件；而这把锁要挡的恰恰是同一个进程里的两件事
// 同时改同一份文件，会话锁的同进程重入在这里正好是漏洞（最初为挡两次候选验证并发而设，候选链已随
// 决策 137 退役）。故实现上不维护进程内计数：靠锁文件本身的独占建立，同进程再取一样被拒。
//
// 残留处理与会话锁同口径：锁文件记持有进程 pid，持有者仍存活则拒绝；已死或内容畸形即接管。
// Linux 上另记开机编号（/proc/sys/kernel/random/boot_id）与持有进程的启动时刻（/proc/<pid>/stat 第 22 列）：
// 整机重启或进程被强杀后 pid 可能被无关进程占用，两者任一与现在不符即按残留接管，不会永远报"持有进程仍在"。
// 取不到这两项的系统（或旧锁文件里没有它们）退回只看 pid，局限同前：pid 被复用时误判为存活，报错给出锁文件路径。
import { randomBytes } from "node:crypto";
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

export class ExclusiveLockError extends Error {}

// 读锁文件的注入点：Windows 上另一进程正在替换/删除锁文件时，readFileSync 会得到 EPERM（不是 ENOENT），
// 这里做有界重试；测试注入假的读与等待，不用真 sleep
export interface LockReadIo {
  read(path: string): string;
  wait(ms: number): void;
}

// 有界重试：三次，20/35/50 毫秒（不随机，避免测试不确定）；仍失败才抛原错误
const LOCK_READ_RETRY_MS = [20, 35, 50] as const;

const defaultLockReadIo: LockReadIo = {
  read: (path) => readFileSync(path, "utf8"),
  wait: (ms) => {
    // 同步接口里的有界等待；只用在上面这三次重试之间，不改变锁语义
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  },
};

interface LockHolder {
  pid: number;
  acquiredAt: number;
  bootId?: string;
  startTime?: string;
}

// 本次开机的编号；取不到（非 Linux）为 undefined
export function currentBootId(): string | undefined {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

// 进程的启动时刻（开机以来的时钟滴答数，/proc/<pid>/stat 第 22 列）；取不到为 undefined
export function processStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // 第 2 列是带括号的进程名，可能含空格：从最后一个右括号之后数起，其后第 1 个字段是第 3 列
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[22 - 3];
  } catch {
    return undefined;
  }
}

// 锁里记的持有者是否还是那个进程：pid 存活，且开机编号与启动时刻（两边都有时）一致
function holderAlive(holder: LockHolder): boolean {
  if (!isProcessAlive(holder.pid)) return false;
  const bootId = currentBootId();
  if (holder.bootId !== undefined && bootId !== undefined && holder.bootId !== bootId) return false;
  const startTime = processStartTime(holder.pid);
  if (holder.startTime !== undefined && startTime !== undefined && holder.startTime !== startTime)
    return false;
  return true;
}

function readHolder(
  path: string,
  io: LockReadIo = defaultLockReadIo
): LockHolder | "missing" | "malformed" {
  let raw: string | undefined;
  for (let attempt = 0; attempt <= LOCK_READ_RETRY_MS.length; attempt += 1) {
    try {
      raw = io.read(path);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return "missing";
      }
      // EPERM 不当作“没锁”：重试几次再抛；其余错误照旧直接上抛
      if (
        (error as NodeJS.ErrnoException).code !== "EPERM" ||
        attempt === LOCK_READ_RETRY_MS.length
      ) {
        throw error;
      }
      io.wait(LOCK_READ_RETRY_MS[attempt] as number);
    }
  }
  if (raw === undefined) {
    throw new Error(`could not read lock file ${path}`);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as LockHolder).pid === "number"
    ) {
      return parsed as LockHolder;
    }
  } catch {
    // 落到畸形
  }
  return "malformed";
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// 锁文件是否正被一个仍存活的进程持有（迁移命令据此拒绝挪动正在使用的状态；会话锁与本锁的持有者记录同形）
export function lockHeldByLiveProcess(
  path: string,
  io: LockReadIo = defaultLockReadIo
): { pid: number } | undefined {
  const holder = readHolder(path, io);
  if (holder === "missing" || holder === "malformed") return undefined;
  return holderAlive(holder) ? { pid: holder.pid } : undefined;
}

// 先写临时文件再硬链接成锁文件（与会话锁同一手法）：锁文件一出现就带着完整的持有者记录。
// 不能分"独占创建空文件、再写内容"两步——那中间的 0 字节窗口会被另一个进程读成损坏锁并直接接管，
// 结果两个进程同时认为自己持锁，而独占锁挡的恰恰就是这个
function tryCreate(path: string, holder: LockHolder): boolean {
  const tempPath = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tempPath, "wx");
  try {
    writeSync(fd, `${JSON.stringify(holder)}\n`);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tempPath, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  } finally {
    unlinkSync(tempPath);
  }
}

// 取锁；返回幂等的释放函数。detail 是给人看的一句话，拒绝时连同锁文件路径一起报出
export function acquireExclusiveLock(
  path: string,
  detail: string,
  io: LockReadIo = defaultLockReadIo
): () => void {
  mkdirSync(dirname(path), { recursive: true });
  const bootId = currentBootId();
  const startTime = processStartTime(process.pid);
  const holder: LockHolder = {
    pid: process.pid,
    acquiredAt: Date.now(),
    ...(bootId !== undefined ? { bootId } : {}),
    ...(startTime !== undefined ? { startTime } : {}),
  };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (tryCreate(path, holder)) {
      return releaser(path, holder.acquiredAt, io);
    }
    const current = readHolder(path, io);
    if (current === "missing") {
      continue;
    }
    if (current !== "malformed" && holderAlive(current)) {
      throw new ExclusiveLockError(`${detail} (held by pid ${current.pid}, lock file ${path})`);
    }
    // 残留锁：持有进程已死、已不是记下的那个进程（重启或 pid 被复用），或内容畸形
    rmSync(path, { force: true });
  }
  throw new ExclusiveLockError(`couldn't acquire lock ${path} after several retries`);
}

// 只删自己那一把：被别人接管之后重复释放不误删
function releaser(path: string, acquiredAt: number, io: LockReadIo): () => void {
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const current = readHolder(path, io);
    if (
      current !== "missing" &&
      current !== "malformed" &&
      current.pid === process.pid &&
      current.acquiredAt === acquiredAt
    ) {
      rmSync(path, { force: true });
    }
  };
}
