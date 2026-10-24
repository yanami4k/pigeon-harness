// 决策 564：凭据变化不得改变已有会话的型号——/login 只增凭据、不重建、不产生档位说明；
// 只有占位运行面才按新凭据解析并重建，重建必须带显式目标型号（决策 557）。
// 这里用记账用的假 host 测决策与文案；真实运行面的换手与 RUN-START 由 main-reload 的
// switchedReloadContext 用例覆盖。
import assert from "node:assert/strict";
import { test } from "vitest";
import type { StreamFn } from "../pi-runtime/index.ts";
import {
  afterCredentialStored,
  type CredentialAccess,
  type CredentialChangeHost,
  type CredentialModel,
  type CredentialResolution,
} from "./main.ts";

const stream = (() => {
  throw new Error("测试里不会真的发请求");
}) as unknown as StreamFn;

function fakeHost(options: {
  current: CredentialModel;
  resolution?: CredentialResolution;
  resolveCalls?: string[];
}) {
  const applied: CredentialAccess[] = [];
  const targets: Array<{ provider: string; model: string; streamFn: StreamFn } | undefined> = [];
  let unavailable = 0;
  const host: CredentialChangeHost = {
    currentModel: () => options.current,
    resolve: async () => {
      options.resolveCalls?.push("resolve");
      if (options.resolution === undefined) throw new Error("不该重新解析");
      return options.resolution;
    },
    apply: (access) => {
      applied.push(access);
    },
    markUnavailable: () => {
      unavailable += 1;
    },
    rebuild: async (target) => {
      targets.push(target);
    },
  };
  return {
    host,
    applied,
    targets,
    unavailable: () => unavailable,
  };
}

test("MODEL-034 已有可用型号时 /login 只增凭据：不解析、不重建、不换型号", async () => {
  const calls: string[] = [];
  const { host, applied, targets } = fakeHost({
    current: { provider: "deepseek", id: "deepseek-v4-flash" },
    resolveCalls: calls,
  });
  const line = await afterCredentialStored(host, "kimi-coding");
  assert.equal(line, "logged in kimi-coding; model unchanged (deepseek/deepseek-v4-flash)");
  assert.deepEqual(calls, [], "没有重新解析凭据");
  assert.deepEqual(applied, [], "没有换接入");
  assert.deepEqual(targets, [], "没有重建（因此也不会触发档位回落说明）");
});

test("MODEL-034 占位时 /login 解析并重建，显式带上选中型号（MODEL-043、决策 557）", async () => {
  const { host, applied, targets } = fakeHost({
    current: { provider: "custom", id: "custom" },
    resolution: {
      kind: "ok",
      streamFn: stream,
      provider: "kimi-coding",
      modelId: "kimi-for-coding",
    },
  });
  const line = await afterCredentialStored(host, "kimi-coding");
  assert.equal(line, "logged in kimi-coding; this session now uses kimi-coding/kimi-for-coding");
  assert.equal(applied.length, 1, "换上新接入与目标");
  assert.deepEqual(targets, [
    { provider: "kimi-coding", model: "kimi-for-coding", streamFn: stream },
  ]);
});

test("MODEL-034 占位时凭据仍解析不出型号：禁止发消息，不重建", async () => {
  const { host, applied, targets, unavailable } = fakeHost({
    current: { provider: "custom", id: "custom" },
    resolution: {
      kind: "failed",
      text: 'no model selected for provider "kimi-coding"; pass --model.',
    },
  });
  const line = await afterCredentialStored(host, "kimi-coding");
  assert.match(line, /saved, but the model still can't be chosen/);
  assert.equal(unavailable(), 1);
  assert.deepEqual(applied, []);
  assert.deepEqual(targets, [], "解析失败不重建");
});

test("MODEL-034 占位时解析结果仍是占位：不重建", async () => {
  const { host, applied, targets } = fakeHost({
    current: { provider: "custom", id: "custom" },
    resolution: {
      kind: "ok",
      streamFn: stream,
      provider: "custom",
      modelId: "custom",
      needsLogin: true,
    },
  });
  const line = await afterCredentialStored(host, "kimi-coding");
  assert.equal(line, "no credentials yet: run /login");
  assert.equal(applied.length, 1);
  assert.deepEqual(targets, []);
});
