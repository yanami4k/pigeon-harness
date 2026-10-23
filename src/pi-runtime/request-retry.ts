// 模型请求的失败重试（决策 420）：在装配层包一层 streamFn，每次调用把重试次数作为 maxRetries 交给 pi-ai。重试本身由 pi-ai 的
// retryProviderRequest 做（与官方 SDK 一致：连接失败、408、409、429、5xx 重试，遵从 Retry-After、最长 60 秒，否则指数退避；
// 400 等请求本身有错的不重试），只覆盖开始收回复之前的失败，回复流中途断开不在此列。
// 记录：pi-ai 的重试在其内部，onResponse 只在最终成功时回调一次、onPayload 只在第一次发送前回调一次，都看不出重试。Pigeon 经调用
// 选项里公开的 fetch 接管每一次 HTTP 尝试：一次尝试失败（非 2xx 响应或连接失败）之后又发起了下一次，即为一次重试，记下第几次、
// 上一次的状态码（连接失败记错误文字）与两次之间的实测等待。pi-ai 0.84.4 的 Google 两条线路拒收自带的 fetch，Bedrock 不走 fetch，
// 故只在接入模块声明的线路（modelInfo.api）是下面几条时才接管；其余线路照样传重试次数，只是不记。不改 pi-ai 的内部。
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { RunId } from "../state/ids.ts";
import {
  SESSION_ENTRY_VERSION,
  type SessionCustomEntry,
  SessionEntryType,
} from "../state/session-entries.ts";

// pi-ai 0.84.4 里用 retryProviderRequest 重试、并经调用选项的 fetch 发聊天请求的线路（SDK 自身的重试关着，一次尝试一次 fetch）
const FETCH_OBSERVABLE_APIS: ReadonlySet<string> = new Set([
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
]);

export function retriesObservable(api: string | undefined): boolean {
  return api !== undefined && FETCH_OBSERVABLE_APIS.has(api);
}

// 一次重试：retry 为这次模型请求里的第几次重试（1 起）；上一次尝试的 HTTP 状态码，连接失败时没有、改记错误文字；
// waitMs 为上一次失败到这次重发之间的实测毫秒数
export interface RequestRetry {
  retry: number;
  status?: number;
  error?: string;
  waitMs: number;
}

const ERROR_TEXT_CHARS = 200;

// 会话记录里的一条（Run 之外的请求不带 runId）
export function requestRetryEntry(
  retry: RequestRetry,
  runId: RunId | undefined
): SessionCustomEntry {
  return {
    customType: SessionEntryType.RequestRetry,
    data: {
      version: SESSION_ENTRY_VERSION,
      ...(runId !== undefined ? { runId } : {}),
      ...retry,
      retriedAt: Date.now(),
    },
  };
}

export function withRequestRetries(
  streamFn: StreamFn,
  options: {
    maxRetries: number;
    onRetry?: (retry: RequestRetry) => void;
    idleTimeoutMs?: number;
    // 决策 420：是否经 fetch 观察每次尝试（Google 两条线路拒收自带的 fetch）
    observeFetch?: boolean;
  }
): StreamFn {
  const onRetry = options.onRetry;
  const observe = onRetry !== undefined && options.observeFetch !== false;
  const base: StreamFn = (model, context, callOptions) =>
    streamFn(model, context, {
      ...callOptions,
      maxRetries: options.maxRetries,
      ...(observe && onRetry !== undefined
        ? { fetch: observeAttempts(callOptions?.fetch ?? globalThis.fetch, onRetry) }
        : {}),
    });
  // 决策 552：空闲超时与“内容未流出时重试一次”；没配空闲时限时原样直通
  return options.idleTimeoutMs !== undefined
    ? withIdleRetry(base, { idleTimeoutMs: options.idleTimeoutMs, ...(onRetry ? { onRetry } : {}) })
    : base;
}

// 决策 552：空闲超时与“内容尚未流出时重试一次”。包装在 streamFn 外层：
// - 每次尝试一个 AbortController 与一个空闲定时器（每收到一个事件就重置，超时即 abort 这一次）；
// - 尚未收到 text/thinking/toolcall 内容时遇到 error 或空闲超时，自动重发一次（记录一条 pigeon.request-retry）；
// - 已有内容时原样交出 error（已收到的内容保留在 partial 消息里，由上层按失败收尾）；
// - 调用方已 abort 不重试。重试前丢掉上一次缓冲的 start 事件，外层只看到一份开始。
interface IdleRetryOptions {
  idleTimeoutMs: number;
  onRetry?: (retry: RequestRetry) => void;
}

