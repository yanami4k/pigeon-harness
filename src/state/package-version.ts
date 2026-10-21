// Pigeon 的包信息（决策 451）：包根下 package.json；源码与打包产物运行时都在包根下。
// 只读一次并缓存；读不出时按空对象处理，各项如实写 unknown。
import { readFileSync } from "node:fs";
import { packageFileUrl } from "./package-paths.ts";

let cached: Readonly<Record<string, unknown>> | undefined;

export function packageManifest(): Readonly<Record<string, unknown>> {
  if (cached === undefined) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(packageFileUrl("package.json"), "utf8"));
      cached =
        typeof parsed === "object" && parsed !== null
          ? Object.freeze(parsed as Record<string, unknown>)
          : Object.freeze({});
    } catch {
      cached = Object.freeze({});
    }
  }
  return cached;
}

export function packageVersion(): string {
  const version = packageManifest().version;
  return typeof version === "string" ? version : "unknown";
}

// 仓库地址规范化：接受字符串、{ url }、github:owner/repo 与裸 owner/repo；
// 去掉 git+ 前缀与 .git 后缀，常见 git/ssh 地址改成 https，最后要求 https 且全是可打印 ASCII。
export function normalizeRepository(repository: unknown): string | undefined {
  let value: unknown = repository;
  if (typeof value === "object" && value !== null) {
    value = (value as { url?: unknown }).url;
  }
  if (typeof value !== "string") return undefined;
  let text = value.trim();
  if (text === "") return undefined;
  text = text.replace(/^git\+/, "");
  const ssh = /^ssh:\/\/git@([^/]+)\/(.+)$/.exec(text);
  if (ssh !== null) text = `https://${ssh[1]}/${ssh[2]}`;
  const scp = /^git@([^:]+):(.+)$/.exec(text);
  if (scp !== null) text = `https://${scp[1]}/${scp[2]}`;
  if (text.startsWith("git://")) text = `https://${text.slice("git://".length)}`;
  const github = /^github:([^/]+)\/(.+)$/.exec(text);
  if (github !== null) {
    text = `https://github.com/${github[1]}/${github[2]}`;
  } else if (/^[\w.-]+\/[\w.-]+$/.test(text)) {
    text = `https://github.com/${text}`;
  }
  text = text.replace(/\/+$/, "").replace(/\.git$/, "");
  if (!/^[\x20-\x7e]+$/.test(text)) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  return url.protocol === "https:" ? text : undefined;
}

export function packageRepository(): string | undefined {
  return normalizeRepository(packageManifest().repository);
}
