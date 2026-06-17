import { useEffect, useState } from 'react';

/**
 * Minimal landing page that calls the backend health endpoint, proving the
 * frontend <-> backend wiring works end to end.
 */
export default function App() {
  const [health, setHealth] = useState<string>('checking…');

  useEffect(() => {
    fetch('/api/health')
      .then((res) => res.json())
      .then((data) => setHealth(data.status ?? 'unknown'))
      .catch(() => setHealth('unreachable'));
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
      <h1>Websol CRM</h1>
      <p>Printer leasing (Managed Print Services) system.</p>
      <p>
        Backend health: <strong>{health}</strong>
      </p>
    </main>
  );
}
