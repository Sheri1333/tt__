// Pure funnel engine shared by the client (navigation/rendering), the server
// (validation/result computation) and the traffic generator.

import type {
  AnswerValue,
  Answers,
  Condition,
  FunnelConfig,
  ResolvedFunnel,
  ResultConfig,
  StepConfig,
} from './types.js';

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isObject(base) || !isObject(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isObject(v) && isObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

/** Apply the variant's order and overrides; drop everything the session cannot see. */
export function resolveFunnel(config: FunnelConfig, variant: string): ResolvedFunnel {
  const v = config.experiment.variants[variant];
  if (!v) throw new Error(`Unknown variant ${variant} for ${config.funnelId} v${config.version}`);
  const steps = v.stepSequence.map((id) => {
    const base = config.steps[id];
    if (!base) throw new Error(`Step ${id} referenced by variant ${variant} is not defined`);
    return deepMerge(base, v.stepOverrides?.[id]);
  });
  const results: Record<string, ResultConfig> = {};
  for (const [id, r] of Object.entries(config.results)) {
    results[id] = deepMerge(r, v.resultOverrides?.[id]);
  }
  return {
    funnelId: config.funnelId,
    version: config.version,
    title: config.title,
    experimentId: config.experiment.id,
    variant,
    overrideQueryParam: config.experiment.overrideQueryParam,
    progress: config.progress,
    steps,
    resultRules: config.resultRules,
    defaultResultId: config.defaultResultId,
    results,
    events: config.events,
  };
}

// ---------------------------------------------------------------- conditions

export function evaluate(cond: Condition, answers: Answers): boolean {
  if ('all' in cond) return cond.all.every((c) => evaluate(c, answers));
  if ('any' in cond) return cond.any.some((c) => evaluate(c, answers));
  if ('not' in cond) return !evaluate(cond.not, answers);
  const actual = answers[cond.answer];
  const expected = cond.value;
  if (cond.operator === 'exists') return actual !== undefined;
  if (actual === undefined) return false; // unanswered never matches
  switch (cond.operator) {
    case 'eq':
      return actual === expected;
    case 'neq':
      return actual !== expected;
    case 'in':
      return Array.isArray(expected) && expected.includes(actual as never);
    case 'nin':
      return Array.isArray(expected) && !expected.includes(actual as never);
    case 'contains':
      return Array.isArray(actual) ? actual.includes(expected as string) : actual === expected;
    case 'gt':
      return typeof actual === 'number' && actual > (expected as number);
    case 'gte':
      return typeof actual === 'number' && actual >= (expected as number);
    case 'lt':
      return typeof actual === 'number' && actual < (expected as number);
    case 'lte':
      return typeof actual === 'number' && actual <= (expected as number);
    default:
      return false;
  }
}

// ---------------------------------------------------------------- visibility

/**
 * Walk the sequence in order and keep only steps that are visible given the
 * answers of *earlier visible* steps. Answers of hidden steps (e.g. office_days
 * after switching to "remote") are ignored, so stale answers never leak into
 * branching or the result.
 */
export function walk(funnel: Pick<ResolvedFunnel, 'steps'>, answers: Answers) {
  const visible: StepConfig[] = [];
  const effective: Answers = {};
  for (const step of funnel.steps) {
    if (step.visibleWhen && !evaluate(step.visibleWhen, effective)) continue;
    visible.push(step);
    const key = step.input?.name ?? step.id;
    if (answers[key] !== undefined) effective[key] = answers[key];
  }
  return { visible, effective };
}

export const visibleSteps = (f: Pick<ResolvedFunnel, 'steps'>, a: Answers) => walk(f, a).visible;
export const effectiveAnswers = (f: Pick<ResolvedFunnel, 'steps'>, a: Answers) => walk(f, a).effective;

export function nextStepId(funnel: ResolvedFunnel, currentId: string, answers: Answers): string | null {
  const visible = visibleSteps(funnel, answers);
  const idx = visible.findIndex((s) => s.id === currentId);
  if (idx === -1) return visible[0]?.id ?? null;
  return visible[idx + 1]?.id ?? null;
}

export function isInteractive(step: StepConfig) {
  return step.type === 'single-select' || step.type === 'multi-select' || step.type === 'number';
}

/** Progress counts only steps currently reachable by this user (and not excluded types). */
export function progressOf(funnel: ResolvedFunnel, currentId: string, answers: Answers) {
  const excluded = new Set(funnel.progress.excludeTypes);
  const counted = visibleSteps(funnel, answers).filter((s) => !excluded.has(s.type));
  const idx = counted.findIndex((s) => s.id === currentId);
  // For an excluded step (intro/result) show how many counted steps are behind it.
  let position: number;
  if (idx >= 0) position = idx + 1;
  else {
    const all = visibleSteps(funnel, answers);
    const at = all.findIndex((s) => s.id === currentId);
    position = all.slice(0, Math.max(at, 0)).filter((s) => !excluded.has(s.type)).length;
  }
  return { index: position, total: counted.length };
}

// ---------------------------------------------------------------- validation

export type ValidationError = { code: string; message: string };

export function validateAnswer(step: StepConfig, value: unknown): ValidationError | null {
  const msg = (code: string, fallback: string) => ({ code, message: step.validation?.messages?.[code] ?? fallback });
  const required = step.validation?.required ?? false;
  const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);

  switch (step.type) {
    case 'info':
    case 'result':
      return null;
    case 'single-select': {
      if (empty) return required ? msg('required', 'Please choose an option.') : null;
      const ok = typeof value === 'string' && (step.input?.options ?? []).some((o) => o.value === value);
      return ok ? null : msg('invalid', 'Choose one of the listed options.');
    }
    case 'multi-select': {
      const min = step.validation?.minSelections ?? (required ? 1 : 0);
      const max = step.validation?.maxSelections ?? Infinity;
      if (empty) return min > 0 ? msg('minSelections', msg('required', 'Choose at least one option.').message) : null;
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) return msg('invalid', 'Invalid selection.');
      const allowed = new Set((step.input?.options ?? []).map((o) => o.value));
      if (value.some((v) => !allowed.has(v)) || new Set(value).size !== value.length)
        return msg('invalid', 'Choose from the listed options.');
      if (value.length < min) return msg('minSelections', `Choose at least ${min}.`);
      if (value.length > max) return msg('maxSelections', `Choose no more than ${max}.`);
      return null;
    }
    case 'number': {
      if (empty) return required ? msg('required', 'Enter a value.') : null;
      if (typeof value !== 'number' || !Number.isFinite(value)) return msg('invalid', 'Enter a number.');
      const { min, max, step: inc } = step.input ?? {};
      if (min !== undefined && value < min) return msg('min', `Enter at least ${min}.`);
      if (max !== undefined && value > max) return msg('max', `Enter at most ${max}.`);
      if (inc && Number.isInteger(inc) && !Number.isInteger(value)) return msg('step', 'Enter a whole number.');
      return null;
    }
  }
}

