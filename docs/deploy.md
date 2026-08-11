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

## Provisionamento da primeira organização e do primeiro admin

`prisma migrate deploy` (rodado automaticamente pelo serviço `api` acima) só cria o
schema — o banco continua **vazio**. Sem uma organização e um usuário, ninguém
consegue logar, a tela de Configurações (onde as credenciais da Uappi/GA4 são
cadastradas) fica inalcançável, `syncAllOrganizations` não encontra nenhuma
organização para sincronizar, e nenhum código de vínculo do WhatsApp pode ser
gerado. Este passo é obrigatório antes de qualquer outra coisa funcionar.

Rode, uma única vez, contra o serviço `api` já em pé:

```bash
docker compose -f docker-compose.prod.yml exec \
  -e PROVISION_ORG_NAME="Nome da Loja" \
  -e PROVISION_ADMIN_NAME="Seu Nome" \
  -e PROVISION_ADMIN_EMAIL="voce@suaempresa.com" \
  -e PROVISION_ADMIN_PASSWORD="escolha uma senha forte, 12+ caracteres" \
  api node dist/scripts/provision-admin.js
```

**Sem credencial padrão.** O script não tem organização nem senha embutida — as
quatro variáveis acima são obrigatórias e validadas (mesmo padrão Zod de
`src/config.ts`); faltando ou inválida alguma, ele recusa antes de tocar no banco
e lista todos os problemas de uma vez.

**Idempotente, mas conservador: recusa em vez de sobrescrever.** Se o banco já tem
qualquer usuário — seja porque este comando já rodou antes, seja por qualquer outro
motivo — o script recusa (saída não-zero, "recusado: já existem N usuário(s)...") e
**não altera nada**: não troca senha, não cria uma segunda organização, não faz
upsert por e-mail. Rodar o comando de novo por engano (segunda vez, ou contra o
banco errado) é seguro — na pior hipótese, é um no-op que avisa. A checagem e as
duas escritas (organização + admin) rodam na mesma transação: se uma corrida
concorrente (duas execuções simultâneas) colidir no e-mail, a organização criada
naquela chamada específica é desfeita junto — nunca fica um registro órfão.

Para adicionar organizações/usuários adicionais depois do primeiro admin, use a
própria aplicação já provisionada (não há hoje uma segunda rota/script para isso —
é escopo intencionalmente fora deste bootstrap).

`dist/scripts/provision-admin.js` só existe porque `apps/api` compila `scripts/`
como uma segunda unidade TypeScript (`tsconfig.scripts.json`, mesmo mecanismo já
usado por `warm-cache.js`/`health-report.js`) — não precisa de nenhum passo extra
além do `pnpm build` que a imagem já roda.

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
