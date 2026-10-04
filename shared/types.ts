// Types describing the funnel JSON config (schemaVersion 1.0) and the runtime
// objects exchanged between client and server.

export type StepType = 'info' | 'single-select' | 'multi-select' | 'number' | 'result';

export type Operator = 'eq' | 'neq' | 'in' | 'nin' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists';

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { answer: string; operator: Operator; value?: unknown };

export interface Option {
  value: string;
  label: string;
}

export interface StepContent {
  eyebrow?: string;
  title?: string;
  body?: string;
  helperText?: string;
  primaryActionLabel?: string;
  loadingTitle?: string;
  errorTitle?: string;
  retryLabel?: string;
}

export interface StepConfig {
  id: string;
  type: StepType;
  content: StepContent;
  input?: {
    name: string;
    options?: Option[];
    min?: number;
    max?: number;
    step?: number;
    unit?: string;
  };
  validation?: {
    required?: boolean;
    minSelections?: number;
    maxSelections?: number;
    messages?: Record<string, string>;
  };
  visibleWhen?: Condition;
  resultSource?: string;
}

export interface Cta {
  label: string;
  action: string;
}

export interface ResultConfig {
  id: string;
  title: string;
  summary: string;
  recommendations: string[];
  cta: Cta;
}

export interface VariantConfig {
  weight: number;
  stepSequence: string[];
  stepOverrides: Record<string, Partial<StepConfig>>;
  resultOverrides: Record<string, Partial<ResultConfig>>;
}

export interface EventDefinition {
  name: string;
  trigger?: string;
  properties: string[];
}

export interface FunnelConfig {
  schemaVersion: string;
  funnelId: string;
  version: number;
  status?: string;
  locale?: string;
  title: string;
  description?: string;
  releaseNote?: string;
  session: { ttlHours: number; persistAnswers: boolean; pinVersion: boolean; pinExperimentVariant: boolean };
  progress: { countVisibleOnly: boolean; excludeTypes: StepType[] };
  experiment: {
    id: string;
    assignment: 'server';
    sticky: boolean;
    overrideQueryParam: string;
    variants: Record<string, VariantConfig>;
  };
  steps: Record<string, StepConfig>;
  resultRules: { resultId: string; when: Condition }[];
  defaultResultId: string;
  results: Record<string, ResultConfig>;
  events: {
    baseProperties: string[];
    allowed: EventDefinition[];
    privacy: { storeRawAnswers: boolean; allowAnswerKinds: boolean };
  };
}

/**
 * The config a single session actually runs: one variant, overrides applied,
 * steps listed in that variant's order. The other variant is never sent to the client.
 */
export interface ResolvedFunnel {
  funnelId: string;
  version: number;
  title: string;
  experimentId: string;
  variant: string;
  overrideQueryParam: string;
  progress: FunnelConfig['progress'];
  steps: StepConfig[];
  resultRules: FunnelConfig['resultRules'];
  defaultResultId: string;
  results: Record<string, ResultConfig>;
  events: FunnelConfig['events'];
}

export type AnswerValue = string | number | string[];
export type Answers = Record<string, AnswerValue>;

export interface SessionState {
  answers: Answers;
  /** Stack of visited step ids; last element is the current step. */
  path: string[];
  resultId?: string | null;
  ctaClicked?: boolean;
}

export interface Utm {
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
}

export interface SessionDto {
  id: string;
  funnelId: string;
  version: number;
  experimentId: string;
  variant: string;
  variantSource: 'hash' | 'override';
  utm: Utm;
  state: SessionState;
  createdAt: string;
  expiresAt: string;
}

export interface ClientEvent {
  event_id: string;
  session_id: string;
  name: string;
  client_timestamp: string;
  funnel_id?: string;
  funnel_version?: number;
  experiment_id?: string;
  variant?: string;
  step_id?: string | null;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  properties?: Record<string, unknown>;
}

export interface IngestResult {
  accepted: string[];
  duplicates: string[];
  rejected: { index: number; event_id: string | null; reason: string }[];
}
