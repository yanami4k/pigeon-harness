// Pigeon 的包信息（决策 451）：包根下 package.json；源码与打包产物运行时都在包根下。
// 只读一次并缓存；读不出时按空对象处理，各项如实写 unknown。
import { readFileSync } from "node:fs";
import { packageFileUrl } from "./package-paths.ts";

let cached: Record<string, unknown> | undefined;

export function packageManifest(): Record<string, unknown> {
  if (cached === undefined) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(packageFileUrl("package.json"), "utf8"));
      cached =
        typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      cached = {};
    }
  }
  return cached;
}

export function packageVersion(): string {
  const version = packageManifest().version;
  return typeof version === "string" ? version : "unknown";
}

export function packageRepository(): string {
  const repository = packageManifest().repository;
  if (typeof repository === "string") return repository;
  if (typeof repository === "object" && repository !== null) {
    const url = (repository as { url?: unknown }).url;
    if (typeof url === "string") return url;
  }
  return "unknown";
}
