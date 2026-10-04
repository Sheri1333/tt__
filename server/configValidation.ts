import { z } from 'zod';
import type { Condition, FunnelConfig } from '../shared/types.js';
import { resolveFunnel } from '../shared/engine.js';

const condition: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(condition) }),
    z.object({ any: z.array(condition) }),
    z.object({ not: condition }),
    z.object({
      answer: z.string(),
      operator: z.enum(['eq', 'neq', 'in', 'nin', 'contains', 'gt', 'gte', 'lt', 'lte', 'exists']),
      value: z.unknown().optional(),
    }),
  ]),
) as z.ZodType<Condition>;

const step = z
  .object({
    id: z.string(),
    type: z.enum(['info', 'single-select', 'multi-select', 'number', 'result']),
    content: z.record(z.string(), z.string()),
    input: z
      .object({
        name: z.string(),
        options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
        min: z.number().optional(),
        max: z.number().optional(),
        step: z.number().optional(),
        unit: z.string().optional(),
      })
      .optional(),
    validation: z.record(z.string(), z.unknown()).optional(),
    visibleWhen: condition.optional(),
  })
  .loose();

const result = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  recommendations: z.array(z.string()),
  cta: z.object({ label: z.string(), action: z.string() }),
});

const schema = z
  .object({
    schemaVersion: z.literal('1.0'),
    funnelId: z.string().regex(/^[a-z0-9-]+$/),
    version: z.number().int().positive(),
    title: z.string(),
    session: z.object({
      ttlHours: z.number().positive(),
      persistAnswers: z.boolean(),
      pinVersion: z.boolean(),
      pinExperimentVariant: z.boolean(),
    }),
    progress: z.object({ countVisibleOnly: z.boolean(), excludeTypes: z.array(z.string()) }),
    experiment: z.object({
      id: z.string(),
      assignment: z.literal('server'),
      sticky: z.boolean(),
      overrideQueryParam: z.string(),
      variants: z.record(
        z.string(),
        z.object({
          weight: z.number().nonnegative(),
          stepSequence: z.array(z.string()).min(1),
          stepOverrides: z.record(z.string(), z.unknown()).default({}),
          resultOverrides: z.record(z.string(), z.unknown()).default({}),
        }),
      ),
    }),
    steps: z.record(z.string(), step),
    resultRules: z.array(z.object({ resultId: z.string(), when: condition })),
    defaultResultId: z.string(),
    results: z.record(z.string(), result),
    events: z.object({
      baseProperties: z.array(z.string()),
      allowed: z.array(z.object({ name: z.string(), trigger: z.string().optional(), properties: z.array(z.string()) })),
      privacy: z.object({ storeRawAnswers: z.boolean(), allowAnswerKinds: z.boolean() }),
    }),
  })
  .loose();

const REQUIRED_EVENTS = [
  'session_started',
  'step_viewed',
  'answer_submitted',
  'step_completed',
  'back_clicked',
  'result_viewed',
  'cta_clicked',
];

/** Structural (zod) + semantic validation. Returns a list of human-readable problems. */
export function validateConfig(raw: unknown): { ok: true; config: FunnelConfig } | { ok: false; errors: string[] } {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  }
  const cfg = parsed.data as unknown as FunnelConfig;
  const errors: string[] = [];

  for (const [key, s] of Object.entries(cfg.steps)) {
    if (s.id !== key) errors.push(`steps.${key}: id "${s.id}" does not match its key`);
    if ((s.type === 'single-select' || s.type === 'multi-select') && !s.input?.options?.length)
      errors.push(`steps.${key}: select step needs input.options`);
    if (s.type === 'number' && !s.input) errors.push(`steps.${key}: number step needs input`);
  }
  const variants = Object.entries(cfg.experiment.variants);
  if (variants.length < 1) errors.push('experiment.variants: at least one variant is required');
  if (variants.reduce((s, [, v]) => s + v.weight, 0) <= 0) errors.push('experiment.variants: weights must sum to > 0');
  for (const [name, v] of variants) {
    const seen = new Set<string>();
    for (const id of v.stepSequence) {
      if (!cfg.steps[id]) errors.push(`variant ${name}: unknown step "${id}"`);
      if (seen.has(id)) errors.push(`variant ${name}: duplicate step "${id}"`);
      seen.add(id);
    }
    const last = cfg.steps[v.stepSequence[v.stepSequence.length - 1]];
    if (last && last.type !== 'result') errors.push(`variant ${name}: sequence must end with a result step`);
    for (const id of Object.keys(v.stepOverrides ?? {}))
      if (!cfg.steps[id]) errors.push(`variant ${name}: override for unknown step "${id}"`);
    for (const id of Object.keys(v.resultOverrides ?? {}))
      if (!cfg.results[id]) errors.push(`variant ${name}: override for unknown result "${id}"`);
    if (!errors.length) {
      try {
        resolveFunnel(cfg, name);
      } catch (e) {
        errors.push(String(e));
      }
    }
  }
  for (const r of cfg.resultRules) if (!cfg.results[r.resultId]) errors.push(`resultRules: unknown result "${r.resultId}"`);
  if (!cfg.results[cfg.defaultResultId]) errors.push(`defaultResultId: unknown result "${cfg.defaultResultId}"`);
  const names = new Set(cfg.events.allowed.map((e) => e.name));
  for (const n of REQUIRED_EVENTS) if (!names.has(n)) errors.push(`events.allowed: missing required event "${n}"`);

  return errors.length ? { ok: false, errors } : { ok: true, config: cfg };
}
