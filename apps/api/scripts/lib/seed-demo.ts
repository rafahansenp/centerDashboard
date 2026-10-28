/**
 * Peças puras/testáveis de `seed-demo.ts` — separadas do arquivo de entrada
 * (que faz I/O real: Postgres, `SecretBox`, o sync de verdade) pelo mesmo
 * motivo que `provision-admin.ts` foi dividido em T24B: as decisões de
 * negócio (recusar rodar fora de modo mock, nunca sobrescrever credencial
 * existente, derivar um toque de atribuição de um pedido já sincronizado)
 * precisam ser exercitadas em teste sem depender de um Postgres real.
 */
import type { Prisma } from '@prisma/client';

/** Lançada quando o script se recusa a rodar — nunca um upsert silencioso. */
export class SeedDemoRefusedError extends Error {}

/**
 * Guarda primária de segurança (ver brief): este script grava credenciais
 * (ainda que falsas) numa organização. Rodar sem `MOCK_EXTERNAL_APIS=true`
 * poderia, contra um banco de produção mal apontado, sobrescrever a
 * configuração de uma loja real com valores de fixture — por isso a recusa
 * acontece ANTES de qualquer conexão com o banco (ver `seed-demo.ts`).
 */
export function assertMockMode(mockExternalApis: boolean): void {
  if (!mockExternalApis) {
    throw new SeedDemoRefusedError(
      'MOCK_EXTERNAL_APIS não está ligado ("true") — este script só popula dados de demonstração ' +
        'contra os clientes mock (Uappi/GA4/BigQuery). Rodar sem isso arriscaria gravar credenciais ' +
        'de demonstração por cima de uma integração real. Configure MOCK_EXTERNAL_APIS="true" no .env ' +
        'e recarregue o terminal (Passo 3 de docs/rodar-local.md) antes de tentar de novo. Nada foi alterado.',
    );
  }
}

/** As mesmas colunas que `apps/api/src/routes/settings.ts` lê/escreve, mais as
 * novas integrações do app mobile (nota da loja, Firebase, Monday.com) — ainda
 * sem uma tela de Configurações própria, mas gravadas pela mesma convenção. */
export interface OrgIntegrationColumns {
  uappiApiKey: string | null;
  uappiSecretKey: string | null;
  ga4PropertyId: string | null;
  ga4BigQueryDataset: string | null;
  ga4AppPropertyId: string | null;
  playConsoleCredsJson: string | null;
  appStoreConnectKeyJson: string | null;
  mondayApiToken: string | null;
  mondayBoardId: string | null;
}

/** Qualquer valor não vazio serve em modo mock — ver docs/rodar-local.md, Passo 8. */
export const DEMO_UAPPI_API_KEY = 'demo-mock-uappi-key';
export const DEMO_UAPPI_SECRET_KEY = 'demo-mock-uappi-secret';
export const DEMO_GA4_PROPERTY_ID = '000000000';
export const DEMO_GA4_BIGQUERY_DATASET = 'demo_dataset';
export const DEMO_GA4_APP_PROPERTY_ID = '111111111';
export const DEMO_PLAY_CONSOLE_CREDS_JSON = 'demo-mock-play-console-creds';
export const DEMO_APP_STORE_CONNECT_KEY_JSON = 'demo-mock-app-store-connect-key';
export const DEMO_MONDAY_API_TOKEN = 'demo-mock-monday-token';
export const DEMO_MONDAY_BOARD_ID = 'demo-board-001';

/**
 * As duas credenciais da Uappi são configuradas juntas (mesma convenção de
 * `settings.ts`: `configured` só é `true` quando ambas existem) — então a
 * decisão de "já configurado" também é conjunta. Se QUALQUER uma das duas já
 * tiver valor, tratamos a organização como já integrada e não tocamos em
 * nenhuma das duas, mesmo que a outra esteja nula (um estado parcial
 * inesperado não é este script quem deve corrigir).
 */
export function shouldSetUappiCredentials(org: Pick<OrgIntegrationColumns, 'uappiApiKey' | 'uappiSecretKey'>): boolean {
  return org.uappiApiKey === null && org.uappiSecretKey === null;
}

