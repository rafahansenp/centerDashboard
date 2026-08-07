import type { PrismaClient } from '@prisma/client';
import type { MetricGateway } from '@center/mcp-core';
import { Pseudonymizer } from '@center/pii';
import { SecretBox } from '@center/secrets';
import { buildServer } from '../server.js';
import { signPayload } from '../whatsapp/signature.js';
import { testConfig } from './helpers/config.js';

const inboundPayload = {
  object: 'whatsapp_business_account',
  entry: [{ id: '1', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '5511999999999', phone_number_id: '1' },
    messages: [{ from: '5511988887777', id: 'wamid.ABC', timestamp: '1773532800', type: 'text', text: { body: 'oi' } }],
  } }] }],
};

async function setup(alreadyProcessed = false, enqueueImpl?: jest.Mock) {
  const enqueue = enqueueImpl ?? jest.fn(async () => {});
  // Estado real (não só mocks fixos): create/delete realmente afetam o que
  // findUnique subsequente enxerga, para poder testar o ciclo completo de
  // "marca -> reverte -> reentrega tenta de novo" do fix da falha de enqueue.
  const processed = new Set<string>(alreadyProcessed ? ['wamid.ABC'] : []);
  const prisma = {
    processedWebhookEvent: {
      findUnique: jest.fn(async ({ where }: { where: { wamid: string } }) => (
        processed.has(where.wamid) ? { wamid: where.wamid } : null
      )),
      create: jest.fn(async ({ data }: { data: { wamid: string } }) => {
        processed.add(data.wamid);
        return { wamid: data.wamid };
      }),
      delete: jest.fn(async ({ where }: { where: { wamid: string } }) => {
        processed.delete(where.wamid);
        return { wamid: where.wamid };
      }),
    },
  } as unknown as PrismaClient;

  const app = await buildServer({
    config: testConfig, prisma,
    gateway: {} as unknown as MetricGateway,
    pseudonymizer: new Pseudonymizer(testConfig.piiPepper),
    secretBox: new SecretBox(testConfig.credentialsEncryptionKey),
    queue: { enqueue },
  });
  return { app, enqueue, prisma, processed };
}

function post(app: Awaited<ReturnType<typeof buildServer>>, payload: unknown, secret = 's') {
  const raw = Buffer.from(JSON.stringify(payload));
  return app.inject({
    method: 'POST', url: '/webhooks/whatsapp',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signPayload(raw, secret) },
    payload: raw,
  });
}

describe('GET /webhooks/whatsapp', () => {
  it('echoes the challenge when the verify token matches', async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: 'GET',
      url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=v&hub.challenge=1158201444',
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('1158201444');
    await app.close();
  });

  it('returns 403 for a wrong verify token', async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: 'GET',
      url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=1',
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it('returns 403 when hub.mode is not subscribe', async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: 'GET',
      url: '/webhooks/whatsapp?hub.mode=unsubscribe&hub.verify_token=v&hub.challenge=1',
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
});

describe('POST /webhooks/whatsapp', () => {
  it('enqueues a valid message and answers 200 immediately', async () => {
    const { app, enqueue } = await setup();
    expect((await post(app, inboundPayload)).statusCode).toBe(200);
    expect(enqueue).toHaveBeenCalledWith({
      wamid: 'wamid.ABC', fromPhoneE164: '+5511988887777', text: 'oi', timestamp: 1773532800,
    });
    await app.close();
  });

  it('rejects a body signed with the wrong secret and does not enqueue', async () => {
    const { app, enqueue } = await setup();
    expect((await post(app, inboundPayload, 'errado')).statusCode).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects a request with no signature header', async () => {
    const { app, enqueue } = await setup();
    const response = await app.inject({
      method: 'POST', url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json' },
      payload: Buffer.from(JSON.stringify(inboundPayload)),
    });
    expect(response.statusCode).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
    await app.close();
  });

  it('does not enqueue a wamid that was already processed', async () => {
    const { app, enqueue } = await setup(true);
    expect((await post(app, inboundPayload)).statusCode).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
    await app.close();
  });

  it('answers 200 for a status-only event without enqueuing', async () => {
    const { app, enqueue } = await setup();
    const statusPayload = {
      object: 'whatsapp_business_account',
      entry: [{ id: '1', changes: [{ field: 'messages', value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '5511999999999', phone_number_id: '1' },
        statuses: [{ id: 'wamid.X', status: 'read', timestamp: '1773532800' }],
      } }] }],
    };
    expect((await post(app, statusPayload)).statusCode).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
    await app.close();
  });

  it('answers 200 even when enqueuing fails, so Meta does not retry forever', async () => {
    const enqueue = jest.fn(async () => { throw new Error('redis fora do ar'); });
    const { app } = await setup(false, enqueue);
    expect((await post(app, inboundPayload)).statusCode).toBe(200);
    await app.close();
  });

  it('reverts the processed-event mark when enqueuing fails, so a redelivery can retry', async () => {
    const enqueue = jest.fn(async () => { throw new Error('redis fora do ar'); });
    const { app, prisma, processed } = await setup(false, enqueue);

    expect((await post(app, inboundPayload)).statusCode).toBe(200);
    // O evento foi marcado como processado e depois revertido — não pode
    // sobrar registrado, senão a mensagem se perde para sempre (a Meta nunca
    // reentrega um 200).
    expect(prisma.processedWebhookEvent.delete).toHaveBeenCalledWith({ where: { wamid: 'wamid.ABC' } });
    expect(processed.has('wamid.ABC')).toBe(false);

    // Uma reentrega idêntica da Meta (mesmo wamid) deve tentar enfileirar de
    // novo, não ser silenciosamente descartada como duplicata.
    enqueue.mockImplementationOnce(async () => {});
    expect((await post(app, inboundPayload)).statusCode).toBe(200);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(processed.has('wamid.ABC')).toBe(true);

    await app.close();
  });
});

describe('rate limiting on /webhooks/whatsapp', () => {
  it('never 429s the webhook, even under a flood of unsigned requests spoofing a real Meta delivery IP', async () => {
    const { app } = await setup();
    // 31.13.115.1 é um IP de entrega real e publicado da Meta — o cenário do
    // achado de segurança é um atacante forjando X-Forwarded-For com esse
    // valor. Sem o allowList, isto esgotaria o balde global de 300/min
    // compartilhado por IP (habilitado via trustProxy) e derrubaria a
    // entrega legítima de mensagens.
    const spoofedMetaIp = '31.13.115.1';
    const unsigned = () => app.inject({
      method: 'POST', url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': spoofedMetaIp },
      payload: Buffer.from(JSON.stringify(inboundPayload)),
    });

    for (let i = 0; i < 305; i += 1) {
      expect((await unsigned()).statusCode).toBe(401);
    }

    // Uma requisição legitimamente assinada, aparentando vir do mesmo IP,
    // ainda deve passar — não pode ter sido pega pelo rate limit.
    const raw = Buffer.from(JSON.stringify(inboundPayload));
    const signedFromSameIp = await app.inject({
      method: 'POST', url: '/webhooks/whatsapp',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': spoofedMetaIp,
        'x-hub-signature-256': signPayload(raw, 's'),
      },
      payload: raw,
    });
    expect(signedFromSameIp.statusCode).toBe(200);

    await app.close();
  }, 20000);
});
