import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import type { MetricGateway } from '@center/mcp-core';
import { Pseudonymizer } from '@center/pii';
import { SecretBox } from '@center/secrets';
import { buildServer } from '../server.js';
import { testConfig } from './helpers/config.js';

// Fixture mínima de um build do Vite: index.html na raiz + um asset com
// hash sob assets/, igual ao que `apps/web` produz de verdade.
function makeWebRootFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'center-web-dist-'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><html><body>dashboard</body></html>');
  writeFileSync(join(root, 'center-attribution.js'), '// script de atribuição publico\n');
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'assets', 'app-abc123.js'), 'console.log("app")');
  return root;
}

async function buildTestServer(webRoot: string) {
  const prisma = {
    user: { findUnique: jest.fn(async () => null) },
    organization: { findUnique: jest.fn(async () => null) },
  } as unknown as PrismaClient;

  return buildServer(
    {
      config: testConfig,
      prisma,
      gateway: { listMetrics: jest.fn(async () => []) } as unknown as MetricGateway,
      pseudonymizer: new Pseudonymizer(testConfig.piiPepper),
      secretBox: new SecretBox(testConfig.credentialsEncryptionKey),
      queue: { enqueue: jest.fn(async () => {}) },
    },
    { webRoot },
  );
}

describe('static dashboard + SPA fallback', () => {
  let webRoot: string;

  beforeEach(() => {
    webRoot = makeWebRootFixture();
  });

  afterEach(() => {
    rmSync(webRoot, { recursive: true, force: true });
  });

  it('serves a hashed asset from the Vite build with its real content', async () => {
    const app = await buildTestServer(webRoot);
    const response = await app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('console.log("app")');
    await app.close();
  });

  it('serves /center-attribution.js at the API origin (checkout-attribution.md contract)', async () => {
    const app = await buildTestServer(webRoot);
    const response = await app.inject({ method: 'GET', url: '/center-attribution.js' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('script de atribuição');
    await app.close();
  });

  it('falls back to index.html for an unknown client-side (react-router) route', async () => {
    const app = await buildTestServer(webRoot);
    const response = await app.inject({ method: 'GET', url: '/produtos/algum-sku' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/html/);
    expect(response.body).toContain('dashboard');
    await app.close();
  });

  it('serves index.html at the root path', async () => {
    const app = await buildTestServer(webRoot);
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('dashboard');
    await app.close();
  });

  // O achado central do gap: a SPA/estático não pode "engolir" uma rota de
  // API real. Prova com uma rota GET registrada de verdade (exige auth) —
  // se o fallback estático tivesse prioridade, ou se o registro do plugin
  // interceptasse por ordem, isto viraria 200 com a index.html em vez do
  // 401 que a própria rota de metrics produz.
  it('does not let the static/SPA handler shadow a real registered API route', async () => {
    const app = await buildTestServer(webRoot);
    const response = await app.inject({ method: 'GET', url: '/api/metrics/catalog' });
    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    await app.close();
  });

  it('returns a JSON 404 (not index.html) for an unknown route under a reserved API prefix', async () => {
    const app = await buildTestServer(webRoot);
    const response = await app.inject({ method: 'GET', url: '/api/this-route-does-not-exist' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.json()).toEqual({ error: 'not_found', message: 'rota não encontrada' });
    await app.close();
  });

  it('returns a JSON 404 for an unknown route under /auth (reserved prefix)', async () => {
    const app = await buildTestServer(webRoot);
    const response = await app.inject({ method: 'GET', url: '/auth/does-not-exist' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    await app.close();
  });

  it('still returns a JSON 404 (not the SPA fallback) for /health under an unmatched method', async () => {
    const app = await buildTestServer(webRoot);
    const response = await app.inject({ method: 'POST', url: '/health' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    await app.close();
  });
});