/** GA4 property id e dataset do BigQuery são independentes um do outro. */
export function shouldSetField(value: string | null): boolean {
  return value === null;
}

export interface CredentialWriteNote {
  note: string;
}

export interface CredentialPlan {
  /** Campos a gravar via `prisma.organization.update` — vazio quando nada precisa mudar. */
  data: Record<string, string>;
  /** Uma linha por decisão, para o resumo impresso no fim do script. */
  notes: string[];
}

/**
 * Decide o que escrever na organização SEM tocar no banco — puro, testável.
 * `encrypt` isola a dependência de `SecretBox` (que exige uma chave hex de 64
 * caracteres) para este helper continuar chamável em teste sem construir uma
 * de verdade. Usado por toda credencial cifrada (Uappi, Play Console, App
 * Store Connect, Monday.com) — os identificadores públicos (ga4PropertyId,
 * mondayBoardId…) são gravados em claro.
 */
export function planIntegrationWrite(
  org: OrgIntegrationColumns,
  encrypt: (plaintext: string) => string,
): CredentialPlan {
  const data: Record<string, string> = {};
  const notes: string[] = [];

  if (shouldSetUappiCredentials(org)) {
    data.uappiApiKey = encrypt(DEMO_UAPPI_API_KEY);
    data.uappiSecretKey = encrypt(DEMO_UAPPI_SECRET_KEY);
    notes.push('Uappi: credenciais mock gravadas — o agendador de sync (scheduler.ts) só sincroniza ' +
      'organizações com as duas colunas preenchidas, mesmo em modo mock.');
  } else {
    notes.push('Uappi: credenciais já configuradas — mantidas intactas, nada sobrescrito.');
  }

  if (shouldSetField(org.ga4PropertyId)) {
    data.ga4PropertyId = DEMO_GA4_PROPERTY_ID;
    notes.push(`GA4: ga4PropertyId mock gravado ("${DEMO_GA4_PROPERTY_ID}").`);
  } else {
    notes.push('GA4: ga4PropertyId já configurado — mantido.');
  }

  if (shouldSetField(org.ga4BigQueryDataset)) {
    data.ga4BigQueryDataset = DEMO_GA4_BIGQUERY_DATASET;
    notes.push(`Comportamento (BigQuery): ga4BigQueryDataset mock gravado ("${DEMO_GA4_BIGQUERY_DATASET}").`);
  } else {
    notes.push('Comportamento (BigQuery): ga4BigQueryDataset já configurado — mantido.');
  }

  if (shouldSetField(org.ga4AppPropertyId)) {
    data.ga4AppPropertyId = DEMO_GA4_APP_PROPERTY_ID;
    notes.push(`App (Firebase): ga4AppPropertyId mock gravado ("${DEMO_GA4_APP_PROPERTY_ID}").`);
  } else {
    notes.push('App (Firebase): ga4AppPropertyId já configurado — mantido.');
  }

  if (shouldSetField(org.playConsoleCredsJson)) {
    data.playConsoleCredsJson = encrypt(DEMO_PLAY_CONSOLE_CREDS_JSON);
    notes.push('Qualidade: credencial mock da Play Console gravada (cliente real ainda não implementado).');
  } else {
    notes.push('Qualidade: credencial da Play Console já configurada — mantida.');
  }

  if (shouldSetField(org.appStoreConnectKeyJson)) {
    data.appStoreConnectKeyJson = encrypt(DEMO_APP_STORE_CONNECT_KEY_JSON);
    notes.push('Qualidade: credencial mock da App Store Connect gravada (cliente real ainda não implementado).');
  } else {
    notes.push('Qualidade: credencial da App Store Connect já configurada — mantida.');
  }

  if (shouldSetField(org.mondayApiToken)) {
    data.mondayApiToken = encrypt(DEMO_MONDAY_API_TOKEN);
    notes.push('Sprint: token mock do Monday.com gravado (cliente real ainda não implementado).');
  } else {
    notes.push('Sprint: token do Monday.com já configurado — mantido.');
  }

  if (shouldSetField(org.mondayBoardId)) {
    data.mondayBoardId = DEMO_MONDAY_BOARD_ID;
    notes.push(`Sprint: mondayBoardId mock gravado ("${DEMO_MONDAY_BOARD_ID}").`);
  } else {
    notes.push('Sprint: mondayBoardId já configurado — mantido.');
  }

  return { data, notes };
}

