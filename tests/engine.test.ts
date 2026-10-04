import { describe, expect, it } from 'vitest';
import { computeResultId, isComplete, nextStepId, progressOf, resolveFunnel, validateAnswer, visibleSteps } from '../shared/engine.js';
import { loadConfig } from './helpers.js';

describe('funnel engine', () => {
  const v1A = resolveFunnel(loadConfig(1), 'A');
  const v3B = resolveFunnel(loadConfig(3), 'B');

  it('branches: office_days only for hybrid/office, security_constraints only with compliance', () => {
    const ids = (a: Record<string, unknown>, f = v1A) => visibleSteps(f, a as never).map((s) => s.id);
    expect(ids({ work_mode: 'remote' })).not.toContain('office_days');
    expect(ids({ work_mode: 'hybrid' })).toContain('office_days');
    expect(ids({ priorities: ['speed'] }, v3B)).not.toContain('security_constraints');
    expect(ids({ priorities: ['compliance'] }, v3B)).toContain('security_constraints');
    expect(nextStepId(v1A, 'timezone_span', { work_mode: 'remote' })).toBe('async_maturity');
  });

  it('v3 variant B has no tool_count step', () => {
    expect(v3B.steps.map((s) => s.id)).not.toContain('tool_count');
  });

  it('progress counts only visible question steps', () => {
    expect(progressOf(v1A, 'team_size', { work_mode: 'remote' })).toEqual({ index: 1, total: 6 });
    expect(progressOf(v1A, 'team_size', { work_mode: 'office' })).toEqual({ index: 1, total: 7 });
    expect(progressOf(v1A, 'intro', {})).toEqual({ index: 0, total: 6 });
  });

  it('ignores stale answers of steps that became hidden', () => {
    const answers = { team_size: 5, work_mode: 'remote', priorities: ['speed'], timezone_span: 'same', office_days: 3, async_maturity: 'low', tool_count: 4 };
    expect(computeResultId(v1A, answers)).toBe('balanced');
    expect(isComplete(v1A, answers)).toBe(true);
    expect(isComplete(v1A, { ...answers, work_mode: 'hybrid', office_days: undefined } as never)).toBe(false);
  });

  it('applies result rules in priority order', () => {
    const base = { team_size: 5, work_mode: 'hybrid', priorities: ['compliance'], security_constraints: 'strict', timezone_span: 'same', office_days: 2, meeting_hours: 20, async_maturity: 'low' };
    expect(computeResultId(v3B, base)).toBe('regulated_scale');
    expect(computeResultId(v3B, { ...base, security_constraints: 'standard' })).toBe('meeting_heavy');
    expect(computeResultId(v3B, { ...base, security_constraints: 'standard', meeting_hours: 2 })).toBe('hybrid_structured');
  });

  it('validates per config rules and messages', () => {
    const steps = Object.fromEntries(v1A.steps.map((s) => [s.id, s]));
    expect(validateAnswer(steps.team_size, undefined)?.message).toBe('Enter the team size.');
    expect(validateAnswer(steps.team_size, 0)?.message).toBe('The team must have at least one person.');
    expect(validateAnswer(steps.team_size, 2.5)?.code).toBe('step');
    expect(validateAnswer(steps.team_size, 12)).toBeNull();
    expect(validateAnswer(steps.priorities, ['speed', 'focus', 'cost', 'culture'])?.message).toBe('Choose no more than three priorities.');
    expect(validateAnswer(steps.priorities, [])?.message).toBe('Choose at least one priority.');
    expect(validateAnswer(steps.work_mode, 'mars')?.code).toBe('invalid');
  });
});
