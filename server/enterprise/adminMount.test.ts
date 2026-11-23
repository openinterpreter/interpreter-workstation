import { describe, expect, it } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { mountEnterpriseAdminRoutes } from './adminMount';
import { ServerDirectory } from './serverDirectory';

describe('explicit tenant-scoped admin route mount', () => {
  it('refuses a remote Workstation password host before registering any enterprise route', async () => {
    const previous = process.env.INTERPRETER_WORKSTATION_ACCESS;
    const app = express();
    try {
      process.env.INTERPRETER_WORKSTATION_ACCESS = 'read-write';
      expect(() => mountEnterpriseAdminRoutes(app, { enabled: true,
        applicationOrigin: 'http://127.0.0.1:39394', organizationId: 'a',
        issuer: 'https://issuer.invalid/a', directory: new ServerDirectory('/nonexistent'),
        verifySession: async () => null, allowInsecureLoopbackForTests: true }))
        .toThrow('cannot share a remote Workstation host session');
      expect((await request(app).get('/api/enterprise/organizations/a/overview')).status).toBe(404);
      process.env.INTERPRETER_WORKSTATION_ACCESS = 'read-only';
      expect(() => mountEnterpriseAdminRoutes(app, { enabled: true,
        applicationOrigin: 'http://127.0.0.1:39394', organizationId: 'a',
        issuer: 'https://issuer.invalid/a', directory: new ServerDirectory('/nonexistent'),
        verifySession: async () => null, allowInsecureLoopbackForTests: true }))
        .toThrow('cannot share a remote Workstation host session');
    } finally {
      if (previous === undefined) delete process.env.INTERPRETER_WORKSTATION_ACCESS;
      else process.env.INTERPRETER_WORKSTATION_ACCESS = previous;
    }
  });

  it('fails closed if the Workstation host becomes remote after an opt-in mount', async () => {
    const previous = process.env.INTERPRETER_WORKSTATION_ACCESS;
    const app = express();
    try {
      delete process.env.INTERPRETER_WORKSTATION_ACCESS;
      expect(mountEnterpriseAdminRoutes(app, { enabled: true,
        applicationOrigin: 'http://127.0.0.1:39394', organizationId: 'a',
        issuer: 'https://issuer.invalid/a', directory: new ServerDirectory('/nonexistent'),
        verifySession: async () => null, allowInsecureLoopbackForTests: true })).toBe(true);
      const get = () => request(app).get('/api/enterprise/organizations/a/overview')
        .set('Host', '127.0.0.1:39394');
      expect((await get()).status).toBe(401);
      process.env.INTERPRETER_WORKSTATION_ACCESS = 'read-write';
      expect((await get()).status).toBe(503);
      process.env.INTERPRETER_WORKSTATION_ACCESS = 'read-only';
      expect((await get()).status).toBe(503);
    } finally {
      if (previous === undefined) delete process.env.INTERPRETER_WORKSTATION_ACCESS;
      else process.env.INTERPRETER_WORKSTATION_ACCESS = previous;
    }
  });

  it('is absent by default and cannot partially mount an invalid origin', async () => {
    const app = express();
    expect(mountEnterpriseAdminRoutes(app)).toBe(false);
    expect((await request(app).get('/api/enterprise/organizations/a/overview')).status).toBe(404);
    const config = { enabled: true as const, applicationOrigin: 'http://example.invalid', accountDomain: 'example.test',
      organizationId: 'a', issuer: 'https://issuer.invalid/a', directory: new ServerDirectory('/nonexistent'),
      oidc: { organizationId: 'a', issuer: 'https://issuer.invalid/a', accountDomain: 'example.test',
        redirectUri: 'http://example.invalid/enterprise/callback' },
      verifySession: async () => null };
    expect(() => mountEnterpriseAdminRoutes(app, config)).toThrow('Invalid browser API origin');
    expect((await request(app).get('/api/enterprise/organizations/a/overview')).status).toBe(404);
    expect(() => mountEnterpriseAdminRoutes(app, { ...config, issuer: '' })).toThrow('requires a verified tenant');
  });

  it('rejects plaintext loopback outside isolated test mode', () => {
    const previous = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      expect(() => mountEnterpriseAdminRoutes(express(), { enabled: true,
        applicationOrigin: 'http://127.0.0.1:39394', organizationId: 'a',
        issuer: 'https://issuer.invalid/a', directory: new ServerDirectory('/nonexistent'),
        verifySession: async () => null, allowInsecureLoopbackForTests: true })).toThrow('requires a verified tenant');
    } finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
  });

  it('rejects a production mount without an exact pinned account domain before registering routes', async () => {
    const app = express();
    const options = { enabled: true as const, applicationOrigin: 'https://enterprise.example.test',
      organizationId: 'a', issuer: 'https://issuer.invalid/a', directory: new ServerDirectory('/nonexistent'),
      verifySession: async () => null };
    expect(() => mountEnterpriseAdminRoutes(app, options)).toThrow('requires a verified tenant');
    expect(() => mountEnterpriseAdminRoutes(app, { ...options, accountDomain: 'Example.Test' }))
      .toThrow('requires a verified tenant');
    const mapped = { ...options, accountDomain: 'example.test', oidc: { organizationId: 'a',
      issuer: options.issuer, accountDomain: 'example.test', redirectUri: 'https://enterprise.example.test/enterprise/callback' } };
    for (const oidc of [
      { ...mapped.oidc, organizationId: 'b' },
      { ...mapped.oidc, issuer: 'https://issuer.invalid/b' },
      { ...mapped.oidc, accountDomain: 'secondary.test' },
      { ...mapped.oidc, redirectUri: 'https://other.example.test/enterprise/callback' },
      { ...mapped.oidc, redirectUri: 'https://enterprise.example.test/not-enterprise/callback' },
    ]) expect(() => mountEnterpriseAdminRoutes(app, { ...mapped, oidc })).toThrow('requires a verified tenant');
    for (const issuer of ['http://issuer.invalid/a', 'https://user:pass@issuer.invalid/a',
      'https://issuer.invalid/a?tenant=b', 'https://issuer.invalid/a#fragment', 'not-an-issuer']) {
      expect(() => mountEnterpriseAdminRoutes(app, { ...mapped, issuer,
        oidc: { ...mapped.oidc, issuer } })).toThrow('requires a verified tenant');
    }
    expect((await request(app).get('/api/enterprise/organizations/a/overview')).status).toBe(404);
  });
});