/**
 * Um pedido já persistido pelo pipeline real (`mapOrder` + `persistOrder`),
 * só com as colunas necessárias para derivar um toque de atribuição.
 */
export interface OrderForTouch {
  visitorHash: string;
  attributionSource: string | null;
  attributionMedium: string | null;
  attributionCampaign: string | null;
  attributionDevice: string | null;
  emittedAt: Date;
}

export interface AttributionTouchWrite {
  organizationId: string;
  visitorHash: string;
  emailHash: null;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  device: string | null;
  landingPage: null;
  occurredAt: Date;
}

/**
 * Minutos entre o "toque" (visita ao site) e a compra. Arbitrário mas
 * determinístico — o mesmo pedido sempre produz o mesmo `occurredAt`, o que
 * é exatamente o que a checagem de idempotência em `seed-demo.ts` precisa
 * (mesma chave em toda rodada, nenhuma duplicata).
 */
export const TOUCH_LEAD_MINUTES = 20;

/**
 * Deriva um `AttributionTouch` de um `CommerceOrder` já sincronizado — não
 * cria dado novo, só re-empacota valores que o pipeline real (T7/T8) já
 * calculou.
 *
 * Por que não bater no endpoint público `POST /public/attribution` (que
 * seria o "caminho de código real" mais óbvio, e é como T9 pretendia que
 * toda linha desta tabela nascesse): esse endpoint sempre grava
 * `occurredAt = now()` no servidor, sem permitir informar uma data — não há
 * como, através dele, popular um toque com data de julho de 2026 (a data das
 * fixtures da Uappi) rodando o script em agosto. Chamá-lo aqui produziria
 * toques carimbados com a data de execução do script, órfãos de qualquer
 * pedido no mesmo período — inútil para demonstrar `campaign_conversion`
 * (que junta por período E por `visitorHash`).
 *
 * A alternativa escolhida não inventa PII nenhuma: `visitorHash` já é o HMAC
 * que `mapAttribution` (uappi-sync/mapper.ts) calculou com o mesmo
 * `Pseudonymizer` que o endpoint público usaria — nunca um client_id em
 * claro. `source`/`medium`/`campaign`/`device` são as mesmas tags já
 * normalizadas (minúsculas) que o pedido carrega. Nenhum campo aqui é
 * fabricado; todos vêm de uma coluna que o sync real já escreveu.
 */
export function buildAttributionTouchData(
  organizationId: string,
  order: OrderForTouch,
): AttributionTouchWrite {
  return {
    organizationId,
    visitorHash: order.visitorHash,
    emailHash: null,
    source: order.attributionSource,
    medium: order.attributionMedium,
    campaign: order.attributionCampaign,
    device: order.attributionDevice,
    landingPage: null,
    occurredAt: new Date(order.emittedAt.getTime() - TOUCH_LEAD_MINUTES * 60_000),
  };
}

