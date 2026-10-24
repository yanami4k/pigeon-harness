// 凭据文件（决策 545）：~/.pigeon/credentials.json 的读、写、删；POSIX 0600；Windows 去继承、只给当前用户。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { userCredentialsPath } from "../state/paths.ts";
import {
  CredentialsError,
  readCredentials,
  removeProviderKey,
  storedProviders,
  writeProviderKey,
} from "./credentials.ts";

function home(): string {
  return mkdtempSync(join(tmpdir(), "pigeon-credentials-"));
}

test("MODEL-032 writes, reads, keeps other providers and deletes one entry", () => {
  const dir = home();
  try {
    writeProviderKey("deepseek", "sk-deepseek", { homeDir: dir });
    writeProviderKey("openai", "sk-openai", { homeDir: dir });
    assert.deepEqual(readCredentials({ homeDir: dir }), {
      deepseek: "sk-deepseek",
      openai: "sk-openai",
    });
    assert.deepEqual(storedProviders({ homeDir: dir }), ["deepseek", "openai"]);
    assert.equal(removeProviderKey("deepseek", { homeDir: dir }), true);
    assert.deepEqual(readCredentials({ homeDir: dir }), { openai: "sk-openai" });
    assert.equal(removeProviderKey("deepseek", { homeDir: dir }), false);
    // 文件仍是合法 JSON，其余条目原样
    const text = readFileSync(userCredentialsPath(dir), "utf8");
    assert.match(text, /"openai"/);
    assert.doesNotMatch(text, /sk-deepseek/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MODEL-032 a missing file is empty; a broken file fails loudly", () => {
  const dir = home();
  try {
    assert.deepEqual(readCredentials({ homeDir: dir }), {});
    mkdirSync(join(dir, ".pigeon"), { recursive: true });
    writeFileSync(userCredentialsPath(dir), "{not json");
    assert.throws(() => readCredentials({ homeDir: dir }), CredentialsError);
    writeFileSync(userCredentialsPath(dir), JSON.stringify({ providers: { deepseek: {} } }));
    assert.throws(() => readCredentials({ homeDir: dir }), /apiKey/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MODEL-032 the file is readable only by the current account", () => {
  const dir = home();
  try {
    writeProviderKey("deepseek", "sk-x", { homeDir: dir });
    const file = userCredentialsPath(dir);
    if (process.platform === "win32") {
      const acl = execFileSync("icacls", [file], { encoding: "utf8" });
      assert.ok(!acl.includes("(I)"), `no inherited entries: ${acl}`);
      assert.ok(acl.includes(userInfo().username), acl);
    } else {
      assert.equal(statSync(file).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MODEL-032 a failed ACL hardening writes nothing", () => {
  const dir = home();
  try {
    // 目录位置被一个同名文件占着：创建目录失败，也就没有写出凭据
    writeFileSync(join(dir, ".pigeon"), "x");
    assert.throws(() => writeProviderKey("deepseek", "sk-x", { homeDir: dir }));
    assert.deepEqual(readCredentials({ homeDir: dir }), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 登录 key 加固：新存进去的 key 去掉首尾空白与换行；读取不动旧内容
test("MODEL-032 a pasted key is trimmed before it is stored, old keys stay as they are", () => {
  const dir = home();
  try {
    assert.equal(writeProviderKey("deepseek", "  sk-abc\n", { homeDir: dir }), true);
    assert.deepEqual(readCredentials({ homeDir: dir }), { deepseek: "sk-abc" });
    // 文件里已有的旧 key（带空白）读取时原样交出，不顺手改写
    writeFileSync(
      userCredentialsPath(dir),
      JSON.stringify({ providers: { deepseek: { apiKey: "  old-key\n" } } })
    );
    assert.deepEqual(readCredentials({ homeDir: dir }), { deepseek: "  old-key\n" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MODEL-032 a key of only whitespace is not written at all", () => {
  const dir = home();
  try {
    assert.equal(writeProviderKey("deepseek", " \n\t ", { homeDir: dir }), false);
    assert.deepEqual(readCredentials({ homeDir: dir }), {});
    assert.deepEqual(storedProviders({ homeDir: dir }), []);
    assert.equal(existsSync(userCredentialsPath(dir)), false, "不建凭据文件");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
