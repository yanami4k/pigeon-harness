// 决策 441：Windows 上右键粘贴读系统剪贴板（PowerShell 的 Get-Clipboard，不弹窗、限时 3 秒）。读不到即空串。
// PowerShell 5.1 的输出缺省按控制台代码页（中文系统为 936），先把输出编码设成 UTF-8 再取，按 UTF-8 解码才不乱码。
import { execFile } from "node:child_process";

const UTF8_OUTPUT = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8";
const BOM = String.fromCharCode(0xfeff);

// 跑一段 PowerShell，按 UTF-8 取它的输出（去掉可能的 UTF-8 前导与末尾一个换行）；出错即空串
export function readPowerShellText(script: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `${UTF8_OUTPUT}; ${script}`],
      { encoding: "utf8", windowsHide: true, timeout: 3000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error !== null) {
          resolve("");
          return;
        }
        const text = stdout.startsWith(BOM) ? stdout.slice(1) : stdout;
        resolve(text.replace(/\r?\n$/, ""));
      }
    );
  });
}

export function readWindowsClipboard(): Promise<string> {
  return readPowerShellText("Get-Clipboard -Raw");
}
