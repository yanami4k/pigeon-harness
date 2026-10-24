// 决策 561：登录/型号面板的异步数据与结果落地后要请求重绘，否则界面停在“加载中”，
// 直到下一次点击或按键才显示。这里用可控 Promise 断言 redraw 回调，无需任何输入。
import assert from "node:assert/strict";
import { test } from "vitest";
import { LoginPanel, ModelPanel } from "./shell.ts";

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function loginFace(
  providers: () => Promise<Array<{ id: string; custom: boolean }>>,
  submit: () => Promise<string>
) {
  return {
    providers,
    submit: () => submit(),
    logout: async () => "logged out",
    stored: () => [],
  };
}

function modelFace(
  list: () => Promise<Array<{ provider: string; id: string }>>,
  apply: () => Promise<string>
) {
  return { list, apply: () => apply() };
}

test("决策 561：LoginPanel 的 providers 成功后立即请求重绘（无需输入）", async () => {
  let resolveProviders: (rows: Array<{ id: string; custom: boolean }>) => void = () => {};
  let redraws = 0;
  const panel = new LoginPanel(
    loginFace(
      () => new Promise((resolve) => (resolveProviders = resolve)),
      async () => "ok"
    ),
    () => {},
    () => {},
    undefined,
    5,
    () => {
      redraws += 1;
    }
  );
  assert.equal(redraws, 0);
  resolveProviders([{ id: "deepseek", custom: false }]);
  await flush();
  assert.equal(redraws, 1, "数据落地后应重绘一帧");
  assert.match(panel.render(80).join("\n"), /> deepseek/);
});

test("决策 561：LoginPanel 的 providers 失败后也请求重绘，错误可见", async () => {
  let rejectProviders: (error: unknown) => void = () => {};
  let redraws = 0;
  const panel = new LoginPanel(
    loginFace(
      () => new Promise((_, reject) => (rejectProviders = reject)),
      async () => "ok"
    ),
    () => {},
    () => {},
    undefined,
    5,
    () => {
      redraws += 1;
    }
  );
  rejectProviders(new Error("boom"));
  await flush();
  assert.equal(redraws, 1);
  assert.match(panel.render(80).join("\n"), /reading providers failed: boom/);
});

test("决策 561：LoginPanel 提交失败后请求重绘，busy 与错误都可见", async () => {
  let redraws = 0;
  const panel = new LoginPanel(
    loginFace(
      async () => [],
      async () => {
        throw new Error("bad key");
      }
    ),
    () => {},
    () => {},
    "deepseek",
    5,
    () => {
      redraws += 1;
    }
  );
  panel.handleInput("sk-x");
  panel.handleInput("\r");
  await flush();
  assert.equal(redraws, 2, "进入 busy 一次、失败一次");
  assert.match(panel.render(80).join("\n"), /login failed: bad key/);
});

test("决策 561：ModelPanel 的 list 成功后立即请求重绘（无需输入）", async () => {
  let resolveRows: (rows: Array<{ provider: string; id: string }>) => void = () => {};
  let redraws = 0;
  const panel = new ModelPanel(
    modelFace(
      () => new Promise((resolve) => (resolveRows = resolve)),
      async () => "ok"
    ),
    () => {},
    () => {},
    5,
    () => {
      redraws += 1;
    }
  );
  assert.equal(redraws, 0);
  resolveRows([{ provider: "deepseek", id: "deepseek-v4-flash" }]);
  await flush();
  assert.equal(redraws, 1);
  assert.match(panel.render(80).join("\n"), /> deepseek\/deepseek-v4-flash/);
});

test("决策 561：ModelPanel 的 list 失败与 apply 失败后都请求重绘", async () => {
  let rejectRows: (error: unknown) => void = () => {};
  let badRedraws = 0;
  const bad = new ModelPanel(
    modelFace(
      () => new Promise((_, reject) => (rejectRows = reject)),
      async () => "ok"
    ),
    () => {},
    () => {},
    5,
    () => {
      badRedraws += 1;
    }
  );
  rejectRows(new Error("boom"));
  await flush();
  assert.equal(badRedraws, 1);
  assert.match(bad.render(80).join("\n"), /reading models failed: boom/);

  let redraws = 0;
  const panel = new ModelPanel(
    modelFace(
      async () => [{ provider: "deepseek", id: "deepseek-v4-flash" }],
      async () => {
        throw new Error("bad model");
      }
    ),
    () => {},
    () => {},
    5,
    () => {
      redraws += 1;
    }
  );
  await flush();
  assert.equal(redraws, 1, "列表落地一次");
  panel.handleInput("\r");
  await flush();
  assert.equal(redraws, 3, "进入 busy 一次、失败一次");
  assert.match(panel.render(80).join("\n"), /switching the model failed: bad model/);
});
