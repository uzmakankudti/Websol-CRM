/**
 * App shell. Decides what to render based on auth state:
 *   - not signed in            -> Login
 *   - must change password     -> forced ChangePassword
 *   - signed in                -> sidebar + the selected screen
 *
 * The sidebar only shows nav items the user's permissions allow, so each role
 * sees only what it should. The backend enforces the same permissions.
 */
import { useState } from 'react';
import { AuthProvider } from './auth/AuthContext';
import { useAuth } from './auth/context';
import Login from './auth/Login';
import ChangePassword from './auth/ChangePassword';
import UsersPage from './pages/UsersPage';
import AuditPage from './pages/AuditPage';
import LeadsPage from './pages/LeadsPage';
import CustomersPage from './pages/CustomersPage';
import ContractsPage from './pages/ContractsPage';
import PrintersPage from './pages/PrintersPage';
import InventoryPage from './pages/InventoryPage';
import DispatchPage from './pages/DispatchPage';
import HelpdeskPage from './pages/HelpdeskPage';
import TonerPage from './pages/TonerPage';
import BillingPage from './pages/BillingPage';
import CustomerPortal from './portal/CustomerPortal';
import { PERM } from './types';

type View = 'leads' | 'customers' | 'contracts' | 'printers' | 'inventory' | 'dispatch' | 'helpdesk' | 'toner' | 'billing' | 'users' | 'audit' | 'password';

function Shell() {
  const { user, loading, logout, can } = useAuth();
  const [view, setView] = useState<View>('leads');

  if (loading) {
    return (
      <div className="center-screen">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (!user) return <Login />;

  // Force a password change before anything else is reachable.
  if (user.mustChangePassword) return <ChangePassword forced />;

  // Build the nav from permissions. The "My password" item is always available.
  const nav: { key: View; label: string; show: boolean }[] = [
    { key: 'leads', label: 'Leads & Pipeline', show: can(PERM.leadsRead) },
    { key: 'customers', label: 'Customers', show: can(PERM.customersRead) },
    { key: 'contracts', label: 'Contracts', show: can(PERM.contractsRead) },
    { key: 'printers', label: 'Printers', show: can(PERM.printersRead) },
    { key: 'inventory', label: 'Inventory', show: can(PERM.inventoryRead) },
    { key: 'dispatch', label: 'Dispatch', show: can(PERM.dispatchRead) },
    { key: 'helpdesk', label: 'Helpdesk', show: can(PERM.serviceRead) },
    { key: 'toner', label: 'Toner', show: can(PERM.tonerRead) },
    { key: 'billing', label: 'Billing', show: can(PERM.billingRead) },
    { key: 'users', label: 'Users', show: can(PERM.usersRead) },
    { key: 'audit', label: 'Audit log', show: can(PERM.auditRead) },
    { key: 'password', label: 'My password', show: true },
  ];
  const available = nav.filter((n) => n.show);
  // If the current view isn't permitted, fall back to the first available one.
  const activeView = available.some((n) => n.key === view)
    ? view
    : (available[0]?.key ?? 'password');

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <h1>Websol CRM</h1>
        <div className="tagline">Access Management</div>
        {available.map((n) => (
          <button
            key={n.key}
            className={`nav-item ${activeView === n.key ? 'active' : ''}`}
            onClick={() => setView(n.key)}
          >
            {n.label}
          </button>
        ))}
        <div className="spacer" />
        <div className="user-box">
          <div>{user.fullName}</div>
          <div className="role">{user.role.name}</div>
          <button
            className="nav-item"
            style={{ marginTop: '0.5rem', paddingLeft: 0 }}
            onClick={() => void logout()}
          >
            Sign out
          </button>
        </div>
      </aside>

      <main className="main">
        {activeView === 'leads' && <LeadsPage />}
        {activeView === 'customers' && <CustomersPage />}
        {activeView === 'contracts' && <ContractsPage />}
        {activeView === 'printers' && <PrintersPage />}
        {activeView === 'inventory' && <InventoryPage />}
        {activeView === 'dispatch' && <DispatchPage />}
        {activeView === 'helpdesk' && <HelpdeskPage />}
        {activeView === 'toner' && <TonerPage />}
        {activeView === 'billing' && <BillingPage />}
        {activeView === 'users' && <UsersPage />}
        {activeView === 'audit' && <AuditPage />}
        {activeView === 'password' && <ChangePassword />}
      </main>
    </div>
  );
}

export default function App() {
  // The customer portal is a completely separate surface served at `/portal`.
  // It has its own token storage and never mounts the staff AuthProvider, so a
  // customer session and a staff session can never bleed into one another.
  if (typeof window !== 'undefined' && window.location.pathname.startsWith('/portal')) {
    return <CustomerPortal />;
  }
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}
