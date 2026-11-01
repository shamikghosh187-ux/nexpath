import { describe, expect, it } from 'vitest';
import { classifyTestOutput, matchRequirementEvidence, renderProofMarkdown } from './proof.js';

describe('matchRequirementEvidence', () => {
  it('finds candidate lexical evidence in a changed file section', () => {
    const diff = [
      'diff --git a/src/auth.ts b/src/auth.ts',
      '--- a/src/auth.ts',
      '+++ b/src/auth.ts',
      '+export function validateSession(token: string): boolean {',
      '+  return token.length > 0;',
    ].join('\n');
    expect(matchRequirementEvidence('validate session token', diff)).toMatchObject({
      status: 'evidence_found',
      matchedTerms: ['validate', 'session', 'token'],
      evidenceFiles: ['src/auth.ts'],
    });
  });

  it('does not claim evidence when no requirement terms appear', () => {
    expect(matchRequirementEvidence('export a CSV report', 'diff --git a/a.ts b/a.ts\n+const value = 1;')).toMatchObject({
      status: 'not_verified',
      matchedTerms: [],
      evidenceFiles: [],
    });
  });

  it('treats very short requirements conservatively', () => {
    expect(matchRequirementEvidence('do it', '+const value = 1;').status).toBe('not_verified');
  });
});

describe('classifyTestOutput', () => {
  it('marks explicit failure output as failed', () => {
    expect(classifyTestOutput('Test Files  1 failed (1)')).toBe('failed');
  });

  it('never treats supplied pass output as independently verified', () => {
    expect(classifyTestOutput('Tests  42 passed (42)')).toBe('reported_unverified');
  });

  it('does not invent a test result from empty output', () => {
    expect(classifyTestOutput('')).toBe('reported_unverified');
  });
});

describe('renderProofMarkdown', () => {
  it('makes the evidence limitations explicit', () => {
    const report = {
      generatedAt: '2026-11-01T00:00:00.000Z',
      repositoryRoot: '/repo',
      changedFiles: [],
      requirements: [],
      tests: { status: 'not_run' as const, source: null, summary: 'Not supplied.' },
      limitations: ['No tests were run.'],
    };
    expect(renderProofMarkdown(report)).toContain('does not prove');
    expect(renderProofMarkdown(report)).toContain('No tests were run.');
  });
});
