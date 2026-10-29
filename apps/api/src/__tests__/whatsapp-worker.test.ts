import type { PrismaClient } from '@prisma/client';
import type { MetricGateway } from '@center/mcp-core';
import { UNKNOWN_PHONE_REPLY, processInboundMessage, type WorkerDeps } from '../whatsapp/worker.js';
import type { CloudApiClient } from '../whatsapp/cloud-api-client.js';
import * as agentModule from '../agent/agent.js';
import { testConfig } from './helpers/config.js';

jest.mock('../agent/agent.js', () => ({
  ...jest.requireActual('../agent/agent.js'),
  runAgent: jest.fn(),
}));
const runAgent = agentModule.runAgent as jest.Mock;

const message = {
  wamid: 'wamid.ABC', fromPhoneE164: '+5511988887777', text: 'quanto vendemos?', timestamp: 1773532800,
};

const verifiedIdentity = {
  id: 'wid_1', phoneE164: '+5511988887777', userId: 'user_1',
  organizationId: 'org_1', verifiedAt: new Date('2026-01-01'),
};

function buildDeps(identity: unknown) {
  const sendText = jest.fn(async () => {});
  const prisma = {
    whatsAppIdentity: { findUnique: jest.fn(async () => identity) },
    organization: { findUnique: jest.fn(async () => ({ id: 'org_1' })) },
    integration: { findMany: jest.fn(async () => [
      { kind: 'WEB_ANALYTICS', status: 'OK', config: { propertyId: '111' } },
    ]) },
    conversation: { findFirst: jest.fn(async () => ({ id: 'conv_1' })), update: jest.fn(async () => ({})) },
    message: { findMany: jest.fn(async () => []), create: jest.fn(async () => ({ id: 'msg_1' })) },
    toolCallLog: { createMany: jest.fn(async () => ({ count: 0 })) },
    linkCode: {
      findUnique: jest.fn(async () => null),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
  } as unknown as PrismaClient;

  const deps: WorkerDeps = {
    prisma,
    gateway: {} as unknown as MetricGateway,
    cloudApi: { sendText } as unknown as CloudApiClient,
    config: testConfig,
    today: () => '2026-03-15',
  };
  return { deps, sendText, prisma };
}

let consoleErrorSpy: jest.SpyInstance;

beforeEach(() => {
  runAgent.mockReset();
  runAgent.mockResolvedValue({ reply: 'Você faturou R$ 4.800,00.', toolCalls: [] });
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe('processInboundMessage', () => {
  it('answers with the agent reply for a known phone', async () => {
    const { deps, sendText } = buildDeps(verifiedIdentity);
    await processInboundMessage(deps, message);
    expect(sendText).toHaveBeenCalledWith('+5511988887777', 'Você faturou R$ 4.800,00.');
  });

  it('passes the resolved tenant and today to the agent', async () => {
    const { deps } = buildDeps(verifiedIdentity);
    await processInboundMessage(deps, message);
    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({
      today: '2026-03-15', userMessage: 'quanto vendemos?',
      tenant: { organizationId: 'org_1', externalIds: { ga4PropertyId: '111' } },
    }));
  });

  it('never calls the agent for an unknown phone', async () => {
    const { deps, sendText } = buildDeps(null);
    await processInboundMessage(deps, message);
    expect(runAgent).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith('+5511988887777', UNKNOWN_PHONE_REPLY);
  });

  it('never calls the agent for a phone that was never verified', async () => {
    const { deps, sendText } = buildDeps({ ...verifiedIdentity, verifiedAt: null });
    await processInboundMessage(deps, message);
    expect(runAgent).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith('+5511988887777', UNKNOWN_PHONE_REPLY);
  });

  it('persists the exchange', async () => {
    const { deps, prisma } = buildDeps(verifiedIdentity);
    await processInboundMessage(deps, message);
    expect(prisma.message.create).toHaveBeenCalledTimes(2);
  });

  it('still warns the user when the agent throws', async () => {
    runAgent.mockRejectedValueOnce(new Error('pane geral'));
    const { deps, sendText } = buildDeps(verifiedIdentity);
    await expect(processInboundMessage(deps, message)).resolves.toBeUndefined();
    expect(sendText).toHaveBeenCalledWith('+5511988887777', expect.stringMatching(/não consegui/i));
    // A falha não pode ficar muda: sem isso, o job seria reportado como
    // "completed" pelo BullMQ mesmo quando todo usuário recebe só o fallback.
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining(message.wamid),
      expect.any(Error),
    );
  });

  it('rethrows when sending fails, so BullMQ can retry', async () => {
    const { deps } = buildDeps(verifiedIdentity);
    (deps.cloudApi.sendText as jest.Mock).mockRejectedValueOnce(new Error('graph 503'));
    await expect(processInboundMessage(deps, message)).rejects.toThrow('graph 503');
  });

  it('redeems a link code for a phone that is not linked yet', async () => {
    const { deps, sendText, prisma } = buildDeps(null);
    const codeMessage = { ...message, text: 'ABCDEF' };
    await processInboundMessage(deps, codeMessage);
    expect(prisma.linkCode.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { code: 'ABCDEF' } }),
    );
    expect(runAgent).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith(
      '+5511988887777',
      expect.stringMatching(/código não encontrado/i),
    );
  });

  it('does not treat a verified user\'s word-shaped message as a link code', async () => {
    const { deps, sendText, prisma } = buildDeps(verifiedIdentity);
    const wordMessage = { ...message, text: 'VENDAS' };
    await processInboundMessage(deps, wordMessage);
    expect(prisma.linkCode.findUnique).not.toHaveBeenCalled();
    expect(runAgent).toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith('+5511988887777', 'Você faturou R$ 4.800,00.');
  });
});
