// 决策 474：/resume 视图里给一个没在这个窗口开着的会话改名（Ctrl+R）——名字规则同 /rename；会话文件被别的进程持有（会话
// 锁在别处）时不改、说明原因；本进程持有的（当前会话、面板里开着的）不在列表里，碰到也不改（它们用 /rename）。改名即在那个
// 会话文件里记一条会话名（同 /rename：不属于任何分支），写时持有会话锁

import { acquireSessionFileLock, sessionFileHolder } from "../persistence/session-lock.ts";
import { locateSessionFile } from "../persistence/session-reader.ts";
import { openSessionStoreWriter } from "../pi-runtime/session-store.ts";
import { validPeerName } from "./peer-messaging.ts";
import { sessionsDirOf } from "./workspace.ts";

export const INVALID_NAME = "invalid name: use letters, digits, _, - and . (max 40)";

// 改成了返回 undefined，改不成返回给人看的一句原因
export async function renameStoredSession(
  governanceRoot: string,
  sessionId: string,
  name: string
): Promise<string | undefined> {
  if (!validPeerName(name)) return INVALID_NAME;
  const sessionsDir = sessionsDirOf(governanceRoot);
  let path: string | undefined;
  try {
    path = locateSessionFile(sessionsDir, sessionId)?.path;
  } catch (error) {
    return `can't rename: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (path === undefined) return "can't rename: session not found";
  const holder = sessionFileHolder(path);
  if (holder === process.pid)
    return "can't rename: the session is open in this window; use /rename there";
  if (holder !== undefined) {
    return holder === -1
      ? "can't rename: can't tell whether another Pigeon has the session open"
      : `can't rename: the session is open in another Pigeon (pid ${holder})`;
  }
  const faults: string[] = [];
  const writer = openSessionStoreWriter({
    sessionsRoot: sessionsDir,
    sessionId,
    cwd: governanceRoot,
    existingPath: path,
    lock: acquireSessionFileLock,
    onFault: (fault) => faults.push(fault.message),
  });
  writer.setName(name);
  await writer.close();
  return faults.length > 0 ? `can't rename: ${faults[0]}` : undefined;
}
