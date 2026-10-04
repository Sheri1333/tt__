import { useState } from 'react';

export function InternalNav({ current }: { current: 'admin' | 'dashboard' }) {
  return (
    <nav className="internal-nav">
      <strong>Funnel platform</strong>
      <a href="/admin" className={current === 'admin' ? 'on' : ''}>Versions</a>
      <a href="/dashboard" className={current === 'dashboard' ? 'on' : ''}>Analytics</a>
      <a href="/" target="_blank">Funnel ↗</a>
    </nav>
  );
}

export function TokenGate({ onSubmit }: { onSubmit: (t: string) => void }) {
  const [t, setT] = useState('');
  return (
    <div className="internal">
      <form className="panel" onSubmit={(e) => { e.preventDefault(); onSubmit(t); }}>
        <h1>Internal access</h1>
        <p className="muted">Enter the admin token (ADMIN_TOKEN on the server).</p>
        <input type="password" value={t} onChange={(e) => setT(e.target.value)} autoFocus />
        <button className="btn primary">Continue</button>
      </form>
    </div>
  );
}

export const pct = (x: number, digits = 1) => `${(x * 100).toFixed(digits)}%`;
