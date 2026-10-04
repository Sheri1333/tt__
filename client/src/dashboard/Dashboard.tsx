import { useCallback, useEffect, useState } from 'react';
import { ApiError, adminToken, http } from '../api';
import { InternalNav, TokenGate, pct } from '../internal';

interface Core { started: number; reachedResult: number; ctaClicked: number; completionRate: number; ctr: number; startToCta: number }
interface Step {
  stepId: string; type: string; conditional: boolean; reached: number; completed: number; droppedHere: number;
  backClicks: number; views: number; reachedPctOfStarted: number; stepConversion: number; dropOffRate: number;
}
interface VariantReport { variant: string; metrics: Core; steps: Step[]; events: Record<string, { events: number; sessions: number }> }
interface Report {
  filters: { version: number | null; campaign: string | null; excludeOverrides: boolean };
  activeVersion: number | null;
  campaigns: string[];
  totals: Core;
  rawEventCount: number;
  versions: { version: number; active: boolean; total: Core; variants: Record<string, Core> }[];
  experiment: {
    version: number; experimentId: string; variants: VariantReport[];
    tests: Record<'startToCta' | 'completionRate' | 'ctr', { z: number; p: number }> | null;
  } | null;
}

const VARIANT_CLASS: Record<string, string> = { A: 'va', B: 'vb' };

