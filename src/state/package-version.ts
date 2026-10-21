// Pigeon 的包版本（决策 451）：包根下 package.json 的 version；源码与打包产物运行时都在包根下。
// 读不出时如实写 unknown。客户端信息与抓取网页时的 User-Agent 也取这里。
import { readFileSync } from "node:fs";
import { packageFileUrl } from "./package-paths.ts";

export function packageVersion(): string {
  try {
    const parsed = JSON.parse(readFileSync(packageFileUrl("package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}
