// 决策 441：Windows 上右键粘贴读系统剪贴板（PowerShell 的 Get-Clipboard，不弹窗、限时 3 秒）。读不到即空串。
import { execFile } from "node:child_process";

export function readWindowsClipboard(): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"],
      { encoding: "utf8", windowsHide: true, timeout: 3000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        // Get-Clipboard -Raw 在末尾多带一个换行
        resolve(error !== null ? "" : stdout.replace(/\r?\n$/, ""));
      }
    );
  });
}
