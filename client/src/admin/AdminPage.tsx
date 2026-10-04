import { useCallback, useEffect, useState } from 'react';
import { ApiError, adminToken, http } from '../api';
import { InternalNav, TokenGate } from '../internal';

interface FunnelInfo {
  funnelId: string;
  activeVersion: number | null;
  rollbackTarget: number | null;
  versions: { version: number; releaseNote: string | null; createdAt: string; checksum: string; active: boolean; sessions: number }[];
  log: { action: string; from: number | null; to: number; at: string }[];
}
interface Bundled {
  file: string;
  funnelId: string;
  version: number;
  releaseNote: string | null;
  config: unknown;
}

const FUNNEL = 'workstyle-planner';

export function AdminPage() {
  const [info, setInfo] = useState<FunnelInfo | null>(null);
  const [bundled, setBundled] = useState<Bundled[]>([]);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string; details?: string[] } | null>(null);
  const [needToken, setNeedToken] = useState(false);
  const [json, setJson] = useState('');
  const [viewing, setViewing] = useState<{ version: number; json: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [i, b] = await Promise.all([
        http<FunnelInfo>('GET', `/api/admin/funnels/${FUNNEL}`),
        http<Bundled[]>('GET', '/api/admin/bundled-configs'),
      ]);
      setInfo(i);
      setBundled(b);
      setNeedToken(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setNeedToken(true);
      else setMsg({ kind: 'err', text: (e as Error).message });
    }
  }, []);
  useEffect(() => void load(), [load]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      setMsg({ kind: 'ok', text: label });
    } catch (e) {
      const err = e as ApiError;
      setMsg({ kind: 'err', text: err.message, details: Array.isArray(err.details) ? (err.details as string[]) : undefined });
    }
    await load();
  };

  const upload = (config: unknown, publish: boolean) =>
    run(publish ? 'Uploaded and published' : 'Uploaded (not active yet)', () =>
      http('POST', `/api/admin/versions${publish ? '?publish=true' : ''}`, config),
    );

  if (needToken) return <TokenGate onSubmit={(t) => { adminToken.set(t); void load(); }} />;

  const known = new Set(info?.versions.map((v) => v.version));
  return (
    <div className="internal">
      <InternalNav current="admin" />
      <h1>Funnel versions</h1>
      {msg && (
        <div className={`notice ${msg.kind}`}>
          {msg.text}
          {msg.details && <ul>{msg.details.map((d) => <li key={d}>{d}</li>)}</ul>}
        </div>
      )}
      {info && (
        <>
          <section className="panel row">
            <div>
              <div className="muted small">Active version for new sessions</div>
              <div className="hero">v{info.activeVersion ?? '—'}</div>
              <div className="muted small">Running sessions stay on the version they started with.</div>
            </div>
            <div className="actions">
              <button
                className="btn"
                disabled={info.rollbackTarget === null}
                onClick={() =>
                  confirm(`Roll back from v${info.activeVersion} to v${info.rollbackTarget}? New sessions will start on v${info.rollbackTarget}.`) &&
                  run(`Rolled back to v${info.rollbackTarget}`, () => http('POST', `/api/admin/funnels/${FUNNEL}/rollback`))
                }
              >
                ↶ Roll back{info.rollbackTarget !== null ? ` to v${info.rollbackTarget}` : ''}
              </button>
              <a className="btn ghost" href="/?variant=A" target="_blank">Open as A ↗</a>
              <a className="btn ghost" href="/?variant=B" target="_blank">Open as B ↗</a>
            </div>
          </section>

          <section className="panel">
            <h2>Stored versions</h2>
            <table className="table">
              <thead>
                <tr><th>Version</th><th>Release note</th><th>Sessions</th><th>Uploaded</th><th>Checksum</th><th /></tr>
              </thead>
              <tbody>
                {info.versions.map((v) => (
                  <tr key={v.version}>
                    <td>v{v.version} {v.active && <span className="badge good">active</span>}</td>
                    <td>{v.releaseNote ?? <span className="muted">—</span>}</td>
                    <td className="num">{v.sessions}</td>
                    <td className="small">{new Date(v.createdAt).toLocaleString()}</td>
                    <td className="mono small">{v.checksum}</td>
                    <td className="actions">
                      <button className="btn small" onClick={async () => setViewing({ version: v.version, json: JSON.stringify(await http('GET', `/api/admin/funnels/${FUNNEL}/versions/${v.version}`), null, 2) })}>
                        View
                      </button>
                      {!v.active && (
                        <button className="btn small primary" onClick={() => run(`Published v${v.version}`, () => http('POST', `/api/admin/funnels/${FUNNEL}/versions/${v.version}/publish`))}>
                          Publish
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {viewing && (
              <details open className="config-view">
                <summary>v{viewing.version} config <button className="link" onClick={() => setViewing(null)}>close</button></summary>
                <pre>{viewing.json}</pre>
              </details>
            )}
          </section>

          <section className="panel">
            <h2>Upload a new version</h2>
            <p className="muted small">Configs are validated (schema + references) and stored immutably. Publishing switches new sessions instantly — no redeploy.</p>
            <div className="bundled">
              {bundled.map((b) => (
                <div key={b.file} className="bundled-item">
                  <div>
                    <strong>{b.file}</strong> <span className="muted">v{b.version}</span>
                    {known.has(b.version) && <span className="badge">stored</span>}
                    <div className="muted small">{b.releaseNote ?? 'Initial version'}</div>
                  </div>
                  <div className="actions">
                    <button className="btn small" onClick={() => setJson(JSON.stringify(b.config, null, 2))}>Edit</button>
                    <button className="btn small primary" onClick={() => upload(b.config, true)}>Upload &amp; publish</button>
                  </div>
                </div>
              ))}
            </div>
            <textarea className="mono" rows={10} placeholder="Paste a funnel config JSON…" value={json} onChange={(e) => setJson(e.target.value)} />
            <div className="actions">
              <label className="btn small">
                Load file…
                <input type="file" accept="application/json" hidden onChange={async (e) => setJson(await e.target.files?.[0]?.text() ?? '')} />
              </label>
              <button className="btn" disabled={!json} onClick={() => parseAnd(json, (c) => upload(c, false), setMsg)}>Upload</button>
              <button className="btn primary" disabled={!json} onClick={() => parseAnd(json, (c) => upload(c, true), setMsg)}>Upload &amp; publish</button>
            </div>
          </section>

          <section className="panel">
            <h2>Release log</h2>
            <table className="table">
              <thead><tr><th>When</th><th>Action</th><th>From</th><th>To</th></tr></thead>
              <tbody>
                {info.log.map((l, i) => (
                  <tr key={i}>
                    <td className="small">{new Date(l.at).toLocaleString()}</td>
                    <td><span className={`badge ${l.action === 'rollback' ? 'warn' : ''}`}>{l.action}</span></td>
                    <td>{l.from ? `v${l.from}` : '—'}</td>
                    <td>v{l.to}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}

function parseAnd(text: string, fn: (c: unknown) => void, setMsg: (m: { kind: 'err'; text: string }) => void) {
  try {
    fn(JSON.parse(text));
  } catch (e) {
    setMsg({ kind: 'err', text: `Invalid JSON: ${(e as Error).message}` });
  }
}
