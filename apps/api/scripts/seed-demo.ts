import { PrismaClient } from '@prisma/client';
import { Pseudonymizer } from '@center/pii';
import { SecretBox } from '@center/secrets';
import { createConnectorRegistry } from '@center/connectors';
import { MODULE_KEYS } from '@center/entitlements';
import { loadConfig } from '../src/config.js';
import { syncAllOrganizations } from '../src/sync/scheduler.js';
import {
  SeedDemoRefusedError,
  assertMockMode,
  planDemoIntegrations,
  buildAttributionTouchData,
  buildAppStoreSnapshots,
  buildAppFeedback,
  buildSprintCycles,
  buildSprintTasks,
  formatCents,
  formatDateOnly,
  type OrderForTouch,
} from './lib/seed-demo.js';

const config = loadConfig(process.env);

async function main(): Promise<number> {
  // Guarda de segurança primeiro, ANTES de qualquer conexão com o banco —
  // ver justificativa em lib/seed-demo.ts. Um `.env` apontando sem querer
  // para um banco real com MOCK_EXTERNAL_APIS=false nunca chega a abrir
  // conexão nenhuma.
  try {
    assertMockMode(config.mockExternalApis);
  } catch (error) {
    if (error instanceof SeedDemoRefusedError) {
      console.error(`recusado: ${error.message}`);
      return 1;
    }
    throw error;
  }

  const prisma = new PrismaClient();
  try {
    const org = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
    if (!org) {
      console.error(
        'recusado: nenhuma organização encontrada no banco. Este script só popula uma organização já ' +
          'existente — rode "pnpm db:seed" (desenvolvimento) ou "node dist/scripts/provision-admin.js" ' +
          '(primeira instalação) antes de tentar de novo. Nada foi alterado.',
      );
      return 1;
    }

    const secretBox = new SecretBox(config.credentialsEncryptionKey);
    const pseudonymizer = new Pseudonymizer(config.piiPepper);

    // 1. Grava as integrações demo no modelo novo (Integration), cifrando os
    //    segredos da COMMERCE com o mesmo SecretBox — nunca um caminho de
    //    gravação paralelo. Nunca sobrescreve uma integração que já exista.
    const existing = await prisma.integration.findMany({ where: { organizationId: org.id }, select: { kind: true } });
    const writes = planDemoIntegrations(existing, secretBox);
    for (const write of writes) {
      await prisma.integration.create({
        data: {
          organizationId: org.id,
          kind: write.kind,
          provider: write.provider as never,
          config: write.config as never,
          secrets: write.secrets,
          secretsUpdatedAt: write.secrets ? new Date() : null,
          status: 'OK',
        },
      });
    }
    await prisma.organizationModule.createMany({
      data: MODULE_KEYS.map((moduleKey) => ({ organizationId: org.id, moduleKey, origin: 'MANUAL' as const })),
      skipDuplicates: true,
    });
    const notes = [
      writes.length > 0
        ? `integrações demo gravadas: ${writes.map((w) => w.kind).join(', ')}.`
        : 'integrações já configuradas — mantidas intactas, nada sobrescrito.',
    ];

    // 2. Sync real: mesmo `syncAllOrganizations` do worker de produção
    //    (sync-worker-main.ts), com o `MockUappiClient` no lugar do cliente
    //    HTTP real — os pedidos atravessam o schema Zod real, `mapOrder` e
    //    `persistOrder` de verdade, exatamente como um pedido de produção.
    //    Idempotente por `numeroPedido` (persist.ts faz upsert) — rodar de
    //    novo não duplica nada.
    console.log('sincronizando pedidos mock da Uappi...');
    const syncReport = await syncAllOrganizations({
      prisma,
      config,
      pseudonymizer,
      secretBox,
      connectors: createConnectorRegistry({ uappiBaseUrl: config.uappiBaseUrl, mock: true }),
      logger: (message, meta) => console.log(`  [sync] ${message}`, meta ?? ''),
    });
    if (syncReport.organizations === 0) {
      console.error(
        'aviso: syncAllOrganizations não encontrou nenhuma organização elegível logo após configurar as ' +
          'credenciais — isso não deveria acontecer; investigue manualmente.',
      );
    }

    // 3. AttributionTouch: deriva um toque por pedido já sincronizado que
    //    carrega visitorHash (ver justificativa detalhada em
    //    buildAttributionTouchData sobre por que isso não é feito batendo no
    //    endpoint público). Idempotente: só insere quando não existe uma
    //    linha com a mesma organização+visitante+instante.
    const ordersWithVisitor = await prisma.commerceOrder.findMany({
      where: { organizationId: org.id, visitorHash: { not: null } },
      select: {
        visitorHash: true,
        attributionSource: true,
        attributionMedium: true,
        attributionCampaign: true,
        attributionDevice: true,
        emittedAt: true,
      },
    });

    let touchesCreated = 0;
    for (const order of ordersWithVisitor as OrderForTouch[]) {
      const touch = buildAttributionTouchData(org.id, order);
      const existing = await prisma.attributionTouch.findFirst({
        where: { organizationId: org.id, visitorHash: touch.visitorHash, occurredAt: touch.occurredAt },
        select: { id: true },
      });
      if (!existing) {
        await prisma.attributionTouch.create({ data: touch });
        touchesCreated += 1;
      }
    }

    // 4. Nota da loja e feedback (Qualidade): sem chave natural em nenhuma das
    //    duas tabelas, então a idempotência aqui é grossa — só popula se a
    //    organização ainda não tiver nenhuma linha de cada tipo. Datas
    //    relativas a `now`, não a julho/2026 (ver comentário em lib/seed-demo.ts).
    const now = new Date();
    const [existingSnapshots, existingFeedback] = await Promise.all([
      prisma.appStoreSnapshot.count({ where: { organizationId: org.id } }),
      prisma.appFeedback.count({ where: { organizationId: org.id } }),
    ]);

    if (existingSnapshots === 0) {
      await prisma.appStoreSnapshot.createMany({ data: buildAppStoreSnapshots(org.id, now) });
    }
    if (existingFeedback === 0) {
      await prisma.appFeedback.createMany({ data: buildAppFeedback(org.id, now) });
    }

    // 5. Sprint (Monday.com): `SprintCycle.sprintNumber` e `SprintTask.externalId`
    //    são chaves naturais — upsert de verdade, roda quantas vezes for
    //    preciso sem duplicar nada. Os ciclos vêm primeiro: as tarefas são
    //    derivadas deles (mesmo sprintNumber, mesma janela de datas).
    const sprintCycles = buildSprintCycles(org.id, now);
    for (const cycle of sprintCycles) {
      await prisma.sprintCycle.upsert({
        where: { organizationId_sprintNumber: { organizationId: org.id, sprintNumber: cycle.sprintNumber } },
        create: cycle,
        update: cycle,
      });
    }
    for (const task of buildSprintTasks(org.id, sprintCycles)) {
      await prisma.sprintTask.upsert({
        where: { organizationId_externalId: { organizationId: org.id, externalId: task.externalId } },
        create: task,
        update: task,
      });
    }

    // 6. Resumo — inclusive a descoberta que este script existe para
    //    resolver (docs/rodar-local.md, achado do brief): qual período
    //    escolher no painel para ver os dados.
    const [
      orderCount, itemCount, customerCount, touchCount, revenue, range,
      snapshotCount, feedbackCount, sprintTaskCount, sprintCycleCount,
    ] = await Promise.all([
      prisma.commerceOrder.count({ where: { organizationId: org.id } }),
      prisma.commerceOrderItem.count({ where: { organizationId: org.id } }),
      prisma.commerceCustomer.count({ where: { organizationId: org.id } }),
      prisma.attributionTouch.count({ where: { organizationId: org.id } }),
      prisma.commerceOrder.aggregate({ where: { organizationId: org.id }, _sum: { totalCents: true } }),
      prisma.commerceOrder.aggregate({
        where: { organizationId: org.id },
        _min: { emittedAt: true },
        _max: { emittedAt: true },
      }),
      prisma.appStoreSnapshot.count({ where: { organizationId: org.id } }),
      prisma.appFeedback.count({ where: { organizationId: org.id } }),
      prisma.sprintTask.count({ where: { organizationId: org.id } }),
      prisma.sprintCycle.count({ where: { organizationId: org.id } }),
    ]);

    console.log('');
    console.log(`organização: "${org.name}" (${org.id})`);
    for (const note of notes) console.log(`  - ${note}`);
    console.log('');
    console.log('estado do banco após o seed:');
    console.log(`  pedidos: ${orderCount}`);
    console.log(`  itens de pedido: ${itemCount}`);
    console.log(`  clientes: ${customerCount}`);
    console.log(`  toques de atribuição: ${touchCount} (${touchesCreated} criados nesta rodada)`);
    console.log(`  faturamento total (todos os status): R$ ${formatCents(revenue._sum.totalCents ?? 0)}`);
    console.log(`  snapshots de nota da loja: ${snapshotCount}`);
    console.log(`  feedback categorizado: ${feedbackCount}`);
    console.log(`  tarefas de sprint: ${sprintTaskCount}`);
    console.log(`  sprints (relatório): ${sprintCycleCount}`);

    if (range._min.emittedAt && range._max.emittedAt) {
      const from = formatDateOnly(range._min.emittedAt);
      const to = formatDateOnly(range._max.emittedAt);
      console.log('');
      console.log(`período coberto pelos pedidos: ${from} a ${to}`);
      console.log(
        'no painel, escolha um período que inclua essas datas (ex.: "Mês passado", "90 dias" ou um ' +
          'intervalo customizado). Se "hoje" estiver fora dessa janela, os presets "Hoje"/"7 dias"/' +
          '"30 dias" aparecerão corretamente vazios — não é um bug.',
      );
    } else {
      console.log('');
      console.log('nenhum pedido foi sincronizado — confira os logs de "[sync]" acima.');
    }

    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

const exitCode = await main();
process.exit(exitCode);
