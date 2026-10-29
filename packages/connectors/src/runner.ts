import type { PrismaClient } from '@prisma/client';
import type { Pseudonymizer } from '@center/pii';
import type { CommerceConnector, ReadContext } from './types.js';
import { persistOrder } from './persist.js';

export const SYNC_RESOURCE = 'orders';
/** Pedidos mudam de status depois de emitidos; reler 3 dias captura isso. */
export const DEFAULT_OVERLAP_DAYS = 3;
export const DEFAULT_BACKFILL_DAYS = 90;

const BUSINESS_TIME_ZONE = 'America/Sao_Paulo';

export interface RunSyncDeps {
  prisma: PrismaClient;
  connector: CommerceConnector;
  /** Já validado por `connector.parseSettings` (ou montado pelo chamador). */
  settings: unknown;
  pseudonymizer: Pseudonymizer;
  organizationId: string;
  now?: () => Date;
  logger?: ReadContext['logger'];
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
 * Lê uma janela de datas pelo conector e grava cada pedido.
 *
 * Um pedido problemático nunca derruba a rodada: contamos a falha e seguimos.
 * Um único pedido atípico não pode impedir que os outros 9.999 entrem no banco.
 */
async function syncWindow(deps: RunSyncDeps, from: string, to: string): Promise<SyncResult> {
  const log = deps.logger ?? (() => {});
  let ordersProcessed = 0;
  let ordersFailed = 0;

  const records = deps.connector.readOrders(
    deps.settings,
    { from, to },
    { pseudonymizer: deps.pseudonymizer, logger: log },
  );

  for await (const record of records) {
    if (record.kind === 'failure') {
      ordersFailed += 1;
      continue;
    }
    try {
      await persistOrder(
        { prisma: deps.prisma, organizationId: deps.organizationId },
        record.order,
        record.items,
      );
      ordersProcessed += 1;
    } catch (error) {
      ordersFailed += 1;
      log('falha ao gravar pedido', {
        numeroPedido: record.order.numeroPedido,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { ordersProcessed, ordersFailed, from, to };
}

async function recordSuccess(deps: RunSyncDeps, cursorDate: string, processed: number, backfill: boolean): Promise<void> {
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

async function recordFailure(deps: RunSyncDeps, message: string): Promise<void> {
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

export async function runCommerceSync(
  deps: RunSyncDeps,
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
