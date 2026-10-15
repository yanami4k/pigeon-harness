// 决策 485：会话文件是不是正被别的 Pigeon 进程开着（只查会话锁、不取）；工作清单据此标 open elsewhere、不在本进程开它。
// 锁读不成按开着（同改名的口径）
import { sessionFileHolder } from "../persistence/session-lock.ts";

export function sessionOpenElsewhere(sessionFile: string): boolean {
  const holder = sessionFileHolder(sessionFile);
  return holder !== undefined && holder !== process.pid;
}
