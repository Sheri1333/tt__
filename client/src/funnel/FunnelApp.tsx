import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnswerValue, ResolvedFunnel, ResultConfig, SessionDto, SessionState } from '../../../shared/types';
import { answerKey, answerKind, isInteractive, nextStepId, progressOf, validateAnswer } from '../../../shared/engine';
import { api, safe } from '../api';
import { bindSession, supportsEvent, track } from '../tracker';
import { StepView } from './StepView';
import { ResultView } from './ResultView';

const SESSION_KEY = 'funnel:session';
const mirrorKey = (sid: string) => `funnel:state:${sid}`;

type Boot = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; session: SessionDto; funnel: ResolvedFunnel };

/**
 * State model:
 *  - server is the source of truth (answers + path are saved on every navigation,
 *    so refresh / reopening the tab / another device with the same id resumes exactly);
 *  - a localStorage mirror marked `dirty` covers the window where a save is in flight
 *    or failed (offline) — on next boot the dirty mirror wins and is re-saved;
 *  - browser Back is wired through history.pushState so it behaves like the in-app Back.
 */
export function FunnelApp() {
  const [boot, setBoot] = useState<Boot>({ status: 'loading' });
  const [state, setState] = useState<SessionState | null>(null);
  const stateRef = useRef<SessionState | null>(null);
  const bootDepth = useRef(1);

  const start = useCallback(async (fresh = false) => {
    setBoot({ status: 'loading' });
    const params = new URLSearchParams(location.search);
    const utm = Object.fromEntries(['utm_source', 'utm_medium', 'utm_campaign'].map((k) => [k, params.get(k)]));
    try {
      const stored = fresh ? null : safe(() => localStorage.getItem(SESSION_KEY));
      const env = await api.resume({ sessionId: stored, utm, variant: params.get('variant') });
      safe(() => localStorage.setItem(SESSION_KEY, env.session.id));
      let st = env.session.state;
      const mirror = safe(() => JSON.parse(localStorage.getItem(mirrorKey(env.session.id)) ?? 'null')) as
        | { dirty: boolean; state: SessionState }
        | null;
      if (mirror?.dirty) st = mirror.state;
      bindSession(env.session, env.funnel.events.allowed.map((e) => e.name));
      stateRef.current = st;
      setState(st);
      bootDepth.current = st.path.length;
      history.replaceState({ depth: st.path.length }, '');
      setBoot({ status: 'ready', session: env.session, funnel: env.funnel });
      if (mirror?.dirty) void persist(env.session.id, st);
    } catch (e) {
      setBoot({ status: 'error', message: (e as Error).message });
    }
  }, []);

  useEffect(() => {
    void start();
  }, [start]);

  const session = boot.status === 'ready' ? boot.session : null;
  const funnel = boot.status === 'ready' ? boot.funnel : null;

  // ------------------------------------------------------------ persistence
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  async function persist(sid: string, st: SessionState) {
    safe(() => localStorage.setItem(mirrorKey(sid), JSON.stringify({ dirty: true, state: st })));
    try {
      await api.saveState(sid, st);
      if (stateRef.current === st) safe(() => localStorage.setItem(mirrorKey(sid), JSON.stringify({ dirty: false, state: st })));
    } catch {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => stateRef.current && persist(sid, stateRef.current), 3000);
    }
  }

  const commit = useCallback(
    (next: SessionState) => {
      stateRef.current = next;
      setState(next);
      if (session) void persist(session.id, next);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session],
  );

  // ------------------------------------------------------------ navigation
  const current = funnel && state ? funnel.steps.find((s) => s.id === state.path[state.path.length - 1]) ?? funnel.steps[0] : null;

  const goNext = (value?: AnswerValue) => {
    if (!funnel || !state || !current) return;
    let answers = state.answers;
    if (isInteractive(current)) {
      if (validateAnswer(current, value)) return;
      answers = { ...answers, [answerKey(current)]: value! };
      track('answer_submitted', current.id, { answer_kind: answerKind(current, value) });
    }
    const next = nextStepId(funnel, current.id, answers);
    if (!next) return;
    if (isInteractive(current)) track('step_completed', current.id, { next_step_id: next });
    const path = [...state.path, next];
    commit({ ...state, answers, path, resultId: null, ctaClicked: false });
    history.pushState({ depth: path.length }, '');
  };

  const backTo = useCallback(
    (depth: number) => {
      const st = stateRef.current;
      if (!st || depth < 1 || depth >= st.path.length) return;
      const from = st.path[st.path.length - 1];
      const path = st.path.slice(0, depth);
      track('back_clicked', from, { destination_step_id: path[path.length - 1] });
      commit({ ...st, path, resultId: null, ctaClicked: false });
    },
    [commit],
  );

  const onBackClick = () => {
    const st = stateRef.current;
    if (!st || st.path.length <= 1) return;
    // Entries pushed during this page load can be popped natively (keeps browser history in sync).
    if (st.path.length > bootDepth.current && history.state?.depth === st.path.length) history.back();
    else {
      backTo(st.path.length - 1);
      bootDepth.current = st.path.length - 1;
      history.replaceState({ depth: st.path.length - 1 }, '');
    }
  };

  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const st = stateRef.current;
      const depth = (e.state as { depth?: number } | null)?.depth;
      if (!st || typeof depth !== 'number') return;
      if (depth < st.path.length) backTo(depth);
      else if (depth > st.path.length) history.back(); // forward into a discarded branch: undo it
    };
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, [backTo]);

  // ------------------------------------------------------------ tracking: step_viewed
  const answersForProgress = state?.answers ?? {};
  const progress = funnel && current ? progressOf(funnel, current.id, answersForProgress) : null;
  useEffect(() => {
    if (!current || !progress || !session) return;
    track('step_viewed', current.id, {
      step_type: current.type,
      visible_step_index: progress.index,
      visible_step_count: progress.total,
    });
    window.scrollTo({ top: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, session?.id, state?.path.length]);

  // ------------------------------------------------------------ result
  const [result, setResult] = useState<{ status: 'idle' | 'loading' | 'error' | 'ready'; id?: string; data?: ResultConfig }>({ status: 'idle' });
  const loadResult = useCallback(async () => {
    if (!session) return;
    setResult({ status: 'loading' });
    try {
      // make sure the server has the latest answers before computing
      if (stateRef.current) await api.saveState(session.id, stateRef.current);
      const r = await api.result(session.id);
      setResult({ status: 'ready', id: r.resultId, data: funnel?.results[r.resultId] ?? r.result });
      track('result_viewed', 'result', { result_id: r.resultId });
      if (stateRef.current) {
        const next = { ...stateRef.current, resultId: r.resultId };
        stateRef.current = next;
        setState(next);
      }
    } catch {
      setResult({ status: 'error' });
    }
  }, [session, funnel]);

  useEffect(() => {
    if (current?.type === 'result') void loadResult();
    else setResult({ status: 'idle' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, session?.id]);

  const onCta = () => {
    if (!state || !result.id || !result.data) return;
    const { action } = result.data.cta;
    track('cta_clicked', 'result', { result_id: result.id, action });
    if (action === 'expand_recommendation' && supportsEvent('recommendation_expanded'))
      track('recommendation_expanded', 'result', { result_id: result.id, action, source: 'cta' });
    commit({ ...state, ctaClicked: true });
  };

  // ------------------------------------------------------------ render
  if (boot.status === 'loading') return <Shell><div className="card muted">Loading…</div></Shell>;
  if (boot.status === 'error')
    return (
      <Shell>
        <div className="card">
          <h1>Something went wrong</h1>
          <p className="muted">{boot.message}</p>
          <button className="btn primary" onClick={() => start()}>Try again</button>
        </div>
      </Shell>
    );
  if (!funnel || !state || !current || !session) return null;

  const showProgress = current.type !== 'info';
  return (
    <Shell
      footer={
        <>
          <span title="Pinned funnel version · experiment variant · session">
            v{session.version} · variant {session.variant} · {session.id.slice(0, 8)}
          </span>
          <button className="link" onClick={() => { safe(() => localStorage.removeItem(SESSION_KEY)); void start(true); }}>
            Start over
          </button>
        </>
      }
    >
      <div className="topbar">
        {state.path.length > 1 ? (
          <button className="btn ghost" onClick={onBackClick} aria-label="Back">← Back</button>
        ) : <span />}
        {showProgress && progress && progress.total > 0 && current.type !== 'result' && (
          <span className="muted small">{progress.index} of {progress.total}</span>
        )}
      </div>
      {showProgress && progress && (
        <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.index}>
          <div style={{ width: `${current.type === 'result' ? 100 : (100 * Math.max(progress.index - 1, 0)) / Math.max(progress.total, 1)}%` }} />
        </div>
      )}
      {current.type === 'result' ? (
        <ResultView step={current} state={result} expanded={Boolean(state.ctaClicked)} onRetry={loadResult} onCta={onCta} />
      ) : (
        <StepView key={current.id} step={current} initial={state.answers[answerKey(current)]} onSubmit={goNext} />
      )}
    </Shell>
  );
}

function Shell({ children, footer }: { children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="funnel">
      <main className="funnel-main">{children}</main>
      {footer && <footer className="funnel-footer muted small">{footer}</footer>}
    </div>
  );
}
