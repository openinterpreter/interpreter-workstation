import { useEffect, useRef, useState } from 'react';

type Challenge = { name: string; value: string; expiresAt: number };
type Status = { domain: string; challengeExpiresAt: number | null; verifiedUntil: number | null };

/** Opt-in admin setup surface; an explicit scoped server mount is required.
 * DNS proof is a preliminary signal, not a live SSO enrollment decision. */
export function EnterpriseDomainSetup({ organizationId }: { organizationId: string }) {
  const [domain, setDomain] = useState('');
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    setDomain(''); setChallenge(null); setStatus(null); setError(null); setBusy(false);
    return () => request.current?.abort();
  }, [organizationId]);
  useEffect(() => {
    const deadlines = [status?.verifiedUntil, status?.challengeExpiresAt, challenge?.expiresAt]
      .filter((value): value is number => typeof value === 'number' && value > clock);
    if (!deadlines.length) return;
    const timer = setTimeout(() => setClock(Date.now()), Math.max(1, Math.min(...deadlines) - Date.now() + 1));
    return () => clearTimeout(timer);
  }, [status, challenge, clock]);

  async function act(action: 'challenge' | 'verify' | 'status') {
    if (busy || !organizationId || !domain || (action === 'verify' && !challenge)) return;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const base = `/api/enterprise/organizations/${encodeURIComponent(organizationId)}/domains/`;
      const loadStatus = async () => {
        const response = await fetch(`${base}status?domain=${encodeURIComponent(domain)}`, {
          credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        });
        if (response.status !== 200) throw new Error('Status unavailable');
        const data = await response.json() as Status;
        const validTime = (value: unknown) => value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
        if (data?.domain !== domain || !validTime(data.challengeExpiresAt) || !validTime(data.verifiedUntil)) {
          throw new Error('Invalid status');
        }
        if (!controller.signal.aborted) { setClock(Date.now()); setStatus(data); }
      };
      if (action === 'status') {
        await loadStatus();
        return;
      }
      const response = await fetch(`${base}${action}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        signal: controller.signal, headers: { 'Content-Type': 'application/json', 'X-Interpreter-CSRF': '1' },
        body: JSON.stringify({ domain }), });
      if (action === 'challenge') {
        if (response.status !== 200) throw new Error('Challenge unavailable');
        const data = await response.json() as Challenge;
        if (data?.name !== `_interpreter-workstation.${domain}` ||
            !/^interpreter-workstation-verification=[A-Za-z0-9_-]{43}$/.test(data.value) ||
            !Number.isSafeInteger(data.expiresAt) || data.expiresAt <= Date.now() ||
            data.expiresAt > Date.now() + 10 * 60_000) throw new Error('Invalid challenge');
        if (!controller.signal.aborted) { setClock(Date.now()); setChallenge(data); }
      } else {
        if (response.status !== 204) throw new Error('Verification denied');
        if (!controller.signal.aborted) setChallenge(null);
        await loadStatus(); // Never present a local success badge without authoritative state.
      }
    } catch {
      if (!controller.signal.aborted) {
        setChallenge(null); setStatus(null);
        setError(action === 'challenge' ? 'No domain challenge was issued. Check your access and try again.' :
          action === 'status' ? 'DNS status is unavailable. No confirmation is shown.' :
            'DNS verification could not be confirmed. Check the record and try a new challenge.');
      }
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }

  return <section className="rounded-xl border border-border bg-muted/10 p-4" aria-label="Domain setup">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div><h3 className="text-sm font-semibold text-foreground">Domain setup</h3>
        <p className="mt-1 max-w-prose text-xs text-muted-foreground">Prove control of a DNS name with a short-lived TXT record. This does not activate SSO or assign accounts.</p></div>
      <span className="rounded-full border border-border px-2 py-1 text-xs text-muted-foreground">Identity setup · DNS step</span>
    </div>
    <label htmlFor="enterprise-domain" className="mt-4 block text-xs font-medium text-foreground">Organization domain</label>
    <div className="mt-1 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
      <input id="enterprise-domain" type="text" autoComplete="off" spellCheck={false} value={domain}
        onChange={(event) => { setDomain(event.target.value.trim().toLowerCase()); setChallenge(null); setStatus(null); setError(null); }}
        placeholder="example.com" disabled={busy}
        className="min-w-0 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground" />
      <button type="button" disabled={!domain || busy} onClick={() => void act('challenge')}
        className="rounded-md border border-border px-3 py-2 text-xs font-medium hover:bg-muted disabled:opacity-50">
        {busy ? 'Checking…' : 'Create DNS challenge'}
      </button>
      <button type="button" disabled={!domain || busy} onClick={() => void act('status')}
        className="rounded-md border border-border px-3 py-2 text-xs font-medium hover:bg-muted disabled:opacity-50">
        Refresh DNS status
      </button>
    </div>
    {challenge && challenge.expiresAt > clock && <div className="mt-4 space-y-2 rounded-lg border border-border bg-background p-3 text-xs">
      <p className="font-medium">Add one TXT record before {new Date(challenge.expiresAt).toLocaleString()}:</p>
      <p>Host <code className="select-all break-all font-mono">{challenge.name}</code></p>
      <p>Value <code className="select-all break-all font-mono">{challenge.value}</code></p>
      <button type="button" disabled={busy} onClick={() => void act('verify')}
        className="rounded-md border border-border px-3 py-2 font-medium hover:bg-muted disabled:opacity-50">Verify DNS record</button>
    </div>}
    {challenge && challenge.expiresAt <= clock && <p role="status" className="mt-3 text-sm text-foreground">The DNS challenge expired. Create a new challenge before retrying verification.</p>}
    {status && <p role="status" className="mt-3 text-sm text-foreground">{status.verifiedUntil && status.verifiedUntil > clock
      ? `DNS proof observed; valid until ${new Date(status.verifiedUntil).toLocaleString()}. SSO remains off until the other identity and deployment checks pass.`
      : status.verifiedUntil ? `DNS proof expired ${new Date(status.verifiedUntil).toLocaleString()}. Create a new challenge to renew it; ordinary administration remains unavailable until verification succeeds.`
      : status.challengeExpiresAt && status.challengeExpiresAt > clock
        ? `A DNS challenge expires ${new Date(status.challengeExpiresAt).toLocaleString()}. Create a new challenge if you no longer have the TXT value.`
      : status.challengeExpiresAt ? 'The DNS challenge expired. Create a new challenge before retrying verification.'
        : 'No current DNS confirmation is recorded for this domain. SSO remains off.'}</p>}
    {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
  </section>;
}
