// 读使用者手写的 JSON 配置（设置文件、.mcp.json 等）：开头的 UTF-8 字节序标记（BOM）去掉再解析——Windows 上不少编辑器与
// PowerShell 5.1 的 Set-Content -Encoding utf8 写出的文件带它，JSON.parse 不认。
const BOM = 0xfeff;

export function parseJsonText(text: string): unknown {
  return JSON.parse(text.charCodeAt(0) === BOM ? text.slice(1) : text);
}
