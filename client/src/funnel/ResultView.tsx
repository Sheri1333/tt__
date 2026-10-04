import type { ResultConfig, StepConfig } from '../../../shared/types';

interface Props {
  step: StepConfig;
  state: { status: 'idle' | 'loading' | 'error' | 'ready'; id?: string; data?: ResultConfig };
  expanded: boolean;
  onRetry: () => void;
  onCta: () => void;
}

export function ResultView({ step, state, expanded, onRetry, onCta }: Props) {
  const c = step.content;
  if (state.status === 'error')
    return (
      <section className="card step">
        <h1>{c.errorTitle ?? 'Could not build the result'}</h1>
        <button className="btn primary" onClick={onRetry}>{c.retryLabel ?? 'Try again'}</button>
      </section>
    );
  if (state.status !== 'ready' || !state.data)
    return (
      <section className="card step" aria-busy>
        <div className="spinner" />
        <h1>{c.loadingTitle ?? 'Loading…'}</h1>
      </section>
    );

  const r = state.data;
  return (
    <section className="card step result">
      <p className="eyebrow">Your recommendation</p>
      <h1>{r.title}</h1>
      <p className="lead">{r.summary}</p>
      {expanded ? (
        <ol className="recommendations">
          {r.recommendations.map((x) => <li key={x}>{x}</li>)}
        </ol>
      ) : (
        <button className="btn primary wide" onClick={onCta}>{r.cta.label}</button>
      )}
    </section>
  );
}
