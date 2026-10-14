// 编排脚本里 agent 的输出格式（决策 310、313）：按一份 JSON Schema 校验 worker 交回的数据。零依赖零 IO 的纯函数，
// 支持常用的关键字——type（可为数组）、enum、const、properties、required、additionalProperties（false 或子格式）、items、
// minItems、maxItems、minLength、maxLength、minimum、maximum、anyOf；其余关键字不校验。返回不合之处（空即合格式），
// 每条写明位置（$ 为根）。决策 428、455：这些文字经纠正提示交给 worker 的模型，用英文。
export type JsonSchema = Record<string, unknown>;

const MAX_PROBLEMS = 20;

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function typeMatches(expected: string, value: unknown): boolean {
  const actual = typeOf(value);
  if (expected === "number") return actual === "number" || actual === "integer";
  return expected === actual;
}

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function check(schema: JsonSchema, value: unknown, at: string, problems: string[]): void {
  if (problems.length >= MAX_PROBLEMS) return;
  const type = schema.type;
  if (type !== undefined) {
    const types = Array.isArray(type) ? type.map(String) : [String(type)];
    if (!types.some((expected) => typeMatches(expected, value))) {
      problems.push(`${at}: expected ${types.join(" or ")}, got ${typeOf(value)}`);
      return;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => sameJson(item, value))) {
    problems.push(
      `${at}: expected one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`
    );
  }
  if ("const" in schema && !sameJson(schema.const, value)) {
    problems.push(`${at}: expected ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.anyOf)) {
    const matched = schema.anyOf.some((option) => {
      if (!isSchema(option)) return false;
      const inner: string[] = [];
      check(option, value, at, inner);
      return inner.length === 0;
    });
    if (!matched) problems.push(`${at}: matches none of the anyOf options`);
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && [...value].length < schema.minLength) {
      problems.push(`${at}: must have at least ${schema.minLength} characters`);
    }
    if (typeof schema.maxLength === "number" && [...value].length > schema.maxLength) {
      problems.push(`${at}: must have at most ${schema.maxLength} characters`);
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      problems.push(`${at}: must be at least ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      problems.push(`${at}: must be at most ${schema.maximum}`);
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      problems.push(`${at}: must have at least ${schema.minItems} items`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      problems.push(`${at}: must have at most ${schema.maxItems} items`);
    }
    if (isSchema(schema.items)) {
      const items = schema.items;
      value.forEach((item, index) => {
        check(items, item, `${at}[${index}]`, problems);
      });
    }
  }
  if (typeOf(value) === "object") {
    const record = value as Record<string, unknown>;
    const properties = isSchema(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && !(key in record)) {
          problems.push(`${at}: missing required property ${key}`);
        }
      }
    }
    for (const [key, item] of Object.entries(record)) {
      const sub = properties[key];
      if (isSchema(sub)) {
        check(sub, item, `${at}.${key}`, problems);
      } else if (schema.additionalProperties === false) {
        problems.push(`${at}: unexpected property ${key}`);
      } else if (isSchema(schema.additionalProperties)) {
        check(schema.additionalProperties, item, `${at}.${key}`, problems);
      }
    }
  }
}

// 校验：返回不合之处；schema 本身不是对象即一条说明
export function checkJsonSchema(schema: unknown, value: unknown): string[] {
  if (!isSchema(schema)) {
    return ["The output schema must be a JSON Schema object"];
  }
  const problems: string[] = [];
  check(schema, value, "$", problems);
  return problems;
}

// 规范化：键按字母序，用于指纹（同一格式不因键序不同而算两份）
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
