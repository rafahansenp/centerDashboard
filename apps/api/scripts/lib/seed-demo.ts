/**
 * Peças puras/testáveis de `seed-demo.ts` — separadas do arquivo de entrada
 * (que faz I/O real: Postgres, `SecretBox`, o sync de verdade) pelo mesmo
 * motivo que `provision-admin.ts` foi dividido em T24B: as decisões de
 * negócio (recusar rodar fora de modo mock, nunca sobrescrever credencial
 * existente, derivar um toque de atribuição de um pedido já sincronizado)
 * precisam ser exercitadas em teste sem depender de um Postgres real.
 */

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

/** As mesmas 4 colunas que `apps/api/src/routes/settings.ts` lê/escreve. */
export interface OrgIntegrationColumns {
  uappiApiKey: string | null;
  uappiSecretKey: string | null;
  ga4PropertyId: string | null;
  ga4BigQueryDataset: string | null;
}

/** Qualquer valor não vazio serve em modo mock — ver docs/rodar-local.md, Passo 8. */
export const DEMO_UAPPI_API_KEY = 'demo-mock-uappi-key';
export const DEMO_UAPPI_SECRET_KEY = 'demo-mock-uappi-secret';
export const DEMO_GA4_PROPERTY_ID = '000000000';
export const DEMO_GA4_BIGQUERY_DATASET = 'demo_dataset';

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
 * `encryptUappi` isola a dependência de `SecretBox` (que exige uma chave
 * hex de 64 caracteres) para este helper continuar chamável em teste sem
 * construir uma de verdade.
 */
export function planIntegrationWrite(
  org: OrgIntegrationColumns,
  encryptUappi: (plaintext: string) => string,
): CredentialPlan {
  const data: Record<string, string> = {};
  const notes: string[] = [];

  if (shouldSetUappiCredentials(org)) {
    data.uappiApiKey = encryptUappi(DEMO_UAPPI_API_KEY);
    data.uappiSecretKey = encryptUappi(DEMO_UAPPI_SECRET_KEY);
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
