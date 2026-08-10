# Deploy

## Staging

```bash
cp .env.example .env   # preencha TODOS os valores; a API não sobe com env faltando
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml logs -f api
```

**Sobre o `.env` usado com `docker-compose.prod.yml`:** preencha também
`POSTGRES_USER`, `POSTGRES_PASSWORD` e `POSTGRES_DB` — eles inicializam o container
do Postgres. Em staging/produção reais, use valores gerados, não o `center`/`center`
do exemplo local. Os campos `DATABASE_URL`/`REDIS_URL` do mesmo `.env` continuam
preenchidos (são usados por `docker-compose.yml`, o compose de desenvolvimento local,
onde as portas do Postgres/Redis são publicadas no host e `localhost` funciona), mas
dentro dos containers `api`/`sync`/`whatsapp` deste compose de produção eles são
**sobrescritos** por um bloco `environment:` que aponta para `postgres:5432` e
`redis:6379` — os nomes de serviço na rede interna do Compose, os únicos endereços
que os containeres irmãos realmente enxergam. Isso evita depender de manter dois
valores diferentes de `DATABASE_URL`/`REDIS_URL` no mesmo arquivo `.env` para os dois
cenários (local vs. este compose).

O serviço `api` roda `prisma migrate deploy` antes de iniciar, então a migração
acontece no deploy sem passo manual.

**No primeiro deploy, o serviço `sync` executa um backfill de 90 dias.** Numa loja
com 10 mil pedidos/mês isso leva algumas horas por causa do limite de 60 req/min no
endpoint de detalhe da Uappi. É esperado. Acompanhe:

```bash
docker compose -f docker-compose.prod.yml logs -f sync
```

## Verificação pós-deploy

```bash
curl -f http://localhost:3333/health
docker compose -f docker-compose.prod.yml exec api node dist/scripts/health-report.js
docker compose -f docker-compose.prod.yml logs whatsapp | grep "worker do WhatsApp em execução"
```

## O que monitorar

| Sinal | Onde | Por que importa |
|---|---|---|
| `SyncState.lastSyncedAt` | `health-report.js`, a cada 30 min | **O mais importante.** Sync parado = dashboard e bot respondendo com dados velhos, sem avisar ninguém |
| `SyncState.lastError` | idem | Credencial da Uappi expirada, mudança de contrato da API |
| Profundidade da fila `whatsapp-inbound` | `LLEN bull:whatsapp-inbound:wait` | Fila crescendo = worker morto. Passando de 24 h, o envio falha com erro 131047 |
| Taxa de falha em `ToolCallLog` | `health-report.js` | Fonte de dados fora do ar |
| 401 em `/webhooks/whatsapp` | Log da API | `WHATSAPP_APP_SECRET` errado, ou alguém sondando o endpoint |
| Latência de `/api/metrics/query` | Log da API | Acima de 3 s sustentados: cache frio ou Redis fora |
| Bytes faturados no BigQuery | Console do GCP | Query da Fase 8 sem filtro de partição |

## Rotação do PII_PEPPER

Trocar o `PII_PEPPER` **invalida todos os hashes já gravados** — é o mecanismo de
revogação em caso de vazamento, e é destrutivo por design. Depois de trocar:

1. `TRUNCATE "AttributionTouch";`
2. `UPDATE "CommerceOrder" SET "visitorHash" = NULL;`
3. `UPDATE "CommerceCustomer" SET "emailHash" = NULL, "documentHash" = NULL;`
4. `UPDATE "SyncState" SET "backfillDoneAt" = NULL;` — força um novo backfill, que
   regrava os hashes com o pepper novo a partir de `rawPayload`.

A atribuição histórica anterior ao vazamento é perdida. Isso é intencional.

## Rollback

```bash
git checkout <tag-anterior>
docker compose -f docker-compose.prod.yml up -d --build
```

Migrações do Prisma são aditivas neste projeto (nenhuma coluna é removida), então
voltar o código não exige reverter o banco.
