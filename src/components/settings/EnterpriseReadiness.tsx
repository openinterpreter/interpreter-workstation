import { useEffect, useState } from 'react';
import { getApiUrl } from '../../ipc';

export function EnterpriseReadiness() {
  const [detail, setDetail] = useState('Checking enterprise control-plane status…');
  useEffect(() => {
    let active = true;
    getApiUrl('/api/enterprise/readiness')
      .then((url) => fetch(url, { cache: 'no-store' }))
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('Unavailable')))
      .then((value: { available?: boolean; detail?: string }) => {
        if (active) setDetail(value.available === false && typeof value.detail === 'string'
          ? value.detail : 'Enterprise control-plane status could not be verified.');
      })
      .catch(() => { if (active) setDetail('Enterprise control-plane status could not be verified.'); });
    return () => { active = false; };
  }, []);
  return (
    <div className="mt-4 rounded-xl border border-border bg-muted/30 px-4 py-4" aria-label="Organization administration status">
      <div className="flex items-center justify-between gap-3">
        <strong className="text-ui-sm text-foreground">Organization administration</strong>
        <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">Not configured</span>
      </div>
      <p className="mt-2 text-ui-sm text-muted-foreground">{detail}</p>
    </div>
  );
}
