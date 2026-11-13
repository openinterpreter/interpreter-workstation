import { describe, expect, it } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { mountEnterpriseAdminRoutes } from './adminMount';
import { ServerDirectory } from './serverDirectory';

describe('explicit tenant-scoped admin route mount', () => {
  it('is absent by default and cannot partially mount an invalid origin', async () => {
    const app = express();
    expect(mountEnterpriseAdminRoutes(app)).toBe(false);
    expect((await request(app).get('/api/enterprise/organizations/a/overview')).status).toBe(404);
    const config = { enabled: true as const, applicationOrigin: 'http://example.invalid',
      organizationId: 'a', issuer: 'https://issuer.invalid/a', directory: new ServerDirectory('/nonexistent'),
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
});
