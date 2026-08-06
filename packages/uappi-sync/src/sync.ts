import type { PrismaClient } from '@prisma/client';
import type { Pseudonymizer } from '@center/pii';
import type { UappiClientLike } from '@center/uappi-client';
import { UappiOrderSchema, UappiOrderSummarySchema } from './schemas.js';
import { mapOrder } from './mapper.js';
import { persistOrder } from './persist.js';

export const SYNC_RESOURCE = 'orders';
/** Pedidos mudam de status depois de emitidos; reler 3 dias captura isso. */
export const DEFAULT_OVERLAP_DAYS = 3;
export const DEFAULT_BACKFILL_DAYS = 90;

const BUSINESS_TIME_ZONE = 'America/Sao_Paulo';

export interface SyncDeps {
  prisma: PrismaClient;
  /** `UappiClientLike`, não a classe concreta — permite injetar `MockUappiClient` (T5B). */
  client: UappiClientLike;
  pseudonymizer: Pseudonymizer;
  organizationId: string;
  statusOverrides?: Record<string, string> | null;
  now?: () => Date;
  logger?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface SyncResult {
  ordersProcessed: number;
  ordersFailed: number;
  from: string;
  to: string;
}

function todayIso(now: () => Date): string {
  return now().toLocaleDateString('en-CA', { timeZone: BUSINESS_TIME_ZONE });
}

function shiftDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Percorre uma janela de datas, busca o detalhe de cada pedido e grava.
 *
 * Um pedido problemático nunca derruba a rodada: contamos a falha e seguimos.
 * Um único pedido atípico não pode impedir que os outros 9.999 entrem no banco.
 */
async function syncWindow(deps: SyncDeps, from: string, to: string): Promise<SyncResult> {
  const log = deps.logger ?? (() => {});
  let ordersProcessed = 0;
  let ordersFailed = 0;

  for await (const page of deps.client.iterateOrders({ from, to })) {
    for (const raw of page) {
      const summary = UappiOrderSummarySchema.safeParse(raw);
      if (!summary.success) {
        ordersFailed += 1;
        log('pedido da listagem sem numeroPedido, ignorado');
        continue;
      }

      try {
        const detail = await deps.client.getOrder(summary.data.numeroPedido);
        const parsed = UappiOrderSchema.parse(detail);
        const { order, items } = mapOrder(parsed, {
          pseudonymizer: deps.pseudonymizer,
          statusOverrides: deps.statusOverrides ?? null,
        });
        await persistOrder(
          { prisma: deps.prisma, organizationId: deps.organizationId },
          order,
          items,
        );
        ordersProcessed += 1;
      } catch (error) {
        ordersFailed += 1;
        log('falha ao sincronizar pedido', {
          numeroPedido: summary.data.numeroPedido,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return { ordersProcessed, ordersFailed, from, to };
}

async function recordSuccess(deps: SyncDeps, cursorDate: string, processed: number, backfill: boolean): Promise<void> {
  const update: Record<string, unknown> = {
    cursorDate,
    lastSyncedAt: deps.now?.() ?? new Date(),
    lastError: null,
    ordersSynced: { increment: processed },
  };
  if (backfill) update.backfillDoneAt = deps.now?.() ?? new Date();

  await deps.prisma.syncState.upsert({
    where: {
      organizationId_resource: { organizationId: deps.organizationId, resource: SYNC_RESOURCE },
    },
    create: {
      organizationId: deps.organizationId,
      resource: SYNC_RESOURCE,
      cursorDate,
      lastSyncedAt: deps.now?.() ?? new Date(),
      ordersSynced: processed,
      ...(backfill ? { backfillDoneAt: deps.now?.() ?? new Date() } : {}),
    },
    update,
  });
}

async function recordFailure(deps: SyncDeps, message: string): Promise<void> {
  // Sem `cursorDate` no update: uma falha NÃO pode avançar o cursor, senão a
  // janela que falhou nunca mais seria lida.
  await deps.prisma.syncState.upsert({
    where: {
      organizationId_resource: { organizationId: deps.organizationId, resource: SYNC_RESOURCE },
    },
    create: {
      organizationId: deps.organizationId,
      resource: SYNC_RESOURCE,
      lastError: message,
    },
    update: { lastError: message },
  });
}

export async function runBackfill(
  deps: SyncDeps,
  options: { days?: number } = {},
): Promise<SyncResult> {
  const now = deps.now ?? (() => new Date());
  const to = todayIso(now);
  const from = shiftDays(to, -(options.days ?? DEFAULT_BACKFILL_DAYS));

  try {
    const result = await syncWindow(deps, from, to);
    await recordSuccess(deps, to, result.ordersProcessed, true);
    return result;
  } catch (error) {
    await recordFailure(deps, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export async function runIncrementalSync(
  deps: SyncDeps,
  options: { overlapDays?: number; backfillDays?: number } = {},
): Promise<SyncResult> {
  const now = deps.now ?? (() => new Date());
  const to = todayIso(now);

  const state = await deps.prisma.syncState.findUnique({
    where: {
      organizationId_resource: { organizationId: deps.organizationId, resource: SYNC_RESOURCE },
    },
  });

  // Sem backfill concluído, a primeira rodada É o backfill.
  const from = state?.backfillDoneAt && state.cursorDate
    ? shiftDays(state.cursorDate, -(options.overlapDays ?? DEFAULT_OVERLAP_DAYS))
    : shiftDays(to, -(options.backfillDays ?? DEFAULT_BACKFILL_DAYS));

  const isBackfill = !state?.backfillDoneAt;

  try {
    const result = await syncWindow(deps, from, to);
    await recordSuccess(deps, to, result.ordersProcessed, isBackfill);
    return result;
  } catch (error) {
    await recordFailure(deps, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
