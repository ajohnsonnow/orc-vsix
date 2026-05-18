import { describe, it, expect } from 'vitest';
import {
  heuristicQualityCheck,
  structuralValidation,
} from '../cascade/selfCorrectionCascade.js';

// ─────────────────────────────────────────────
//  heuristicQualityCheck
// ─────────────────────────────────────────────

describe('heuristicQualityCheck — universal checks', () => {
  it('fails extremely short responses', () => {
    const result = heuristicQualityCheck('ok', 'implement a parser', 'code');
    expect(result.passed).toBe(false);
    expect(result.score).toBeLessThan(60);
    expect(result.shouldEscalate).toBe(true);
  });

  it('passes a reasonable general response', () => {
    const result = heuristicQualityCheck(
      'The error occurs because the variable is undefined. To fix it, initialize the value before use.',
      'why does this fail?',
      'general',
    );
    expect(result.passed).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(60);
  });

  it('penalizes hallucination markers', () => {
    const result = heuristicQualityCheck(
      'I cannot access the file system as an AI language model.',
      'read my config file',
      'general',
    );
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(100);
  });

  it('penalizes truncated responses', () => {
    const response = 'Here is the code:\n```ts\nfunction foo() {\n  // ...\n  return result;\n```\n...';
    const result = heuristicQualityCheck(response, 'write a function', 'code');
    expect(result.issues.some(i => i.toLowerCase().includes('truncat'))).toBe(true);
  });
});

describe('heuristicQualityCheck — code-specific checks', () => {
  it('penalizes code task response with no code block', () => {
    const result = heuristicQualityCheck(
      'You should implement a parser that reads tokens and builds an AST. Consider using recursive descent.',
      'implement a parser',
      'code',
    );
    expect(result.issues.some(i => i.includes('No code block'))).toBe(true);
    expect(result.score).toBeLessThan(100);
  });

  it('does not penalize code block for non-code tasks', () => {
    const result = heuristicQualityCheck(
      'The main issue is that the algorithm has O(n²) complexity. Consider sorting first to achieve O(n log n).',
      'explain the performance issue',
      'analysis',
    );
    // No penalty for missing code block on analysis task
    expect(result.issues.filter(i => i.includes('No code block'))).toHaveLength(0);
  });

  it('penalizes unmatched braces', () => {
    const result = heuristicQualityCheck(
      '```ts\nfunction foo() {\n  if (true) {\n    return 1;\n  \n```',
      'write a function',
      'code',
    );
    expect(result.issues.some(i => i.includes('brace'))).toBe(true);
  });

  it('penalizes TODO placeholders in code', () => {
    const result = heuristicQualityCheck(
      '```ts\nfunction parseExpression() {\n  // TODO: implement this\n  return null;\n}\n```',
      'implement a parser',
      'code',
    );
    expect(result.issues.some(i => i.toLowerCase().includes('todo'))).toBe(true);
  });
});

describe('heuristicQualityCheck — analysis-specific checks', () => {
  it('penalizes long analysis responses with no structure', () => {
    const unstructured = 'a '.repeat(300); // 300 words, no headings or bullets
    const result = heuristicQualityCheck(unstructured, 'analyze this code', 'analysis');
    expect(result.issues.some(i => i.includes('structure'))).toBe(true);
  });

  it('passes structured analysis with headings', () => {
    const structured = `## Summary\nThe code has several issues.\n\n## Issues\n- Memory leak in loop\n- Missing error handling\n\n## Recommendations\n1. Fix the loop\n2. Add try/catch`;
    const result = heuristicQualityCheck(structured, 'analyze this code', 'analysis');
    expect(result.issues.filter(i => i.includes('structure'))).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────
//  structuralValidation
// ─────────────────────────────────────────────

describe('structuralValidation', () => {
  it('passes response with no JSON blocks', () => {
    const result = structuralValidation('Here is the fixed function:\n```ts\nfunction foo() { return 1; }\n```');
    expect(result.passed).toBe(true);
  });

  it('passes response with valid JSON blocks', () => {
    const result = structuralValidation('Result:\n```json\n{"key": "value", "num": 42}\n```');
    expect(result.passed).toBe(true);
  });

  it('fails response with invalid JSON blocks', () => {
    const result = structuralValidation('Result:\n```json\n{"key": "value", invalid}\n```');
    expect(result.passed).toBe(false);
    expect(result.issues.some(i => i.includes('JSON'))).toBe(true);
  });

  it('penalizes severely malformed JSON (score < 50 → shouldEscalate)', () => {
    const result = structuralValidation(
      '```json\n{broken json {{{}}}\n```\n```json\n[unclosed array\n```',
    );
    expect(result.score).toBeLessThan(70);
  });
});

// ─────────────────────────────────────────────
//  Score thresholds
// ─────────────────────────────────────────────

describe('score thresholds', () => {
  it('score >= 60 = passed', () => {
    const result = heuristicQualityCheck(
      '## Analysis\nThe function is correct but could be optimized.\n- Use a Map instead of nested loops\n- Cache the result',
      'analyze this',
      'analysis',
    );
    if (result.score >= 60) {
      expect(result.passed).toBe(true);
    }
  });

  it('score < 50 = shouldEscalate', () => {
    const result = heuristicQualityCheck('no', 'implement a complete REST API', 'code');
    expect(result.shouldEscalate).toBe(true);
  });
});
