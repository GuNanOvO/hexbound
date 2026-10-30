import type ts from 'typescript';

export type RuleId = `HB${number}`;

export interface Finding {
  readonly ruleId: RuleId;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
  readonly evidence: string;
  readonly fingerprint?: string;
  readonly kind?: 'violation' | 'infrastructure';
}

export interface Waiver {
  readonly ruleId: RuleId;
  readonly file: string;
  readonly fingerprint: string;
  readonly reason: string;
  readonly approvedBy: string;
  readonly expires: string;
}

export interface Policy {
  readonly version: 1;
  readonly rulesVersion: string;
  readonly businessRoots: readonly string[];
  readonly serverRoots: readonly string[];
  readonly serverServicesRoots: readonly string[];
  readonly effectRoots: readonly string[];
  readonly dataRoots: readonly string[];
  readonly validationRoots: readonly string[];
  readonly cacheRoots: readonly string[];
  readonly envFiles: readonly string[];
  readonly generatedPaths: readonly string[];
  readonly dbPackages: readonly string[];
  readonly authModules: readonly string[];
  readonly identityTypes: readonly string[];
  readonly moneyTypes: readonly string[];
  readonly money: boolean;
  readonly waivers: readonly Waiver[];
}

export interface AnalysisContext {
  readonly root: string;
  readonly files: readonly ts.SourceFile[];
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly policy: Policy;
}

export type Analyzer = (context: AnalysisContext) => Finding[];

export interface CheckResult {
  readonly schemaVersion: 1;
  readonly rulesVersion: string;
  readonly root: string;
  readonly exitCode: 0 | 1 | 2;
  readonly scannedFiles: readonly string[];
  readonly excludedFiles: readonly string[];
  readonly findings: readonly Finding[];
  readonly errors: readonly string[];
  readonly appliedWaivers: readonly Waiver[];
  readonly semanticReview: readonly { readonly ruleId: RuleId; readonly status: 'not_proven_by_static_analysis'; readonly requirement: string }[];
  readonly notApplicable: readonly string[];
  readonly toolVersions: Readonly<Record<string, string>>;
}