/** Privacy-safe description of an answer that is allowed into analytics. */
export function answerKind(step: StepConfig, value: AnswerValue | undefined): string {
  if (step.type === 'multi-select') return `multi:${Array.isArray(value) ? value.length : 0}`;
  return step.type;
}

// ---------------------------------------------------------------- result

export function computeResultId(funnel: ResolvedFunnel, answers: Answers): string {
  const eff = effectiveAnswers(funnel, answers);
  for (const rule of funnel.resultRules) {
    if (evaluate(rule.when, eff) && funnel.results[rule.resultId]) return rule.resultId;
  }
  return funnel.defaultResultId;
}

/** Every visible interactive step has a valid answer. */
export function isComplete(funnel: ResolvedFunnel, answers: Answers): boolean {
  return visibleSteps(funnel, answers)
    .filter(isInteractive)
    .every((s) => validateAnswer(s, answers[s.input?.name ?? s.id]) === null);
}

export const answerKey = (step: StepConfig) => step.input?.name ?? step.id;

/** Deterministic 32-bit FNV-1a; used for stable variant bucketing. */
export function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function pickVariant(config: FunnelConfig, sessionId: string): string {
  const entries = Object.entries(config.experiment.variants).sort(([a], [b]) => a.localeCompare(b));
  const total = entries.reduce((s, [, v]) => s + v.weight, 0);
  let bucket = fnv1a(`${config.experiment.id}:${sessionId}`) % total;
  for (const [name, v] of entries) {
    if (bucket < v.weight) return name;
    bucket -= v.weight;
  }
  return entries[0][0];
}
