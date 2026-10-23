// 斜杠命令表（决策 286 第 4、6 项；决策 546）：/login、/logout 的登记、运行中拒绝与作用域。
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  commandScope,
  lookupSlashCommand,
  rejectWhileRunning,
  SLASH_COMMANDS,
  slashTokens,
} from "./command-table.ts";

test("MODEL-033 /login and /logout are program-level commands refused while running", () => {
  assert.deepEqual(lookupSlashCommand(slashTokens("/login")), {
    name: "login",
    usage: "/login [provider]",
    whileRunning: { allow: false },
    scope: "program",
  });
  assert.equal(commandScope("/logout"), "program");
  assert.equal(rejectWhileRunning("/login"), "can't use /login while running");
  assert.equal(rejectWhileRunning("/logout deepseek"), "can't use /logout while running");
  // 已在表里（补全列表从表来），且不重复
  const names = SLASH_COMMANDS.map((spec) => spec.name);
  assert.equal(names.filter((name) => name === "login").length, 1);
  assert.equal(names.filter((name) => name === "logout").length, 1);
});
