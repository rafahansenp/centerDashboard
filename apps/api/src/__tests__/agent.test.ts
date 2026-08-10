import { MockLanguageModelV2 } from 'ai/test';
import type { MetricGateway } from '@center/mcp-core';
import type { MetricSeries, TenantContext } from '@center/shared';
import { MAX_REPLY_CHARS, buildSystemPrompt, defaultModel, runAgent } from '../agent/agent.js';

const tenant: TenantContext = { organizationId: 'org_1', externalIds: {} };

const series: MetricSeries = {
  metricId: 'commerce.revenue', source: 'commerce', unit: 'currency', granularity: 'day',
  total: 480000, points: [{ date: '2026-02-01', value: 480000 }],
};

function buildGateway() {
  return {
    listMetrics: jest.fn(async () => [{
      id: 'commerce.revenue', label: 'Faturamento', description: 'receita',
      source: 'commerce', unit: 'currency', dimensions: [],
    }]),
    queryMetric: jest.fn(async () => series),
    queryBatch: jest.fn(async () => [series, series]),
    callTool: jest.fn(async () => ({ rows: [] })),
  } as unknown as MetricGateway;
}

const usage = { inputTokens: 10, outputTokens: 10, totalTokens: 20 };

function textOnlyModel(text: string) {
  return new MockLanguageModelV2({
    doGenerate: async () => ({
      finishReason: 'stop' as const, usage,
      content: [{ type: 'text' as const, text }], warnings: [],
    }),
  });
}

function toolThenTextModel(toolName: string, input: unknown, finalText: string) {
  let call = 0;
  return new MockLanguageModelV2({
    doGenerate: async () => {
      call += 1;
      if (call === 1) {
        return {
          finishReason: 'tool-calls' as const, usage,
          content: [{ type: 'tool-call' as const, toolCallId: 'call_1', toolName, input: JSON.stringify(input) }],
          warnings: [],
        };
      }
      return {
        finishReason: 'stop' as const, usage,
        content: [{ type: 'text' as const, text: finalText }], warnings: [],
      };
    },
  });
}

const baseInput = {
  tenant, today: '2026-03-15', history: [], userMessage: 'quanto vendemos mês passado?',
};

describe('buildSystemPrompt', () => {
  it('embeds today so the model never guesses the date', () => {
    expect(buildSystemPrompt('2026-03-15')).toContain('2026-03-15');
  });

  it('forbids inventing numbers', () => {
    expect(buildSystemPrompt('2026-03-15')).toMatch(/nunca estime|jamais/i);
  });

  it('warns about cents explicitly', () => {
    expect(buildSystemPrompt('2026-03-15')).toMatch(/CENTAVOS/);
  });

  it('states what the agent does not have access to', () => {
    const prompt = buildSystemPrompt('2026-03-15');
    expect(prompt).toMatch(/Crashlytics/);
    expect(prompt).toMatch(/performance/i);
  });

  it('requires the causality caveat to be repeated for every tool that returns one', () => {
    const prompt = buildSystemPrompt('2026-03-15');
    expect(prompt).toMatch(/correlacionar/);
    expect(prompt).toMatch(/impacto_da_versao/);
    expect(prompt).toMatch(/impacto_da_tela/);
  });
});

describe('runAgent', () => {
  it('returns the model reply when no tool is needed', async () => {
    const result = await runAgent({
      ...baseInput, gateway: buildGateway(),
      model: textOnlyModel('Só consigo ajudar com os dados de analytics da conta.'),
    });
    expect(result.reply).toBe('Só consigo ajudar com os dados de analytics da conta.');
    expect(result.toolCalls).toEqual([]);
  });

  it('executes the tool the model asked for and returns the final text', async () => {
    const gateway = buildGateway();
    const result = await runAgent({
      ...baseInput, gateway,
      model: toolThenTextModel(
        'consultar_metrica',
        { metricId: 'commerce.revenue', periodo: 'mês passado' },
        'Você faturou R$ 4.800,00 em fevereiro de 2026.',
      ),
    });
    expect(gateway.queryMetric).toHaveBeenCalledWith(
      expect.objectContaining({ from: '2026-02-01', to: '2026-02-28', tenant }),
    );
    expect(result.reply).toContain('R$ 4.800,00');
  });

  it('records every tool call for auditing', async () => {
    const result = await runAgent({
      ...baseInput, gateway: buildGateway(),
      model: toolThenTextModel('consultar_metrica', { metricId: 'commerce.revenue', periodo: 'mês passado' }, 'pronto'),
    });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ toolName: 'consultar_metrica', success: true });
  });

  it('keeps only the most recent history messages', async () => {
    let promptLength = 0;
    const model = new MockLanguageModelV2({
      doGenerate: async ({ prompt }) => {
        promptLength = prompt.length;
        return { finishReason: 'stop' as const, usage, content: [{ type: 'text' as const, text: 'ok' }], warnings: [] };
      },
    });
    const history = Array.from({ length: 40 }, (_, index) => ({
      role: (index % 2 === 0 ? 'user' : 'assistant') as const, content: `mensagem ${index}`,
    }));
    await runAgent({ ...baseInput, gateway: buildGateway(), history, model });
    // system + 12 do histórico + a mensagem atual
    expect(promptLength).toBe(14);
  });

  it('truncates a reply that is too long for WhatsApp', async () => {
    const result = await runAgent({
      ...baseInput, gateway: buildGateway(), model: textOnlyModel('a'.repeat(3000)),
    });
    expect(result.reply.length).toBeLessThanOrEqual(MAX_REPLY_CHARS);
    expect(result.reply.endsWith('…')).toBe(true);
  });

  it('returns a friendly message when the model itself fails', async () => {
    const model = new MockLanguageModelV2({
      doGenerate: async () => { throw new Error('anthropic 529 overloaded'); },
    });
    const result = await runAgent({ ...baseInput, gateway: buildGateway(), model });
    expect(result.reply).toMatch(/não consegui/i);
    expect(result.toolCalls).toEqual([]);
  });

  it('returns a fallback when the model answers with empty text', async () => {
    const result = await runAgent({ ...baseInput, gateway: buildGateway(), model: textOnlyModel('   ') });
    expect(result.reply).toMatch(/não consegui/i);
  });
});

describe('defaultModel', () => {
  it('builds an Anthropic Claude Sonnet 5 model from an API key without calling the network', () => {
    // createAnthropic(...) só monta o cliente; nenhuma chamada de rede acontece
    // antes de generateText() usar o model retornado.
    const model = defaultModel('sk-ant-fake-key');
    expect(model).toBeTruthy();
  });
});
