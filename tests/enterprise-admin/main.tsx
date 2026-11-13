import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/index.css';
import { EnterpriseAdminDashboard } from '../../src/components/settings/EnterpriseAdminDashboard';

createRoot(document.getElementById('root')!).render(<React.StrictMode>
  <main className="mx-auto max-w-5xl space-y-5 px-5 py-10">
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">Local mock IdP fixture only. No production identity or SSO is configured.</div>
    <a className="inline-flex rounded-md border border-border px-3 py-2 text-sm" href="/fixture/login">Start local admin session</a>
    <EnterpriseAdminDashboard organizationId="org-a" />
  </main>
</React.StrictMode>);
