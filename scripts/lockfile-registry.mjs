// 锁文件防回退（发版）：package-lock.json 里所有 resolved 都必须指向官方源。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const lockfile = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const expected = "https://registry.npmjs.org/";
const bad = [];
let checked = 0;
for (const [key, entry] of Object.entries(lockfile.packages)) {
  if (typeof entry.resolved !== "string") continue;
  checked += 1;
  if (!entry.resolved.startsWith(expected)) {
    bad.push(`${key === "" ? "(root)" : key}: ${entry.resolved}`);
  }
}
if (bad.length > 0) {
  console.error(`package-lock.json 有 ${bad.length} 条 resolved 不是以 ${expected} 开头：`);
  for (const line of bad) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`锁文件源检查通过：${checked} 条 resolved 都指向官方源`);
