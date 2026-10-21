// 锁文件防回退（发版）：lockfileVersion 必须是 3；除根、link、inBundle 外的每个条目都要有官方源的
// resolved 与 sha512- 的 integrity。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const lockfile = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
if (lockfile.lockfileVersion !== 3) {
  console.error(`package-lock.json 的 lockfileVersion 应为 3，实际为 ${lockfile.lockfileVersion}`);
  process.exit(1);
}
const registry = "https://registry.npmjs.org/";
const integrity = "sha512-";
const bad = [];
let checked = 0;
for (const [key, entry] of Object.entries(lockfile.packages)) {
  if (key === "" || entry.link === true || entry.inBundle === true) continue;
  checked += 1;
  if (typeof entry.resolved !== "string" || !entry.resolved.startsWith(registry)) {
    bad.push(`${key}: resolved ${JSON.stringify(entry.resolved)}`);
  }
  if (typeof entry.integrity !== "string" || !entry.integrity.startsWith(integrity)) {
    bad.push(`${key}: integrity ${JSON.stringify(entry.integrity)}`);
  }
}
if (checked === 0) {
  console.error("package-lock.json 没有可检查的条目");
  process.exit(1);
}
if (bad.length > 0) {
  console.error(`package-lock.json 有 ${bad.length} 项不符合要求：`);
  for (const line of bad) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`锁文件源检查通过：${checked} 条`);
