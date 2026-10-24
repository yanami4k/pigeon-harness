// 模型凭据文件（决策 545）：~/.pigeon/credentials.json，形如 { "providers": { "<id>": { "apiKey": "..." } } }。
// 环境变量优先于它（MODEL-001）；这里只负责文件的读、写、删与"只有本账户能读"：
// POSIX 用 0600（临时文件先设好再改名）；Windows 用 icacls 去掉继承、只给当前用户——目录在首次创建时同样收紧，
// 文件在改名之前收紧，失败即报错、不留下可直接读的凭据。
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { userCredentialsPath, userPigeonDir } from "../state/paths.ts";
import { parseJsonText } from "./json-text.ts";

const CLOSED = { additionalProperties: false } as const;

export const CredentialEntrySchema = Type.Object(
  {
    apiKey: Type.String({ minLength: 1 }),
  },
  CLOSED
);

export const CredentialsFileSchema = Type.Object(
  {
    providers: Type.Optional(
      Type.Record(Type.String({ minLength: 1 }), CredentialEntrySchema, CLOSED)
    ),
  },
  CLOSED
);
export type CredentialsFile = {
  providers?: Record<string, { apiKey: string }>;
};

export class CredentialsError extends Error {}

export interface CredentialsOptions {
  homeDir?: string;
}

function credentialsPath(options: CredentialsOptions): string {
  return userCredentialsPath(options.homeDir);
}

// 读带校验的文件内容；不存在即空（合法）；不是合法 JSON 或字段不对即报错并指出文件
function readFileOrEmpty(file: string): CredentialsFile {
  if (!existsSync(file)) return {};
  let raw: unknown;
  try {
    raw = parseJsonText(readFileSync(file, "utf8"));
  } catch (error) {
    throw new CredentialsError(
      `credentials file ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!Value.Check(CredentialsFileSchema, raw)) {
    const problems = [...Value.Errors(CredentialsFileSchema, raw)].map((failure) => {
      const where = "instancePath" in failure ? String(failure.instancePath) : "";
      return `${where === "" ? "/" : where}: ${failure.message}`;
    });
    throw new CredentialsError(`credentials file ${file} is invalid: ${problems.join("; ")}`);
  }
  return raw;
}

// provider → apiKey；文件不存在即空
export function readCredentials(options: CredentialsOptions = {}): Record<string, string> {
  const file = readFileOrEmpty(credentialsPath(options));
  const out: Record<string, string> = {};
  for (const [provider, entry] of Object.entries(file.providers ?? {})) {
    out[provider] = entry.apiKey;
  }
  return out;
}

// 只有本账户能读：POSIX 由临时文件的 0600 落实；Windows 去掉继承、只给当前用户
function hardenWindowsAcl(target: string): void {
  const user = userInfo().username;
  try {
    execFileSync("icacls", [target, "/inheritance:r", "/grant:r", `${user}:F`], {
      stdio: "pipe",
      windowsHide: true,
    });
  } catch (error) {
    throw new CredentialsError(
      `could not restrict permissions on ${target} to the current user: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// 先写同目录临时文件（POSIX 设 0600、Windows 先收紧）再改名覆盖：任何时刻读到的都是完整且已收紧的文件
function writeSecure(file: string, text: string): void {
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
    if (process.platform === "win32") hardenWindowsAcl(temp);
    renameSync(temp, file);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // 清不掉临时文件不改变结论：下面照样报错
    }
    throw error instanceof CredentialsError
      ? error
      : new CredentialsError(
          `writing ${file} failed: ${error instanceof Error ? error.message : String(error)}`
        );
  }
}

function writeFile(file: string, value: CredentialsFile): void {
  writeSecure(file, `${JSON.stringify(value, null, 2)}\n`);
}

// 写入一个服务商的 key（保留其余条目）。目录首次创建时先收紧；凭据文件在改名之前收紧。
// 登录 key 加固：保存前 trim（去首尾空白与换行）；trim 后为空不写文件、返回 false（调用方提示重新粘贴）。
// 已存文件里的旧 key 读取时不做改动。
export function writeProviderKey(
  provider: string,
  apiKey: string,
  options: CredentialsOptions = {}
): boolean {
  const key = apiKey.trim();
  if (key === "") return false;
  const dir = userPigeonDir(options.homeDir);
  const created = !existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (created && process.platform === "win32") hardenWindowsAcl(dir);
  const file = credentialsPath(options);
  const current = readFileOrEmpty(file);
  writeFile(file, {
    ...current,
    providers: { ...(current.providers ?? {}), [provider]: { apiKey: key } },
  });
  return true;
}

// 删掉一个服务商的条目；文件里本来没有它即 false（不写文件）
export function removeProviderKey(provider: string, options: CredentialsOptions = {}): boolean {
  const file = credentialsPath(options);
  const current = readFileOrEmpty(file);
  const providers = current.providers ?? {};
  if (providers[provider] === undefined) return false;
  const { [provider]: _removed, ...rest } = providers;
  writeFile(file, { ...current, providers: rest });
  return true;
}

// 文件里存着的服务商（/logout 不带参数时列出用）
export function storedProviders(options: CredentialsOptions = {}): string[] {
  return Object.keys(readFileOrEmpty(credentialsPath(options)).providers ?? {}).sort();
}