export function formatCents(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ─────────────── DADOS MOCK DAS NOVAS INTEGRAÇÕES (app mobile) ───────────────
//
// Ao contrário dos pedidos da Uappi (fixture fixa de julho/2026, documentada
// no README), estas três fontes não têm uma data narrativa própria — são
// preenchidas relativas ao momento em que o script roda, para aparecerem sob
// qualquer preset de período (30/90 dias, mês passado) independente de quando
// o seed for executado.

export const APP_STORE_SNAPSHOT_DAYS = 21;

export interface AppStoreSnapshotSeed {
  organizationId: string;
  platform: 'ANDROID' | 'IOS';
  capturedAt: Date;
  averageRating: number;
  ratingCount: number;
  appVersion: string | null;
  rawPayload: Prisma.InputJsonValue;
}

/**
 * Uma linha por (plataforma, dia) nos últimos `APP_STORE_SNAPSHOT_DAYS` dias.
 * `averageRating` oscila de forma determinística (seno do índice do dia) só
 * para o gráfico de tendência não sair uma linha reta; não é ruído aleatório.
 */
export function buildAppStoreSnapshots(organizationId: string, now: Date): AppStoreSnapshotSeed[] {
  const platforms: Array<{ platform: 'ANDROID' | 'IOS'; base: number; startCount: number }> = [
    { platform: 'ANDROID', base: 4.3, startCount: 1180 },
    { platform: 'IOS', base: 4.6, startCount: 640 },
  ];

  const seeds: AppStoreSnapshotSeed[] = [];
  for (const p of platforms) {
    for (let i = APP_STORE_SNAPSHOT_DAYS - 1; i >= 0; i -= 1) {
      const capturedAt = new Date(now);
      capturedAt.setUTCDate(capturedAt.getUTCDate() - i);
      capturedAt.setUTCHours(3, 0, 0, 0);
      const wobble = Math.sin(i / 3) * 0.15;
      seeds.push({
        organizationId,
        platform: p.platform,
        capturedAt,
        averageRating: Number((p.base + wobble).toFixed(2)),
        ratingCount: p.startCount + (APP_STORE_SNAPSHOT_DAYS - 1 - i) * 6,
        appVersion: i < 7 ? '2.4.0' : '2.3.1',
        rawPayload: { source: 'seed-demo', platform: p.platform },
      });
    }
  }
  return seeds;
}

export interface AppFeedbackSeed {
  organizationId: string;
  origin: 'STORE_ANDROID' | 'STORE_IOS' | 'MARKETPLACE';
  category: 'CRITICA' | 'ERRO' | 'SUGESTAO' | 'ELOGIO' | 'OUTRO';
  rating: number | null;
  occurredAt: Date;
  rawPayload: Prisma.InputJsonValue;
}

const FEEDBACK_TEMPLATES: Array<Pick<AppFeedbackSeed, 'origin' | 'category' | 'rating'> & { text: string }> = [
  { origin: 'STORE_ANDROID', category: 'ELOGIO', rating: 5, text: 'App muito bom, treinos completos.' },
  { origin: 'STORE_ANDROID', category: 'ERRO', rating: 2, text: 'Trava ao abrir a dieta do dia.' },
  { origin: 'STORE_IOS', category: 'SUGESTAO', rating: 4, text: 'Podia ter mais receitas de dieta.' },
  { origin: 'STORE_IOS', category: 'CRITICA', rating: 3, text: 'Interface confusa no cadastro de treino.' },
  { origin: 'MARKETPLACE', category: 'OUTRO', rating: null, text: 'Dúvida sobre a assinatura do plano.' },
  { origin: 'STORE_ANDROID', category: 'ELOGIO', rating: 5, text: 'Melhor app de treino que já usei.' },
  { origin: 'MARKETPLACE', category: 'ERRO', rating: null, text: 'Produto do plano não chegou.' },
  { origin: 'STORE_IOS', category: 'ELOGIO', rating: 5, text: 'Muito fácil de acompanhar os exercícios.' },
];

/**
 * Cicla pelos templates acima, espalhando as datas pelos últimos
 * `APP_STORE_SNAPSHOT_DAYS` dias — não é feedback real, só o suficiente para
 * `feedback_by_category` ter uma distribuição plausível entre categorias.
 */
export function buildAppFeedback(organizationId: string, now: Date, count = 24): AppFeedbackSeed[] {
  return Array.from({ length: count }, (_, index) => {
    const template = FEEDBACK_TEMPLATES[index % FEEDBACK_TEMPLATES.length]!;
    const daysAgo = Math.floor((index / count) * APP_STORE_SNAPSHOT_DAYS);
    const occurredAt = new Date(now);
    occurredAt.setUTCDate(occurredAt.getUTCDate() - daysAgo);
    occurredAt.setUTCHours(9 + (index % 10), 0, 0, 0);
    return {
      organizationId,
      origin: template.origin,
      category: template.category,
      rating: template.rating,
      occurredAt,
      rawPayload: { source: 'seed-demo', text: template.text },
    };
  });
}

/** Primeira sprint mockada — mesma numeração do relatório de referência do time. */
export const SPRINT_NUMBER_START = 77;
export const SPRINT_COUNT = 24;
const SPRINT_LENGTH_DAYS = 7;

export interface SprintCycleSeed {
  organizationId: string;
  sprintNumber: number;
  totalTasks: number;
  planned: number;
  carriedFromPrevious: number;
  additionalTasks: number;
  completed: number;
  carriedToNext: number;
  bugfixTest: number;
  bugfixProduction: number;
  startDate: Date;
  endDate: Date;
  rawPayload: Prisma.InputJsonValue;
}

/**
 * Um relatório de sprint por semana, terminando "agora" na mais recente.
 * `carriedFromPrevious` da sprint N é sempre igual a `carriedToNext` da
 * sprint N-1 — a mesma consistência que o board do Monday.com garante de
 * verdade, nunca dois números desencontrados por sprint.
 */
export function buildSprintCycles(organizationId: string, now: Date): SprintCycleSeed[] {
  const cycles: SprintCycleSeed[] = [];
  let carriedFromPrevious = 0;

  for (let i = 0; i < SPRINT_COUNT; i += 1) {
    const sprintNumber = SPRINT_NUMBER_START + i;
    const wobble = Math.sin(i / 2.3);
    const planned = 16 + Math.round(4 * wobble) + (i % 3);
    const additionalTasks = 2 + (i % 4);
    const totalTasks = planned + carriedFromPrevious + additionalTasks;

    // As duas sprints mais recentes ainda estão em andamento (nem tudo
    // entregue) — as anteriores já fecharam.
    const isOpen = i >= SPRINT_COUNT - 2;
    const incomplete = isOpen ? 3 + (i % 3) : Math.max(0, Math.round(2 + wobble));
    const completed = Math.max(0, totalTasks - incomplete);
    const carriedToNext = totalTasks - completed;

    const endDate = new Date(now);
    endDate.setUTCDate(endDate.getUTCDate() - (SPRINT_COUNT - 1 - i) * SPRINT_LENGTH_DAYS);
    endDate.setUTCHours(18, 0, 0, 0);
    const startDate = new Date(endDate);
    startDate.setUTCDate(startDate.getUTCDate() - (SPRINT_LENGTH_DAYS - 1));
    startDate.setUTCHours(9, 0, 0, 0);

    cycles.push({
      organizationId,
      sprintNumber,
      totalTasks,
      planned,
      carriedFromPrevious,
      additionalTasks,
      completed,
      carriedToNext,
      bugfixTest: i % 3,
      bugfixProduction: i % 2,
      startDate,
      endDate,
      rawPayload: { source: 'seed-demo' },
    });

    carriedFromPrevious = carriedToNext;
  }

  return cycles;
}

export interface SprintTaskSeed {
  organizationId: string;
  externalId: string;
  title: string;
  area: 'FRONT' | 'BACK';
  type: 'MELHORIA' | 'CORRECAO' | 'BUGFIX' | 'MODULO';
  status: 'PLANEJADO' | 'ADICIONAL' | 'ENTREGUE';
  sprintNumber: number;
  bugfixEnvironment: 'TESTE' | 'PRODUCAO' | null;
  createdAt: Date;
  deliveredAt: Date | null;
  rawPayload: Prisma.InputJsonValue;
}

const MODULE_TITLES = [
  'Tela de níveis de treino', 'Tela de dietas', 'API de exercícios',
  'Tela de resumo de alimentos', 'API de resumo de feedback',
  'Tela de acompanhamento de cadastro', 'Webhook de feedback do marketplace',
  'Tela de histórico de treinos', 'Tela de metas semanais', 'API de progresso do usuário',
  'Tela de lembretes de treino', 'Integração com balança inteligente',
];
const IMPROVEMENT_TITLES = [
  'Ajuste de layout do cadastro', 'Cache de alimentos', 'Otimiza consulta de treinos',
  'Nova navegação de treinos', 'Reduz tempo de carregamento da loja',
  'Ajuste de contraste no modo escuro', 'Otimiza upload de foto de perfil',
  'Reduz consumo de dados no modo offline', 'Ajuste de acessibilidade nos botões',
];
const BUGFIX_TITLES = [
  'Corrige trava ao salvar dieta', 'Corrige crash na tela de treino',
  'Corrige ícone da nota do app', 'Investiga duplicidade de cadastro',
  'Corrige contagem de exercícios duplicada', 'Corrige sessão expirando cedo demais',
  'Corrige notificação duplicada de treino', 'Corrige sincronização de progresso',
];
const CORRECTION_TITLES = [
  'Ajuste de texto na tela de feedback', 'Correção pega no apk de teste de dieta',
  'Ajuste no contador de exercícios', 'Correção de espaçamento no cadastro',
  'Ajuste na navegação de treinos', 'Correção pega no apk de teste de alimentos',
  'Correção de tradução na tela de treino', 'Ajuste no ícone da loja',
];

/** Distribuição por sprint: soma 15 — perto do volume real de um time pequeno. */
const TASKS_PER_SPRINT = { MODULO: 5, MELHORIA: 4, BUGFIX: 3, CORRECAO: 3 } as const;

/**
 * ~15 tarefas por sprint, distribuídas entre os 4 tipos. `externalId` é a
 * chave natural do Monday.com, então o script faz upsert por ela e rodar de
 * novo não duplica. As duas sprints mais recentes ficam com tarefas em
 * aberto (planejado/adicional); o resto, entregue — espelhando
 * `carriedToNext` de `buildSprintCycles`.
 */
export function buildSprintTasks(organizationId: string, cycles: SprintCycleSeed[]): SprintTaskSeed[] {
  const tasks: SprintTaskSeed[] = [];
  let index = 0;

  for (const cycle of cycles) {
    const createdAt = new Date(cycle.startDate.getTime() + 2 * 24 * 60 * 60 * 1000);
    const isOpen = cycle.sprintNumber >= SPRINT_NUMBER_START + SPRINT_COUNT - 2;
    const deliveredAt = (status: SprintTaskSeed['status']) =>
      status === 'ENTREGUE' ? new Date(createdAt.getTime() + 3 * 24 * 60 * 60 * 1000) : null;

    const entries: Array<Pick<SprintTaskSeed, 'area' | 'type' | 'title' | 'bugfixEnvironment'>> = [];
    const pools: Record<keyof typeof TASKS_PER_SPRINT, string[]> = {
      MODULO: MODULE_TITLES, MELHORIA: IMPROVEMENT_TITLES, BUGFIX: BUGFIX_TITLES, CORRECAO: CORRECTION_TITLES,
    };
    for (const [type, count] of Object.entries(TASKS_PER_SPRINT) as Array<[keyof typeof TASKS_PER_SPRINT, number]>) {
      for (let i = 0; i < count; i += 1) {
        const pool = pools[type];
        entries.push({
          area: (index + i) % 2 === 0 ? 'FRONT' : 'BACK',
          type,
          title: pool[(index + i) % pool.length]!,
          bugfixEnvironment: type === 'BUGFIX' ? (i % 2 === 0 ? 'TESTE' : 'PRODUCAO') : null,
        });
      }
    }

    for (const [entryIndex, entry] of entries.entries()) {
      index += 1;
      const status: SprintTaskSeed['status'] = isOpen
        ? (entryIndex % 3 === 0 ? 'PLANEJADO' : entryIndex % 3 === 1 ? 'ADICIONAL' : 'ENTREGUE')
        : 'ENTREGUE';
      tasks.push({
        organizationId,
        externalId: `monday-demo-${index}`,
        title: entry.title,
        area: entry.area,
        type: entry.type,
        status,
        sprintNumber: cycle.sprintNumber,
        bugfixEnvironment: entry.bugfixEnvironment,
        createdAt,
        deliveredAt: deliveredAt(status),
        rawPayload: { source: 'seed-demo' },
      });
    }
  }

  return tasks;
}
