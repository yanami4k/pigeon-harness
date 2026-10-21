// 包信息：manifest 只读一次并冻结，仓库地址按字符串、对象、简写与缺失四种情况规范化。
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  normalizeRepository,
  packageManifest,
  packageRepository,
  packageVersion,
} from "./package-version.ts";

test("packageManifest 只读一次且冻结；版本与仓库地址取自 package.json", () => {
  assert.equal(Object.isFrozen(packageManifest()), true);
  assert.equal(packageVersion(), "0.0.1");
  assert.equal(packageRepository(), "https://github.com/yanami4k/pigeon-harness");
});

test("仓库地址：字符串与对象", () => {
  assert.equal(
    normalizeRepository("https://github.com/yanami4k/pigeon-harness"),
    "https://github.com/yanami4k/pigeon-harness"
  );
  assert.equal(
    normalizeRepository("git+https://github.com/earendil-works/pi.git"),
    "https://github.com/earendil-works/pi"
  );
  assert.equal(
    normalizeRepository({
      type: "git",
      url: "git+https://github.com/earendil-works/pi.git",
      directory: "packages/ai",
    }),
    "https://github.com/earendil-works/pi"
  );
  assert.equal(
    normalizeRepository({ url: "ssh://git@github.com/owner/repo.git" }),
    "https://github.com/owner/repo"
  );
});

test("仓库地址：github 简写、裸 owner/repo、scp 与 git 协议", () => {
  assert.equal(normalizeRepository("github:owner/repo"), "https://github.com/owner/repo");
  assert.equal(normalizeRepository("owner/repo"), "https://github.com/owner/repo");
  assert.equal(
    normalizeRepository("git@github.com:owner/repo.git"),
    "https://github.com/owner/repo"
  );
  assert.equal(normalizeRepository("git://github.com/owner/repo"), "https://github.com/owner/repo");
});

test("仓库地址：缺失、空串、非 https 与非 ASCII 都返回 undefined", () => {
  assert.equal(normalizeRepository(undefined), undefined);
  assert.equal(normalizeRepository({}), undefined);
  assert.equal(normalizeRepository(""), undefined);
  assert.equal(normalizeRepository("http://github.com/owner/repo"), undefined);
  assert.equal(normalizeRepository("https://github.com/owner/répo"), undefined);
});
