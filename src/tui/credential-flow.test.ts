// 决策 564、566：凭据变化不得改变已有会话的型号——当前型号的服务商还有凭据时只增删凭据、不重建；
// 没了才按剩余凭据解析一次，并为选中的目标型号显式重建（不为旧的、已无凭据的型号解析或重建）；
// 解析不到可用型号时转占位。这里用记账用的假 host 测决策与文案；
// 真实运行面的换手、RUN-START 与标签一致由 main-reload 的 switchedReloadContext 用例覆盖。
import assert from "node:assert/strict";
import { test } from "vitest";
import type { StreamFn } from "../pi-runtime/index.ts";
import {
  afterCredentialRemoved,
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
  credentials?: Record<string, boolean>;
  resolution?: CredentialResolution;
  resolveCalls?: string[];
}) {
  const applied: CredentialAccess[] = [];
  const targets: Array<{ provider: string; model: string; streamFn: StreamFn } | undefined> = [];
  let placeholders = 0;
  const host: CredentialChangeHost = {
    currentModel: () => options.current,
    hasCredential: (provider) => options.credentials?.[provider] === true,
    resolve: async () => {
      options.resolveCalls?.push("resolve");
      if (options.resolution === undefined) throw new Error("不该重新解析");
      return options.resolution;
    },
    apply: (access) => {
      applied.push(access);
    },
    applyPlaceholder: () => {
      placeholders += 1;
    },
    rebuild: async (target) => {
      targets.push(target);
    },
  };
  return {
    host,
    applied,
    targets,
    placeholders: () => placeholders,
  };
}

test("MODEL-034 已有可用型号时 /login 只增凭据：不解析、不重建、不换型号", async () => {
  const calls: string[] = [];
  const { host, applied, targets } = fakeHost({
    current: { provider: "deepseek", id: "deepseek-v4-flash" },
    credentials: { deepseek: true },
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

test("MODEL-034 占位时凭据仍解析不出型号：转占位，只重建到占位", async () => {
  const { host, applied, targets, placeholders } = fakeHost({
    current: { provider: "custom", id: "custom" },
    resolution: {
      kind: "failed",
      text: 'no model selected for provider "kimi-coding"; pass --model.',
    },
  });
  const line = await afterCredentialStored(host, "kimi-coding");
  assert.match(line, /saved, but the model still can't be chosen/);
  assert.equal(placeholders(), 1);
  assert.deepEqual(applied, []);
  assert.deepEqual(targets, [undefined], "不带可用目标");
});

test("MODEL-034 占位时解析结果仍是占位：不换可用型号", async () => {
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
  assert.deepEqual(targets, [undefined]);
});

test("MODEL-034、MODEL-043 登出当前型号的唯一来源：换到剩余凭据的型号，且只为目标解析/重建一次", async () => {
  const calls: string[] = [];
  const { host, applied, targets } = fakeHost({
    current: { provider: "kimi-coding", id: "kimi-for-coding" },
    credentials: { deepseek: true },
    resolution: {
      kind: "ok",
      streamFn: stream,
      provider: "deepseek",
      modelId: "deepseek-v4-flash",
    },
    resolveCalls: calls,
  });
  const line = await afterCredentialRemoved(host, "kimi-coding");
  assert.equal(line, "logged out kimi-coding; this session now uses deepseek/deepseek-v4-flash");
  assert.deepEqual(calls, ["resolve"], "只解析剩余凭据一次，不为旧的 kimi 再解析");
  assert.equal(applied.length, 1);
  assert.deepEqual(
    targets,
    [{ provider: "deepseek", model: "deepseek-v4-flash", streamFn: stream }],
    "只重建显式目标一次（旧 kimi 不重建，所以不会冒出它的档位说明）"
  );
});

test("MODEL-034 登出当前型号后没有任何凭据：转占位并提示 /login", async () => {
  const { host, applied, targets, placeholders } = fakeHost({
    current: { provider: "kimi-coding", id: "kimi-for-coding" },
    resolution: { kind: "failed", text: "no credentials" },
  });
  const line = await afterCredentialRemoved(host, "kimi-coding");
  assert.equal(line, "logged out kimi-coding; no credentials left: run /login");
  assert.equal(placeholders(), 1);
  assert.deepEqual(applied, []);
  assert.deepEqual(targets, [undefined], "重建到占位，不保留无凭据的型号");
});

test("MODEL-034 登出无关的服务商：当前型号仍有凭据，不解析、不重建", async () => {
  const calls: string[] = [];
  const { host, applied, targets } = fakeHost({
    current: { provider: "deepseek", id: "deepseek-v4-flash" },
    credentials: { deepseek: true },
    resolveCalls: calls,
  });
  const line = await afterCredentialRemoved(host, "kimi-coding");
  assert.equal(line, "logged out kimi-coding; model unchanged (deepseek/deepseek-v4-flash)");
  assert.deepEqual(calls, []);
  assert.deepEqual(applied, []);
  assert.deepEqual(targets, []);
});
