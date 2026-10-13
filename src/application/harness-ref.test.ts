import assert from "node:assert/strict";
import { test } from "vitest";
import { currentHarnessRef, describeHarness } from "./harness-ref.ts";

test("代码版本：取本源码所在仓库的 HEAD 短号与是否有未提交改动", () => {
  const ref = currentHarnessRef();
  assert.match(ref.commit, /^[0-9a-f]{7,40}$|^unknown$/);
  assert.equal(typeof ref.dirty, "boolean");
});

test("代码版本的写法：提交号与有无未提交改动；读不到时记 unknown", () => {
  assert.equal(describeHarness({ commit: "a85e6dd", dirty: false }), "commit a85e6dd");
  assert.equal(
    describeHarness({ commit: "a85e6dd", dirty: true }),
    "commit a85e6dd, uncommitted changes"
  );
  assert.equal(describeHarness(undefined), "commit unknown");
});
