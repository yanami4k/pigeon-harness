export interface RuleDuplicate {
  rule: string;
  first: string;
  second: string;
}

export interface SpecRules {
  rules: Map<string, string>;
  duplicates: RuleDuplicate[];
  areas: Map<string, Set<string>>;
}

export interface TestRef {
  file: string;
  rule: string;
  source: "title" | "spec comment";
}

export interface AreaReport {
  area: string;
  covered: number;
  total: number;
}

export interface ExemptRule {
  rule: string;
  why: string;
}

export interface CoverageRow {
  area: string;
  unreferenced: number;
  allowed: number;
  surplus: number;
}

export function collectSpecRules(specDir: string): SpecRules;

export function collectTestRefs(srcDir: string, knownPrefixes: Set<string>): TestRef[];

export function checkSpecRefs(options: { specDir: string; srcDir: string }): {
  problems: string[];
  report: AreaReport[];
  rules: Map<string, string>;
  referenced: Set<string>;
  refs: TestRef[];
};

export function unreferencedByArea(options: {
  report: AreaReport[];
  referenced: Set<string>;
  rules: Map<string, string>;
  exemptRules: readonly ExemptRule[];
}): { areas: Map<string, number>; problems: string[] };

export function compareWithBaseline(options: {
  areas: Map<string, number>;
  baseline: Record<string, number>;
}): CoverageRow[];

export function formatCoverageLine(row: CoverageRow, covered: number, total: number): string;

export function formatSurplus(row: CoverageRow): string;

export const REFERENCE_HINT: string;

export function readJsonFile(path: string): unknown;

export function readExemptRules(path: string): ExemptRule[];

export function readBaseline(path: string): Record<string, number> | undefined;

export function writeBaseline(path: string, areas: Map<string, number>): void;