export function Dashboard() {
  const params = new URLSearchParams(location.search);
  const [version, setVersion] = useState(params.get('version') ?? '');
  const [campaign, setCampaign] = useState(params.get('campaign') ?? '');
  const [excludeOverrides, setExclude] = useState(params.get('excludeOverrides') === 'true');
  const [auto, setAuto] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [needToken, setNeedToken] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const q = new URLSearchParams();
    if (version) q.set('version', version);
    if (campaign) q.set('campaign', campaign);
    if (excludeOverrides) q.set('excludeOverrides', 'true');
    history.replaceState(null, '', `/dashboard${q.size ? `?${q}` : ''}`);
    try {
      setReport(await http<Report>('GET', `/api/admin/analytics?${q}`));
      setNeedToken(false);
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setNeedToken(true);
      else setError((e as Error).message);
    }
  }, [version, campaign, excludeOverrides]);

  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [auto, load]);

  if (needToken) return <TokenGate onSubmit={(t) => { adminToken.set(t); void load(); }} />;

  const exp = report?.experiment;
  return (
    <div className="internal wide">
      <InternalNav current="dashboard" />
      <h1>Funnel analytics</h1>
      <p className="muted small">All numbers are unique sessions. Duplicate event_ids are dropped at ingest; repeated views, back-navigation and out-of-order events don't inflate counts.</p>

      <div className="filters">
        <label>Version
          <select value={version} onChange={(e) => setVersion(e.target.value)}>
            <option value="">Active (v{report?.activeVersion ?? '…'})</option>
            {report?.versions.map((v) => <option key={v.version} value={v.version}>v{v.version}{v.active ? ' (active)' : ''}</option>)}
          </select>
        </label>
        <label>UTM campaign
          <select value={campaign} onChange={(e) => setCampaign(e.target.value)}>
            <option value="">All campaigns</option>
            {report?.campaigns.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="check-label"><input type="checkbox" checked={excludeOverrides} onChange={(e) => setExclude(e.target.checked)} /> Exclude QA overrides (?variant=)</label>
        <label className="check-label"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto-refresh</label>
        <button className="btn small" onClick={load}>Refresh</button>
      </div>
      {error && <div className="notice err">{error}</div>}
      {report && (
        <>
          <section>
            <h2>All versions{campaign ? ` · ${campaign}` : ''}</h2>
            <div className="tiles">
              <Tile label="Started" value={report.totals.started} />
              <Tile label="Reached result" value={report.totals.reachedResult} sub={pct(report.totals.completionRate)} />
              <Tile label="CTA clicks" value={report.totals.ctaClicked} sub={`CTR ${pct(report.totals.ctr)}`} />
              <Tile label="Start → CTA" value={pct(report.totals.startToCta)} sub="primary metric" />
              <Tile label="Stored events" value={report.rawEventCount} sub="after dedup" />
            </div>
          </section>

          {exp && (
            <section className="panel">
              <h2>Experiment <span className="mono small">{exp.experimentId}</span> · v{exp.version}</h2>
              <AbTable variants={exp.variants} tests={exp.tests} />
            </section>
          )}

          {exp && (
            <section>
              <h2>Step funnel · v{exp.version}</h2>
              <p className="muted small">
                Reached = sessions with any evidence of the step. → Next = share of them that moved past it. Drop-off = sessions whose furthest step is this one and that never saw the result.
                <span className="badge">if</span> marks conditional steps (shown only on some branches).
              </p>
              <div className="variant-grid">
                {exp.variants.map((v) => <StepTable key={v.variant} v={v} />)}
              </div>
            </section>
          )}

          <section className="panel">
            <h2>Versions</h2>
            <table className="table">
              <thead>
                <tr><th>Version</th><th className="num">Started</th><th className="num">Reached result</th><th className="num">CTR</th><th className="num">Start → CTA</th><th>By variant (started · start→CTA)</th></tr>
              </thead>
              <tbody>
                {report.versions.map((v) => (
                  <tr key={v.version}>
                    <td>v{v.version} {v.active && <span className="badge good">active</span>}</td>
                    <td className="num">{v.total.started}</td>
                    <td className="num">{v.total.reachedResult} <span className="muted">({pct(v.total.completionRate)})</span></td>
                    <td className="num">{pct(v.total.ctr)}</td>
                    <td className="num"><strong>{pct(v.total.startToCta)}</strong></td>
                    <td>
                      {Object.entries(v.variants).sort().map(([name, m]) => (
                        <span key={name} className="chip"><i className={`dot ${VARIANT_CLASS[name] ?? ''}`} />{name}: {m.started} · {pct(m.startToCta)}</span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {exp && (
            <section className="panel">
              <h2>Event volume vs unique sessions · v{exp.version}</h2>
              <table className="table">
                <thead><tr><th>Event</th>{exp.variants.map((v) => <th key={v.variant} className="num">{v.variant}: events / sessions</th>)}</tr></thead>
                <tbody>
                  {[...new Set(exp.variants.flatMap((v) => Object.keys(v.events)))].sort().map((name) => (
                    <tr key={name}>
                      <td className="mono">{name}</td>
                      {exp.variants.map((v) => (
                        <td key={v.variant} className="num">{v.events[name]?.events ?? 0} / {v.events[name]?.sessions ?? 0}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className="tile">
      <div className="muted small">{label}</div>
      <div className="tile-value">{value}</div>
      {sub && <div className="muted small">{sub}</div>}
    </div>
  );
}

function AbTable({ variants, tests }: { variants: VariantReport[]; tests: NonNullable<Report['experiment']>['tests'] }) {
  const [a, b] = variants;
  const rows: { key: keyof Core; label: string; rate: boolean; test?: keyof NonNullable<typeof tests>; primary?: boolean }[] = [
    { key: 'started', label: 'Started', rate: false },
    { key: 'reachedResult', label: 'Reached result', rate: false },
    { key: 'ctaClicked', label: 'CTA clicked', rate: false },
    { key: 'startToCta', label: 'Start → CTA (primary)', rate: true, test: 'startToCta', primary: true },
    { key: 'completionRate', label: 'Completion rate', rate: true, test: 'completionRate' },
    { key: 'ctr', label: 'Result → CTA (CTR)', rate: true, test: 'ctr' },
  ];
  return (
    <table className="table">
      <thead>
        <tr><th>Metric</th>{variants.map((v) => <th key={v.variant} className="num"><i className={`dot ${VARIANT_CLASS[v.variant] ?? ''}`} />{v.variant}</th>)}<th className="num">Δ B vs A</th><th className="num">p-value</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const va = a?.metrics[r.key] ?? 0;
          const vb = b?.metrics[r.key] ?? 0;
          const t = r.test && tests ? tests[r.test] : null;
          return (
            <tr key={r.key} className={r.primary ? 'primary-row' : ''}>
              <td>{r.label}</td>
              {variants.map((v) => <td key={v.variant} className="num">{r.rate ? pct(v.metrics[r.key]) : v.metrics[r.key]}</td>)}
              <td className="num">{r.rate && b ? `${vb - va >= 0 ? '+' : ''}${((vb - va) * 100).toFixed(1)} pp` : ''}</td>
              <td className="num">{t ? <span className={t.p < 0.05 ? 'sig' : 'muted'}>{t.p < 0.001 ? '<0.001' : t.p.toFixed(3)}</span> : ''}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function StepTable({ v }: { v: VariantReport }) {
  const started = v.metrics.started;
  return (
    <div className="panel">
      <h3><i className={`dot ${VARIANT_CLASS[v.variant] ?? ''}`} />Variant {v.variant} <span className="muted small">· {started} started</span></h3>
      <table className="table steps">
        <thead>
          <tr><th>Step</th><th>Reached</th><th className="num">→ Next</th><th className="num">Drop-off</th><th className="num">Back</th><th className="num" title="Raw step_viewed events (incl. refresh/back repeats)">Views</th></tr>
        </thead>
        <tbody>
          {v.steps.map((s) => (
            <tr key={s.stepId}>
              <td className="mono small">{s.stepId} {s.conditional && <span className="badge" title="Conditional step">if</span>}</td>
              <td>
                <div className="bar" title={`${s.reached} of ${started} sessions (${pct(s.reachedPctOfStarted)})`}>
                  <div className={`bar-fill ${VARIANT_CLASS[v.variant] ?? ''}`} style={{ width: pct(s.reachedPctOfStarted) }} />
                  <span>{s.reached} <span className="muted">· {pct(s.reachedPctOfStarted, 0)}</span></span>
                </div>
              </td>
              <td className="num">{s.type === 'result' ? '—' : pct(s.stepConversion)}</td>
              <td className="num">{s.type === 'result' ? '—' : <>{s.droppedHere} <span className="muted">({pct(s.dropOffRate, 0)})</span></>}</td>
              <td className="num">{s.backClicks || ''}</td>
              <td className="num muted">{s.views}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