function withIdleRetry(streamFn: StreamFn, options: IdleRetryOptions): StreamFn {
  return (model, context, callOptions) => {
    const caller = callOptions?.signal;
    const initial = new AbortController();
    if (caller?.aborted === true) initial.abort(caller.reason);
    const onCallerAbort = () => initial.abort(caller?.reason);
    caller?.addEventListener("abort", onCallerAbort, { once: true });
    // 流还没出来就失败的（返回 Promise）：交给 pi-ai 自己的重试与上层错误处理，本层只转交
    const first = streamFn(model, context, { ...callOptions, signal: initial.signal });
    if (first instanceof Promise) {
      void first.then(
        () => caller?.removeEventListener("abort", onCallerAbort),
        () => caller?.removeEventListener("abort", onCallerAbort)
      );
      return first;
    }
    const out = createAssistantMessageEventStream();
    caller?.removeEventListener("abort", onCallerAbort);
    let settled = false;
    let attemptCount = 0;
    let sawContent = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined = initial;
    let buffered: AssistantMessageEvent[] = [];

    const clearTimer = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    const forwardAbort = () => controller?.abort(caller?.reason);
    caller?.addEventListener("abort", forwardAbort, { once: true });
    const cleanup = () => {
      clearTimer();
      caller?.removeEventListener("abort", forwardAbort);
    };
    const flush = () => {
      for (const event of buffered.splice(0)) out.push(event);
    };
    const finish = (event: AssistantMessageEvent | undefined, message?: AssistantMessage) => {
      if (settled) return;
      settled = true;
      cleanup();
      flush();
      if (event !== undefined) out.push(event);
      out.end(message);
    };
    // 没有可交出的最终消息时（流内抛错、流结束却没有终止事件）：造一条错误回复，不把错误吞掉
    const failedMessage = (text: string): AssistantMessage =>
      ({
        role: "assistant",
        content: [],
        api: (model as { api?: string }).api ?? "unknown",
        provider: (model as { provider?: string }).provider ?? "unknown",
        model: (model as { id?: string }).id ?? "unknown",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        errorMessage: text.slice(0, ERROR_TEXT_CHARS),
        timestamp: Date.now(),
      }) as unknown as AssistantMessage;
    const canRetry = () => !sawContent && attemptCount === 1 && caller?.aborted !== true;
    const retry = (reason: string, stream?: { result(): Promise<AssistantMessage> }) => {
      clearTimer();
      buffered = [];
      // 放弃这一次的最终结果：不挂上 rejection 处理会变成未处理拒绝
      void stream?.result().catch(() => {});
      try {
        options.onRetry?.({ retry: 1, error: reason, waitMs: 0 });
      } catch {
        // 记录失败不挡请求
      }
      start();
    };
    const errorText = (event: Extract<AssistantMessageEvent, { type: "error" }>): string =>
      (event.error.errorMessage ?? "stream error").slice(0, ERROR_TEXT_CHARS);

    const start = (first?: AssistantMessageEventStream): void => {
      attemptCount += 1;
      // 第一次尝试的流是用入口那个 controller 的信号建的，沿用同一个；重试才新建
      const current = first !== undefined ? initial : new AbortController();
      controller = current;
      if (caller?.aborted === true) current.abort(caller.reason);
      let idle = false;
      const arm = () => {
        clearTimer();
        timer = setTimeout(() => {
          idle = true;
          current.abort(new Error("idle timeout"));
        }, options.idleTimeoutMs);
      };
      const inner = first ?? streamFn(model, context, { ...callOptions, signal: current.signal });
      arm();
      void (async () => {
        try {
          const stream = inner instanceof Promise ? await inner : inner;
          for await (const event of stream) {
            if (settled) return;
            arm();
            if (event.type === "error") {
              const text = errorText(event);
              // 服务方按请求本身拒绝（错误文本以 3xx/4xx/5xx 开头）不在这里再重发：pi-ai 已经按策略试过，
              // 请求本身有错重发也没用（如图片被拒要让适配层换占位而非重试原请求）
              const requestError = /^\s*[3-5]\d\d\b/.test(text);
              if (canRetry() && (idle || !requestError)) {
                retry(idle ? `idle timeout after ${options.idleTimeoutMs}ms` : text, stream);
                return;
              }
              finish(event, event.error);
              return;
            }
            if (event.type === "done") {
              flush();
              finish(event, event.message);
              return;
            }
            const content =
              event.type === "text_start" ||
              event.type === "text_delta" ||
              event.type === "thinking_start" ||
              event.type === "thinking_delta" ||
              event.type === "toolcall_start";
            if (content) sawContent = true;
            if (sawContent) {
              flush();
              out.push(event);
            } else {
              buffered.push(event);
            }
          }
          if (settled) return;
          // 流结束了却没有终止事件：尽量用内层的最终结果按错误收尾
          let message: AssistantMessage | undefined;
          try {
            message = await stream.result();
          } catch {
            message = undefined;
          }
          if (message !== undefined) {
            finish({ type: "error", reason: "error", error: message }, message);
          } else {
            const failed = failedMessage("stream ended without a final message");
            finish({ type: "error", reason: "error", error: failed }, failed);
          }
        } catch (error) {
          if (settled) return;
          const text = error instanceof Error ? error.message : String(error);
          if (canRetry()) {
            retry(text.slice(0, ERROR_TEXT_CHARS));
            return;
          }
          const failed = failedMessage(text);
          finish({ type: "error", reason: "error", error: failed }, failed);
        }
      })();
    };

    start(first);
    return out;
  };
}

// 每次模型请求一个：数尝试，失败之后又来一次尝试即记一次重试
function observeAttempts(base: typeof fetch, onRetry: (retry: RequestRetry) => void): typeof fetch {
  let retries = 0;
  let failed: { status?: number; error?: string; at: number } | undefined;
  return async (input, init) => {
    if (failed !== undefined) {
      retries += 1;
      const { at, ...outcome } = failed;
      failed = undefined;
      try {
        onRetry({ retry: retries, ...outcome, waitMs: Math.max(0, Date.now() - at) });
      } catch {
        // 记录出错不挡请求
      }
    }
    try {
      const response = await base(input, init);
      if (!response.ok) {
        failed = { status: response.status, at: Date.now() };
      }
      return response;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      failed = { error: text.slice(0, ERROR_TEXT_CHARS), at: Date.now() };
      throw error;
    }
  };
}
