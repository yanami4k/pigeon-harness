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

export function collectSpecRules(specDir: string): SpecRules;

export function collectTestRefs(srcDir: string, knownPrefixes: Set<string>): TestRef[];

export function checkSpecRefs(options: { specDir: string; srcDir: string }): {
  problems: string[];
  report: AreaReport[];
  rules: Map<string, string>;
  refs: TestRef[];
};
