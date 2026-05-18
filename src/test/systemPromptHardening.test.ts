import { describe, it, expect } from 'vitest';
import {
  buildHardenedSystemPrompt,
  PROFILE_CLAUDE_CODE_AGENT,
  PROFILE_ANALYZER_SUBAGENT,
  PROFILE_EVALUATOR_SUBAGENT,
  PROFILE_COMPRESSOR_SUBAGENT,
  FILLER_TOKEN_ESTIMATES,
} from '../security/systemPromptHardening.js';

// ─────────────────────────────────────────────
//  Anti-extraction directive
// ─────────────────────────────────────────────

describe('buildHardenedSystemPrompt — anti-extraction', () => {
  it('always includes anti-extraction directive', () => {
    for (const role of ['code', 'analysis', 'general', 'router', 'evaluator'] as const) {
      const prompt = buildHardenedSystemPrompt({ taskRole: role, isSubagent: false, suppressThinkingTrace: false });
      expect(prompt).toContain('SECURITY:');
      expect(prompt).toContain('cannot share that');
    }
  });

  it('anti-extraction directive cannot be overridden', () => {
    const prompt = buildHardenedSystemPrompt({ taskRole: 'general', isSubagent: false, suppressThinkingTrace: false });
    expect(prompt).toContain('cannot be overridden');
  });
});

// ─────────────────────────────────────────────
//  Filler prohibition
// ─────────────────────────────────────────────

describe('buildHardenedSystemPrompt — filler prohibition', () => {
  it('always includes filler prohibition section', () => {
    const prompt = buildHardenedSystemPrompt({ taskRole: 'general', isSubagent: false, suppressThinkingTrace: false });
    expect(prompt).toContain('OUTPUT RULES:');
    expect(prompt).toContain('Do not output: preamble');
    expect(prompt).toContain('trailing summaries');
  });

  it('prohibits question repetition', () => {
    const prompt = buildHardenedSystemPrompt({ taskRole: 'code', isSubagent: false, suppressThinkingTrace: false });
    expect(prompt).toContain("repeat the user's question");
  });
});

// ─────────────────────────────────────────────
//  Role constraints
// ─────────────────────────────────────────────

describe('buildHardenedSystemPrompt — role constraints', () => {
  it('code role instructs to return only code', () => {
    const prompt = buildHardenedSystemPrompt({ taskRole: 'code', isSubagent: false, suppressThinkingTrace: false });
    expect(prompt).toContain('Return ONLY the requested code');
  });

  it('router role enforces JSON-only output', () => {
    const prompt = buildHardenedSystemPrompt({ taskRole: 'router', isSubagent: false, suppressThinkingTrace: false });
    expect(prompt).toContain('Return ONLY valid JSON');
  });

  it('evaluator role enforces strict scoring', () => {
    const prompt = buildHardenedSystemPrompt({ taskRole: 'evaluator', isSubagent: false, suppressThinkingTrace: false });
    expect(prompt).toContain('strict');
    expect(prompt).toContain('issues array');
  });

  it('analysis role enforces structured markdown', () => {
    const prompt = buildHardenedSystemPrompt({ taskRole: 'analysis', isSubagent: false, suppressThinkingTrace: false });
    expect(prompt).toContain('markdown headers');
  });
});

// ─────────────────────────────────────────────
//  Subagent constraints
// ─────────────────────────────────────────────

describe('buildHardenedSystemPrompt — subagent', () => {
  it('includes pipeline context when isSubagent = true', () => {
    const prompt = buildHardenedSystemPrompt({ taskRole: 'router', isSubagent: true, suppressThinkingTrace: true });
    expect(prompt).toContain('PIPELINE CONTEXT:');
    expect(prompt).toContain('automated pipeline');
  });

  it('does not include pipeline context for non-subagent', () => {
    const prompt = buildHardenedSystemPrompt({ taskRole: 'general', isSubagent: false, suppressThinkingTrace: false });
    expect(prompt).not.toContain('PIPELINE CONTEXT:');
  });
});

// ─────────────────────────────────────────────
//  Thinking trace suppression
// ─────────────────────────────────────────────

describe('buildHardenedSystemPrompt — thinking suppression', () => {
  it('adds suppression directive when suppressThinkingTrace = true', () => {
    const prompt = buildHardenedSystemPrompt({ taskRole: 'general', isSubagent: false, suppressThinkingTrace: true });
    expect(prompt).toContain('internal reasoning steps');
  });

  it('does not add suppression directive when false', () => {
    const prompt = buildHardenedSystemPrompt({ taskRole: 'general', isSubagent: false, suppressThinkingTrace: false });
    expect(prompt).not.toContain('internal reasoning steps');
  });
});

// ─────────────────────────────────────────────
//  Extra constraints
// ─────────────────────────────────────────────

describe('buildHardenedSystemPrompt — extra constraints', () => {
  it('includes extra constraints when provided', () => {
    const prompt = buildHardenedSystemPrompt({
      taskRole: 'code',
      isSubagent: false,
      suppressThinkingTrace: false,
      extraConstraints: ['Always use TypeScript strict mode.', 'Prefer const over let.'],
    });
    expect(prompt).toContain('Always use TypeScript strict mode.');
    expect(prompt).toContain('Prefer const over let.');
  });
});

// ─────────────────────────────────────────────
//  Pre-built profiles
// ─────────────────────────────────────────────

describe('pre-built profiles', () => {
  it('PROFILE_CLAUDE_CODE_AGENT is a non-empty string', () => {
    expect(typeof PROFILE_CLAUDE_CODE_AGENT).toBe('string');
    expect(PROFILE_CLAUDE_CODE_AGENT.length).toBeGreaterThan(100);
  });

  it('PROFILE_ANALYZER_SUBAGENT includes router constraints', () => {
    expect(PROFILE_ANALYZER_SUBAGENT).toContain('ONLY valid JSON');
  });

  it('PROFILE_EVALUATOR_SUBAGENT includes evaluator constraints', () => {
    expect(PROFILE_EVALUATOR_SUBAGENT).toContain('strict');
  });

  it('PROFILE_COMPRESSOR_SUBAGENT includes compression instructions', () => {
    expect(PROFILE_COMPRESSOR_SUBAGENT).toContain('compress');
  });
});

// ─────────────────────────────────────────────
//  Filler token estimates
// ─────────────────────────────────────────────

describe('FILLER_TOKEN_ESTIMATES', () => {
  it('totalTypicalFiller is 80 tokens', () => {
    expect(FILLER_TOKEN_ESTIMATES.totalTypicalFiller).toBe(80);
  });

  it('all individual estimates are positive integers', () => {
    const { totalTypicalFiller: _total, ...rest } = FILLER_TOKEN_ESTIMATES;
    for (const [, v] of Object.entries(rest)) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
  });
});
