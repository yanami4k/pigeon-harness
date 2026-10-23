// 决策 552：空闲 60 秒超时；内容尚未流出时遇到 error 或空闲自动重发一次；已流出不重试、原样交出错误；
// 调用方 abort 不重试。用假定时器与假 streamFn，不 sleep、不连网。
import assert from "node:assert/strict";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  type AssistantMessageEvent,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { afterEach, test, vi } from "vitest";
import { type RequestRetry, withRequestRetries } from "./request-retry.ts";

afterEach(() => {
  vi.useRealTimers();
});

function message(
  text: string,
  stopReason: "stop" | "error" | "aborted" = "stop"
): AssistantMessage {
  return {
    role: "assistant",
    content: text === "" ? [] : [{ type: "text", text }],
    api: "openai-completions",
    provider: "deepseek",
    model: "m",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 0,
  };
}

type Attempt = "error-before" | "text-then-error" | "ok" | "hang";

// 一次尝试：按剧本产出事件；hang 只产出 start 并等信号（模拟空闲）
function scripted(attempts: Attempt[]): { fn: StreamFn; count: () => number } {
  let calls = 0;
  const fn: StreamFn = (_model, _context, options) => {
    const attempt = attempts[Math.min(calls, attempts.length - 1)] as Attempt;
    calls += 1;
    const stream = createAssistantMessageEventStream();
    if (attempt === "hang") {
      stream.push({ type: "start", partial: message("") });
      options?.signal?.addEventListener(
        "abort",
        () => {
          const aborted = message("");
          aborted.stopReason = "aborted";
          stream.push({ type: "error", reason: "aborted", error: aborted });
        },
        { once: true }
      );
      return stream;
    }
    stream.push({ type: "start", partial: message("") });
    if (attempt === "error-before") {
      const failed = message("");
      failed.stopReason = "error";
      failed.errorMessage = "boom";
      stream.push({ type: "error", reason: "error", error: failed });
      return stream;
    }
    stream.push({ type: "text_start", contentIndex: 0, partial: message("") });
    stream.push({ type: "text_delta", contentIndex: 0, delta: "好", partial: message("好") });
    stream.push({ type: "text_end", contentIndex: 0, content: "好", partial: message("好") });
    if (attempt === "text-then-error") {
      const failed = message("好");
      failed.stopReason = "error";
      failed.errorMessage = "cut";
      stream.push({ type: "error", reason: "error", error: failed });
      return stream;
    }
    stream.push({ type: "done", reason: "stop", message: message("好") });
    return stream;
  };
  return { fn, count: () => calls };
}

async function run(
  attempts: Attempt[],
  idleTimeoutMs = 60_000
): Promise<{ retries: RequestRetry[]; events: AssistantMessageEvent[]; result: AssistantMessage }> {
  const script = scripted(attempts);
  const retries: RequestRetry[] = [];
  const fn = withRequestRetries(script.fn, {
    maxRetries: 0,
    idleTimeoutMs,
    observeFetch: false,
    onRetry: (retry) => retries.push(retry),
  });
  const stream = (await fn(message("") as never, { messages: [] } as never, {})) as ReturnType<
    typeof createAssistantMessageEventStream
  >;
  const events: AssistantMessageEvent[] = [];
  const resultPromise = (async () => {
    for await (const event of stream) events.push(event);
    return await stream.result();
  })();
  return { retries, events, result: await resultPromise };
}

test("MODEL-042 an error before any content is retried once and recorded", async () => {
  const { retries, events, result } = await run(["error-before", "ok"]);
  assert.equal(result.stopReason, "stop");
  assert.equal(retries.length, 1);
  assert.equal(retries[0]?.retry, 1);
  assert.match(retries[0]?.error ?? "", /boom/);
  // 外层只看到一份开始
  assert.equal(events.filter((event) => event.type === "start").length, 1);
  assert.ok(events.some((event) => event.type === "text_delta" && event.delta === "好"));
});

test("MODEL-042 an error after content is not retried and the partial text is kept", async () => {
  const { retries, events, result } = await run(["text-then-error", "ok"]);
  assert.deepEqual(retries, []);
  assert.equal(result.stopReason, "error");
  assert.ok(events.some((event) => event.type === "text_delta" && event.delta === "好"));
});

test("MODEL-042 60 seconds without an event aborts the attempt and retries once", async () => {
  vi.useFakeTimers();
  const script = scripted(["hang", "ok"]);
  const retries: RequestRetry[] = [];
  const fn = withRequestRetries(script.fn, {
    maxRetries: 0,
    idleTimeoutMs: 60_000,
    observeFetch: false,
    onRetry: (retry) => retries.push(retry),
  });
  const stream = (await fn(message("") as never, { messages: [] } as never, {})) as ReturnType<
    typeof createAssistantMessageEventStream
  >;
  const resultPromise = stream.result();
  await vi.advanceTimersByTimeAsync(60_000);
  const result = await resultPromise;
  assert.equal(result.stopReason, "stop");
  assert.equal(script.count(), 2);
  assert.match(retries[0]?.error ?? "", /idle timeout after 60000ms/);
});

test("MODEL-042 a caller abort is not retried", async () => {
  const script = scripted(["hang", "ok"]);
  const retries: RequestRetry[] = [];
  const fn = withRequestRetries(script.fn, {
    maxRetries: 0,
    idleTimeoutMs: 60_000,
    observeFetch: false,
    onRetry: (retry) => retries.push(retry),
  });
  const controller = new AbortController();
  const stream = (await fn(message("") as never, { messages: [] } as never, {
    signal: controller.signal,
  })) as ReturnType<typeof createAssistantMessageEventStream>;
  controller.abort();
  const result = await stream.result();
  assert.equal(result.stopReason, "aborted");
  assert.deepEqual(retries, []);
  assert.equal(script.count(), 1);
});
