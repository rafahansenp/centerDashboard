import { PrismaClient } from '@prisma/client';
import { Pseudonymizer } from '@center/pii';
import { SecretBox } from '@center/secrets';
import { MockUappiClient, type UappiClientLike } from '@center/uappi-client';
import { loadConfig } from '../src/config.js';
import { syncAllOrganizations } from '../src/sync/scheduler.js';
import {
  SeedDemoRefusedError,
  assertMockMode,
  planIntegrationWrite,
  buildAttributionTouchData,
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

    // 1. Configura a organização pelas MESMAS colunas que a página de
    //    Configurações escreve (settings.ts), cifrando a credencial da
    //    Uappi com o mesmo SecretBox — nunca um caminho de gravação paralelo.
    //    Nunca sobrescreve valor não nulo já existente.
    const plan = planIntegrationWrite(org, (plaintext) => secretBox.encrypt(plaintext));
    if (Object.keys(plan.data).length > 0) {
      await prisma.organization.update({ where: { id: org.id }, data: plan.data });
    }

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
      buildClient: (): UappiClientLike => new MockUappiClient(),
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

    // 4. Resumo — inclusive a descoberta que este script existe para
    //    resolver (docs/rodar-local.md, achado do brief): qual período
    //    escolher no painel para ver os dados.
    const [orderCount, itemCount, customerCount, touchCount, revenue, range] = await Promise.all([
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
    ]);

    console.log('');
    console.log(`organização: "${org.name}" (${org.id})`);
    for (const note of plan.notes) console.log(`  - ${note}`);
    console.log('');
    console.log('estado do banco após o seed:');
    console.log(`  pedidos: ${orderCount}`);
    console.log(`  itens de pedido: ${itemCount}`);
    console.log(`  clientes: ${customerCount}`);
    console.log(`  toques de atribuição: ${touchCount} (${touchesCreated} criados nesta rodada)`);
    console.log(`  faturamento total (todos os status): R$ ${formatCents(revenue._sum.totalCents ?? 0)}`);

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
