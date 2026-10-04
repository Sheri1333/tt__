import { createRoot } from 'react-dom/client';
import { FunnelApp } from './funnel/FunnelApp';
import { AdminPage } from './admin/AdminPage';
import { Dashboard } from './dashboard/Dashboard';
import './styles.css';

// Three surfaces, routed by path. The funnel itself has no hardcoded screens:
// everything under "/" is rendered from the config the backend returns.
const path = window.location.pathname.replace(/\/+$/, '');
const page = path === '/admin' ? <AdminPage /> : path === '/dashboard' ? <Dashboard /> : <FunnelApp />;

createRoot(document.getElementById('root')!).render(page);
