import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Command } from 'commander';

export type ProofStatus = 'evidence_found' | 'not_verified';
export type TestEvidenceStatus = 'passed' | 'failed' | 'reported_unverified' | 'not_run';

export interface RequirementEvidence {
  requirement: string;
  status: ProofStatus;
  matchedTerms: string[];
  evidenceFiles: string[];
}

export interface TestEvidence {
  status: TestEvidenceStatus;
  source: string | null;
  summary: string;
}

export interface ProofReport {
  generatedAt: string;
  repositoryRoot: string;
  changedFiles: string[];
  requirements: RequirementEvidence[];
  tests: TestEvidence;
  limitations: string[];
}

export interface ProofInput {
  cwd?: string;
  requirements?: string[];
  testOutputPath?: string;
}

const STOP_WORDS = new Set(['about', 'after', 'also', 'and', 'are', 'can', 'for', 'from', 'have', 'into', 'must', 'that', 'the', 'then', 'this', 'with', 'will']);

function runGit(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error('Git command failed (git ' + args.join(' ') + '): ' + detail);
  }
}

function extractTerms(requirement: string): string[] {
  return [...new Set(requirement.toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/g) ?? [])]
    .filter((term) => !STOP_WORDS.has(term));
}

export function matchRequirementEvidence(requirement: string, diff: string): RequirementEvidence {
  const terms = extractTerms(requirement);
  const lowerDiff = diff.toLowerCase();
  const matchedTerms = terms.filter((term) => lowerDiff.includes(term));
  const evidenceFiles = diff.split(/^diff --git .*$/m).slice(1)
    .filter((section) => matchedTerms.some((term) => section.toLowerCase().includes(term)))
    .map((section) => {
      const match = section.match(/^\s*a\/([^\n]+) b\/([^\n]+)/);
      return match?.[2] ?? '';
    })
    .filter(Boolean);

  return {
    requirement,
    status: matchedTerms.length > 0 ? 'evidence_found' : 'not_verified',
    matchedTerms,
    evidenceFiles: [...new Set(evidenceFiles)],
  };
}

export function classifyTestOutput(output: string): TestEvidenceStatus {
  if (!output.trim()) return 'reported_unverified';
  if (/\bFAIL(?:ED)?\b|^\s*not ok\b|\btests?\s+\d+\s+failed\b/im.test(output)) return 'failed';
  return 'reported_unverified';
}

export function buildProofReport(input: ProofInput = {}): ProofReport {
  const cwd = resolve(input.cwd ?? process.cwd());
  const repositoryRoot = runGit(['rev-parse', '--show-toplevel'], cwd).trim();
  const changedFiles = runGit(['diff', '--name-only', 'HEAD'], repositoryRoot).split(/\r?\n/).filter(Boolean);
  const untrackedFiles = runGit(['ls-files', '--others', '--exclude-standard'], repositoryRoot).split(/\r?\n/).filter(Boolean);
  const allChangedFiles = [...new Set([...changedFiles, ...untrackedFiles])].sort();
  const diff = runGit(['diff', '--no-ext-diff', '--unified=0', 'HEAD'], repositoryRoot);
  const requirements = (input.requirements ?? []).map((requirement) => matchRequirementEvidence(requirement, diff));

  let tests: TestEvidence = {
    status: 'not_run',
    source: null,
    summary: 'No test-output file was supplied. ProofPath does not execute project commands.',
  };

  if (input.testOutputPath) {
    const source = resolve(cwd, input.testOutputPath);
    if (!existsSync(source)) throw new Error('Test-output file not found: ' + source);
    const output = readFileSync(source, 'utf8');
    const status = classifyTestOutput(output);
    const summary = status === 'failed'
      ? 'Failure markers were found in the supplied output. Review the original log.'
      : /\ball tests passed\b|\btests?\s+\d+\s+passed\b/i.test(output)
        ? 'The supplied output contains a pass summary; this is user-provided evidence, not an independently rerun test.'
        : 'Output was supplied, but no recognised pass/failure summary was found.';
    tests = { status, source, summary };
  }

  return {
    generatedAt: new Date().toISOString(),
    repositoryRoot,
    changedFiles: allChangedFiles,
    requirements,
    tests,
    limitations: [
      'Requirement matching is lexical and identifies candidate evidence only; it does not prove the implementation satisfies the requirement.',
      'Test output is user-supplied and is not independently verified or rerun.',
      'ProofPath is read-only and does not upload source code, run tests, or execute project scripts.',
      'Untracked files are listed, but their contents are not included in the Git diff until staged.',
    ],
  };
}

export function renderProofMarkdown(report: ProofReport): string {
  const lines = [
    '# Nexpath ProofPath report',
    '',
    '- Generated: ' + report.generatedAt,
    '- Repository: ' + report.repositoryRoot,
    '',
    '## Changed files',
    ...(report.changedFiles.length ? report.changedFiles.map((file) => '- ' + file) : ['- No changed files detected.']),
    '',
    '## Requirements',
  ];

  if (report.requirements.length === 0) {
    lines.push('No requirements were supplied. Add one or more --requirement options.');
  } else {
    for (const item of report.requirements) {
      lines.push(
        '### ' + (item.status === 'evidence_found' ? 'Evidence found (candidate)' : 'Not verified') + ': ' + item.requirement,
        item.matchedTerms.length ? '- Matched terms: ' + item.matchedTerms.join(', ') : '- Matched terms: none',
        item.evidenceFiles.length ? '- Candidate files: ' + item.evidenceFiles.join(', ') : '- Candidate files: none',
        '',
      );
    }
  }

  lines.push(
    '## Test evidence',
    '- Status: ' + report.tests.status,
    '- Source: ' + (report.tests.source ?? 'not supplied'),
    '- Summary: ' + report.tests.summary,
    '',
    '## Limitations',
    ...report.limitations.map((item) => '- ' + item),
    '',
  );
  return lines.join('\n');
}

export function registerProofCommand(program: Command): void {
  program
    .command('proof')
    .description('Create a local, evidence-based audit of Git changes and supplied test output')
    .option('-p, --project <path>', 'Project root path', process.cwd())
    .option('-r, --requirement <text>', 'Requirement to check (repeat for multiple requirements)', (value: string, previous: string[] = []) => [...previous, value], [])
    .option('--test-output <path>', 'Path to an existing test-output log (never runs tests)')
    .option('--format <format>', 'Report format: markdown or json', 'markdown')
    .option('-o, --output <path>', 'Write the report to a file instead of stdout')
    .action((opts: { project: string; requirement: string[]; testOutput?: string; format: string; output?: string }) => {
      try {
        if (opts.format !== 'markdown' && opts.format !== 'json') throw new Error('Format must be either markdown or json.');
        const report = buildProofReport({ cwd: opts.project, requirements: opts.requirement, testOutputPath: opts.testOutput });
        const content = opts.format === 'json' ? JSON.stringify(report, null, 2) + '\n' : renderProofMarkdown(report);
        if (opts.output) {
          const destination = resolve(opts.project, opts.output);
          writeFileSync(destination, content, 'utf8');
          process.stdout.write('ProofPath report written to ' + destination + '\n');
        } else {
          process.stdout.write(content);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write('ProofPath failed: ' + message + '\n');
        process.exitCode = 1;
      }
    });
}
