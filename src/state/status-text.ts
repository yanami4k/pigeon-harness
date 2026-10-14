// 开工状态块的标签与识别（决策 363）：开工状态块与状态追加以用户消息存进会话，但不是人输入的话。
// 这类消息带结构化标记（消息对象上的 pigeonStatus: true，随消息原样存进会话记录；交给模型之前去掉），
// 读会话的地方（会话列表的第一句、会话检索、回看、分叉的缺省分叉点）按标记跳过或另行显示，不看正文开头——
// 人输入的话即使以 <pigeon-status> 开头也照常算人说的
export const STATUS_TAG = "pigeon-status";
export const STATUS_UPDATE_TAG = "pigeon-status-update";
export const STATUS_MARKER = "pigeonStatus";

// 是不是 Pigeon 附上的开工状态消息（按标记）
export function isStatusMessage(message: unknown): boolean {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const record = message as Record<string, unknown>;
  return record.role === "user" && record[STATUS_MARKER] === true;
}

// 决策 480、482：agent 之间的传话（派出时交代的任务、消息、交回的结果）以一条带标记的用户消息进模型——标记记谁发给谁、
// 哪一种，随消息原样存进会话记录、交给模型之前去掉；回看、回退与续接列表据此认出不是人说的（旧会话里的程序通知照旧按前缀认）
export const AGENT_MESSAGE_MARKER = "pigeonAgentMessage";

export interface AgentMessageMark {
  from: string;
  to: string;
  kind: "task" | "message" | "result";
}

export function agentMessageMarkOf(message: unknown): AgentMessageMark | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const record = message as Record<string, unknown>;
  const mark = record[AGENT_MESSAGE_MARKER];
  return record.role === "user" && typeof mark === "object" && mark !== null
    ? (mark as AgentMessageMark)
    : undefined;
}

// 交给模型之前去掉标记（各 provider 不认识的字段不往外发）
export function withoutStatusMarker<T extends object>(message: T): T {
  if (!(STATUS_MARKER in message) && !(AGENT_MESSAGE_MARKER in message)) {
    return message;
  }
  const {
    [STATUS_MARKER]: _marker,
    [AGENT_MESSAGE_MARKER]: _agent,
    ...rest
  } = message as Record<string, unknown>;
  return rest as T;
}

// 回看时的一行：哪几节（只对已按标记认出的状态消息用）；节名照消息里的原样显示（决策 428 起为英文）
export function statusSummary(text: string): string {
  const names = [...text.matchAll(/<pigeon-section name="([^"]+)">/g)].map((match) => match[1]);
  const kind = text.startsWith(`<${STATUS_UPDATE_TAG}>`) ? "status update" : "status";
  return `[${kind}] ${names.length > 0 ? names.join(", ") : "(empty)"}`;
}
