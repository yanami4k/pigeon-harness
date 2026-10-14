// 进程内 agent 之间的消息（决策 457；由 450 的会话间通信留下送达的规矩）：单条字数上限、按发送方与收件方限流、短时间内
// 相同的消息只收一次、收件方待读的通知满了即拒收；递给模型时前后各一行带随机串的边界标记，正文里看着像边界标记的行一律改写。
// 跨进程的收件口、名录与鉴权已删除，这里只管进程内的一来一回。
import { randomBytes } from "node:crypto";

// 单条消息的字数上限
export const MAX_MESSAGE_CHARS = 100_000;
// 同一发送方给同一收件方：窗口内最多几条
export const RATE_LIMIT_COUNT = 10;
export const RATE_LIMIT_WINDOW_MS = 60_000;
// 同一发送方给同一收件方的相同消息在这个时长内只收一次
export const DEDUPE_WINDOW_MS = 60_000;
// 收件方待模型读的通知上限（超过即拒收）
export const MAX_QUEUED = 50;

export type MailVerdict =
  | "ok"
  | "empty"
  | "too-large"
  | "duplicate"
  | "rate-limited"
  | "queue-full";

// 送达前的检查：按发送方与收件方（名字或会话号，调用方给稳定的键）记限流与去重
export class MailGate {
  readonly #now: () => number;
  readonly #recent = new Map<string, number[]>();
  readonly #seen = new Map<string, number>();

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  // pending 为收件方当下待读的通知条数；返回 ok 即可送达（同时记下限流与去重）
  admit(from: string, to: string, text: string, pending: number): MailVerdict {
    if (text.trim() === "") return "empty";
    if (text.length > MAX_MESSAGE_CHARS) return "too-large";
    const now = this.#now();
    for (const [key, at] of this.#seen) {
      if (now - at >= DEDUPE_WINDOW_MS) this.#seen.delete(key);
    }
    const pair = `${from}\0${to}`;
    const key = `${pair}\0${text}`;
    if (this.#seen.has(key)) return "duplicate";
    // 待读满在记限流与去重之前判：被拒的重试不会被当成重复
    if (pending >= MAX_QUEUED) return "queue-full";
    const recent = (this.#recent.get(pair) ?? []).filter((at) => now - at < RATE_LIMIT_WINDOW_MS);
    if (recent.length >= RATE_LIMIT_COUNT) {
      this.#recent.set(pair, recent);
      return "rate-limited";
    }
    recent.push(now);
    this.#recent.set(pair, recent);
    this.#seen.set(key, now);
    return "ok";
  }
}

export const MESSAGE_BOUNDARY = "AGENT-MESSAGE";

// 正文里看着像边界标记的行一律前加 "(escaped) "：先做 NFKC 归一并去掉零宽字符再比（全角、零宽夹杂、各式连字符的写法同样
// 认得）；真边界带 16 位随机串，本就猜不中，这一步是兜底
export function neutralizeMarkers(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const probe = line.normalize("NFKC").replace(/[​-‏⁠-⁩﻿­]/g, "");
      return /<\s*<\s*<?\s*(BEGIN|END)\s*AGENT\s*[-‐-―−]?\s*MESSAGE/i.test(probe)
        ? `(escaped) ${line}`
        : line;
    })
    .join("\n");
}

export function randomBoundary(): string {
  return randomBytes(8).toString("hex");
}

// 把正文放进一对边界标记之间：head 是边界之外的说明（来源与信任，调用方给），tail 可选（比如怎么回话）
export function wrapBetweenMarkers(
  head: string,
  text: string,
  boundary: string = randomBoundary(),
  tail?: string
): string {
  return [
    head,
    `<<<BEGIN ${MESSAGE_BOUNDARY} ${boundary}>>>`,
    neutralizeMarkers(text),
    `<<<END ${MESSAGE_BOUNDARY} ${boundary}>>>`,
    ...(tail !== undefined ? [tail] : []),
  ].join("\n");
}
