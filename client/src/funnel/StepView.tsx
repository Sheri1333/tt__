import { useState } from 'react';
import type { AnswerValue, StepConfig } from '../../../shared/types';
import { validateAnswer } from '../../../shared/engine';

/** Generic renderer: the step's `type` picks the input, all copy comes from the config. */
export function StepView({ step, initial, onSubmit }: { step: StepConfig; initial?: AnswerValue; onSubmit: (v?: AnswerValue) => void }) {
  const [value, setValue] = useState<AnswerValue | undefined>(initial);
  const [text, setText] = useState(initial === undefined ? '' : String(initial));
  const [error, setError] = useState<string | null>(null);
  const c = step.content;

  const submit = (v: AnswerValue | undefined = value) => {
    const err = validateAnswer(step, v);
    if (err) return setError(err.message);
    setError(null);
    onSubmit(v);
  };

  let body: React.ReactNode = null;
  if (step.type === 'single-select') {
    body = (
      <div className="options" role="radiogroup" aria-label={c.title}>
        {step.input?.options?.map((o) => (
          <button
            key={o.value}
            role="radio"
            aria-checked={value === o.value}
            className={`option ${value === o.value ? 'selected' : ''}`}
            onClick={() => {
              setValue(o.value);
              setTimeout(() => submit(o.value), 160); // single choice auto-advances
            }}
          >
            <span className="radio" />
            {o.label}
          </button>
        ))}
      </div>
    );
  } else if (step.type === 'multi-select') {
    const selected = Array.isArray(value) ? value : [];
    const max = step.validation?.maxSelections ?? Infinity;
    body = (
      <>
        <div className="options" role="group" aria-label={c.title}>
          {step.input?.options?.map((o) => {
            const on = selected.includes(o.value);
            const disabled = !on && selected.length >= max;
            return (
              <button
                key={o.value}
                role="checkbox"
                aria-checked={on}
                disabled={disabled}
                className={`option ${on ? 'selected' : ''}`}
                onClick={() => {
                  setError(null);
                  setValue(on ? selected.filter((x) => x !== o.value) : [...selected, o.value]);
                }}
              >
                <span className="check">{on ? '✓' : ''}</span>
                {o.label}
              </button>
            );
          })}
        </div>
        {Number.isFinite(max) && <p className="muted small">{selected.length} of {max} selected</p>}
      </>
    );
  } else if (step.type === 'number') {
    body = (
      <form
        className="number-field"
        onSubmit={(e) => {
          e.preventDefault();
          submit(text.trim() === '' ? undefined : Number(text));
        }}
      >
        <input
          autoFocus
          inputMode="numeric"
          type="number"
          min={step.input?.min}
          max={step.input?.max}
          step={step.input?.step}
          value={text}
          aria-invalid={Boolean(error)}
          aria-describedby="step-error"
          onChange={(e) => {
            setError(null);
            setText(e.target.value);
          }}
        />
        {step.input?.unit && <span className="unit">{step.input.unit}</span>}
      </form>
    );
  }

  const ctaLabel = step.type === 'info' ? c.primaryActionLabel ?? 'Continue' : 'Continue';
  const needsButton = step.type !== 'single-select';
  return (
    <section className="card step">
      {c.eyebrow && <p className="eyebrow">{c.eyebrow}</p>}
      <h1>{c.title}</h1>
      {c.body && <p className="lead">{c.body}</p>}
      {c.helperText && <p className="muted">{c.helperText}</p>}
      {body}
      <p id="step-error" className="error" role="alert">{error ?? ''}</p>
      {needsButton && (
        <button
          className="btn primary wide"
          onClick={() => (step.type === 'number' ? submit(text.trim() === '' ? undefined : Number(text)) : submit())}
        >
          {ctaLabel}
        </button>
      )}
    </section>
  );
}
