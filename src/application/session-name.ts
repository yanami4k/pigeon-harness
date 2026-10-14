// 决策 456：会话名是会话自己的属性——/rename 改了即记进会话文件（上游会话的 name 事实，不属于任何分支，会话回退不影响），
// 续接、/resume 换会话与列表、pigeon session list 与本机会话名录都从这里取（主视图不再有标题栏，决策 460）；没改过名的用缺省名（工作目录名加会话号末 4 位）。
// 文件里记的名字不合名字规则（被手改过）的不认，按没改过名处理。只读，不写任何记录
import { locateSessionFile, readSessionFile } from "../persistence/session-reader.ts";
import { defaultPeerName, validPeerName } from "./peer-messaging.ts";
import { sessionsDirOf } from "./workspace.ts";

// 显示用的会话名：记过的合规名字，否则缺省名
export function sessionDisplayName(
  stored: string | undefined,
  cwd: string,
  sessionId: string
): string {
  return stored !== undefined && validPeerName(stored) ? stored : defaultPeerName(cwd, sessionId);
}

// 会话文件里记的名字（合规的）与文件头的工作目录；没有这个会话文件、或读不了（占用、权限、刚被删）时为 undefined——
// 名字只是显示用，读不到按没改过名处理，不让启动、换会话与看历史因此出错
export function storedSessionName(
  governanceRoot: string,
  sessionId: string
): { name?: string; cwd: string } | undefined {
  try {
    const ref = locateSessionFile(sessionsDirOf(governanceRoot), sessionId);
    if (ref === undefined) return undefined;
    const file = readSessionFile(ref.path);
    if (file === undefined) return undefined;
    const name = file.name;
    return {
      ...(name !== undefined && validPeerName(name) ? { name } : {}),
      cwd: file.header.cwd,
    };
  } catch {
    return undefined;
  }
}

// 按会话号取显示用的名字：记过的名字，否则按文件头的工作目录（没有文件时按 cwd）给缺省名
export function sessionNameOf(governanceRoot: string, sessionId: string, cwd: string): string {
  const stored = storedSessionName(governanceRoot, sessionId);
  return sessionDisplayName(stored?.name, stored?.cwd || cwd, sessionId);
}
