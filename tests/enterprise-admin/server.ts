/** Loopback-only visual acceptance fixture. Not imported by any product server. */
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ServerDirectory } from '../../server/enterprise/serverDirectory';
import { createEnterpriseAdminMutationRouter, createEnterpriseBrowserRouter, createEnterpriseLogoutRouter } from '../../server/enterprise/oidcHttp';

if (process.env.NODE_ENV !== 'test') throw new Error('Enterprise visual fixture requires NODE_ENV=test');
const port = Number(process.env.PORT ?? 39394);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid fixture port');
const origin = `http://127.0.0.1:${port}`;
const issuer = 'https://idp.example/local-fixture';
const root = resolve(fileURLToPath(new URL('../../.tmp/enterprise-admin-browser', import.meta.url)));
const temp = await mkdtemp(join(tmpdir(), 'enterprise-admin-browser-'));
const directory = new ServerDirectory(join(temp, 'private', 'directory.json'));
await directory.bootstrap('org-a', 'Fixture organization', issuer,
  { organizationId: 'org-a', subject: 'alice', displayName: 'Alice Admin', role: 'admin', active: true });
const { identity } = await directory.createSession(issuer, 'org-a', 'alice', Date.now() + 60 * 60_000);
await directory.setMember(identity,
  { organizationId: 'org-a', subject: 'carol', displayName: 'Carol Member', role: 'member', active: true });
await directory.revokeSession(identity); // Do not retain a hidden setup bearer.
const { token: member } = await directory.createSession(issuer, 'org-a', 'carol', Date.now() + 60 * 60_000);
const app = express();
app.get('/fixture/login', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const { token } = await directory.createSession(issuer, 'org-a', 'alice', Date.now() + 60 * 60_000);
    res.cookie('interpreter-enterprise-session', token, { httpOnly: true, sameSite: 'lax', path: '/' });
    res.redirect('/');
  } catch { res.status(503).end(); }
});
const options = { applicationOrigin: origin, allowInsecureLoopbackForTests: true,
  verifySession: (token: string) => directory.verifySession(token), directory };
app.use('/api/enterprise', createEnterpriseBrowserRouter(options));
app.use('/api/enterprise', createEnterpriseAdminMutationRouter(options));
app.use('/api/enterprise', createEnterpriseLogoutRouter(options));
app.use(express.static(root));
app.get('/', (_req, res) => res.sendFile(join(root, 'index.html')));
const server = app.listen(port, '127.0.0.1', () => process.stdout.write(`Fixture listening at ${origin}\n`));
async function stop() { server.close(); await rm(temp, { recursive: true, force: true }); }
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
// Keep the member session live until the UI revokes it, for manual verification.
void member;
