import type { PrismaClient } from '@prisma/client';
import { Pseudonymizer } from '@center/pii';
import { SecretBox } from '@center/secrets';
import { buildServer } from '../server.js';
import { testConfig as config } from './helpers/config.js';

const pseudonymizer = new Pseudonymizer(config.piiPepper);
const secretBox = new SecretBox(config.credentialsEncryptionKey);

function setup(organizationExists = true) {
  const create = jest.fn(async () => ({ id: 'touch_1' }));
  const prisma = {
    organization: {
      findUnique: jest.fn(async () => (organizationExists ? { id: 'org_1' } : null)),
    },
    attributionTouch: { create },
  } as unknown as PrismaClient;

  return { prisma, create };
}

const validBody = {
  organizationId: 'org_1',
  clientId: '1234567890.1699999999',
  source: 'google',
  medium: 'cpc',
  campaign: 'Black-Friday',
  device: 'mobile',
  landingPage: '/promocoes',
};

async function build(prisma: PrismaClient) {
  return buildServer({
    config, prisma, pseudonymizer, secretBox,
    gateway: {} as never,
    queue: { enqueue: jest.fn(async () => {}) },
  });
}

describe('POST /public/attribution', () => {
  it('accepts a valid touch and answers 204', async () => {
    const { prisma } = setup();
    const app = await build(prisma);
    const response = await app.inject({ method: 'POST', url: '/public/attribution', payload: validBody });
    expect(response.statusCode).toBe(204);
    await app.close();
  });

  it('stores only the hashed visitor id, never the raw client id', async () => {
    const { prisma, create } = setup();
    const app = await build(prisma);
    await app.inject({ method: 'POST', url: '/public/attribution', payload: validBody });

    const data = create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.visitorHash).toBe(pseudonymizer.hashVisitorId('1234567890.1699999999'));
    expect(JSON.stringify(data)).not.toContain('1234567890.1699999999');
    await app.close();
  });

  it('stores only the hashed email when one is sent', async () => {
    const { prisma, create } = setup();
    const app = await build(prisma);
    await app.inject({
      method: 'POST', url: '/public/attribution',
      payload: { ...validBody, email: 'Ana@Example.com' },
    });

    const data = create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.emailHash).toBe(pseudonymizer.hashEmail('ana@example.com'));
    expect(JSON.stringify(data)).not.toContain('Ana@Example.com');
    await app.close();
  });

  it('lowercases the campaign so grouping does not split', async () => {
    const { prisma, create } = setup();
    const app = await build(prisma);
    await app.inject({ method: 'POST', url: '/public/attribution', payload: validBody });
    expect((create.mock.calls[0]![0].data as Record<string, unknown>).campaign).toBe('black-friday');
    await app.close();
  });

  it('rejects a body without a client id', async () => {
    const { prisma, create } = setup();
    const app = await build(prisma);
    const { clientId: _omitted, ...withoutClient } = validBody;
    const response = await app.inject({ method: 'POST', url: '/public/attribution', payload: withoutClient });
    expect(response.statusCode).toBe(400);
    expect(create).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects an unknown organization instead of creating orphan rows', async () => {
    const { prisma, create } = setup(false);
    const app = await build(prisma);
    const response = await app.inject({ method: 'POST', url: '/public/attribution', payload: validBody });
    expect(response.statusCode).toBe(404);
    expect(create).not.toHaveBeenCalled();
    await app.close();
  });

  it('truncates an oversized landing page instead of rejecting the touch', async () => {
    const { prisma, create } = setup();
    const app = await build(prisma);
    await app.inject({
      method: 'POST', url: '/public/attribution',
      payload: { ...validBody, landingPage: `/${'a'.repeat(5000)}` },
    });
    const landingPage = (create.mock.calls[0]![0].data as Record<string, string>).landingPage;
    expect(landingPage.length).toBeLessThanOrEqual(512);
    await app.close();
  });

  it('never returns data that could identify the visitor', async () => {
    const { prisma } = setup();
    const app = await build(prisma);
    const response = await app.inject({ method: 'POST', url: '/public/attribution', payload: validBody });
    expect(response.body).toBe('');
    await app.close();
  });
});
