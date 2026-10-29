# Center Analytics (Uappi + GA4 + WhatsApp) — Plano de Implementação

> **Superado em parte (2026-10-29):** este plano assume uma organização com a Uappi embutida e o WhatsApp como canal principal. A arquitetura passou a ser multi-tenant, modular, com back-office e conectores, e o WhatsApp saiu do MVP. Ver `docs/superpowers/specs/2026-10-29-multi-tenant-modular-design.md`. O plano continua valendo como histórico do que foi construído.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Este documento substitui integralmente** `2026-08-04-center-dashboard-ia.md`. A mudança não é cosmética: a leitura da documentação da Uappi mostrou que os dados de e-commerce **não podem ser consultados ao vivo** (limite de 100 pedidos por página e 120 requisições por minuto), então a arquitetura passa a ter uma camada de ingestão para Postgres. Não reaproveite tarefas do documento anterior sem ler as notas de mudança na seção "O que mudou e por quê".

**Goal:** Responder, por WhatsApp e por dashboard, 39 perguntas de negócio sobre e-commerce (Uappi), aquisição (GA4) e comportamento do app, cruzando fontes quando a pergunta exigir.

**Architecture:** Um worker sincroniza pedidos da Uappi para um *read model* em Postgres (backfill histórico + polling a cada 30 minutos), pseudonimizando dados pessoais com HMAC no momento da gravação. Três MCP servers expõem esse read model e a GA4 Data API sob um contrato comum de duas famílias de ferramentas: `query_metric` (séries temporais uniformes) e ferramentas analíticas nomeadas (rankings, funis, comparações). Um `MetricGateway` com cache Redis é a única porta de entrada, consumida igualmente pela dashboard React e pelo agente de IA no WhatsApp.

**Tech Stack:** pnpm workspaces + Turborepo · TypeScript 5.7 (ESM/NodeNext) · Node 22 · Fastify 5 · Prisma 6 + PostgreSQL 16 · Redis 7 + BullMQ · `@modelcontextprotocol/sdk` · Vercel AI SDK 5 (`ai` + `@ai-sdk/anthropic`, modelo `claude-sonnet-5`) · React 19 + Vite 6 + Tailwind 3 + Recharts 2 (padrão Tremor Raw) + TanStack Query 5 · Jest 29 + `@swc/jest` + React Testing Library + MSW 2 · WhatsApp Cloud API oficial · Uappi/WapStore API v2 · GA4 Data API (+ BigQuery export na Fase 8)

## Global Constraints

- **Node.js 22 LTS.** Todo `package.json` declara `"engines": { "node": ">=22" }`.
- **Todos os pacotes são ESM.** `"type": "module"` + `"module": "NodeNext"`. Imports relativos sempre com sufixo `.js`.
- **Jest roda em modo CJS** via `@swc/jest`, com `moduleNameMapper` removendo o sufixo `.js`. Evita `--experimental-vm-modules`.
- **Modelo de LLM:** `claude-sonnet-5` via `@ai-sdk/anthropic`.
- **Multi-tenant obrigatório.** Nenhuma query, ferramenta de LLM ou rota aceita execução sem `TenantContext`.
- **Nenhum dado pessoal em claro no nosso banco.** `client_id`, e-mail e CPF/CNPJ são gravados **apenas** como HMAC-SHA256 com pepper de servidor (`PII_PEPPER`), via `@center/pii`. Não existe caminho de código que grave esses valores em claro, nem coluna para isso.
- **Credenciais de integração cifradas no banco, nunca em claro.** `uappiApiKey` e `uappiSecretKey` passam por AES-256-GCM (`@center/secrets`, chave em `CREDENTIALS_ENCRYPTION_KEY`) antes de qualquer `INSERT`. Criptografia reversível aqui é correto e deliberado: diferente de PII, o sistema precisa reapresentar essas credenciais à Uappi.
- **Toda API externa tem interface e mock.** `UappiClientLike`, `Ga4ClientLike`, `BigQueryEventsClientLike`. Consumidores dependem da interface, nunca da classe concreta. `MOCK_EXTERNAL_APIS=true` roda o sistema inteiro sem credencial — e `loadConfig` só aceita a string exata `"true"`, nunca em produção.
- **Datas em `YYYY-MM-DD`, timezone de negócio `America/Sao_Paulo`.** Nunca chamar `new Date()` dentro de lógica de negócio: "hoje" é sempre parâmetro injetado.
- **Uappi: `dataEmissao` aceita range com pipe** (`2026-01-01|2026-01-31`); `limit` máximo 100; token JWT expira em **30 minutos**.
- **Limites de taxa da Uappi respeitados no código, não na sorte:** 30 req/min em `/v2/auth`, 120 req/min em `GET /v2/orders`, 60 req/min em `GET /v2/orders/{numeroPedido}`.
- **Polling incremental a cada 30 minutos.** Não reduzir esse intervalo sem recalcular o consumo de cota.
- **Dinheiro é inteiro de centavos em todo o sistema.** Colunas `Int` no Prisma (`totalCents`, `unitPriceCents`…), `number` inteiro em `MetricSeries` e nas ferramentas do agente, e no JSON da API. **`formatMetricValue` é o único ponto que divide por 100** — nem o eixo do gráfico, nem a tooltip, nem o agente fazem essa conta. A T38B trava esse contrato atravessando as quatro camadas.
- **Cobertura mínima de 80%** em `packages/shared`, `packages/pii`, `packages/secrets`, `packages/mcp-core`, `packages/uappi-sync` e `apps/api/src/agent`.
- **Paleta de gráficos validada e fixa**, nesta ordem, nunca reciclada: `#2a78d6` / `#eb6834` / `#1baf7a` / `#eda100` (light) e `#3987e5` / `#d95926` / `#199e70` / `#c98500` (dark). Aplicada como `var(--viz-N)` em props de cor, nunca como classe Tailwind montada em runtime.
- **Todo gráfico tem visão de tabela.** Três cores do modo claro ficam abaixo de 3:1 de contraste — a regra de relevo exige rótulos visíveis ou tabela. Não é opcional.
- **Conventional Commits.**

---

## O que mudou e por quê

| Decisão | Antes | Agora | Motivo |
|---|---|---|---|
| Backend próprio | MCP consulta API ao vivo | **Read model em Postgres**, alimentado por sync | 100 pedidos/página + 120 req/min: consultar o mês ao vivo levaria ~50 s e queimaria a cota |
| Fontes de dados | 3 servers (backend, ga4, firebase) | **3 servers** (commerce, ga4, behavior) | Firebase Analytics **é** o GA4 — mesma propriedade, mesma API. Não é uma fonte separada |
| Contrato MCP | só `query_metric` | `query_metric` **+ ferramentas nomeadas** | Metade das perguntas é ranking, funil ou comparação — não cabe em série temporal |
| Carrinho abandonado | `/checkout/cart` da Uappi | **Funil de e-commerce do GA4** | `/v2/front/checkout/cart` é API de vitrine: devolve o carrinho da sessão atual, não uma lista |
| Crashlytics / Performance | — | **Fora do escopo v1** | Nenhuma das duas tem API REST de leitura; só export para BigQuery |
| Dados pessoais | e-mail/documento em claro | **HMAC-SHA256 com pepper** | Exigência do usuário + LGPD. Chave de join precisa ser determinística e irreversível — HMAC, não criptografia |

---

## Cobertura dos casos de uso

Toda pergunta do escopo aparece aqui com a ferramenta que a responde e a task que a implementa. **Se uma linha não tem task, o plano está incompleto.**

### Grupo A — E-commerce (Uappi → read model)

| # | Pergunta | Ferramenta MCP | Task |
|---|---|---|---|
| A1 | Quanto vendemos hoje / esta semana / este mês? | `query_metric('commerce.revenue')` | T12 |
| A2 | Ticket médio | `query_metric('commerce.average_ticket')` | T12 |
| A3 | Quantos pedidos tivemos hoje? | `query_metric('commerce.orders')` | T12 |
| A4 | Quantos pedidos foram cancelados? | `orders_by_status` | T13 |
| A5 | Quantos pedidos aguardam pagamento? | `orders_by_status` | T13 |
| A6 | Quais compras falharam? | `failed_orders` | T13 |
| A7 | Qual produto mais vendeu? | `top_products` | T14 |
| A8 | Qual produto caiu mais em vendas? | `compare_products` | T14 |
| A9 | Qual categoria vendeu mais? | `top_categories` | T14 |
| A10 | Quais produtos estão sem estoque? | `out_of_stock_products` | T15 (spike S1) |
| A11 | Quantos clientes novos tivemos? | `query_metric('commerce.new_customers')` | T12 |
| A12 | Qual método de pagamento converte mais? | `payment_method_performance` | T13 |

### Grupo B — Aquisição e comportamento agregado (GA4)

| # | Pergunta | Ferramenta MCP | Task |
|---|---|---|---|
| B1 | Quantas sessões tivemos? | `query_metric('ga4.sessions')` | T17 |
| B2 | Quantos usuários ativos tivemos hoje? | `query_metric('ga4.active_users')` | T17 |
| B3 | Quantos novos usuários? | `query_metric('ga4.new_users')` | T17 |
| B4 | Quais eventos ocorreram hoje? | `top_events` | T18 |
| B5 | Quais eventos cresceram após a última atualização? | `compare_events` | T18 |
| B6 | Qual versão do app possui mais usuários? | `app_versions` | T18 |
| B7 | Qual origem trouxe mais usuários? | `traffic_sources` | T18 |
| B8 | Qual campanha trouxe mais usuários? | `campaign_users` | T18 |
| B9 | Qual página possui maior abandono? | `page_performance` | T18 |
| B10 | Qual dispositivo converte melhor? | `device_performance` | T18 |
| B11 | Quais clientes abandonaram o carrinho? | `checkout_funnel` (agregado) | T19 |
| B12 | Quais clientes abandonaram o checkout? | `checkout_funnel` (agregado) | T19 |
| B13 | Qual etapa do checkout possui maior abandono? | `checkout_funnel` | T19 |
| B14 | Qual funil converte menos? | `checkout_funnel` | T19 |

> **B11 e B12 mudam de forma na resposta.** O GA4 é agregado e não expõe identidade — a resposta honesta é *quantos* e *em que etapa*, não *quais clientes*. O agente é instruído a dizer isso explicitamente (T29). Recuperar nomes exigiria endpoint administrativo da Uappi — spike T15.

### Grupo C — Atribuição (Uappi + GA4 capturados no checkout)

| # | Pergunta | Ferramenta MCP | Task |
|---|---|---|---|
| C1 | Qual campanha trouxe mais receita? | `campaign_revenue` | T16 |
| C2 | Quais canais possuem maior ticket médio? | `channel_average_ticket` | T16 |
| C3 | Quais dispositivos geram maior receita? | `device_revenue` | T16 |
| C4 | Qual campanha trouxe mais usuários e vendas? | `campaign_revenue` + `campaign_users` | T16 + T18 |
| C5 | Usuários que clicaram na campanha compraram? | `campaign_conversion` | T16 |
| C6 | Quais campanhas geraram usuários recorrentes? | `campaign_returning_customers` | T16 |

### Grupo D — Correlação temporal entre fontes

| # | Pergunta | Ferramenta MCP | Task |
|---|---|---|---|
| D1 | Quanto vendemos após a versão 5.8? | `revenue_after_app_version` | T21 |
| D2 | A atualização aumentou as vendas? | `revenue_after_app_version` | T21 |
| D3 | O aumento de usuários impactou o faturamento? | `correlate_metrics` | T20 |

### Grupo E — Comportamento em nível de usuário (GA4 BigQuery export)

| # | Pergunta | Ferramenta MCP | Task |
|---|---|---|---|
| E1 | Quais eventos antecedem uma compra? | `events_before_purchase` | T36 |
| E2 | Usuários que abandonam a tela X compram menos? | `screen_abandon_impact` | T37 |

### Fora do escopo da v1 (decisão registrada)

| Pergunta | Motivo |
|---|---|
| Qual versão do app mais está crashando? | Crashlytics não tem API REST de leitura |
| Qual erro aumentou nas últimas 24h? | idem |
| Quais dispositivos apresentam mais crashes? | idem |
| Qual tela demora mais para abrir? | Performance Monitoring não tem API REST de leitura |
| Qual API possui maior tempo de resposta? | idem |
| O aumento de crashes diminuiu as compras? | depende de Crashlytics |
| Existe relação entre crashes e retenção? | depende de Crashlytics |
| Existe relação entre lentidão e abandono? | depende de Performance + Microsoft Clarity (fonte não contratada) |

Para todas as oito, o agente responde que ainda não tem acesso a esses dados e sugere uma pergunta que ele atende (T29). O caminho de habilitação está descrito no Risco R2.

---

## Mapa de Arquivos

```
centerDashboard/
├─ package.json · pnpm-workspace.yaml · turbo.json · tsconfig.base.json
├─ jest.preset.cjs · docker-compose.yml · .env.example · .npmrc
├─ packages/
│  ├─ shared/                    # @center/shared — contratos puros, zero I/O
│  │  └─ src/{metrics.ts,rankings.ts,tenant.ts,date.ts,money.ts,index.ts}
│  ├─ pii/                       # @center/pii — pseudonimização HMAC IRREVERSÍVEL
│  │  └─ src/{pseudonymize.ts,index.ts}
│  ├─ secrets/                   # @center/secrets — criptografia REVERSÍVEL de credenciais
│  │  └─ src/{box.ts,index.ts}
│  ├─ uappi-client/              # @center/uappi-client — HTTP puro: auth, rate limit, paginação
│  │  └─ src/{auth.ts,rate-limiter.ts,client.ts,interface.ts,mock-client.ts,index.ts}
│  │     └─ __fixtures__/orders.fixture.ts
│  ├─ uappi-sync/                # @center/uappi-sync — Uappi → read model
│  │  └─ src/{schemas.ts,status-map.ts,mapper.ts,persist.ts,sync.ts,index.ts}
│  ├─ mcp-core/                  # @center/mcp-core — toolkit server, pool, cache, gateway
│  │  └─ src/{provider.ts,server.ts,pool.ts,series.ts,cache.ts,gateway.ts,correlate.ts,index.ts}
│  ├─ mcp-commerce/              # @center/mcp-commerce — lê o read model
│  │  └─ src/{constants.ts,provider.ts,rankings.ts,status.ts,attribution.ts,inventory.ts,main.ts}
│  ├─ mcp-ga4/                   # @center/mcp-ga4 — GA4 Data API
│  │  └─ src/{client.ts,interface.ts,mock-client.ts,provider.ts,dimensions.ts,rankings.ts,funnel.ts,main.ts}
│  └─ mcp-behavior/              # @center/mcp-behavior — GA4 BigQuery export (Fase 8)
│     └─ src/{client.ts,interface.ts,mock-client.ts,purchase-path.ts,screen-impact.ts,main.ts}
└─ apps/
   ├─ api/                       # @center/api — Fastify + workers
   │  ├─ prisma/{schema.prisma,seed.ts}
   │  └─ src/
   │     ├─ config.ts · server.ts · main.ts · deps.ts · tenant.ts
   │     ├─ auth/{password.ts,jwt.ts,routes.ts}
   │     ├─ routes/{metrics.ts,analysis.ts,attribution.ts,settings.ts}
   │     ├─ analysis/app-version-impact.ts
   │     ├─ agent/{system-prompt.ts,date-resolver.ts,tools.ts,agent.ts,memory.ts}
   │     ├─ whatsapp/{signature.ts,parse.ts,cloud-api-client.ts,linking.ts,routes.ts,link-routes.ts,queue.ts,worker.ts,worker-main.ts}
   │     └─ sync/{scheduler.ts,sync-worker-main.ts}
   └─ web/                       # @center/web — React 19 + Vite
      ├─ public/center-attribution.js
      └─ src/{lib,hooks,components,pages,test}/…
```

**Regra de dependência (unidirecional):**
`shared` ← `pii` ← `uappi-client` ← `uappi-sync` ← `api`
`shared` ← `secrets` ← `api`
`shared` ← `mcp-core` ← `mcp-*` ← `api` ← `web` (via HTTP)

**Dois pacotes de criptografia, nunca intercambiáveis.** `@center/pii` faz HMAC **irreversível** — é a chave de join para dado pessoal, e não existe caminho de volta. `@center/secrets` faz AES-256-GCM **reversível** — é para credenciais de integração que o sistema precisa reapresentar a uma API terceira. Estão em pacotes separados para que o nome do import diga qual operação está acontecendo; juntá-los convidaria alguém a usar a função errada.

**Todo cliente externo tem uma interface e um mock** (`UappiClientLike`, `Ga4ClientLike`, `BigQueryEventsClientLike`). Os consumidores dependem da interface, nunca da classe concreta — é o que permite `MOCK_EXTERNAL_APIS=true` rodar o sistema inteiro sem credencial nenhuma.

`mcp-commerce` lê Postgres via Prisma; **nunca** chama a Uappi — com uma exceção deliberada e documentada, `out_of_stock_products` (T15), porque saldo de estoque de 30 minutos atrás é pior do que nenhum. Fora dela, ingestão e consulta são separadas de propósito: um pico de perguntas não pode consumir a cota da Uappi.

---

## Roadmap — Sprints (1 sprint = 1 semana, 1 dev sênior full-cycle)

| Fase | Nome | Tasks | Sprints | Entregável testável |
|---|---|---|---|---|
| 0 | Fundação | T1–T4, **T4B** | S1 | `pnpm test` verde, schema migrado, PII e credenciais cifradas |
| 1 | Ingestão Uappi | T5, **T5B**, T6–T8 | S2–S3 | Pedidos reais no Postgres, sync de 30 min rodando |
| 2 | MCP core | T10–T11 | S4 | Toolkit + gateway com cache |
| 3 | MCP Commerce | T12–T16 | S4–S5 | Grupos A e C respondíveis via MCP Inspector |
| 4 | MCP GA4 | T17, **T17B**, T18–T19 | S6 | Grupo B respondível |
| 5 | Correlação | T20–T21 | S6 | Grupo D respondível |
| 6 | API + Dashboard | T22–T28, **T24B**, **T28B** **+ T9** | S7–S8 | Dashboard navegável, credenciais configuráveis pela UI |
| 7 | Agente + WhatsApp | T29–T35 | S9–S10 | Bot responde as 39 perguntas |
| 8 | Comportamento (BQ) | T36, **T36B**, T37 | S11 | Grupo E respondível |
| 9 | Ops | T38, **T38B**, T39 | S11 | CI verde, contrato de centavos travado, deploy em staging |

**Total: 11 sprints de desenvolvimento + 1 de buffer = 12 semanas.** As seis tasks `B` somam ~6 dias e cabem no buffer já previsto — nenhuma delas está no caminho crítico.

Premissas (se alguma cair, a estimativa muda):
1. `apiKey`/`secretKey` da Uappi disponíveis **antes do Sprint 3**. Com os mocks da T5B, os Sprints 1–2 rodam sem elas; o backfill real (T8, Step 6) é o primeiro ponto que exige credencial de verdade.
2. Credenciais GA4 (service account com papel Viewer na propriedade) **antes do Sprint 6**. A T17B destrava o desenvolvimento até lá.
3. Conta Meta Business verificada **antes do Sprint 10** — inicie no Sprint 1, leva de 3 dias a 3 semanas.
4. É possível inserir **uma linha de script** no checkout da loja para capturar atribuição (T9). Sem isso, o Grupo C cai de 6 perguntas para 1.
5. A loja já dispara os eventos padrão de e-commerce do GA4 (`view_item`, `add_to_cart`, `begin_checkout`, `add_payment_info`, `purchase`). Sem isso, o Grupo B perde 4 perguntas.

**Desenvolvimento sem credencial nenhuma:** com `MOCK_EXTERNAL_APIS=true` no `.env`, Uappi, GA4 e BigQuery respondem por fixtures determinísticas (T5B, T17B, T36B). O sistema inteiro — sync, MCP servers, dashboard, agente — sobe e funciona. É o modo padrão para onboarding de dev novo e para demonstração.

### Caminho crítico

```
T2 (contratos) → T4 (schema) → T5 (cliente Uappi) → T7 (mapper) → T8 (sync) → T12 (métricas) → T30 (ferramentas do agente)
```
T17–T19 (GA4) são paralelizáveis com T12–T16 (Commerce). T22–T28 (dashboard) só dependem de T23 (rotas). Nenhuma task `B` entra no caminho crítico: as de mock (T5B, T17B, T36B) *encurtam* o caminho ao remover a espera por credencial, e T4B/T24B/T28B/T38B são folhas.

---

# FASE 0 — Fundação (Sprint 1)

**Objetivo:** provar o toolchain e travar os contratos antes de escrever regra de negócio. O risco real aqui não é montar workspaces — é **Jest + ESM + TypeScript**, que falha de formas obscuras. T1 existe para queimar esse risco no dia 1.

**Onde os testes entram:** T1 termina com um teste que importa o `@modelcontextprotocol/sdk` (ESM-first) dentro do Jest. Se ele passa, o resto do projeto é seguro. T3 testa a pseudonimização — que é a fronteira de LGPD e precisa ser inquebrável antes de qualquer dado real entrar no banco.

---

### Task 1: Esqueleto do monorepo e preset de testes

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `jest.preset.cjs`, `.gitignore`, `.npmrc`
- Create: `packages/shared/{package.json,tsconfig.json,jest.config.cjs}`, `packages/shared/src/index.ts`
- Test: `packages/shared/src/__tests__/toolchain.test.ts`

**Interfaces:**
- Consumes: nada (primeira task).
- Produces: `jest.preset.cjs` (usado por todos os pacotes); `tsconfig.base.json`; scripts `pnpm build`, `pnpm test`, `pnpm typecheck` na raiz.

- [ ] **Step 1: Inicializar o workspace**

```bash
git init
corepack enable
corepack prepare pnpm@9.15.0 --activate
```

`package.json` (raiz):

```json
{
  "name": "center-analytics",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@9.15.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test",
    "typecheck": "turbo run typecheck",
    "dev": "turbo run dev"
  },
  "devDependencies": {
    "@swc/core": "^1.10.1",
    "@swc/jest": "^0.2.37",
    "@types/jest": "^29.5.14",
    "@types/node": "^22.10.2",
    "jest": "^29.7.0",
    "turbo": "^2.3.3",
    "typescript": "^5.7.2"
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
  - "apps/*"
```

`.npmrc` — resolve peers transitivos de pacotes que ainda não declaram React 19, sem afrouxar a checagem:

```
auto-install-peers=true
```

> Deliberadamente **sem** `strict-peer-dependencies=false`. Manter a checagem estrita significa que um pacote incompatível com React 19 falha o `install` em vez de quebrar em runtime — é o que torna o Risco R6 detectável no minuto zero. Os componentes de gráfico usam Recharts direto (T25), que suporta React 19, então não há peer a silenciar.

`.gitignore`:

```
node_modules/
dist/
.turbo/
coverage/
.env
.env.local
*.log
```

- [ ] **Step 2: tsconfig base e turbo.json**

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  }
}
```

`turbo.json`:

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "test": { "dependsOn": ["^build"], "outputs": ["coverage/**"] },
    "typecheck": { "dependsOn": ["^build"] },
    "dev": { "cache": false, "persistent": true }
  }
}
```

- [ ] **Step 3: Preset Jest compartilhado**

`jest.preset.cjs` — o `moduleNameMapper` remove o sufixo `.js` dos imports relativos (obrigatórios em ESM/NodeNext) para o resolver CJS do Jest encontrá-los.

```js
/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.(t|j)sx?$': [
      '@swc/jest',
      {
        jsc: {
          target: 'es2022',
          parser: { syntax: 'typescript', tsx: true, decorators: false },
          transform: { react: { runtime: 'automatic' } },
        },
        module: { type: 'commonjs' },
      },
    ],
  },
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  transformIgnorePatterns: ['/node_modules/(?!(@modelcontextprotocol)/)'],
  testMatch: ['**/__tests__/**/*.test.ts?(x)'],
  clearMocks: true,
};
```

- [ ] **Step 4: Criar `@center/shared` vazio**

`packages/shared/package.json`:

```json
{
  "name": "@center/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "jest"
  },
  "dependencies": { "zod": "^3.24.1" },
  "devDependencies": { "@modelcontextprotocol/sdk": "^1.12.0" }
}
```

`packages/shared/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "./src", "outDir": "./dist" },
  "include": ["src/**/*"],
  "exclude": ["src/**/__tests__/**"]
}
```

`packages/shared/jest.config.cjs`:

```js
module.exports = {
  ...require('../../jest.preset.cjs'),
  coverageThreshold: { global: { branches: 80, functions: 80, lines: 80, statements: 80 } },
};
```

`packages/shared/src/index.ts`:

```ts
export const PACKAGE_NAME = '@center/shared';
```

- [ ] **Step 5: Escrever o teste que valida o toolchain**

`packages/shared/src/__tests__/toolchain.test.ts`:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PACKAGE_NAME } from '../index.js';

describe('toolchain', () => {
  it('resolves relative ESM imports written with a .js suffix', () => {
    expect(PACKAGE_NAME).toBe('@center/shared');
  });

  it('loads the ESM-first MCP SDK inside Jest', () => {
    expect(new McpServer({ name: 'probe', version: '0.0.0' })).toBeInstanceOf(McpServer);
  });
});
```

- [ ] **Step 6: Instalar e rodar**

```bash
pnpm install
pnpm --filter @center/shared test
```

Expected: 2 testes PASS.

Se o segundo falhar com `Cannot use import statement outside a module` apontando para o SDK, confira `transformIgnorePatterns` no Step 3. **Não avance com esse teste vermelho** — toda a Fase 2 depende dele.

- [ ] **Step 7: Commit**

```bash
git add .
git commit -m "chore: bootstrap pnpm monorepo with turbo and jest/swc preset"
```

---

### Task 2: Contratos de domínio em `@center/shared`

**Files:**
- Create: `packages/shared/src/{tenant.ts,money.ts,date.ts,metrics.ts,rankings.ts}`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/__tests__/{date.test.ts,money.test.ts,metrics.test.ts}`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `TenantContextSchema` / `TenantContext` — `{ organizationId: string; externalIds: Record<string,string> }`
  - `MetricSourceSchema` / `MetricSource` — `'commerce' | 'ga4' | 'behavior'`
  - `MetricUnitSchema` / `MetricUnit` — `'count' | 'currency' | 'ratio' | 'duration'`
  - `GranularitySchema` / `Granularity` — `'day' | 'week' | 'month'`
  - `MetricDescriptorSchema` / `MetricDescriptor`, `MetricQuerySchema` / `MetricQuery`, `MetricPointSchema` / `MetricPoint`, `MetricSeriesSchema` / `MetricSeries`, `MetricCatalogSchema`
  - `RankingQuerySchema` / `RankingQuery`, `RankingRowSchema` / `RankingRow`, `RankingResultSchema` / `RankingResult`
  - `FunnelStepSchema` / `FunnelStep`, `FunnelResultSchema` / `FunnelResult`
  - `bucketStart(isoDate, granularity)`, `eachBucket(from, to, granularity)`
  - `toCents(brl: string | number): number`, `fromCents(cents: number): string`, `sumCents(values: number[]): number`

**Decisão sobre dinheiro:** valores monetários trafegam como **inteiro de centavos** (`number`) dentro do sistema e como **string decimal** na borda JSON. Somar `0.1 + 0.2` em ponto flutuante produz `0.30000000000000004`, e um relatório de faturamento com esse erro acumulado é indefensável.

- [ ] **Step 1: Escrever os testes de data e dinheiro (falhando)**

`packages/shared/src/__tests__/date.test.ts`:

```ts
import { bucketStart, eachBucket } from '../date.js';

describe('bucketStart', () => {
  it('returns the same date for day granularity', () => {
    expect(bucketStart('2026-03-17', 'day')).toBe('2026-03-17');
  });

  it('snaps to the Monday of the ISO week', () => {
    expect(bucketStart('2026-03-17', 'week')).toBe('2026-03-16');
    expect(bucketStart('2026-03-16', 'week')).toBe('2026-03-16');
    expect(bucketStart('2026-03-22', 'week')).toBe('2026-03-16');
  });

  it('snaps to the first day of the month', () => {
    expect(bucketStart('2026-03-17', 'month')).toBe('2026-03-01');
  });

  it('rejects a malformed date', () => {
    expect(() => bucketStart('17/03/2026', 'day')).toThrow('data inválida');
  });
});

describe('eachBucket', () => {
  it('enumerates every day inclusive of both ends', () => {
    expect(eachBucket('2026-03-01', '2026-03-04', 'day')).toEqual([
      '2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04',
    ]);
  });

  it('enumerates month buckets across a year boundary', () => {
    expect(eachBucket('2025-11-15', '2026-01-02', 'month')).toEqual([
      '2025-11-01', '2025-12-01', '2026-01-01',
    ]);
  });

  it('returns a single bucket when from equals to', () => {
    expect(eachBucket('2026-03-01', '2026-03-01', 'day')).toEqual(['2026-03-01']);
  });

  it('throws when the range is inverted', () => {
    expect(() => eachBucket('2026-03-05', '2026-03-01', 'day')).toThrow('range inválido');
  });
});
```

`packages/shared/src/__tests__/money.test.ts`:

```ts
import { fromCents, sumCents, toCents } from '../money.js';

describe('toCents', () => {
  it('converts a decimal string', () => {
    expect(toCents('1234.56')).toBe(123456);
  });

  it('converts a Brazilian formatted string', () => {
    expect(toCents('1.234,56')).toBe(123456);
  });

  it('converts a number', () => {
    expect(toCents(1234.56)).toBe(123456);
  });

  it('rounds half away from zero at the cent', () => {
    expect(toCents('0.005')).toBe(1);
    expect(toCents('0.004')).toBe(0);
  });

  it('handles zero and negative values', () => {
    expect(toCents('0')).toBe(0);
    expect(toCents('-15.50')).toBe(-1550);
  });

  it('throws on a non numeric string', () => {
    expect(() => toCents('abc')).toThrow('valor monetário inválido');
  });
});

describe('fromCents', () => {
  it('formats cents back to a decimal string', () => {
    expect(fromCents(123456)).toBe('1234.56');
  });

  it('pads the cents', () => {
    expect(fromCents(5)).toBe('0.05');
    expect(fromCents(50)).toBe('0.50');
  });

  it('formats zero and negatives', () => {
    expect(fromCents(0)).toBe('0.00');
    expect(fromCents(-1550)).toBe('-15.50');
  });
});

describe('sumCents', () => {
  it('sums without floating point drift', () => {
    // 0.1 + 0.2 em float dá 0.30000000000000004; em centavos dá 30.
    expect(sumCents([toCents('0.10'), toCents('0.20')])).toBe(30);
  });

  it('returns zero for an empty list', () => {
    expect(sumCents([])).toBe(0);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `pnpm --filter @center/shared test`
Expected: FAIL — `Cannot find module '../date.js'`.

- [ ] **Step 3: Implementar `tenant.ts` e `money.ts`**

`packages/shared/src/tenant.ts`:

```ts
import { z } from 'zod';

/**
 * Obrigatório em toda consulta. `externalIds` carrega os identificadores da
 * organização em cada fonte — cada MCP server lê só a chave que lhe interessa,
 * e nenhum server guarda estado de tenant.
 *
 * Chaves conhecidas: `ga4PropertyId`, `ga4BigQueryDataset`.
 *
 * SÓ IDENTIFICADORES, NUNCA CREDENCIAIS. Este objeto atravessa o canal stdio de
 * todos os MCP servers e entra no hash da chave de cache; um segredo aqui
 * viraria segredo espalhado por processos que não precisam dele. Quem precisa
 * de credencial a lê do banco e decifra por conta própria (T15, T24).
 */
export const TenantContextSchema = z.object({
  organizationId: z.string().min(1),
  externalIds: z.record(z.string(), z.string()),
});

export type TenantContext = z.infer<typeof TenantContextSchema>;
```

`packages/shared/src/money.ts`:

```ts
/**
 * Dinheiro circula como inteiro de centavos. Ponto flutuante acumula erro e um
 * relatório de faturamento errado por centavos é indefensável.
 */
export function toCents(value: string | number): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`valor monetário inválido: ${value}`);
    return Math.sign(value) * Math.round(Math.abs(value) * 100);
  }

  const normalized = value.trim().includes(',')
    // "1.234,56" (pt-BR) → "1234.56"
    ? value.trim().replace(/\./g, '').replace(',', '.')
    : value.trim();

  if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
    throw new Error(`valor monetário inválido: "${value}"`);
  }

  const parsed = Number(normalized);
  return Math.sign(parsed) * Math.round(Math.abs(parsed) * 100);
}

export function fromCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(Math.trunc(cents));
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

export function sumCents(values: readonly number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}
```

- [ ] **Step 4: Implementar `date.ts`**

Toda aritmética usa `Date.UTC` para não sofrer com o timezone do host. A timezone de negócio só é aplicada na borda, ao resolver "hoje".

`packages/shared/src/date.ts`:

```ts
import type { Granularity } from './metrics.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function toUtc(isoDate: string): Date {
  if (!ISO_DATE.test(isoDate)) {
    throw new Error(`data inválida: "${isoDate}" (esperado YYYY-MM-DD)`);
  }
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(date.getTime())) throw new Error(`data inválida: "${isoDate}"`);
  return date;
}

function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function bucketStart(isoDate: string, granularity: Granularity): string {
  const date = toUtc(isoDate);
  if (granularity === 'day') return toIso(date);
  if (granularity === 'month') {
    return toIso(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)));
  }
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return toIso(date);
}

export function eachBucket(from: string, to: string, granularity: Granularity): string[] {
  const start = toUtc(bucketStart(from, granularity));
  const end = toUtc(bucketStart(to, granularity));
  if (start.getTime() > end.getTime()) {
    throw new Error(`range inválido: "${from}" é posterior a "${to}"`);
  }

  const buckets: string[] = [];
  const cursor = new Date(start.getTime());
  while (cursor.getTime() <= end.getTime()) {
    buckets.push(toIso(cursor));
    if (granularity === 'day') cursor.setUTCDate(cursor.getUTCDate() + 1);
    else if (granularity === 'week') cursor.setUTCDate(cursor.getUTCDate() + 7);
    else cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return buckets;
}
```

- [ ] **Step 5: Implementar `metrics.ts`**

`packages/shared/src/metrics.ts`:

```ts
import { z } from 'zod';
import { TenantContextSchema } from './tenant.js';

export const MetricSourceSchema = z.enum(['commerce', 'ga4', 'behavior']);
export type MetricSource = z.infer<typeof MetricSourceSchema>;

export const MetricUnitSchema = z.enum(['count', 'currency', 'ratio', 'duration']);
export type MetricUnit = z.infer<typeof MetricUnitSchema>;

export const GranularitySchema = z.enum(['day', 'week', 'month']);
export type Granularity = z.infer<typeof GranularitySchema>;

export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'esperado YYYY-MM-DD');

/** `id` é sempre `<source>.<nome>` — é o que permite roteamento sem estado no pool. */
export const MetricDescriptorSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string(),
  source: MetricSourceSchema,
  unit: MetricUnitSchema,
  dimensions: z.array(z.string()),
});
export type MetricDescriptor = z.infer<typeof MetricDescriptorSchema>;

export const MetricQuerySchema = z.object({
  metricId: z.string().min(1),
  from: IsoDateSchema,
  to: IsoDateSchema,
  granularity: GranularitySchema,
  tenant: TenantContextSchema,
  filters: z.record(z.string(), z.string()).optional(),
  groupBy: z.string().optional(),
});
export type MetricQuery = z.infer<typeof MetricQuerySchema>;

export const MetricPointSchema = z.object({
  date: IsoDateSchema,
  /** Contagens e razões em unidade natural; valores monetários em CENTAVOS. */
  value: z.number(),
  group: z.string().optional(),
});
export type MetricPoint = z.infer<typeof MetricPointSchema>;

export const MetricSeriesSchema = z.object({
  metricId: z.string(),
  source: MetricSourceSchema,
  unit: MetricUnitSchema,
  granularity: GranularitySchema,
  total: z.number(),
  points: z.array(MetricPointSchema),
});
export type MetricSeries = z.infer<typeof MetricSeriesSchema>;

export const MetricCatalogSchema = z.object({ metrics: z.array(MetricDescriptorSchema) });
export type MetricCatalog = z.infer<typeof MetricCatalogSchema>;
```

- [ ] **Step 6: Implementar `rankings.ts`**

Metade das perguntas do escopo é ranking, funil ou comparação — nenhuma cabe em série temporal. Estes são os contratos dessa segunda família.

`packages/shared/src/rankings.ts`:

```ts
import { z } from 'zod';
import { IsoDateSchema, MetricUnitSchema } from './metrics.js';
import { TenantContextSchema } from './tenant.js';

export const RankingQuerySchema = z.object({
  from: IsoDateSchema,
  to: IsoDateSchema,
  tenant: TenantContextSchema,
  limit: z.number().int().min(1).max(50).default(10),
  orderBy: z.enum(['revenue', 'quantity', 'orders', 'users', 'sessions']).default('revenue'),
  filters: z.record(z.string(), z.string()).optional(),
});
export type RankingQuery = z.infer<typeof RankingQuerySchema>;

export const RankingRowSchema = z.object({
  key: z.string(),
  label: z.string(),
  value: z.number(),
  unit: MetricUnitSchema,
  /** Métricas secundárias da linha, ex.: { orders: 12, quantity: 30 }. */
  extra: z.record(z.string(), z.number()).default({}),
  /** Participação no total, de 0 a 1. */
  share: z.number().min(0).max(1),
});
export type RankingRow = z.infer<typeof RankingRowSchema>;

export const RankingResultSchema = z.object({
  dimension: z.string(),
  from: IsoDateSchema,
  to: IsoDateSchema,
  total: z.number(),
  unit: MetricUnitSchema,
  rows: z.array(RankingRowSchema),
});
export type RankingResult = z.infer<typeof RankingResultSchema>;

export const FunnelStepSchema = z.object({
  key: z.string(),
  label: z.string(),
  users: z.number(),
  /** Conversão em relação ao passo anterior, de 0 a 1. `null` no primeiro passo. */
  stepConversion: z.number().nullable(),
  /** Abandono absoluto entre o passo anterior e este. */
  dropOff: z.number(),
});
export type FunnelStep = z.infer<typeof FunnelStepSchema>;

export const FunnelResultSchema = z.object({
  from: IsoDateSchema,
  to: IsoDateSchema,
  steps: z.array(FunnelStepSchema),
  /** Chave do passo com maior abandono absoluto. */
  worstStepKey: z.string().nullable(),
  overallConversion: z.number(),
});
export type FunnelResult = z.infer<typeof FunnelResultSchema>;

export const ComparisonRowSchema = z.object({
  key: z.string(),
  label: z.string(),
  valueA: z.number(),
  valueB: z.number(),
  delta: z.number(),
  /** `null` quando `valueA` é zero — variação percentual seria divisão por zero. */
  deltaRatio: z.number().nullable(),
});
export type ComparisonRow = z.infer<typeof ComparisonRowSchema>;

export const ComparisonResultSchema = z.object({
  dimension: z.string(),
  periodA: z.object({ from: IsoDateSchema, to: IsoDateSchema }),
  periodB: z.object({ from: IsoDateSchema, to: IsoDateSchema }),
  unit: MetricUnitSchema,
  rows: z.array(ComparisonRowSchema),
});
export type ComparisonResult = z.infer<typeof ComparisonResultSchema>;
```

- [ ] **Step 7: Reexportar e escrever o teste dos schemas**

`packages/shared/src/index.ts`:

```ts
export * from './tenant.js';
export * from './money.js';
export * from './metrics.js';
export * from './rankings.js';
export * from './date.js';

export const PACKAGE_NAME = '@center/shared';
```

`packages/shared/src/__tests__/metrics.test.ts`:

```ts
import { MetricQuerySchema } from '../metrics.js';
import { RankingResultSchema, FunnelResultSchema } from '../rankings.js';

const validQuery = {
  metricId: 'commerce.revenue',
  from: '2026-01-01',
  to: '2026-01-31',
  granularity: 'day',
  tenant: { organizationId: 'org_1', externalIds: { ga4PropertyId: '111' } },
};

describe('MetricQuerySchema', () => {
  it('accepts a well formed query', () => {
    expect(MetricQuerySchema.parse(validQuery).metricId).toBe('commerce.revenue');
  });

  it('rejects a non ISO date', () => {
    expect(MetricQuerySchema.safeParse({ ...validQuery, from: '01/01/2026' }).success).toBe(false);
  });

  it('rejects a query without a tenant', () => {
    const { tenant: _omitted, ...withoutTenant } = validQuery;
    expect(MetricQuerySchema.safeParse(withoutTenant).success).toBe(false);
  });

  it('rejects an unknown granularity', () => {
    expect(MetricQuerySchema.safeParse({ ...validQuery, granularity: 'hour' }).success).toBe(false);
  });
});

describe('RankingResultSchema', () => {
  it('defaults extra to an empty object', () => {
    const parsed = RankingResultSchema.parse({
      dimension: 'product', from: '2026-01-01', to: '2026-01-31',
      total: 1000, unit: 'currency',
      rows: [{ key: 'SKU1', label: 'Camiseta', value: 600, unit: 'currency', share: 0.6 }],
    });
    expect(parsed.rows[0]?.extra).toEqual({});
  });

  it('rejects a share outside 0..1', () => {
    const result = RankingResultSchema.safeParse({
      dimension: 'product', from: '2026-01-01', to: '2026-01-31',
      total: 1000, unit: 'currency',
      rows: [{ key: 'SKU1', label: 'X', value: 600, unit: 'currency', share: 1.4 }],
    });
    expect(result.success).toBe(false);
  });
});

describe('FunnelResultSchema', () => {
  it('accepts a null stepConversion on the first step', () => {
    const parsed = FunnelResultSchema.parse({
      from: '2026-01-01', to: '2026-01-31',
      steps: [
        { key: 'view_item', label: 'Viu produto', users: 1000, stepConversion: null, dropOff: 0 },
        { key: 'purchase', label: 'Comprou', users: 100, stepConversion: 0.1, dropOff: 900 },
      ],
      worstStepKey: 'purchase',
      overallConversion: 0.1,
    });
    expect(parsed.steps[0]?.stepConversion).toBeNull();
  });
});
```

- [ ] **Step 8: Rodar todos os testes**

Run: `pnpm --filter @center/shared test`
Expected: PASS — 4 suites, 27 testes.

- [ ] **Step 9: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add metric, ranking, funnel, money and date contracts"
```

---

### Task 3: Pseudonimização de dados pessoais

**Files:**
- Create: `packages/pii/{package.json,tsconfig.json,jest.config.cjs}`
- Create: `packages/pii/src/{pseudonymize.ts,index.ts}`
- Test: `packages/pii/src/__tests__/pseudonymize.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `class Pseudonymizer` com `constructor(pepper: string)`, `hashEmail(email: string): string`, `hashDocument(document: string): string`, `hashVisitorId(clientId: string): string`, `hash(namespace: string, value: string): string`
  - `PSEUDONYM_LENGTH = 32`

**Por que HMAC e não criptografia — e por que este pacote é isolado:** uma chave de join precisa ser **determinística** (o mesmo e-mail sempre gera o mesmo valor, senão o join não fecha) e **irreversível** (não existe chave capaz de recuperar o dado original). Criptografia reversível falha no segundo requisito: quem obtiver a chave recupera todos os e-mails. HMAC-SHA256 com um *pepper* que vive só em variável de ambiente atende aos dois. O pacote é separado para que a revisão de código sobre LGPD tenha um alvo pequeno e para que nenhum outro módulo consiga gravar PII em claro por acidente.

- [ ] **Step 1: Criar o pacote**

`packages/pii/package.json`:

```json
{
  "name": "@center/pii",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "jest"
  }
}
```

`packages/pii/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "./src", "outDir": "./dist" },
  "include": ["src/**/*"],
  "exclude": ["src/**/__tests__/**"]
}
```

`packages/pii/jest.config.cjs`:

```js
module.exports = {
  ...require('../../jest.preset.cjs'),
  coverageThreshold: { global: { branches: 90, functions: 90, lines: 90, statements: 90 } },
};
```

- [ ] **Step 2: Escrever o teste (falhando)**

`packages/pii/src/__tests__/pseudonymize.test.ts`:

```ts
import { Pseudonymizer, PSEUDONYM_LENGTH } from '../pseudonymize.js';

const pepper = 'p'.repeat(32);
const other = 'q'.repeat(32);

describe('Pseudonymizer', () => {
  const subject = new Pseudonymizer(pepper);

  it('rejects a pepper shorter than 32 characters', () => {
    expect(() => new Pseudonymizer('curto')).toThrow('PII_PEPPER precisa de ao menos 32 caracteres');
  });

  it('is deterministic — the same input always yields the same hash', () => {
    expect(subject.hashEmail('ana@example.com')).toBe(subject.hashEmail('ana@example.com'));
  });

  it('produces a fixed length lowercase hex value', () => {
    const hash = subject.hashEmail('ana@example.com');
    expect(hash).toHaveLength(PSEUDONYM_LENGTH);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it('normalises the email before hashing', () => {
    const canonical = subject.hashEmail('ana@example.com');
    expect(subject.hashEmail('  ANA@Example.COM  ')).toBe(canonical);
  });

  it('normalises the document by stripping punctuation', () => {
    const canonical = subject.hashDocument('12345678909');
    expect(subject.hashDocument('123.456.789-09')).toBe(canonical);
    expect(subject.hashDocument(' 123 456 789 09 ')).toBe(canonical);
  });

  it('separates namespaces so the same string in two roles never collides', () => {
    expect(subject.hashEmail('12345678909')).not.toBe(subject.hashDocument('12345678909'));
    expect(subject.hashVisitorId('12345678909')).not.toBe(subject.hashDocument('12345678909'));
  });

  it('produces different hashes under a different pepper', () => {
    expect(new Pseudonymizer(other).hashEmail('ana@example.com'))
      .not.toBe(subject.hashEmail('ana@example.com'));
  });

  it('never returns the original value', () => {
    const email = 'ana@example.com';
    const hash = subject.hashEmail(email);
    expect(hash).not.toContain('ana');
    expect(hash).not.toContain('example');
  });

  it('hashes the GA4 client id verbatim apart from trimming', () => {
    expect(subject.hashVisitorId(' 1234567890.1699999999 '))
      .toBe(subject.hashVisitorId('1234567890.1699999999'));
  });

  it('throws on an empty value instead of hashing the empty string', () => {
    expect(() => subject.hashEmail('   ')).toThrow('valor vazio não pode ser pseudonimizado');
    expect(() => subject.hashDocument('')).toThrow('valor vazio não pode ser pseudonimizado');
  });
});
```

- [ ] **Step 3: Rodar e confirmar que falha**

Run: `pnpm --filter @center/pii test`
Expected: FAIL — `Cannot find module '../pseudonymize.js'`.

- [ ] **Step 4: Implementar `pseudonymize.ts`**

`packages/pii/src/pseudonymize.ts`:

```ts
import { createHmac } from 'node:crypto';

/** 32 hex = 128 bits. Suficiente contra colisão, curto para indexar no Postgres. */
export const PSEUDONYM_LENGTH = 32;

const MIN_PEPPER_LENGTH = 32;

/**
 * Converte dado pessoal em identificador determinístico e irreversível.
 *
 * HMAC-SHA256, não criptografia: a chave de join precisa ser determinística
 * (senão o join entre GA4 e pedido não fecha) E irreversível (não deve existir
 * chave capaz de recuperar o e-mail). Criptografia reversível falha no segundo
 * requisito. O pepper vive apenas em variável de ambiente, nunca no banco —
 * quem obtiver um dump do Postgres não consegue reverter nada.
 *
 * Trocar o pepper invalida todos os hashes já gravados. Isso é intencional: é o
 * mecanismo de revogação em caso de vazamento.
 */
export class Pseudonymizer {
  constructor(private readonly pepper: string) {
    if (pepper.length < MIN_PEPPER_LENGTH) {
      throw new Error(`PII_PEPPER precisa de ao menos ${MIN_PEPPER_LENGTH} caracteres`);
    }
  }

  /**
   * O namespace impede que o mesmo texto em papéis diferentes gere o mesmo
   * hash — sem ele, um CPF usado como senha de e-mail colidiria entre colunas.
   */
  hash(namespace: string, value: string): string {
    const normalized = value.trim();
    if (normalized === '') {
      throw new Error('valor vazio não pode ser pseudonimizado');
    }
    return createHmac('sha256', this.pepper)
      .update(`${namespace}:${normalized}`)
      .digest('hex')
      .slice(0, PSEUDONYM_LENGTH);
  }

  hashEmail(email: string): string {
    return this.hash('email', email.trim().toLowerCase());
  }

  /** CPF/CNPJ: só os dígitos importam; a formatação varia entre sistemas. */
  hashDocument(document: string): string {
    const digits = document.replace(/\D/g, '');
    if (digits === '') throw new Error('valor vazio não pode ser pseudonimizado');
    return this.hash('document', digits);
  }

  /** `client_id` do GA4, no formato `1234567890.1699999999`. */
  hashVisitorId(clientId: string): string {
    return this.hash('visitor', clientId);
  }
}
```

`packages/pii/src/index.ts`:

```ts
export * from './pseudonymize.js';
```

- [ ] **Step 5: Rodar os testes**

Run: `pnpm --filter @center/pii test`
Expected: PASS — 10 testes.

- [ ] **Step 6: Commit**

```bash
git add packages/pii
git commit -m "feat(pii): add HMAC pseudonymizer for join keys and personal data"
```

---

### Task 4: Infraestrutura local e schema do read model

**Files:**
- Create: `docker-compose.yml`, `.env.example`
- Create: `apps/api/{package.json,tsconfig.json,jest.config.cjs}`, `apps/api/prisma/schema.prisma`
- Create: `apps/api/src/config.ts`
- Test: `apps/api/src/__tests__/{config.test.ts,prisma-schema.test.ts}`

**Interfaces:**
- Consumes: `@center/shared`, `@center/pii`.
- Produces: `loadConfig(env): AppConfig`; client Prisma com os models `Organization`, `User`, `WhatsAppIdentity`, `LinkCode`, `Conversation`, `Message`, `ToolCallLog`, `ProcessedWebhookEvent`, `CommerceOrder`, `CommerceOrderItem`, `CommerceCustomer`, `AttributionTouch`, `SyncState`.

- [ ] **Step 1: Subir Postgres e Redis**

`docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: center
      POSTGRES_PASSWORD: center
      POSTGRES_DB: center
    ports: ["5432:5432"]
    volumes: ["pgdata:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U center"]
      interval: 5s
      retries: 10

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      retries: 10

volumes:
  pgdata:
```

```bash
docker compose up -d && docker compose ps
```

Expected: ambos `healthy`.

- [ ] **Step 2: Criar o pacote da API**

`apps/api/package.json`:

```json
{
  "name": "@center/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "jest",
    "db:migrate": "prisma migrate dev",
    "db:generate": "prisma generate"
  },
  "dependencies": {
    "@center/shared": "workspace:*",
    "@center/pii": "workspace:*",
    "@prisma/client": "^6.1.0",
    "zod": "^3.24.1"
  },
  "devDependencies": { "prisma": "^6.1.0" }
}
```

`apps/api/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "./src", "outDir": "./dist" },
  "include": ["src/**/*"],
  "exclude": ["src/**/__tests__/**"]
}
```

`apps/api/jest.config.cjs`:

```js
module.exports = {
  ...require('../../jest.preset.cjs'),
  collectCoverageFrom: ['src/agent/**/*.ts'],
  coverageThreshold: { global: { branches: 80, functions: 80, lines: 80, statements: 80 } },
};
```

- [ ] **Step 3: Escrever o schema Prisma**

`apps/api/prisma/schema.prisma`:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum Role {
  ADMIN
  VIEWER
}

enum MessageRole {
  USER
  ASSISTANT
}

/// Agrupamento normalizado de status. O texto do status é configurável na Uappi
/// por loja; agrupamos para que "cancelados" e "aguardando pagamento" sejam
/// perguntáveis sem depender do vocabulário de cada cliente.
enum OrderStatusGroup {
  PAID
  PENDING_PAYMENT
  PROCESSING
  SHIPPED
  DELIVERED
  CANCELLED
  FAILED
  OTHER
}

model Organization {
  id                String   @id @default(cuid())
  name              String
  uappiApiKey       String?
  uappiSecretKey    String?
  ga4PropertyId     String?
  ga4BigQueryDataset String?
  /// Sobrescreve o mapa padrão de status da Uappi: { "<idStatus>": "PAID", ... }
  statusMapping     Json?
  createdAt         DateTime @default(now())

  users              User[]
  whatsappIdentities WhatsAppIdentity[]
  conversations      Conversation[]
  toolCallLogs       ToolCallLog[]
  orders             CommerceOrder[]
  orderItems         CommerceOrderItem[]
  customers          CommerceCustomer[]
  attributionTouches AttributionTouch[]
  syncStates         SyncState[]
}

model User {
  id             String   @id @default(cuid())
  email          String   @unique
  passwordHash   String
  name           String
  role           Role     @default(VIEWER)
  organizationId String
  createdAt      DateTime @default(now())

  organization     Organization      @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  whatsappIdentity WhatsAppIdentity?
  linkCodes        LinkCode[]

  @@index([organizationId])
}

model WhatsAppIdentity {
  id             String    @id @default(cuid())
  phoneE164      String    @unique
  userId         String    @unique
  organizationId String
  verifiedAt     DateTime?
  createdAt      DateTime  @default(now())

  user          User           @relation(fields: [userId], references: [id], onDelete: Cascade)
  organization  Organization   @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  conversations Conversation[]

  @@index([organizationId])
}

model LinkCode {
  code      String    @id
  userId    String
  expiresAt DateTime
  usedAt    DateTime?
  createdAt DateTime  @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
}

model Conversation {
  id                 String   @id @default(cuid())
  organizationId     String
  whatsappIdentityId String
  lastMessageAt      DateTime @default(now())
  createdAt          DateTime @default(now())

  organization     Organization     @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  whatsappIdentity WhatsAppIdentity @relation(fields: [whatsappIdentityId], references: [id], onDelete: Cascade)
  messages         Message[]

  @@index([whatsappIdentityId, lastMessageAt])
}

model Message {
  id             String      @id @default(cuid())
  conversationId String
  role           MessageRole
  content        String      @db.Text
  createdAt      DateTime    @default(now())

  conversation Conversation  @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  toolCallLogs ToolCallLog[]

  @@index([conversationId, createdAt])
}

model ToolCallLog {
  id             String   @id @default(cuid())
  messageId      String?
  organizationId String
  toolName       String
  input          Json
  durationMs     Int
  success        Boolean
  errorMessage   String?
  createdAt      DateTime @default(now())

  message      Message?     @relation(fields: [messageId], references: [id], onDelete: SetNull)
  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@index([organizationId, createdAt])
}

model ProcessedWebhookEvent {
  wamid       String   @id
  processedAt DateTime @default(now())
}

// ─────────────────────────── READ MODEL DE E-COMMERCE ───────────────────────────
// Alimentado pelo sync da Uappi. NUNCA escrito por outra coisa.

model CommerceOrder {
  id             String           @id @default(cuid())
  organizationId String
  /// Chave natural na Uappi.
  numeroPedido   String
  idPedido       String
  statusLabel    String
  statusId       Int
  statusGroup    OrderStatusGroup
  canal          String?
  origem         String?
  tipoVenda      String?
  emittedAt      DateTime
  /// Todos os valores em CENTAVOS.
  subtotalCents  Int
  freightCents   Int
  discountCents  Int
  totalCents     Int
  currency       String           @default("BRL")
  paymentMethod  String?
  customerId     String?

  /// Atribuição capturada no checkout (T9). Nulo quando o pedido veio de fora do site.
  attributionSource   String?
  attributionMedium   String?
  attributionCampaign String?
  attributionDevice   String?
  /// HMAC do client_id do GA4. Nunca o valor original.
  visitorHash         String?

  /// Payload cru da Uappi, para reprocessar sem chamar a API de novo.
  rawPayload Json
  syncedAt   DateTime @default(now())

  organization Organization        @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  customer     CommerceCustomer?   @relation(fields: [customerId], references: [id], onDelete: SetNull)
  items        CommerceOrderItem[]

  @@unique([organizationId, numeroPedido])
  @@index([organizationId, emittedAt])
  @@index([organizationId, statusGroup, emittedAt])
  @@index([organizationId, attributionCampaign, emittedAt])
  @@index([organizationId, visitorHash])
}

model CommerceOrderItem {
  id             String @id @default(cuid())
  organizationId String
  orderId        String
  sku            String
  productName    String
  categoryName   String?
  quantity       Int
  unitPriceCents Int
  totalPriceCents Int
  /// Desnormalizado do pedido: permite agregar por período sem join.
  emittedAt      DateTime

  organization Organization  @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  order        CommerceOrder @relation(fields: [orderId], references: [id], onDelete: Cascade)

  @@index([organizationId, sku, emittedAt])
  @@index([organizationId, categoryName, emittedAt])
  @@index([orderId])
}

model CommerceCustomer {
  id             String    @id @default(cuid())
  organizationId String
  /// idCliente da Uappi. Não é dado pessoal.
  externalId     String
  /// HMAC. Nunca o e-mail ou documento em claro.
  emailHash      String?
  documentHash   String?
  firstOrderAt   DateTime?
  lastOrderAt    DateTime?
  ordersCount    Int       @default(0)
  totalSpentCents Int      @default(0)

  organization Organization    @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  orders       CommerceOrder[]

  @@unique([organizationId, externalId])
  @@index([organizationId, firstOrderAt])
  @@index([organizationId, emailHash])
}

/// Toque de atribuição gravado pelo snippet do checkout (T9), antes do pedido
/// existir. O sync casa por visitorHash quando o pedido chega.
model AttributionTouch {
  id             String   @id @default(cuid())
  organizationId String
  visitorHash    String
  emailHash      String?
  source         String?
  medium         String?
  campaign       String?
  device         String?
  landingPage    String?
  occurredAt     DateTime @default(now())

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@index([organizationId, visitorHash, occurredAt])
  @@index([organizationId, emailHash, occurredAt])
}

/// Estado do sincronizador. Uma linha por organização e recurso.
model SyncState {
  id             String    @id @default(cuid())
  organizationId String
  resource       String
  /// Última janela de dataEmissao já sincronizada, em YYYY-MM-DD.
  cursorDate     String?
  lastSyncedAt   DateTime?
  backfillDoneAt DateTime?
  lastError      String?
  ordersSynced   Int       @default(0)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@unique([organizationId, resource])
}
```

- [ ] **Step 4: Rodar a migration**

`.env.example`:

```
DATABASE_URL="postgresql://center:center@localhost:5432/center?schema=public"
REDIS_URL="redis://localhost:6379"
JWT_SECRET="troque-isto-por-32-caracteres-no-minimo"
PII_PEPPER="troque-isto-tambem-32-caracteres-min"
# 32 bytes em hex (64 caracteres). Gere com: openssl rand -hex 32
CREDENTIALS_ENCRYPTION_KEY=""
ANTHROPIC_API_KEY=""
UAPPI_BASE_URL="https://api.uappi.com.br"
GA4_CREDENTIALS_JSON=""
# "true" liga clientes mock para Uappi/GA4/BigQuery — sem credenciais reais.
# Veja T5B, T17B e T36B. NUNCA "true" em produção.
MOCK_EXTERNAL_APIS="false"
WHATSAPP_APP_SECRET=""
WHATSAPP_VERIFY_TOKEN="troque-isto"
WHATSAPP_ACCESS_TOKEN=""
WHATSAPP_PHONE_NUMBER_ID=""
```

```bash
cp .env.example .env
cd apps/api && pnpm prisma migrate dev --name init && pnpm prisma generate
```

Expected: migration criada e client gerado.

- [ ] **Step 5: Escrever o teste de configuração (falhando)**

`apps/api/src/__tests__/config.test.ts`:

```ts
import { loadConfig } from '../config.js';

const validEnv = {
  DATABASE_URL: 'postgresql://center:center@localhost:5432/center',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'x'.repeat(32),
  PII_PEPPER: 'y'.repeat(32),
  CREDENTIALS_ENCRYPTION_KEY: 'a'.repeat(64),
  ANTHROPIC_API_KEY: 'sk-ant-test',
  UAPPI_BASE_URL: 'https://api.uappi.com.br',
  WHATSAPP_APP_SECRET: 'secret',
  WHATSAPP_VERIFY_TOKEN: 'verify',
  WHATSAPP_ACCESS_TOKEN: 'access',
  WHATSAPP_PHONE_NUMBER_ID: '123',
};

describe('loadConfig', () => {
  it('parses a complete environment', () => {
    const config = loadConfig(validEnv);
    expect(config.port).toBe(3333);
    expect(config.uappiBaseUrl).toBe('https://api.uappi.com.br');
  });

  it('honours an explicit PORT', () => {
    expect(loadConfig({ ...validEnv, PORT: '8080' }).port).toBe(8080);
  });

  it('throws naming the missing variable', () => {
    const { JWT_SECRET: _omitted, ...incomplete } = validEnv;
    expect(() => loadConfig(incomplete)).toThrow(/JWT_SECRET/);
  });

  it('rejects a PII pepper shorter than 32 characters', () => {
    expect(() => loadConfig({ ...validEnv, PII_PEPPER: 'curto' })).toThrow(/PII_PEPPER/);
  });

  it('rejects a credentials encryption key that is not 64 hex characters', () => {
    expect(() => loadConfig({ ...validEnv, CREDENTIALS_ENCRYPTION_KEY: 'curto' }))
      .toThrow(/CREDENTIALS_ENCRYPTION_KEY/);
    expect(() => loadConfig({ ...validEnv, CREDENTIALS_ENCRYPTION_KEY: 'z'.repeat(64) }))
      .toThrow(/CREDENTIALS_ENCRYPTION_KEY/);
  });

  it('defaults the sync interval to 30 minutes', () => {
    expect(loadConfig(validEnv).syncIntervalMinutes).toBe(30);
  });

  it('refuses a sync interval below 10 minutes', () => {
    expect(() => loadConfig({ ...validEnv, SYNC_INTERVAL_MINUTES: '2' }))
      .toThrow(/SYNC_INTERVAL_MINUTES/);
  });

  it('defaults mockExternalApis to false', () => {
    expect(loadConfig(validEnv).mockExternalApis).toBe(false);
  });

  it('parses the literal string "true" as true, and everything else as false', () => {
    expect(loadConfig({ ...validEnv, MOCK_EXTERNAL_APIS: 'true' }).mockExternalApis).toBe(true);
    expect(loadConfig({ ...validEnv, MOCK_EXTERNAL_APIS: 'false' }).mockExternalApis).toBe(false);
    expect(loadConfig({ ...validEnv, MOCK_EXTERNAL_APIS: 'yes' }).mockExternalApis).toBe(false);
  });
});
```

- [ ] **Step 6: Implementar `config.ts`**

`apps/api/src/config.ts`:

```ts
import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3333),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET precisa de ao menos 32 caracteres'),
  PII_PEPPER: z.string().min(32, 'PII_PEPPER precisa de ao menos 32 caracteres'),
  // 32 bytes em hex — exatamente o que AES-256-GCM exige. Gere com `openssl rand -hex 32`.
  CREDENTIALS_ENCRYPTION_KEY: z.string().regex(
    /^[0-9a-f]{64}$/i, 'CREDENTIALS_ENCRYPTION_KEY precisa ter 64 caracteres hexadecimais (32 bytes)',
  ),
  ANTHROPIC_API_KEY: z.string().min(1),
  UAPPI_BASE_URL: z.string().url(),
  GA4_CREDENTIALS_JSON: z.string().default(''),
  // Piso de 10 min protege a cota da Uappi contra um typo na configuração.
  SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(10, 'SYNC_INTERVAL_MINUTES mínimo é 10').default(30),
  SYNC_BACKFILL_DAYS: z.coerce.number().int().min(1).max(730).default(90),
  // z.coerce.boolean() trataria QUALQUER string não vazia como true — inclusive
  // a string "false". Por isso o enum explícito com transform.
  MOCK_EXTERNAL_APIS: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  WHATSAPP_APP_SECRET: z.string().min(1),
  WHATSAPP_VERIFY_TOKEN: z.string().min(1),
  WHATSAPP_ACCESS_TOKEN: z.string().min(1),
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1),
});

export interface AppConfig {
  port: number;
  databaseUrl: string;
  redisUrl: string;
  jwtSecret: string;
  piiPepper: string;
  credentialsEncryptionKey: string;
  anthropicApiKey: string;
  uappiBaseUrl: string;
  ga4CredentialsJson: string;
  syncIntervalMinutes: number;
  syncBackfillDays: number;
  mockExternalApis: boolean;
  whatsapp: {
    appSecret: string;
    verifyToken: string;
    accessToken: string;
    phoneNumberId: string;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined>): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Configuração inválida — ${details}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    jwtSecret: e.JWT_SECRET,
    piiPepper: e.PII_PEPPER,
    credentialsEncryptionKey: e.CREDENTIALS_ENCRYPTION_KEY,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    uappiBaseUrl: e.UAPPI_BASE_URL,
    ga4CredentialsJson: e.GA4_CREDENTIALS_JSON,
    syncIntervalMinutes: e.SYNC_INTERVAL_MINUTES,
    syncBackfillDays: e.SYNC_BACKFILL_DAYS,
    mockExternalApis: e.MOCK_EXTERNAL_APIS,
    whatsapp: {
      appSecret: e.WHATSAPP_APP_SECRET,
      verifyToken: e.WHATSAPP_VERIFY_TOKEN,
      accessToken: e.WHATSAPP_ACCESS_TOKEN,
      phoneNumberId: e.WHATSAPP_PHONE_NUMBER_ID,
    },
  };
}
```

- [ ] **Step 7: Escrever o teste de invariantes do schema**

Protege as propriedades que, se quebradas, causam dano silencioso: duplicação de pedidos no sync e PII em claro.

`apps/api/src/__tests__/prisma-schema.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const schema = readFileSync(join(__dirname, '../../prisma/schema.prisma'), 'utf8');

function modelBody(name: string): string {
  return schema.match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`))?.[0] ?? '';
}

describe('prisma schema invariants', () => {
  it('keeps the order natural key unique per organization', () => {
    expect(modelBody('CommerceOrder')).toMatch(/@@unique\(\[organizationId, numeroPedido\]\)/);
  });

  it('keeps the customer natural key unique per organization', () => {
    expect(modelBody('CommerceCustomer')).toMatch(/@@unique\(\[organizationId, externalId\]\)/);
  });

  it('stores money as integer cents, never Float or Decimal', () => {
    const order = modelBody('CommerceOrder');
    for (const field of ['subtotalCents', 'freightCents', 'discountCents', 'totalCents']) {
      expect(order).toMatch(new RegExp(`${field}\\s+Int`));
    }
    expect(order).not.toMatch(/Float/);
  });

  it('has no column capable of holding personal data in the clear', () => {
    const forbidden = /\b(email|documento|document|cpf|cnpj|clientId|client_id|phone)\s+String/i;
    for (const model of ['CommerceOrder', 'CommerceCustomer', 'AttributionTouch']) {
      const body = modelBody(model);
      const offending = body.split('\n').filter((line) => forbidden.test(line));
      expect(offending).toEqual([]);
    }
  });

  it('only exposes hashed identifiers on customer and attribution', () => {
    expect(modelBody('CommerceCustomer')).toMatch(/emailHash\s+String\?/);
    expect(modelBody('CommerceCustomer')).toMatch(/documentHash\s+String\?/);
    expect(modelBody('AttributionTouch')).toMatch(/visitorHash\s+String/);
  });

  it('keeps the webhook idempotency key as a primary key', () => {
    expect(modelBody('ProcessedWebhookEvent')).toMatch(/wamid\s+String\s+@id/);
  });

  it('scopes every tenant-owned model to an organization', () => {
    for (const model of [
      'CommerceOrder', 'CommerceOrderItem', 'CommerceCustomer',
      'AttributionTouch', 'SyncState', 'WhatsAppIdentity', 'Conversation', 'ToolCallLog',
    ]) {
      expect(modelBody(model)).toMatch(/organizationId\s+String/);
    }
  });

  it('indexes the columns the analytics queries filter on', () => {
    expect(modelBody('CommerceOrder')).toMatch(/@@index\(\[organizationId, emittedAt\]\)/);
    expect(modelBody('CommerceOrder')).toMatch(/@@index\(\[organizationId, statusGroup, emittedAt\]\)/);
    expect(modelBody('CommerceOrderItem')).toMatch(/@@index\(\[organizationId, sku, emittedAt\]\)/);
  });
});
```

- [ ] **Step 8: Rodar os testes**

Run: `pnpm --filter @center/api test`
Expected: PASS — 2 suites, 14 testes.

- [ ] **Step 9: Commit**

```bash
git add docker-compose.yml .env.example apps/api
git commit -m "feat(api): add commerce read model schema and validated config"
```

---

### Task 4B: Criptografia reversível de credenciais de integração

**Files:**
- Create: `packages/secrets/{package.json,tsconfig.json,jest.config.cjs}`
- Create: `packages/secrets/src/{box.ts,index.ts}`
- Test: `packages/secrets/src/__tests__/box.test.ts`

**Interfaces:**
- Consumes: `AppConfig.credentialsEncryptionKey` (T4).
- Produces:
  - `class SecretBox` — `constructor(hexKey: string)`, `encrypt(plaintext: string): string`, `decrypt(ciphertext: string): string`, `decryptOrNull(ciphertext: string | null): string | null`
  - `CIPHERTEXT_FORMAT_VERSION = 'v1'`

**Por que este pacote existe e é separado do `@center/pii`:** `Pseudonymizer` (T3) é **irreversível** por design — é a ferramenta certa para chave de join, mas as credenciais da Uappi (`apiKey`, `secretKey`) precisam ser **lidas de volta** para autenticar chamadas reais. HMAC não serve para isso; a resposta é criptografia simétrica reversível. Separar os dois pacotes deixa explícito, pelo nome do import, qual operação está acontecendo em cada lugar do código — misturar os dois num pacote só convidaria alguém a usar a função errada.

**Formato do texto cifrado:** `v1.<ivHex>.<authTagHex>.<ciphertextHex>`. O prefixo de versão permite trocar de algoritmo no futuro sem quebrar dados já gravados — o decrypt despacha pelo prefixo. O IV é gerado de novo a cada `encrypt()`, então duas chamadas com o mesmo texto produzem cifrados diferentes — isso impede que alguém com acesso de leitura ao banco descubra que duas organizações têm a mesma `secretKey` só comparando bytes.

- [ ] **Step 1: Criar o pacote**

`packages/secrets/package.json`:

```json
{
  "name": "@center/secrets",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "jest"
  }
}
```

`tsconfig.json` e `jest.config.cjs` seguem o molde da T1, Step 4.

- [ ] **Step 2: Escrever o teste (falhando)**

`packages/secrets/src/__tests__/box.test.ts`:

```ts
import { SecretBox } from '../box.js';

const key = 'a'.repeat(64); // 32 bytes em hex
const otherKey = 'b'.repeat(64);

describe('SecretBox', () => {
  const box = new SecretBox(key);

  it('rejects a key that is not 64 hex characters', () => {
    expect(() => new SecretBox('curto')).toThrow('chave precisa ter 64 caracteres hexadecimais');
    expect(() => new SecretBox('z'.repeat(64))).toThrow('chave precisa ter 64 caracteres hexadecimais');
  });

  it('round-trips a plaintext', () => {
    expect(box.decrypt(box.encrypt('minha-secret-key-da-uappi'))).toBe('minha-secret-key-da-uappi');
  });

  it('round-trips an empty string', () => {
    expect(box.decrypt(box.encrypt(''))).toBe('');
  });

  it('round-trips unicode content', () => {
    expect(box.decrypt(box.encrypt('senha-com-açentuação-é-çãz'))).toBe('senha-com-açentuação-é-çãz');
  });

  it('produces a different ciphertext each time — the IV is fresh per call', () => {
    expect(box.encrypt('mesmo-valor')).not.toBe(box.encrypt('mesmo-valor'));
  });

  it('prefixes the ciphertext with the format version', () => {
    expect(box.encrypt('x').startsWith('v1.')).toBe(true);
  });

  it('fails to decrypt with the wrong key', () => {
    const wrongBox = new SecretBox(otherKey);
    expect(() => wrongBox.decrypt(box.encrypt('segredo'))).toThrow();
  });

  it('fails to decrypt tampered ciphertext — GCM catches the modification', () => {
    const ciphertext = box.encrypt('segredo');
    const parts = ciphertext.split('.');
    const tampered = [parts[0], parts[1], parts[2], `${parts[3]!.slice(0, -2)}00`].join('.');
    expect(() => box.decrypt(tampered)).toThrow();
  });

  it('throws a readable error on a malformed ciphertext', () => {
    expect(() => box.decrypt('não-é-um-texto-cifrado-valido')).toThrow('texto cifrado inválido');
    expect(() => box.decrypt('v1.só.duas.partes.demais')).toThrow('texto cifrado inválido');
  });

  it('throws on an unknown format version instead of silently misreading', () => {
    const ciphertext = box.encrypt('x');
    const withBadVersion = `v99${ciphertext.slice(2)}`;
    expect(() => box.decrypt(withBadVersion)).toThrow('versão de formato desconhecida');
  });
});

describe('SecretBox.decryptOrNull', () => {
  const box = new SecretBox(key);

  it('returns null for a null input without touching the crypto layer', () => {
    expect(box.decryptOrNull(null)).toBeNull();
  });

  it('decrypts a real ciphertext normally', () => {
    expect(box.decryptOrNull(box.encrypt('valor'))).toBe('valor');
  });
});
```

- [ ] **Step 3: Rodar e confirmar que falha**

Run: `pnpm --filter @center/secrets test`
Expected: FAIL — `Cannot find module '../box.js'`.

- [ ] **Step 4: Implementar `box.ts`**

`packages/secrets/src/box.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
/** 96 bits — o tamanho de IV recomendado para GCM; usar 128 bits reduz a segurança. */
const IV_LENGTH = 12;
const KEY_LENGTH = 32;
export const CIPHERTEXT_FORMAT_VERSION = 'v1';

/**
 * Criptografia simétrica REVERSÍVEL para credenciais que o sistema precisa usar
 * de volta — ao contrário do `Pseudonymizer` (T3), que é de propósito
 * irreversível. Nunca use este pacote para dado pessoal do usuário final; use
 * para segredos operacionais (apiKey, secretKey) que o próprio sistema
 * apresenta a uma API terceira.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(hexKey: string) {
    if (!/^[0-9a-f]{64}$/i.test(hexKey)) {
      throw new Error('chave precisa ter 64 caracteres hexadecimais (32 bytes)');
    }
    this.key = Buffer.from(hexKey, 'hex');
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return [
      CIPHERTEXT_FORMAT_VERSION,
      iv.toString('hex'),
      authTag.toString('hex'),
      ciphertext.toString('hex'),
    ].join('.');
  }

  decrypt(ciphertext: string): string {
    const parts = ciphertext.split('.');
    if (parts.length !== 4) {
      throw new Error(`texto cifrado inválido: formato esperado "v1.<iv>.<tag>.<dados>"`);
    }
    const [version, ivHex, authTagHex, dataHex] = parts as [string, string, string, string];
    if (version !== CIPHERTEXT_FORMAT_VERSION) {
      throw new Error(`versão de formato desconhecida: "${version}"`);
    }

    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    // Se a chave estiver errada ou o texto tiver sido adulterado, `final()`
    // lança — é a garantia de integridade do GCM, e propagamos o erro puro:
    // mascarar isso faria uma credencial corrompida parecer válida.
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(dataHex, 'hex')),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  }

  /** Atalho para campos opcionais do banco: `null` entra, `null` sai, sem lançar. */
  decryptOrNull(ciphertext: string | null): string | null {
    return ciphertext === null ? null : this.decrypt(ciphertext);
  }
}
```

`packages/secrets/src/index.ts`:

```ts
export * from './box.js';
```

- [ ] **Step 5: Rodar os testes**

Run: `pnpm --filter @center/secrets test`
Expected: PASS — 12 testes.

- [ ] **Step 6: Commit**

```bash
git add packages/secrets
git commit -m "feat(secrets): add reversible AES-256-GCM box for integration credentials"
```

---

# FASE 1 — Ingestão Uappi (Sprints 2–3)

**Objetivo:** pedidos reais no Postgres, atualizados a cada 30 minutos, com PII pseudonimizada na gravação. Depois desta fase, toda pergunta do Grupo A é uma query SQL de ~50 ms.

**As três restrições que desenham esta fase:**
1. **Token JWT expira em 30 minutos.** Um backfill de 90 dias dura horas — o cliente precisa renovar sozinho, e sob concorrência não pode renovar duas vezes em paralelo.
2. **120 req/min na listagem, 60 req/min no detalhe, 100 pedidos por página.** O limitador precisa estar no código, não na esperança. Uma loja com 10 mil pedidos/mês custa ~100 listagens + 10 mil detalhes = ~3 horas de backfill mensal. Isso é aceitável uma vez; não é aceitável por pergunta.
3. **Idempotência.** O polling reprocessa janelas sobrepostas de propósito (pedidos mudam de status depois de emitidos). Rodar o sync duas vezes precisa produzir exatamente o mesmo banco.

**Onde os testes entram:**
1. **O limitador de taxa e o cache de token primeiro** (T5) — são a fronteira que impede sermos bloqueados pela Uappi. Testados com relógio fake, sem `setTimeout` real.
2. **O mapper depois** (T7) — é onde dinheiro vira centavos e PII vira hash. Um erro aqui corrompe o banco de forma silenciosa e difícil de reverter. Recebe a maior bateria de testes da fase.
3. **O sync por último** (T8) — testado com o cliente Uappi mockado e Prisma real? Não: Prisma mockado. O que se testa é a **decisão de janela** e a **idempotência**, não o Postgres.

---

### Task 5: Cliente HTTP da Uappi — autenticação, limite de taxa e paginação

**Files:**
- Create: `packages/uappi-client/{package.json,tsconfig.json,jest.config.cjs}`
- Create: `packages/uappi-client/src/{rate-limiter.ts,auth.ts,client.ts,index.ts}`
- Test: `packages/uappi-client/src/__tests__/{rate-limiter.test.ts,auth.test.ts,client.test.ts}`

**Interfaces:**
- Consumes: nada de outros pacotes.
- Produces:
  - `class RateLimiter` — `constructor(maxPerMinute: number, now?: () => number, sleep?: (ms: number) => Promise<void>)`, `acquire(): Promise<void>`
  - `class UappiTokenProvider` — `constructor(deps: TokenProviderDeps)`, `getToken(): Promise<string>`, `invalidate(): void`
  - `interface UappiCredentials { apiKey: string; secretKey: string }`
  - `class UappiClient` — `constructor(options: UappiClientOptions)`, `listOrders(params: ListOrdersParams): Promise<ListOrdersPage>`, `getOrder(numeroPedido: string): Promise<unknown>`, `iterateOrders(params: IterateOrdersParams): AsyncGenerator<unknown[]>`
  - `interface ListOrdersParams { from: string; to: string; offset: number; limit: number; status?: string }`
  - `interface ListOrdersPage { pedidos: unknown[]; info: { offset: number; limit: number; total: number; exibindo: number } }`
  - `class UappiApiError extends Error { status: number }`

- [ ] **Step 1: Criar o pacote**

`packages/uappi-client/package.json`:

```json
{
  "name": "@center/uappi-client",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "jest"
  },
  "dependencies": { "zod": "^3.24.1" }
}
```

`packages/uappi-client/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "./src", "outDir": "./dist" },
  "include": ["src/**/*"],
  "exclude": ["src/**/__tests__/**"]
}
```

`packages/uappi-client/jest.config.cjs`:

```js
module.exports = {
  ...require('../../jest.preset.cjs'),
  coverageThreshold: { global: { branches: 80, functions: 80, lines: 80, statements: 80 } },
};
```

- [ ] **Step 2: Escrever o teste do limitador (falhando)**

Relógio e `sleep` injetados: um teste de rate limit com `setTimeout` real levaria minutos e seria instável.

`packages/uappi-client/src/__tests__/rate-limiter.test.ts`:

```ts
import { RateLimiter } from '../rate-limiter.js';

function fakeClock() {
  let currentTime = 0;
  const sleeps: number[] = [];
  return {
    now: () => currentTime,
    sleep: async (ms: number) => { sleeps.push(ms); currentTime += ms; },
    advance: (ms: number) => { currentTime += ms; },
    sleeps,
  };
}

describe('RateLimiter', () => {
  it('lets the first N calls through without sleeping', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(3, clock.now, clock.sleep);
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    expect(clock.sleeps).toEqual([]);
  });

  it('sleeps until the oldest call leaves the window on the N+1th call', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(3, clock.now, clock.sleep);
    await limiter.acquire();
    clock.advance(10_000);
    await limiter.acquire();
    await limiter.acquire();

    await limiter.acquire();
    // A chamada mais antiga foi em t=0; a janela é 60s; estamos em t=10000.
    expect(clock.sleeps).toEqual([50_000]);
  });

  it('does not sleep once the window has rolled past every call', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(2, clock.now, clock.sleep);
    await limiter.acquire();
    await limiter.acquire();
    clock.advance(61_000);
    await limiter.acquire();
    expect(clock.sleeps).toEqual([]);
  });

  it('keeps admitting calls at a steady rate under sustained pressure', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(2, clock.now, clock.sleep);
    for (let i = 0; i < 6; i += 1) await limiter.acquire();
    // 6 chamadas com teto de 2/min: 4 esperas.
    expect(clock.sleeps).toHaveLength(4);
    expect(clock.sleeps.every((ms) => ms > 0)).toBe(true);
  });

  it('rejects a non positive limit', () => {
    expect(() => new RateLimiter(0)).toThrow('maxPerMinute precisa ser positivo');
  });
});
```

- [ ] **Step 3: Implementar `rate-limiter.ts`**

`packages/uappi-client/src/rate-limiter.ts`:

```ts
const WINDOW_MS = 60_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Janela deslizante. Guarda o instante das últimas N chamadas; quando a janela
 * está cheia, dorme até a mais antiga sair dela.
 *
 * Existe porque a Uappi bloqueia por excesso de requisições e um backfill
 * ingênuo estoura 120 req/min em segundos. O relógio é injetável para que o
 * teste rode em microssegundos.
 */
export class RateLimiter {
  private readonly timestamps: number[] = [];

  constructor(
    private readonly maxPerMinute: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {
    if (maxPerMinute <= 0) throw new Error('maxPerMinute precisa ser positivo');
  }

  async acquire(): Promise<void> {
    this.evictExpired();

    if (this.timestamps.length >= this.maxPerMinute) {
      const oldest = this.timestamps[0]!;
      const waitMs = oldest + WINDOW_MS - this.now();
      if (waitMs > 0) await this.sleep(waitMs);
      this.evictExpired();
    }

    this.timestamps.push(this.now());
  }

  private evictExpired(): void {
    const cutoff = this.now() - WINDOW_MS;
    while (this.timestamps.length > 0 && this.timestamps[0]! <= cutoff) {
      this.timestamps.shift();
    }
  }
}
```

- [ ] **Step 4: Escrever o teste do provedor de token (falhando)**

`packages/uappi-client/src/__tests__/auth.test.ts`:

```ts
import { UappiTokenProvider } from '../auth.js';

const credentials = { apiKey: 'ak', secretKey: 'sk' };

function buildProvider(fetchImpl: jest.Mock, now: () => number = () => 0) {
  return new UappiTokenProvider({
    baseUrl: 'https://api.uappi.com.br',
    credentials,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now,
  });
}

function tokenResponse(token: string) {
  return new Response(JSON.stringify({ token }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

describe('UappiTokenProvider', () => {
  it('posts the credentials to /v2/auth with the App-Token header', async () => {
    const fetchImpl = jest.fn(async () => tokenResponse('jwt-1'));
    expect(await buildProvider(fetchImpl).getToken()).toBe('jwt-1');

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.uappi.com.br/v2/auth');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['App-Token']).toBe('wapstore');
    expect(JSON.parse(init.body as string)).toEqual({ apiKey: 'ak', secretKey: 'sk' });
  });

  it('reuses the cached token instead of authenticating again', async () => {
    const fetchImpl = jest.fn(async () => tokenResponse('jwt-1'));
    const provider = buildProvider(fetchImpl);
    await provider.getToken();
    await provider.getToken();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('renews the token before the 30 minute expiry', async () => {
    let currentTime = 0;
    const fetchImpl = jest.fn(async () => tokenResponse(`jwt-${fetchImpl.mock.calls.length}`));
    const provider = buildProvider(fetchImpl, () => currentTime);

    await provider.getToken();
    currentTime = 24 * 60_000; // 24 min — ainda dentro da margem
    await provider.getToken();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    currentTime = 26 * 60_000; // passou dos 25 min de margem
    await provider.getToken();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('authenticates only once when many callers race for the token', async () => {
    const fetchImpl = jest.fn(async () => {
      await new Promise((resolve) => { setTimeout(resolve, 5); });
      return tokenResponse('jwt-1');
    });
    const provider = buildProvider(fetchImpl);
    const tokens = await Promise.all([
      provider.getToken(), provider.getToken(), provider.getToken(),
    ]);
    expect(tokens).toEqual(['jwt-1', 'jwt-1', 'jwt-1']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('re-authenticates after invalidate', async () => {
    const fetchImpl = jest.fn(async () => tokenResponse(`jwt-${fetchImpl.mock.calls.length}`));
    const provider = buildProvider(fetchImpl);
    await provider.getToken();
    provider.invalidate();
    await provider.getToken();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws a readable error when the credentials are rejected', async () => {
    const fetchImpl = jest.fn(async () => new Response(
      JSON.stringify({ message: 'apiKey inválida' }), { status: 401 },
    ));
    await expect(buildProvider(fetchImpl).getToken())
      .rejects.toThrow('autenticação na Uappi falhou (401): apiKey inválida');
  });

  it('does not cache a failed authentication', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 500 }))
      .mockResolvedValueOnce(tokenResponse('jwt-1'));
    const provider = buildProvider(fetchImpl);
    await expect(provider.getToken()).rejects.toThrow();
    expect(await provider.getToken()).toBe('jwt-1');
  });
});
```

- [ ] **Step 5: Implementar `auth.ts`**

`packages/uappi-client/src/auth.ts`:

```ts
import { z } from 'zod';

const APP_TOKEN = 'wapstore';
const TOKEN_LIFETIME_MS = 30 * 60_000;
/** Renovamos aos 25 min: 5 min de folga cobrem clock skew e requisições em voo. */
const RENEW_MARGIN_MS = 5 * 60_000;

const AuthResponseSchema = z.object({ token: z.string().min(1) });

export interface UappiCredentials {
  apiKey: string;
  secretKey: string;
}

export interface TokenProviderDeps {
  baseUrl: string;
  credentials: UappiCredentials;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Cacheia o JWT da Uappi e o renova antes de expirar.
 *
 * A promessa em voo é compartilhada entre chamadores concorrentes: durante o
 * backfill dezenas de requisições descobrem o token vencido ao mesmo tempo, e
 * sem isso todas autenticariam em paralelo — estourando o limite de 30 req/min
 * do próprio endpoint de auth.
 */
export class UappiTokenProvider {
  private token: string | null = null;
  private issuedAt = 0;
  private inFlight: Promise<string> | null = null;

  private readonly baseUrl: string;
  private readonly credentials: UappiCredentials;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(deps: TokenProviderDeps) {
    this.baseUrl = deps.baseUrl.replace(/\/$/, '');
    this.credentials = deps.credentials;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  async getToken(): Promise<string> {
    if (this.token && this.now() - this.issuedAt < TOKEN_LIFETIME_MS - RENEW_MARGIN_MS) {
      return this.token;
    }
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.authenticate();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  invalidate(): void {
    this.token = null;
    this.issuedAt = 0;
  }

  private async authenticate(): Promise<string> {
    const response = await this.fetchImpl(`${this.baseUrl}/v2/auth`, {
      method: 'POST',
      headers: { 'App-Token': APP_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(this.credentials),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      throw new Error(
        `autenticação na Uappi falhou (${response.status})${body?.message ? `: ${body.message}` : ''}`,
      );
    }

    const { token } = AuthResponseSchema.parse(await response.json());
    this.token = token;
    this.issuedAt = this.now();
    return token;
  }
}
```

- [ ] **Step 6: Escrever o teste do cliente (falhando)**

`packages/uappi-client/src/__tests__/client.test.ts`:

```ts
import { RateLimiter } from '../rate-limiter.js';
import { UappiClient, UappiApiError } from '../client.js';
import { UappiTokenProvider } from '../auth.js';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
}

function page(pedidos: unknown[], total: number, offset: number, limit: number) {
  return { pedidos, info: { offset, limit, total, exibindo: pedidos.length } };
}

function buildClient(fetchImpl: jest.Mock) {
  const tokenProvider = {
    getToken: jest.fn(async () => 'jwt-1'),
    invalidate: jest.fn(),
  } as unknown as UappiTokenProvider;

  // Limitadores sem espera: o comportamento de espera já é testado em rate-limiter.test.
  const noWait = new RateLimiter(1000, () => 0, async () => {});

  return {
    client: new UappiClient({
      baseUrl: 'https://api.uappi.com.br',
      tokenProvider,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      listLimiter: noWait,
      detailLimiter: noWait,
    }),
    tokenProvider,
  };
}

describe('UappiClient.listOrders', () => {
  it('sends both required headers', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(page([], 0, 0, 100)));
    await buildClient(fetchImpl).client.listOrders({
      from: '2026-01-01', to: '2026-01-31', offset: 0, limit: 100,
    });
    const headers = (fetchImpl.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['App-Token']).toBe('wapstore');
    expect(headers.Authorization).toBe('Bearer jwt-1');
  });

  it('encodes the date range with the pipe separator Uappi expects', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(page([], 0, 0, 100)));
    await buildClient(fetchImpl).client.listOrders({
      from: '2026-01-01', to: '2026-01-31', offset: 0, limit: 100,
    });
    const url = new URL(fetchImpl.mock.calls[0]![0] as string);
    expect(url.pathname).toBe('/v2/orders');
    expect(url.searchParams.get('dataEmissao')).toBe('2026-01-01|2026-01-31');
    expect(url.searchParams.get('offset')).toBe('0');
    expect(url.searchParams.get('limit')).toBe('100');
  });

  it('caps the limit at the documented maximum of 100', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(page([], 0, 0, 100)));
    await buildClient(fetchImpl).client.listOrders({
      from: '2026-01-01', to: '2026-01-31', offset: 0, limit: 500,
    });
    expect(new URL(fetchImpl.mock.calls[0]![0] as string).searchParams.get('limit')).toBe('100');
  });

  it('forwards an optional status filter', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(page([], 0, 0, 100)));
    await buildClient(fetchImpl).client.listOrders({
      from: '2026-01-01', to: '2026-01-31', offset: 0, limit: 100, status: 'cancelado',
    });
    expect(new URL(fetchImpl.mock.calls[0]![0] as string).searchParams.get('status')).toBe('cancelado');
  });

  it('returns the parsed page', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(page([{ numeroPedido: '1' }], 1, 0, 100)));
    const result = await buildClient(fetchImpl).client.listOrders({
      from: '2026-01-01', to: '2026-01-31', offset: 0, limit: 100,
    });
    expect(result.info.total).toBe(1);
    expect(result.pedidos).toHaveLength(1);
  });

  it('invalidates the token and retries once on 401', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ message: 'token expirado' }, 401))
      .mockResolvedValueOnce(jsonResponse(page([], 0, 0, 100)));
    const { client, tokenProvider } = buildClient(fetchImpl);

    await client.listOrders({ from: '2026-01-01', to: '2026-01-31', offset: 0, limit: 100 });
    expect(tokenProvider.invalidate).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up after a second 401 instead of looping', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ message: 'sem permissão' }, 401));
    await expect(
      buildClient(fetchImpl).client.listOrders({
        from: '2026-01-01', to: '2026-01-31', offset: 0, limit: 100,
      }),
    ).rejects.toBeInstanceOf(UappiApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws UappiApiError carrying the status on 429', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ message: 'rate limit' }, 429));
    await expect(
      buildClient(fetchImpl).client.listOrders({
        from: '2026-01-01', to: '2026-01-31', offset: 0, limit: 100,
      }),
    ).rejects.toMatchObject({ name: 'UappiApiError', status: 429 });
  });
});

describe('UappiClient.getOrder', () => {
  it('requests the order detail path', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ numeroPedido: 'PED-1' }));
    await buildClient(fetchImpl).client.getOrder('PED-1');
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://api.uappi.com.br/v2/orders/PED-1');
  });

  it('url-encodes an order number with special characters', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({}));
    await buildClient(fetchImpl).client.getOrder('PED/2026 1');
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://api.uappi.com.br/v2/orders/PED%2F2026%201');
  });
});

describe('UappiClient.iterateOrders', () => {
  it('walks every page until the total is reached', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(jsonResponse(page([{ n: 1 }, { n: 2 }], 5, 0, 2)))
      .mockResolvedValueOnce(jsonResponse(page([{ n: 3 }, { n: 4 }], 5, 2, 2)))
      .mockResolvedValueOnce(jsonResponse(page([{ n: 5 }], 5, 4, 2)));

    const collected: unknown[] = [];
    for await (const batch of buildClient(fetchImpl).client.iterateOrders({
      from: '2026-01-01', to: '2026-01-31', pageSize: 2,
    })) {
      collected.push(...batch);
    }
    expect(collected).toHaveLength(5);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('stops on an empty page even if the total disagrees', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(jsonResponse(page([{ n: 1 }], 999, 0, 2)))
      .mockResolvedValueOnce(jsonResponse(page([], 999, 2, 2)));

    const collected: unknown[] = [];
    for await (const batch of buildClient(fetchImpl).client.iterateOrders({
      from: '2026-01-01', to: '2026-01-31', pageSize: 2,
    })) {
      collected.push(...batch);
    }
    expect(collected).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('yields nothing when the range has no orders', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(page([], 0, 0, 100)));
    const batches: unknown[][] = [];
    for await (const batch of buildClient(fetchImpl).client.iterateOrders({
      from: '2026-01-01', to: '2026-01-31', pageSize: 100,
    })) {
      batches.push(batch);
    }
    expect(batches).toEqual([]);
  });
});
```

- [ ] **Step 7: Implementar `client.ts`**

`packages/uappi-client/src/client.ts`:

```ts
import { z } from 'zod';
import { RateLimiter } from './rate-limiter.js';
import type { UappiTokenProvider } from './auth.js';

const APP_TOKEN = 'wapstore';
/** Documentado como máximo por página. */
export const MAX_PAGE_SIZE = 100;
/** Limites publicados na documentação da Uappi. */
export const LIST_ORDERS_PER_MINUTE = 120;
export const ORDER_DETAIL_PER_MINUTE = 60;

export class UappiApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'UappiApiError';
  }
}

const ListOrdersPageSchema = z.object({
  pedidos: z.array(z.unknown()).default([]),
  info: z.object({
    offset: z.coerce.number(),
    limit: z.coerce.number(),
    total: z.coerce.number(),
    exibindo: z.coerce.number(),
  }),
});
export type ListOrdersPage = z.infer<typeof ListOrdersPageSchema>;

export interface ListOrdersParams {
  from: string;
  to: string;
  offset: number;
  limit: number;
  status?: string;
}

export interface IterateOrdersParams {
  from: string;
  to: string;
  pageSize?: number;
  status?: string;
}

export interface UappiClientOptions {
  baseUrl: string;
  tokenProvider: UappiTokenProvider;
  fetchImpl?: typeof fetch;
  listLimiter?: RateLimiter;
  detailLimiter?: RateLimiter;
}

export class UappiClient {
  private readonly baseUrl: string;
  private readonly tokenProvider: UappiTokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly listLimiter: RateLimiter;
  private readonly detailLimiter: RateLimiter;

  constructor(options: UappiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.tokenProvider = options.tokenProvider;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.listLimiter = options.listLimiter ?? new RateLimiter(LIST_ORDERS_PER_MINUTE);
    this.detailLimiter = options.detailLimiter ?? new RateLimiter(ORDER_DETAIL_PER_MINUTE);
  }

  /**
   * Um 401 no meio de um backfill longo quase sempre significa token vencido —
   * invalidamos e tentamos uma única vez. Uma segunda falha é credencial ou
   * permissão, e repetir não resolveria.
   */
  private async request(url: string, limiter: RateLimiter): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await limiter.acquire();
      const token = await this.tokenProvider.getToken();

      const response = await this.fetchImpl(url, {
        headers: {
          'App-Token': APP_TOKEN,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(30_000),
      });

      if (response.ok) return response.json();

      if (response.status === 401 && attempt === 0) {
        this.tokenProvider.invalidate();
        continue;
      }

      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      throw new UappiApiError(
        response.status,
        `Uappi respondeu ${response.status} em ${new URL(url).pathname}${
          body?.message ? `: ${body.message}` : ''
        }`,
      );
    }
    throw new UappiApiError(401, 'autenticação na Uappi falhou após renovar o token');
  }

  async listOrders(params: ListOrdersParams): Promise<ListOrdersPage> {
    const url = new URL('/v2/orders', this.baseUrl);
    url.searchParams.set('offset', String(params.offset));
    url.searchParams.set('limit', String(Math.min(params.limit, MAX_PAGE_SIZE)));
    // A Uappi espera o range separado por pipe: 2026-01-01|2026-01-31.
    url.searchParams.set('dataEmissao', `${params.from}|${params.to}`);
    if (params.status) url.searchParams.set('status', params.status);

    return ListOrdersPageSchema.parse(await this.request(url.toString(), this.listLimiter));
  }

  getOrder(numeroPedido: string): Promise<unknown> {
    const url = `${this.baseUrl}/v2/orders/${encodeURIComponent(numeroPedido)}`;
    return this.request(url, this.detailLimiter);
  }

  /**
   * Percorre todas as páginas do range. Para numa página vazia mesmo que o
   * `total` diga o contrário — vimos APIs reportarem total inconsistente, e um
   * laço infinito num backfill é pior do que perder a última página.
   */
  async *iterateOrders(params: IterateOrdersParams): AsyncGenerator<unknown[]> {
    const pageSize = Math.min(params.pageSize ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);
    let offset = 0;

    for (;;) {
      const page = await this.listOrders({
        from: params.from,
        to: params.to,
        offset,
        limit: pageSize,
        ...(params.status ? { status: params.status } : {}),
      });

      if (page.pedidos.length === 0) return;
      yield page.pedidos;

      offset += page.pedidos.length;
      if (offset >= page.info.total) return;
    }
  }
}
```

`packages/uappi-client/src/index.ts`:

```ts
export * from './rate-limiter.js';
export * from './auth.js';
export * from './client.js';
```

- [ ] **Step 8: Rodar os testes**

Run: `pnpm --filter @center/uappi-client test`
Expected: PASS — 3 suites, 22 testes.

- [ ] **Step 9: Smoke test contra a API real**

```bash
pnpm --filter @center/uappi-client build
node --input-type=module -e "
import { UappiTokenProvider, UappiClient } from './packages/uappi-client/dist/index.js';
const tokenProvider = new UappiTokenProvider({
  baseUrl: process.env.UAPPI_BASE_URL,
  credentials: { apiKey: process.env.UAPPI_API_KEY, secretKey: process.env.UAPPI_SECRET_KEY },
});
const client = new UappiClient({ baseUrl: process.env.UAPPI_BASE_URL, tokenProvider });
const page = await client.listOrders({ from: '2026-07-01', to: '2026-07-31', offset: 0, limit: 5 });
console.log('total no período:', page.info.total);
console.log(JSON.stringify(page.pedidos[0], null, 2));
"
```

**Salve a saída deste comando em `docs/uappi-order-sample.json`.** A Task 6 escreve o schema a partir da forma real do pedido — a documentação pública lista os nomes dos campos, mas não os tipos nem quais são opcionais.

- [ ] **Step 10: Commit**

```bash
git add packages/uappi-client docs/uappi-order-sample.json
git commit -m "feat(uappi-client): add rate limited client with JWT caching and pagination"
```

---

### Task 5B: Cliente mock e fixtures da Uappi

**Files:**
- Create: `packages/uappi-client/src/interface.ts`
- Modify: `packages/uappi-client/src/client.ts` (implementa a interface extraída)
- Create: `packages/uappi-client/src/__fixtures__/orders.fixture.ts`
- Create: `packages/uappi-client/src/mock-client.ts`
- Test: `packages/uappi-client/src/__tests__/mock-client.test.ts`

**Interfaces:**
- Consumes: `MAX_PAGE_SIZE`, `ListOrdersPage`, `ListOrdersParams`, `IterateOrdersParams` (T5).
- Produces:
  - `interface UappiClientLike { listOrders(params): Promise<ListOrdersPage>; getOrder(numeroPedido): Promise<unknown>; iterateOrders(params): AsyncGenerator<unknown[]> }`
  - `FIXTURE_ORDERS: unknown[]` — 15 pedidos realistas cobrindo todo `OrderStatusGroup`, duas campanhas, três métodos de pagamento
  - `class MockUappiClient implements UappiClientLike`

**Por que isto existe:** as credenciais reais da Uappi só chegam no Sprint 2 na melhor hipótese (Premissa 1 do roadmap), e um spike de API (T15) ou uma demonstração não deveriam ficar bloqueados por isso. Com `MOCK_EXTERNAL_APIS=true`, o time inteiro — sync, MCP servers, dashboard, agente — roda de ponta a ponta contra dados determinísticos, sem tocar a rede. O mock nunca é usado fora de desenvolvimento: `loadConfig` (T4) só aceita a string exata `"true"`, e o Risco R11 (seção de riscos) documenta o travamento em produção.

- [ ] **Step 1: Extrair a interface do cliente real**

`packages/uappi-client/src/interface.ts`:

```ts
import type { IterateOrdersParams, ListOrdersPage, ListOrdersParams } from './client.js';

/**
 * O contrato que qualquer consumidor (sync, spikes) deve depender — nunca da
 * classe concreta `UappiClient`. É o que permite `MockUappiClient` substituir
 * o cliente real sem que `packages/uappi-sync` saiba a diferença.
 */
export interface UappiClientLike {
  listOrders(params: ListOrdersParams): Promise<ListOrdersPage>;
  getOrder(numeroPedido: string): Promise<unknown>;
  iterateOrders(params: IterateOrdersParams): AsyncGenerator<unknown[]>;
}
```

- [ ] **Step 2: Declarar que o cliente real implementa a interface**

Em `packages/uappi-client/src/client.ts` (T5), adicione o import e a cláusula `implements`:

```ts
import type { UappiClientLike } from './interface.js';
```

```ts
export class UappiClient implements UappiClientLike {
```

(era `export class UappiClient {` — só a assinatura da classe muda; nada no corpo).

- [ ] **Step 3: Escrever a fixture de pedidos**

15 pedidos cobrindo os oito `OrderStatusGroup`, duas campanhas (`black-friday`, `natal`) e três métodos de pagamento — o suficiente para que toda ferramenta do `mcp-commerce` (T12–T16) tenha o que agregar.

`packages/uappi-client/src/__fixtures__/orders.fixture.ts`:

```ts
/** Pedidos determinísticos para desenvolvimento e demonstração sem credenciais reais. */
export const FIXTURE_ORDERS: Record<string, unknown> = {
  'PED-0001': {
    idPedido: 9001, numeroPedido: 'PED-0001', canal: 'site', origem: 'organico',
    dataEmissao: '2026-07-01 10:15:00', moeda: 'BRL',
    status: { id: 3, descricao: 'Pagamento aprovado' },
    cliente: { idCliente: 501, email: 'ana.mock@example.com', nomeRazao: 'Ana (mock)' },
    valores: { subtotal: 189.9, frete: 15.0, descontos: 0, totalPedido: 204.9 },
    pagamento: [{ descricao: 'Pix', valor: 204.9 }],
    itens: [{ sku: 'CAM-001', descricao: 'Camiseta Preta', categoria: 'Vestuário', quantidade: 2, valorUnitario: 79.95, valorTotal: 159.9 },
             { sku: 'MEI-002', descricao: 'Meia', categoria: 'Vestuário', quantidade: 1, valorUnitario: 30.0, valorTotal: 30.0 }],
    informacoesAdicionais: { utmSource: 'google', utmMedium: 'cpc', utmCampaign: 'black-friday', device: 'mobile', centerVisitorId: 'mock-visitor-1.1699999001' },
  },
  'PED-0002': {
    idPedido: 9002, numeroPedido: 'PED-0002', canal: 'app', origem: 'direto',
    dataEmissao: '2026-07-02 14:40:00', moeda: 'BRL',
    status: { id: 4, descricao: 'Entregue' },
    cliente: { idCliente: 502, email: 'bruno.mock@example.com', nomeRazao: 'Bruno (mock)' },
    valores: { subtotal: 349.9, frete: 0, descontos: 20.0, totalPedido: 329.9 },
    pagamento: [{ descricao: 'Cartão de crédito', valor: 329.9 }],
    itens: [{ sku: 'TEN-003', descricao: 'Tênis Runner', categoria: 'Calçados', quantidade: 1, valorUnitario: 349.9, valorTotal: 349.9 }],
    informacoesAdicionais: { utmSource: 'facebook', utmMedium: 'cpc', utmCampaign: 'natal', device: 'desktop', centerVisitorId: 'mock-visitor-2.1699999002' },
  },
  'PED-0003': {
    idPedido: 9003, numeroPedido: 'PED-0003', canal: 'site', origem: 'organico',
    dataEmissao: '2026-07-03 09:05:00', moeda: 'BRL',
    status: { id: 5, descricao: 'Cancelado pelo cliente' },
    cliente: { idCliente: 503, email: 'carla.mock@example.com', nomeRazao: 'Carla (mock)' },
    valores: { subtotal: 99.9, frete: 12.0, descontos: 0, totalPedido: 111.9 },
    pagamento: [{ descricao: 'Boleto', valor: 111.9 }],
    itens: [{ sku: 'BON-004', descricao: 'Boné', categoria: 'Acessórios', quantidade: 1, valorUnitario: 99.9, valorTotal: 99.9 }],
    informacoesAdicionais: { utmSource: 'google', utmMedium: 'cpc', utmCampaign: 'black-friday', device: 'mobile' },
  },
  'PED-0004': {
    idPedido: 9004, numeroPedido: 'PED-0004', canal: 'site', origem: 'organico',
    dataEmissao: '2026-07-04 18:22:00', moeda: 'BRL',
    status: { id: 1, descricao: 'Aguardando pagamento' },
    cliente: { idCliente: 504, email: 'diego.mock@example.com', nomeRazao: 'Diego (mock)' },
    valores: { subtotal: 259.8, frete: 18.0, descontos: 0, totalPedido: 277.8 },
    pagamento: [{ descricao: 'Boleto', valor: 277.8 }],
    itens: [{ sku: 'CAM-001', descricao: 'Camiseta Preta', categoria: 'Vestuário', quantidade: 2, valorUnitario: 129.9, valorTotal: 259.8 }],
    informacoesAdicionais: {},
  },
  'PED-0005': {
    idPedido: 9005, numeroPedido: 'PED-0005', canal: 'marketplace', origem: 'pago',
    dataEmissao: '2026-07-05 11:11:00', moeda: 'BRL',
    status: { id: 6, descricao: 'Pagamento recusado' },
    cliente: { idCliente: 505, email: 'elis.mock@example.com', nomeRazao: 'Elis (mock)' },
    valores: { subtotal: 449.9, frete: 0, descontos: 0, totalPedido: 449.9 },
    pagamento: [{ descricao: 'Cartão de crédito', valor: 449.9 }],
    itens: [{ sku: 'TEN-003', descricao: 'Tênis Runner', categoria: 'Calçados', quantidade: 1, valorUnitario: 449.9, valorTotal: 449.9 }],
    informacoesAdicionais: { utmSource: 'facebook', utmMedium: 'cpc', utmCampaign: 'natal', device: 'mobile' },
  },
  'PED-0006': {
    idPedido: 9006, numeroPedido: 'PED-0006', canal: 'site', origem: 'organico',
    dataEmissao: '2026-07-08 16:00:00', moeda: 'BRL',
    status: { id: 2, descricao: 'Em separação' },
    cliente: { idCliente: 501, email: 'ana.mock@example.com', nomeRazao: 'Ana (mock)' },
    valores: { subtotal: 89.9, frete: 10.0, descontos: 0, totalPedido: 99.9 },
    pagamento: [{ descricao: 'Pix', valor: 99.9 }],
    itens: [{ sku: 'MEI-002', descricao: 'Meia', categoria: 'Vestuário', quantidade: 3, valorUnitario: 29.97, valorTotal: 89.9 }],
    informacoesAdicionais: { utmSource: 'google', utmMedium: 'cpc', utmCampaign: 'black-friday', device: 'mobile', centerVisitorId: 'mock-visitor-1.1699999001' },
  },
  'PED-0007': {
    idPedido: 9007, numeroPedido: 'PED-0007', canal: 'app', origem: 'direto',
    dataEmissao: '2026-07-10 08:30:00', moeda: 'BRL',
    status: { id: 7, descricao: 'Enviado' },
    cliente: { idCliente: 506, email: 'fabio.mock@example.com', nomeRazao: 'Fábio (mock)' },
    valores: { subtotal: 129.9, frete: 15.0, descontos: 0, totalPedido: 144.9 },
    pagamento: [{ descricao: 'Cartão de crédito', valor: 144.9 }],
    itens: [{ sku: 'BON-004', descricao: 'Boné', categoria: 'Acessórios', quantidade: 1, valorUnitario: 129.9, valorTotal: 129.9 }],
    informacoesAdicionais: { utmSource: 'direto', device: 'desktop' },
  },
  'PED-0008': {
    idPedido: 9008, numeroPedido: 'PED-0008', canal: 'site', origem: 'organico',
    dataEmissao: '2026-07-12 20:45:00', moeda: 'BRL',
    status: { id: 3, descricao: 'Pagamento aprovado' },
    cliente: { idCliente: 507, email: 'giovana.mock@example.com', nomeRazao: 'Giovana (mock)' },
    valores: { subtotal: 599.9, frete: 0, descontos: 50.0, totalPedido: 549.9 },
    pagamento: [{ descricao: 'Pix', valor: 549.9 }],
    itens: [{ sku: 'TEN-003', descricao: 'Tênis Runner', categoria: 'Calçados', quantidade: 1, valorUnitario: 349.9, valorTotal: 349.9 },
             { sku: 'CAM-001', descricao: 'Camiseta Preta', categoria: 'Vestuário', quantidade: 2, valorUnitario: 125.0, valorTotal: 250.0 }],
    informacoesAdicionais: { utmSource: 'google', utmMedium: 'cpc', utmCampaign: 'black-friday', device: 'tablet' },
  },
};

export const FIXTURE_ORDER_NUMBERS = Object.keys(FIXTURE_ORDERS);
```

> A fixture tem 8 pedidos completos aqui para manter o exemplo legível; complete até 15 seguindo o mesmo padrão (mais status `Estornado` e `Aguardando retirada` para exercitar `OTHER` na T6) antes de rodar o smoke test do Step 6.

- [ ] **Step 4: Escrever o teste do mock (falhando)**

`packages/uappi-client/src/__tests__/mock-client.test.ts`:

```ts
import { MAX_PAGE_SIZE } from '../client.js';
import { FIXTURE_ORDER_NUMBERS } from '../__fixtures__/orders.fixture.js';
import { MockUappiClient } from '../mock-client.js';

describe('MockUappiClient.listOrders', () => {
  it('returns a page shaped exactly like the real API', async () => {
    const client = new MockUappiClient();
    const page = await client.listOrders({ from: '2026-01-01', to: '2026-12-31', offset: 0, limit: 5 });
    expect(page.pedidos).toHaveLength(5);
    expect(page.info).toMatchObject({ offset: 0, limit: 5, total: FIXTURE_ORDER_NUMBERS.length });
  });

  it('filters by the dataEmissao range', async () => {
    const client = new MockUappiClient();
    const page = await client.listOrders({ from: '2026-07-01', to: '2026-07-01', offset: 0, limit: 100 });
    expect(page.pedidos).toHaveLength(1);
  });

  it('caps the limit at MAX_PAGE_SIZE, same as the real client', async () => {
    const client = new MockUappiClient();
    const page = await client.listOrders({ from: '2026-01-01', to: '2026-12-31', offset: 0, limit: 500 });
    expect(page.info.limit).toBe(MAX_PAGE_SIZE);
  });

  it('returns an empty page past the end of the fixture', async () => {
    const client = new MockUappiClient();
    const page = await client.listOrders({
      from: '2026-01-01', to: '2026-12-31', offset: FIXTURE_ORDER_NUMBERS.length, limit: 10,
    });
    expect(page.pedidos).toEqual([]);
  });
});

describe('MockUappiClient.getOrder', () => {
  it('returns the full fixture order by its natural key', async () => {
    const order = await new MockUappiClient().getOrder('PED-0001') as { numeroPedido: string };
    expect(order.numeroPedido).toBe('PED-0001');
  });

  it('throws UappiApiError-like 404 for an unknown order number', async () => {
    await expect(new MockUappiClient().getOrder('PED-INEXISTENTE')).rejects.toThrow('404');
  });
});

describe('MockUappiClient.iterateOrders', () => {
  it('walks every fixture order across pages', async () => {
    const client = new MockUappiClient();
    const collected: unknown[] = [];
    for await (const batch of client.iterateOrders({ from: '2026-01-01', to: '2026-12-31', pageSize: 3 })) {
      collected.push(...batch);
    }
    expect(collected).toHaveLength(FIXTURE_ORDER_NUMBERS.length);
  });
});
```

- [ ] **Step 5: Implementar `mock-client.ts`**

`packages/uappi-client/src/mock-client.ts`:

```ts
import { MAX_PAGE_SIZE, UappiApiError, type ListOrdersPage, type ListOrdersParams } from './client.js';
import type { UappiClientLike } from './interface.js';
import { FIXTURE_ORDERS, FIXTURE_ORDER_NUMBERS } from './__fixtures__/orders.fixture.js';

interface FixtureOrder { numeroPedido: string; dataEmissao: string }

/**
 * Mesma forma pública do `UappiClient`, respondendo com dados fixos.
 * Nunca faz rede — existe para desenvolver e demonstrar o sistema inteiro sem
 * credenciais reais. Ligado por `MOCK_EXTERNAL_APIS=true` (T4), nunca em produção.
 */
export class MockUappiClient implements UappiClientLike {
  private readonly orders: FixtureOrder[] = FIXTURE_ORDER_NUMBERS
    .map((key) => FIXTURE_ORDERS[key] as FixtureOrder)
    .sort((a, b) => a.dataEmissao.localeCompare(b.dataEmissao));

  async listOrders(params: ListOrdersParams): Promise<ListOrdersPage> {
    const limit = Math.min(params.limit, MAX_PAGE_SIZE);
    const inRange = this.orders.filter((order) => {
      const date = order.dataEmissao.slice(0, 10);
      return date >= params.from && date <= params.to;
    });
    const page = inRange.slice(params.offset, params.offset + limit);

    return {
      pedidos: page,
      info: { offset: params.offset, limit, total: inRange.length, exibindo: page.length },
    };
  }

  async getOrder(numeroPedido: string): Promise<unknown> {
    const order = FIXTURE_ORDERS[numeroPedido];
    if (!order) {
      throw new UappiApiError(404, `Uappi respondeu 404 em /v2/orders/${numeroPedido} (mock)`);
    }
    return order;
  }

  async *iterateOrders(params: { from: string; to: string; pageSize?: number }): AsyncGenerator<unknown[]> {
    const pageSize = Math.min(params.pageSize ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);
    let offset = 0;
    for (;;) {
      const page = await this.listOrders({ from: params.from, to: params.to, offset, limit: pageSize });
      if (page.pedidos.length === 0) return;
      yield page.pedidos;
      offset += page.pedidos.length;
      if (offset >= page.info.total) return;
    }
  }
}
```

Adicione ao final de `packages/uappi-client/src/index.ts` (que já tem os três `export *` da T5):

```ts
export * from './interface.js';
export * from './mock-client.js';
```

- [ ] **Step 6: Rodar os testes e o smoke test end-to-end**

Run: `pnpm --filter @center/uappi-client test`
Expected: PASS — 7 testes novos.

```bash
pnpm build
MOCK_EXTERNAL_APIS=true node --input-type=module -e "
import { MockUappiClient } from './packages/uappi-client/dist/index.js';
const client = new MockUappiClient();
const page = await client.listOrders({ from: '2026-01-01', to: '2026-12-31', offset: 0, limit: 100 });
console.log('total mock:', page.info.total);
"
```

Expected: `total mock: 15` (ou o número de pedidos que você completou no Step 3).

- [ ] **Step 7: Commit**

```bash
git add packages/uappi-client
git commit -m "feat(uappi-client): add mock client and order fixtures for credential-free dev"
```

---

### Task 6: Schemas do pedido e mapa de status

**Files:**
- Create: `packages/uappi-sync/{package.json,tsconfig.json,jest.config.cjs}`
- Create: `packages/uappi-sync/src/{schemas.ts,status-map.ts,index.ts}`
- Test: `packages/uappi-sync/src/__tests__/{schemas.test.ts,status-map.test.ts}`

**Interfaces:**
- Consumes: `docs/uappi-order-sample.json` (T5).
- Produces:
  - `UappiOrderSchema` / `UappiOrder` — schema tolerante do pedido detalhado
  - `UappiOrderSummarySchema` / `UappiOrderSummary` — schema do item da listagem
  - `type OrderStatusGroup = 'PAID' | 'PENDING_PAYMENT' | 'PROCESSING' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED' | 'FAILED' | 'OTHER'`
  - `DEFAULT_STATUS_PATTERNS: Array<{ group: OrderStatusGroup; pattern: RegExp }>`
  - `resolveStatusGroup(statusId: number, statusLabel: string, overrides?: Record<string, string>): OrderStatusGroup`

**Por que o schema é tolerante:** a Uappi é multi-loja e campos opcionais variam por configuração. Um schema estrito quebraria o sync inteiro por causa de um campo ausente num pedido. A regra: **campos que usamos são validados; o resto passa**. O payload cru vai para `rawPayload`, então nada se perde.

- [ ] **Step 1: Criar o pacote**

`packages/uappi-sync/package.json`:

```json
{
  "name": "@center/uappi-sync",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "jest"
  },
  "dependencies": {
    "@center/shared": "workspace:*",
    "@center/pii": "workspace:*",
    "@center/uappi-client": "workspace:*",
    "zod": "^3.24.1"
  }
}
```

`tsconfig.json` e `jest.config.cjs` seguem o molde da Task 5, Step 1.

- [ ] **Step 2: Escrever o teste do mapa de status (falhando)**

`packages/uappi-sync/src/__tests__/status-map.test.ts`:

```ts
import { resolveStatusGroup } from '../status-map.js';

describe('resolveStatusGroup — padrões por texto', () => {
  it.each([
    ['Pago', 'PAID'],
    ['Pagamento aprovado', 'PAID'],
    ['Pagamento confirmado', 'PAID'],
    ['Aguardando pagamento', 'PENDING_PAYMENT'],
    ['Aguardando Pgto', 'PENDING_PAYMENT'],
    ['Pendente de pagamento', 'PENDING_PAYMENT'],
    ['Em separação', 'PROCESSING'],
    ['Em processamento', 'PROCESSING'],
    ['Enviado', 'SHIPPED'],
    ['Em transporte', 'SHIPPED'],
    ['Entregue', 'DELIVERED'],
    ['Cancelado', 'CANCELLED'],
    ['Cancelado pelo cliente', 'CANCELLED'],
    ['Pagamento recusado', 'FAILED'],
    ['Pagamento não autorizado', 'FAILED'],
    ['Estornado', 'FAILED'],
  ])('maps "%s" to %s', (label, expected) => {
    expect(resolveStatusGroup(1, label)).toBe(expected);
  });

  it('is accent and case insensitive', () => {
    expect(resolveStatusGroup(1, 'EM SEPARACAO')).toBe('PROCESSING');
    expect(resolveStatusGroup(1, 'aguardando pagamento')).toBe('PENDING_PAYMENT');
  });

  it('falls back to OTHER for an unrecognised label', () => {
    expect(resolveStatusGroup(1, 'Aguardando retirada na loja física')).toBe('OTHER');
  });

  it('prefers CANCELLED over PAID when both words appear', () => {
    // "Cancelado após pagamento" é um cancelamento, não uma venda.
    expect(resolveStatusGroup(1, 'Cancelado após pagamento aprovado')).toBe('CANCELLED');
  });

  it('prefers FAILED over PENDING when the payment was refused', () => {
    expect(resolveStatusGroup(1, 'Pagamento recusado, aguardando nova tentativa')).toBe('FAILED');
  });
});

describe('resolveStatusGroup — override por loja', () => {
  it('lets an override win over the text pattern', () => {
    expect(resolveStatusGroup(42, 'Pago', { '42': 'CANCELLED' })).toBe('CANCELLED');
  });

  it('ignores an override pointing to an unknown group', () => {
    expect(resolveStatusGroup(42, 'Pago', { '42': 'INVENTADO' })).toBe('PAID');
  });

  it('ignores an override for a different status id', () => {
    expect(resolveStatusGroup(7, 'Pago', { '42': 'CANCELLED' })).toBe('PAID');
  });
});
```

- [ ] **Step 3: Implementar `status-map.ts`**

`packages/uappi-sync/src/status-map.ts`:

```ts
export type OrderStatusGroup =
  | 'PAID' | 'PENDING_PAYMENT' | 'PROCESSING' | 'SHIPPED'
  | 'DELIVERED' | 'CANCELLED' | 'FAILED' | 'OTHER';

const VALID_GROUPS = new Set<string>([
  'PAID', 'PENDING_PAYMENT', 'PROCESSING', 'SHIPPED',
  'DELIVERED', 'CANCELLED', 'FAILED', 'OTHER',
]);

/**
 * A ORDEM IMPORTA — o primeiro padrão que casa vence.
 *
 * Cancelamento e falha vêm antes de "pago" de propósito: um status como
 * "Cancelado após pagamento aprovado" contém as duas palavras, e contá-lo como
 * venda inflaria o faturamento. Erro de faturamento para cima é o pior tipo.
 */
export const DEFAULT_STATUS_PATTERNS: Array<{ group: OrderStatusGroup; pattern: RegExp }> = [
  { group: 'CANCELLED', pattern: /cancel/ },
  { group: 'FAILED', pattern: /recusad|nao autorizad|negad|estornad|falh|chargeback/ },
  { group: 'DELIVERED', pattern: /entregue/ },
  { group: 'SHIPPED', pattern: /enviad|transporte|despachad|em rota|saiu para entrega/ },
  { group: 'PENDING_PAYMENT', pattern: /aguardando (pagamento|pgto)|pendente de pagamento|aguardando pgto/ },
  { group: 'PAID', pattern: /\bpago\b|pagamento (aprovad|confirmad)|aprovad|faturad/ },
  { group: 'PROCESSING', pattern: /separacao|processamento|em producao|preparando|conferencia/ },
];

function normalize(label: string): string {
  return label
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

/**
 * Traduz o status configurável da loja num grupo perguntável.
 *
 * `overrides` vem de `Organization.statusMapping` e mapeia `idStatus` → grupo.
 * Existe porque nenhum conjunto de padrões cobre todas as lojas, e a alternativa
 * — pedir ao cliente para renomear os status dele — não é uma alternativa.
 */
export function resolveStatusGroup(
  statusId: number,
  statusLabel: string,
  overrides?: Record<string, string> | null,
): OrderStatusGroup {
  const override = overrides?.[String(statusId)];
  if (override && VALID_GROUPS.has(override)) {
    return override as OrderStatusGroup;
  }

  const normalized = normalize(statusLabel);
  for (const { group, pattern } of DEFAULT_STATUS_PATTERNS) {
    if (pattern.test(normalized)) return group;
  }
  return 'OTHER';
}
```

- [ ] **Step 4: Escrever o teste dos schemas (falhando)**

`packages/uappi-sync/src/__tests__/schemas.test.ts`:

```ts
import { UappiOrderSchema, UappiOrderSummarySchema } from '../schemas.js';

const fullOrder = {
  idPedido: 9001,
  numeroPedido: 'PED-2026-0001',
  canal: 'site',
  origem: 'organico',
  tipoVenda: 'varejo',
  dataEmissao: '2026-07-15 14:30:00',
  moeda: 'BRL',
  status: { id: 3, descricao: 'Pagamento aprovado' },
  cliente: {
    idCliente: 555,
    email: 'ana@example.com',
    documento: '123.456.789-09',
    nomeRazao: 'Ana Silva',
  },
  valores: { subtotal: 200.0, frete: 20.5, descontos: 10.0, totalPedido: 210.5 },
  pagamento: [{ idPagamento: 1, descricao: 'Cartão de crédito', valor: 210.5 }],
  itens: [
    { sku: 'CAM-001', descricao: 'Camiseta Preta', categoria: 'Vestuário', quantidade: 2, valorUnitario: 80.0, valorTotal: 160.0 },
    { sku: 'MEI-002', descricao: 'Meia', quantidade: 1, valorUnitario: 40.0, valorTotal: 40.0 },
  ],
  informacoesAdicionais: { centerVisitorId: '1234567890.1699999999', utmCampaign: 'black-friday' },
};

describe('UappiOrderSchema', () => {
  it('parses a complete order', () => {
    const parsed = UappiOrderSchema.parse(fullOrder);
    expect(parsed.numeroPedido).toBe('PED-2026-0001');
    expect(parsed.itens).toHaveLength(2);
  });

  it('coerces a numeric order number to string', () => {
    expect(UappiOrderSchema.parse({ ...fullOrder, numeroPedido: 20260001 }).numeroPedido)
      .toBe('20260001');
  });

  it('accepts monetary values that arrive as strings', () => {
    const parsed = UappiOrderSchema.parse({
      ...fullOrder,
      valores: { subtotal: '200.00', frete: '20.50', descontos: '10.00', totalPedido: '210.50' },
    });
    expect(parsed.valores.totalPedido).toBe('210.50');
  });

  it('survives an order with no items', () => {
    expect(UappiOrderSchema.parse({ ...fullOrder, itens: [] }).itens).toEqual([]);
  });

  it('survives a missing itens key entirely', () => {
    const { itens: _omitted, ...withoutItems } = fullOrder;
    expect(UappiOrderSchema.parse(withoutItems).itens).toEqual([]);
  });

  it('survives a missing payment array', () => {
    const { pagamento: _omitted, ...withoutPayment } = fullOrder;
    expect(UappiOrderSchema.parse(withoutPayment).pagamento).toEqual([]);
  });

  it('survives an order with no customer document or email', () => {
    const parsed = UappiOrderSchema.parse({
      ...fullOrder, cliente: { idCliente: 555, nomeRazao: 'Consumidor' },
    });
    expect(parsed.cliente?.email).toBeUndefined();
  });

  it('keeps unknown fields instead of stripping them', () => {
    const parsed = UappiOrderSchema.parse({ ...fullOrder, campoNovoDaUappi: 'x' }) as Record<string, unknown>;
    expect(parsed.campoNovoDaUappi).toBe('x');
  });

  it('accepts a status given as a plain string', () => {
    const parsed = UappiOrderSchema.parse({ ...fullOrder, status: 'Pagamento aprovado' });
    expect(parsed.status.descricao).toBe('Pagamento aprovado');
    expect(parsed.status.id).toBe(0);
  });

  it('rejects an order with no numeroPedido — it is the natural key', () => {
    const { numeroPedido: _omitted, ...withoutKey } = fullOrder;
    expect(UappiOrderSchema.safeParse(withoutKey).success).toBe(false);
  });

  it('rejects an order with no dataEmissao — every metric buckets by it', () => {
    const { dataEmissao: _omitted, ...withoutDate } = fullOrder;
    expect(UappiOrderSchema.safeParse(withoutDate).success).toBe(false);
  });
});

describe('UappiOrderSummarySchema', () => {
  it('parses the minimal shape the list endpoint returns', () => {
    const parsed = UappiOrderSummarySchema.parse({
      numeroPedido: 'PED-1', dataEmissao: '2026-07-15 10:00:00',
    });
    expect(parsed.numeroPedido).toBe('PED-1');
  });

  it('rejects a summary without an order number', () => {
    expect(UappiOrderSummarySchema.safeParse({ dataEmissao: '2026-07-15' }).success).toBe(false);
  });
});
```

- [ ] **Step 5: Implementar `schemas.ts`**

`packages/uappi-sync/src/schemas.ts`:

```ts
import { z } from 'zod';

/** Aceita número ou string: a Uappi varia o tipo entre lojas e endpoints. */
const MoneySchema = z.union([z.number(), z.string()]);

/** Alguns campos numéricos chegam como string; coerção evita quebrar o sync. */
const NumericSchema = z.coerce.number();

/**
 * Status às vezes vem como objeto `{ id, descricao }`, às vezes como string
 * simples. Normalizamos para objeto — `id: 0` sinaliza "veio sem id".
 */
const StatusSchema = z.union([
  z.object({
    id: NumericSchema.default(0),
    descricao: z.string().default(''),
  }).passthrough(),
  z.string().transform((descricao) => ({ id: 0, descricao })),
]);

const CustomerSchema = z.object({
  idCliente: z.union([z.number(), z.string()]).optional(),
  email: z.string().optional(),
  documento: z.string().optional(),
  nomeRazao: z.string().optional(),
}).passthrough();

const ItemSchema = z.object({
  sku: z.union([z.string(), z.number()]).transform(String).optional(),
  descricao: z.string().default(''),
  categoria: z.string().optional(),
  quantidade: NumericSchema.default(1),
  valorUnitario: MoneySchema.default(0),
  valorTotal: MoneySchema.default(0),
}).passthrough();

const PaymentSchema = z.object({
  idPagamento: z.union([z.number(), z.string()]).optional(),
  descricao: z.string().default(''),
  valor: MoneySchema.default(0),
}).passthrough();

const ValuesSchema = z.object({
  subtotal: MoneySchema.default(0),
  frete: MoneySchema.default(0),
  descontos: MoneySchema.default(0),
  totalPedido: MoneySchema.default(0),
}).passthrough();

/**
 * Schema deliberadamente tolerante. A Uappi é multi-loja: campos opcionais
 * variam por configuração, e um schema estrito derrubaria o sync inteiro por
 * causa de um pedido atípico. Só `numeroPedido` e `dataEmissao` são obrigatórios
 * — sem eles não há chave natural nem bucket temporal, e o registro é inútil.
 * O payload completo é preservado em `rawPayload`, então nada se perde.
 */
export const UappiOrderSchema = z.object({
  idPedido: z.union([z.number(), z.string()]).transform(String).optional(),
  numeroPedido: z.union([z.string(), z.number()]).transform(String),
  canal: z.string().optional(),
  origem: z.string().optional(),
  tipoVenda: z.string().optional(),
  dataEmissao: z.string().min(1),
  moeda: z.string().default('BRL'),
  status: StatusSchema.default({ id: 0, descricao: '' }),
  cliente: CustomerSchema.optional(),
  valores: ValuesSchema.default({}),
  pagamento: z.array(PaymentSchema).default([]),
  itens: z.array(ItemSchema).default([]),
  informacoesAdicionais: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export type UappiOrder = z.infer<typeof UappiOrderSchema>;

/** O que a listagem devolve — usada só para descobrir quais detalhes buscar. */
export const UappiOrderSummarySchema = z.object({
  numeroPedido: z.union([z.string(), z.number()]).transform(String),
  dataEmissao: z.string().optional(),
}).passthrough();

export type UappiOrderSummary = z.infer<typeof UappiOrderSummarySchema>;
```

- [ ] **Step 6: Rodar os testes**

Run: `pnpm --filter @center/uappi-sync test`
Expected: PASS — 2 suites, 29 testes.

- [ ] **Step 7: Validar os schemas contra o pedido real**

```bash
node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { UappiOrderSchema } from './packages/uappi-sync/dist/schemas.js';
const sample = JSON.parse(readFileSync('docs/uappi-order-sample.json', 'utf8'));
const result = UappiOrderSchema.safeParse(sample);
console.log(result.success ? 'schema OK' : JSON.stringify(result.error.issues, null, 2));
"
```

Expected: `schema OK`. Se falhar, ajuste `schemas.ts` **e adicione um teste** cobrindo a forma real encontrada — o objetivo do sample é exatamente descobrir estes casos.

Confira também os `status.descricao` distintos que a loja usa:

```bash
node --input-type=module -e "
import { UappiTokenProvider, UappiClient } from './packages/uappi-client/dist/index.js';
import { resolveStatusGroup } from './packages/uappi-sync/dist/status-map.js';
const tokenProvider = new UappiTokenProvider({ baseUrl: process.env.UAPPI_BASE_URL,
  credentials: { apiKey: process.env.UAPPI_API_KEY, secretKey: process.env.UAPPI_SECRET_KEY } });
const client = new UappiClient({ baseUrl: process.env.UAPPI_BASE_URL, tokenProvider });
const seen = new Map();
for await (const batch of client.iterateOrders({ from: '2026-05-01', to: '2026-07-31' })) {
  for (const o of batch) {
    const label = o?.status?.descricao ?? String(o?.status ?? '');
    const id = o?.status?.id ?? 0;
    seen.set(\`\${id}|\${label}\`, resolveStatusGroup(id, label));
  }
}
for (const [k, v] of seen) console.log(k, '→', v);
"
```

Toda linha que sair como `OTHER` precisa de um override em `Organization.statusMapping` **ou** de um padrão novo em `DEFAULT_STATUS_PATTERNS` com teste. `OTHER` não entra em nenhuma resposta de faturamento — deixar um status de venda cair ali subnotifica receita.

- [ ] **Step 8: Commit**

```bash
git add packages/uappi-sync
git commit -m "feat(uappi-sync): add tolerant order schemas and status group mapping"
```

---

### Task 7: Mapeamento do pedido para o read model

**Files:**
- Create: `packages/uappi-sync/src/mapper.ts`
- Modify: `packages/uappi-sync/src/index.ts`
- Test: `packages/uappi-sync/src/__tests__/mapper.test.ts`

**Interfaces:**
- Consumes: `UappiOrder` (T6), `resolveStatusGroup` (T6), `Pseudonymizer` (T3), `toCents` (T2).
- Produces:
  - `interface MappedOrder { numeroPedido, idPedido, statusLabel, statusId, statusGroup, canal, origem, tipoVenda, emittedAt, subtotalCents, freightCents, discountCents, totalCents, currency, paymentMethod, customer, attribution, rawPayload }`
  - `interface MappedCustomer { externalId: string; emailHash: string | null; documentHash: string | null }`
  - `interface MappedAttribution { source: string | null; medium: string | null; campaign: string | null; device: string | null; visitorHash: string | null }`
  - `interface MappedOrderItem { sku, productName, categoryName, quantity, unitPriceCents, totalPriceCents }`
  - `mapOrder(order: UappiOrder, deps: MapOrderDeps): { order: MappedOrder; items: MappedOrderItem[] }`
  - `interface MapOrderDeps { pseudonymizer: Pseudonymizer; statusOverrides?: Record<string, string> | null; timeZone?: string }`
  - `parseUappiDate(raw: string, timeZone?: string): Date`

**Este é o ponto mais delicado do sistema.** Aqui dinheiro vira centavos e PII vira hash. Um erro aqui corrompe o banco de forma silenciosa e só aparece quando alguém questiona um número. Daí a densidade de testes.

- [ ] **Step 1: Escrever o teste (falhando)**

`packages/uappi-sync/src/__tests__/mapper.test.ts`:

```ts
import { Pseudonymizer } from '@center/pii';
import { UappiOrderSchema } from '../schemas.js';
import { mapOrder, parseUappiDate } from '../mapper.js';

const pseudonymizer = new Pseudonymizer('p'.repeat(32));

const rawOrder = {
  idPedido: 9001,
  numeroPedido: 'PED-2026-0001',
  canal: 'site',
  origem: 'organico',
  tipoVenda: 'varejo',
  dataEmissao: '2026-07-15 14:30:00',
  moeda: 'BRL',
  status: { id: 3, descricao: 'Pagamento aprovado' },
  cliente: { idCliente: 555, email: 'Ana@Example.com', documento: '123.456.789-09' },
  valores: { subtotal: 200.0, frete: 20.5, descontos: 10.0, totalPedido: 210.5 },
  pagamento: [{ idPagamento: 1, descricao: 'Cartão de crédito', valor: 210.5 }],
  itens: [
    { sku: 'CAM-001', descricao: 'Camiseta Preta', categoria: 'Vestuário', quantidade: 2, valorUnitario: 80.0, valorTotal: 160.0 },
    { sku: 'MEI-002', descricao: 'Meia', quantidade: 1, valorUnitario: 40.0, valorTotal: 40.0 },
  ],
  informacoesAdicionais: {
    centerVisitorId: '1234567890.1699999999',
    utmSource: 'google', utmMedium: 'cpc', utmCampaign: 'black-friday', device: 'mobile',
  },
};

function map(overrides: Record<string, unknown> = {}, statusOverrides?: Record<string, string>) {
  const parsed = UappiOrderSchema.parse({ ...rawOrder, ...overrides });
  return mapOrder(parsed, {
    pseudonymizer,
    ...(statusOverrides ? { statusOverrides } : {}),
  });
}

describe('parseUappiDate', () => {
  it('parses "YYYY-MM-DD HH:mm:ss" as São Paulo local time', () => {
    // 14:30 em São Paulo (UTC-3) = 17:30 UTC.
    expect(parseUappiDate('2026-07-15 14:30:00').toISOString()).toBe('2026-07-15T17:30:00.000Z');
  });

  it('parses a date without a time as midnight São Paulo', () => {
    expect(parseUappiDate('2026-07-15').toISOString()).toBe('2026-07-15T03:00:00.000Z');
  });

  it('respects an ISO string that already carries an offset', () => {
    expect(parseUappiDate('2026-07-15T14:30:00Z').toISOString()).toBe('2026-07-15T14:30:00.000Z');
  });

  it('throws on an unparseable value rather than producing Invalid Date', () => {
    expect(() => parseUappiDate('15/07/2026')).toThrow('dataEmissao inválida');
  });
});

describe('mapOrder — identificação e status', () => {
  it('keeps the natural key and ids as strings', () => {
    const { order } = map();
    expect(order.numeroPedido).toBe('PED-2026-0001');
    expect(order.idPedido).toBe('9001');
  });

  it('resolves the status group from the label', () => {
    const { order } = map();
    expect(order.statusGroup).toBe('PAID');
    expect(order.statusLabel).toBe('Pagamento aprovado');
    expect(order.statusId).toBe(3);
  });

  it('honours a per-store status override', () => {
    expect(map({}, { '3': 'PROCESSING' }).order.statusGroup).toBe('PROCESSING');
  });
});

describe('mapOrder — dinheiro', () => {
  it('converts every monetary field to integer cents', () => {
    const { order } = map();
    expect(order.subtotalCents).toBe(20000);
    expect(order.freightCents).toBe(2050);
    expect(order.discountCents).toBe(1000);
    expect(order.totalCents).toBe(21050);
  });

  it('handles values that arrive as decimal strings', () => {
    const { order } = map({
      valores: { subtotal: '200.00', frete: '20.50', descontos: '10.00', totalPedido: '210.50' },
    });
    expect(order.totalCents).toBe(21050);
  });

  it('handles values in Brazilian format with comma decimals', () => {
    const { order } = map({
      valores: { subtotal: '1.200,00', frete: '0,00', descontos: '0,00', totalPedido: '1.200,00' },
    });
    expect(order.totalCents).toBe(120000);
  });

  it('never produces a floating point cent', () => {
    const { order } = map({
      valores: { subtotal: 0.1, frete: 0.2, descontos: 0, totalPedido: 0.3 },
    });
    expect(Number.isInteger(order.totalCents)).toBe(true);
    expect(order.subtotalCents + order.freightCents).toBe(30);
  });
});

describe('mapOrder — dados pessoais', () => {
  it('stores only hashes, never the email or document', () => {
    const { order } = map();
    const serialized = JSON.stringify({
      externalId: order.customer?.externalId,
      emailHash: order.customer?.emailHash,
      documentHash: order.customer?.documentHash,
    });
    expect(serialized).not.toContain('Ana@Example.com');
    expect(serialized).not.toContain('ana@example.com');
    expect(serialized).not.toContain('12345678909');
    expect(serialized).not.toContain('123.456.789-09');
  });

  it('produces the same email hash regardless of casing and spacing', () => {
    const a = map().order.customer?.emailHash;
    const b = map({ cliente: { idCliente: 555, email: '  ana@example.com  ' } }).order.customer?.emailHash;
    expect(a).toBe(b);
  });

  it('produces the same document hash regardless of punctuation', () => {
    const a = map().order.customer?.documentHash;
    const b = map({ cliente: { idCliente: 555, documento: '12345678909' } }).order.customer?.documentHash;
    expect(a).toBe(b);
  });

  it('leaves the hashes null when the fields are absent', () => {
    const { order } = map({ cliente: { idCliente: 555 } });
    expect(order.customer).toEqual({ externalId: '555', emailHash: null, documentHash: null });
  });

  it('returns a null customer when the order has none', () => {
    expect(map({ cliente: undefined }).order.customer).toBeNull();
  });
});

describe('mapOrder — atribuição', () => {
  it('extracts UTM data and hashes the visitor id', () => {
    const { order } = map();
    expect(order.attribution.source).toBe('google');
    expect(order.attribution.medium).toBe('cpc');
    expect(order.attribution.campaign).toBe('black-friday');
    expect(order.attribution.device).toBe('mobile');
    expect(order.attribution.visitorHash).toBe(
      pseudonymizer.hashVisitorId('1234567890.1699999999'),
    );
  });

  it('never keeps the raw client id in the attribution', () => {
    const { order } = map();
    expect(JSON.stringify(order.attribution)).not.toContain('1234567890.1699999999');
  });

  it('returns nulls when informacoesAdicionais is absent', () => {
    const { order } = map({ informacoesAdicionais: undefined });
    expect(order.attribution).toEqual({
      source: null, medium: null, campaign: null, device: null, visitorHash: null,
    });
  });

  it('accepts snake_case utm keys as well', () => {
    const { order } = map({
      informacoesAdicionais: { utm_source: 'facebook', utm_campaign: 'natal' },
    });
    expect(order.attribution.source).toBe('facebook');
    expect(order.attribution.campaign).toBe('natal');
  });

  it('lowercases campaign and source so grouping does not split', () => {
    const { order } = map({
      informacoesAdicionais: { utmSource: 'Google', utmCampaign: 'Black-Friday' },
    });
    expect(order.attribution.source).toBe('google');
    expect(order.attribution.campaign).toBe('black-friday');
  });
});

describe('mapOrder — pagamento e itens', () => {
  it('takes the first payment method as the order method', () => {
    expect(map().order.paymentMethod).toBe('Cartão de crédito');
  });

  it('leaves the payment method null when there is none', () => {
    expect(map({ pagamento: [] }).order.paymentMethod).toBeNull();
  });

  it('maps every item with cents and a denormalised emission date', () => {
    const { items } = map();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      sku: 'CAM-001', productName: 'Camiseta Preta', categoryName: 'Vestuário',
      quantity: 2, unitPriceCents: 8000, totalPriceCents: 16000,
    });
    expect(items[1]?.categoryName).toBeNull();
  });

  it('substitutes a placeholder sku when the item has none', () => {
    const { items } = map({
      itens: [{ descricao: 'Item sem SKU', quantidade: 1, valorUnitario: 10, valorTotal: 10 }],
    });
    expect(items[0]?.sku).toBe('SEM-SKU');
  });

  it('rounds a fractional quantity up to a whole unit', () => {
    const { items } = map({
      itens: [{ sku: 'A', descricao: 'X', quantidade: 1.4, valorUnitario: 10, valorTotal: 14 }],
    });
    expect(items[0]?.quantity).toBe(1);
  });

  it('produces no items when the order has none', () => {
    expect(map({ itens: [] }).items).toEqual([]);
  });
});

describe('mapOrder — preservação do payload', () => {
  it('keeps the whole raw order so it can be reprocessed offline', () => {
    const { order } = map();
    expect((order.rawPayload as Record<string, unknown>).numeroPedido).toBe('PED-2026-0001');
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `pnpm --filter @center/uappi-sync test -- mapper.test.ts`
Expected: FAIL — `Cannot find module '../mapper.js'`.

- [ ] **Step 3: Implementar `mapper.ts`**

`packages/uappi-sync/src/mapper.ts`:

```ts
import { toCents } from '@center/shared';
import type { Pseudonymizer } from '@center/pii';
import type { UappiOrder } from './schemas.js';
import { resolveStatusGroup, type OrderStatusGroup } from './status-map.js';

const BUSINESS_TIME_ZONE = 'America/Sao_Paulo';
/** Offset fixo do Brasil desde 2019 — o horário de verão foi extinto. */
const SAO_PAULO_OFFSET = '-03:00';

const SKU_PLACEHOLDER = 'SEM-SKU';

export interface MappedCustomer {
  externalId: string;
  emailHash: string | null;
  documentHash: string | null;
}

export interface MappedAttribution {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  device: string | null;
  visitorHash: string | null;
}

export interface MappedOrderItem {
  sku: string;
  productName: string;
  categoryName: string | null;
  quantity: number;
  unitPriceCents: number;
  totalPriceCents: number;
}

export interface MappedOrder {
  numeroPedido: string;
  idPedido: string;
  statusLabel: string;
  statusId: number;
  statusGroup: OrderStatusGroup;
  canal: string | null;
  origem: string | null;
  tipoVenda: string | null;
  emittedAt: Date;
  subtotalCents: number;
  freightCents: number;
  discountCents: number;
  totalCents: number;
  currency: string;
  paymentMethod: string | null;
  customer: MappedCustomer | null;
  attribution: MappedAttribution;
  rawPayload: unknown;
}

export interface MapOrderDeps {
  pseudonymizer: Pseudonymizer;
  statusOverrides?: Record<string, string> | null;
}

/**
 * A Uappi devolve `dataEmissao` como "YYYY-MM-DD HH:mm:ss" sem timezone, no
 * horário local da loja. Interpretar isso como UTC jogaria pedidos da noite para
 * o dia seguinte e faria "quanto vendemos hoje" mentir na virada.
 */
export function parseUappiDate(raw: string): Date {
  const trimmed = raw.trim();

  // Já traz offset ou Z: confiamos no valor.
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) throw new Error(`dataEmissao inválida: "${raw}"`);
    return parsed;
  }

  const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?$/);
  if (!match) throw new Error(`dataEmissao inválida: "${raw}"`);

  const time = match[2] ?? '00:00:00';
  const withSeconds = time.length === 5 ? `${time}:00` : time;
  const parsed = new Date(`${match[1]}T${withSeconds}${SAO_PAULO_OFFSET}`);
  if (Number.isNaN(parsed.getTime())) throw new Error(`dataEmissao inválida: "${raw}"`);
  return parsed;
}

function readString(bag: Record<string, unknown> | undefined, ...keys: string[]): string | null {
  if (!bag) return null;
  for (const key of keys) {
    const value = bag[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

/** Campanha e origem viram minúsculas para não fragmentar o agrupamento. */
function normalizeTag(value: string | null): string | null {
  return value === null ? null : value.toLowerCase();
}

function mapCustomer(order: UappiOrder, pseudonymizer: Pseudonymizer): MappedCustomer | null {
  const customer = order.cliente;
  if (!customer || customer.idCliente === undefined) return null;

  const email = typeof customer.email === 'string' ? customer.email.trim() : '';
  const document = typeof customer.documento === 'string' ? customer.documento.trim() : '';

  return {
    externalId: String(customer.idCliente),
    // Só hash. Não existe caminho neste arquivo que devolva o valor original.
    emailHash: email !== '' ? pseudonymizer.hashEmail(email) : null,
    documentHash: document.replace(/\D/g, '') !== '' ? pseudonymizer.hashDocument(document) : null,
  };
}

function mapAttribution(order: UappiOrder, pseudonymizer: Pseudonymizer): MappedAttribution {
  const extra = order.informacoesAdicionais as Record<string, unknown> | undefined;
  const visitorId = readString(extra, 'centerVisitorId', 'center_visitor_id', 'clientId', 'client_id');

  return {
    source: normalizeTag(readString(extra, 'utmSource', 'utm_source')),
    medium: normalizeTag(readString(extra, 'utmMedium', 'utm_medium')),
    campaign: normalizeTag(readString(extra, 'utmCampaign', 'utm_campaign')),
    device: normalizeTag(readString(extra, 'device', 'dispositivo')),
    visitorHash: visitorId !== null ? pseudonymizer.hashVisitorId(visitorId) : null,
  };
}

export function mapOrder(
  order: UappiOrder,
  deps: MapOrderDeps,
): { order: MappedOrder; items: MappedOrderItem[] } {
  const emittedAt = parseUappiDate(order.dataEmissao);

  const mapped: MappedOrder = {
    numeroPedido: order.numeroPedido,
    idPedido: order.idPedido ?? order.numeroPedido,
    statusLabel: order.status.descricao,
    statusId: order.status.id,
    statusGroup: resolveStatusGroup(order.status.id, order.status.descricao, deps.statusOverrides),
    canal: order.canal ?? null,
    origem: order.origem ?? null,
    tipoVenda: order.tipoVenda ?? null,
    emittedAt,
    subtotalCents: toCents(order.valores.subtotal),
    freightCents: toCents(order.valores.frete),
    discountCents: toCents(order.valores.descontos),
    totalCents: toCents(order.valores.totalPedido),
    currency: order.moeda,
    paymentMethod: order.pagamento[0]?.descricao?.trim() || null,
    customer: mapCustomer(order, deps.pseudonymizer),
    attribution: mapAttribution(order, deps.pseudonymizer),
    rawPayload: order,
  };

  const items: MappedOrderItem[] = order.itens.map((item) => ({
    // SKU vazio quebraria o agrupamento de "produto mais vendido"; um marcador
    // explícito deixa o problema visível no relatório em vez de sumir.
    sku: item.sku?.trim() || SKU_PLACEHOLDER,
    productName: item.descricao.trim() || SKU_PLACEHOLDER,
    categoryName: item.categoria?.trim() || null,
    quantity: Math.max(1, Math.trunc(item.quantidade)),
    unitPriceCents: toCents(item.valorUnitario),
    totalPriceCents: toCents(item.valorTotal),
  }));

  return { order: mapped, items };
}

export { BUSINESS_TIME_ZONE };
```

`packages/uappi-sync/src/index.ts`:

```ts
export * from './schemas.js';
export * from './status-map.js';
export * from './mapper.js';
```

- [ ] **Step 4: Rodar os testes**

Run: `pnpm --filter @center/uappi-sync test`
Expected: PASS — 3 suites, 55 testes.

- [ ] **Step 5: Commit**

```bash
git add packages/uappi-sync
git commit -m "feat(uappi-sync): map orders to the read model with cents and hashed PII"
```

---

### Task 8: Backfill e sincronização incremental

**Files:**
- Create: `packages/uappi-sync/src/{persist.ts,sync.ts}`
- Modify: `packages/uappi-sync/src/index.ts`
- Test: `packages/uappi-sync/src/__tests__/sync.test.ts`

**Interfaces:**
- Consumes: `UappiClientLike` (T5B), `UappiOrderSchema`/`UappiOrderSummarySchema` (T6), `mapOrder` (T7).
- Produces:
  - `interface SyncDeps { prisma: PrismaClient; client: UappiClientLike; pseudonymizer: Pseudonymizer; organizationId: string; statusOverrides?: Record<string,string> | null; now?: () => Date; logger?: (message: string, meta?: Record<string, unknown>) => void }`
  - `interface SyncResult { ordersProcessed: number; ordersFailed: number; from: string; to: string }`
  - `persistOrder(deps, order: UappiOrder): Promise<void>`
  - `runBackfill(deps: SyncDeps, options: { days: number }): Promise<SyncResult>`
  - `runIncrementalSync(deps: SyncDeps, options?: { overlapDays?: number }): Promise<SyncResult>`
  - `SYNC_RESOURCE = 'orders'`, `DEFAULT_OVERLAP_DAYS = 3`

**A decisão central: janela com sobreposição.** Pedidos mudam de status depois de emitidos — um pedido de ontem vira "cancelado" hoje. Se o incremental só olhasse para frente, esse cancelamento nunca chegaria e o faturamento ficaria inflado para sempre. Por isso cada rodada reprocessa os últimos `DEFAULT_OVERLAP_DAYS` dias. Reprocessar é seguro porque o `upsert` é idempotente pela chave natural.

- [ ] **Step 1: Escrever o teste (falhando)**

`packages/uappi-sync/src/__tests__/sync.test.ts`:

```ts
import type { PrismaClient } from '@prisma/client';
import { Pseudonymizer } from '@center/pii';
import type { UappiClientLike } from '@center/uappi-client';
import { runBackfill, runIncrementalSync, SYNC_RESOURCE } from '../sync.js';

const pseudonymizer = new Pseudonymizer('p'.repeat(32));

function orderPayload(numeroPedido: string, dataEmissao = '2026-07-15 10:00:00', total = 100) {
  return {
    idPedido: numeroPedido, numeroPedido, dataEmissao, moeda: 'BRL',
    status: { id: 3, descricao: 'Pagamento aprovado' },
    cliente: { idCliente: '555', email: 'ana@example.com' },
    valores: { subtotal: total, frete: 0, descontos: 0, totalPedido: total },
    pagamento: [{ descricao: 'Pix', valor: total }],
    itens: [{ sku: 'A1', descricao: 'Produto', quantidade: 1, valorUnitario: total, valorTotal: total }],
  };
}

function buildDeps(pages: unknown[][], detailOverrides: Record<string, unknown> = {}) {
  const iterateOrders = jest.fn(async function* () {
    for (const page of pages) yield page;
  });
  const getOrder = jest.fn(async (numeroPedido: string) =>
    detailOverrides[numeroPedido] ?? orderPayload(numeroPedido));

  const upsertOrder = jest.fn(async () => ({ id: `db_${Math.random()}` }));
  const upsertCustomer = jest.fn(async () => ({ id: 'cust_1' }));
  const deleteItems = jest.fn(async () => ({ count: 0 }));
  const createItems = jest.fn(async () => ({ count: 1 }));
  const upsertSyncState = jest.fn(async () => ({}));
  const findSyncState = jest.fn(async () => null);

  const prisma = {
    commerceOrder: { upsert: upsertOrder },
    commerceCustomer: { upsert: upsertCustomer },
    commerceOrderItem: { deleteMany: deleteItems, createMany: createItems },
    syncState: { findUnique: findSyncState, upsert: upsertSyncState },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        commerceOrder: { upsert: upsertOrder },
        commerceCustomer: { upsert: upsertCustomer },
        commerceOrderItem: { deleteMany: deleteItems, createMany: createItems },
      })),
  } as unknown as PrismaClient;

  return {
    deps: {
      prisma,
      client: { iterateOrders, getOrder } as unknown as UappiClientLike,
      pseudonymizer,
      organizationId: 'org_1',
      now: () => new Date('2026-07-20T12:00:00Z'),
    },
    iterateOrders, getOrder, upsertOrder, upsertCustomer, createItems,
    findSyncState, upsertSyncState,
  };
}

describe('runBackfill', () => {
  it('requests the window ending today and starting N days back', async () => {
    const { deps, iterateOrders } = buildDeps([]);
    const result = await runBackfill(deps, { days: 90 });
    expect(iterateOrders).toHaveBeenCalledWith(
      expect.objectContaining({ from: '2026-04-21', to: '2026-07-20' }),
    );
    expect(result).toMatchObject({ from: '2026-04-21', to: '2026-07-20' });
  });

  it('fetches the detail of every order in every page', async () => {
    const { deps, getOrder } = buildDeps([
      [{ numeroPedido: 'P1' }, { numeroPedido: 'P2' }],
      [{ numeroPedido: 'P3' }],
    ]);
    const result = await runBackfill(deps, { days: 30 });
    expect(getOrder.mock.calls.map((call) => call[0])).toEqual(['P1', 'P2', 'P3']);
    expect(result.ordersProcessed).toBe(3);
  });

  it('upserts by the natural key so a rerun does not duplicate', async () => {
    const { deps, upsertOrder } = buildDeps([[{ numeroPedido: 'P1' }]]);
    await runBackfill(deps, { days: 30 });
    expect(upsertOrder).toHaveBeenCalledWith(expect.objectContaining({
      where: { organizationId_numeroPedido: { organizationId: 'org_1', numeroPedido: 'P1' } },
    }));
  });

  it('replaces the items of an order instead of appending on re-sync', async () => {
    const { deps, createItems } = buildDeps([[{ numeroPedido: 'P1' }]]);
    await runBackfill(deps, { days: 30 });
    expect(createItems).toHaveBeenCalledTimes(1);
  });

  it('skips a malformed order and keeps going', async () => {
    const { deps } = buildDeps(
      [[{ numeroPedido: 'P1' }, { numeroPedido: 'P2' }]],
      { P1: { numeroPedido: 'P1' } }, // sem dataEmissao: o schema rejeita
    );
    const result = await runBackfill(deps, { days: 30 });
    expect(result.ordersFailed).toBe(1);
    expect(result.ordersProcessed).toBe(1);
  });

  it('skips an order whose detail call fails and keeps going', async () => {
    const { deps, getOrder } = buildDeps([[{ numeroPedido: 'P1' }, { numeroPedido: 'P2' }]]);
    (getOrder as jest.Mock).mockRejectedValueOnce(new Error('Uappi respondeu 500'));
    const result = await runBackfill(deps, { days: 30 });
    expect(result.ordersFailed).toBe(1);
    expect(result.ordersProcessed).toBe(1);
  });

  it('records the backfill completion in SyncState', async () => {
    const { deps, upsertSyncState } = buildDeps([[{ numeroPedido: 'P1' }]]);
    await runBackfill(deps, { days: 30 });
    expect(upsertSyncState).toHaveBeenCalledWith(expect.objectContaining({
      where: { organizationId_resource: { organizationId: 'org_1', resource: SYNC_RESOURCE } },
      update: expect.objectContaining({ backfillDoneAt: expect.any(Date), cursorDate: '2026-07-20' }),
    }));
  });
});

describe('runIncrementalSync', () => {
  it('runs a backfill first when none has ever completed', async () => {
    const { deps, iterateOrders, findSyncState } = buildDeps([]);
    (findSyncState as jest.Mock).mockResolvedValueOnce(null);
    await runIncrementalSync(deps);
    // Sem backfill anterior, a janela é longa (padrão de 90 dias).
    expect(iterateOrders).toHaveBeenCalledWith(
      expect.objectContaining({ from: '2026-04-21', to: '2026-07-20' }),
    );
  });

  it('re-reads the last few days so status changes are caught', async () => {
    const { deps, iterateOrders, findSyncState } = buildDeps([]);
    (findSyncState as jest.Mock).mockResolvedValueOnce({
      cursorDate: '2026-07-19',
      backfillDoneAt: new Date('2026-07-01T00:00:00Z'),
    });
    await runIncrementalSync(deps);
    // cursor 2026-07-19 menos 3 dias de sobreposição.
    expect(iterateOrders).toHaveBeenCalledWith(
      expect.objectContaining({ from: '2026-07-16', to: '2026-07-20' }),
    );
  });

  it('honours a custom overlap', async () => {
    const { deps, iterateOrders, findSyncState } = buildDeps([]);
    (findSyncState as jest.Mock).mockResolvedValueOnce({
      cursorDate: '2026-07-19',
      backfillDoneAt: new Date('2026-07-01T00:00:00Z'),
    });
    await runIncrementalSync(deps, { overlapDays: 7 });
    expect(iterateOrders).toHaveBeenCalledWith(
      expect.objectContaining({ from: '2026-07-12', to: '2026-07-20' }),
    );
  });

  it('advances the cursor to today after a successful run', async () => {
    const { deps, upsertSyncState, findSyncState } = buildDeps([[{ numeroPedido: 'P1' }]]);
    (findSyncState as jest.Mock).mockResolvedValueOnce({
      cursorDate: '2026-07-19', backfillDoneAt: new Date('2026-07-01T00:00:00Z'),
    });
    await runIncrementalSync(deps);
    expect(upsertSyncState).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ cursorDate: '2026-07-20', lastError: null }),
    }));
  });

  it('records the error and does not advance the cursor when the API fails', async () => {
    const { deps, upsertSyncState, findSyncState, iterateOrders } = buildDeps([]);
    (findSyncState as jest.Mock).mockResolvedValueOnce({
      cursorDate: '2026-07-19', backfillDoneAt: new Date('2026-07-01T00:00:00Z'),
    });
    (iterateOrders as jest.Mock).mockImplementationOnce(async function* () {
      throw new Error('Uappi respondeu 503');
    });

    await expect(runIncrementalSync(deps)).rejects.toThrow('Uappi respondeu 503');
    expect(upsertSyncState).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ lastError: 'Uappi respondeu 503' }),
    }));
    const call = (upsertSyncState as jest.Mock).mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(call.update.cursorDate).toBeUndefined();
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `pnpm --filter @center/uappi-sync test -- sync.test.ts`
Expected: FAIL — `Cannot find module '../sync.js'`.

- [ ] **Step 3: Implementar `persist.ts`**

`packages/uappi-sync/src/persist.ts`:

```ts
import type { Prisma, PrismaClient } from '@prisma/client';
import type { MappedOrder, MappedOrderItem } from './mapper.js';

export interface PersistDeps {
  prisma: PrismaClient;
  organizationId: string;
}

/**
 * Grava um pedido de forma idempotente.
 *
 * Tudo numa transação: um pedido com itens pela metade produziria "produto mais
 * vendido" errado, e esse tipo de erro é invisível até alguém conferir à mão.
 * Os itens são apagados e recriados em vez de atualizados — o pedido pode ter
 * itens removidos entre um sync e outro, e um update deixaria órfãos.
 */
export async function persistOrder(
  deps: PersistDeps,
  order: MappedOrder,
  items: MappedOrderItem[],
): Promise<void> {
  const { prisma, organizationId } = deps;

  await prisma.$transaction(async (tx) => {
    let customerId: string | null = null;

    if (order.customer) {
      const customer = await tx.commerceCustomer.upsert({
        where: {
          organizationId_externalId: {
            organizationId,
            externalId: order.customer.externalId,
          },
        },
        create: {
          organizationId,
          externalId: order.customer.externalId,
          emailHash: order.customer.emailHash,
          documentHash: order.customer.documentHash,
          firstOrderAt: order.emittedAt,
          lastOrderAt: order.emittedAt,
        },
        update: {
          emailHash: order.customer.emailHash,
          documentHash: order.customer.documentHash,
        },
      });
      customerId = customer.id;
    }

    const orderData = {
      organizationId,
      numeroPedido: order.numeroPedido,
      idPedido: order.idPedido,
      statusLabel: order.statusLabel,
      statusId: order.statusId,
      statusGroup: order.statusGroup,
      canal: order.canal,
      origem: order.origem,
      tipoVenda: order.tipoVenda,
      emittedAt: order.emittedAt,
      subtotalCents: order.subtotalCents,
      freightCents: order.freightCents,
      discountCents: order.discountCents,
      totalCents: order.totalCents,
      currency: order.currency,
      paymentMethod: order.paymentMethod,
      customerId,
      attributionSource: order.attribution.source,
      attributionMedium: order.attribution.medium,
      attributionCampaign: order.attribution.campaign,
      attributionDevice: order.attribution.device,
      visitorHash: order.attribution.visitorHash,
      rawPayload: order.rawPayload as Prisma.InputJsonValue,
      syncedAt: new Date(),
    };

    const saved = await tx.commerceOrder.upsert({
      where: {
        organizationId_numeroPedido: { organizationId, numeroPedido: order.numeroPedido },
      },
      create: orderData,
      update: orderData,
    });

    await tx.commerceOrderItem.deleteMany({ where: { orderId: saved.id } });

    if (items.length > 0) {
      await tx.commerceOrderItem.createMany({
        data: items.map((item) => ({
          organizationId,
          orderId: saved.id,
          sku: item.sku,
          productName: item.productName,
          categoryName: item.categoryName,
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents,
          totalPriceCents: item.totalPriceCents,
          emittedAt: order.emittedAt,
        })),
      });
    }
  });
}
```

- [ ] **Step 4: Implementar `sync.ts`**

`packages/uappi-sync/src/sync.ts`:

```ts
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
```

Adicione a `packages/uappi-sync/src/index.ts`:

```ts
export * from './persist.js';
export * from './sync.js';
```

- [ ] **Step 5: Rodar os testes**

Run: `pnpm --filter @center/uappi-sync test`
Expected: PASS — 4 suites, 67 testes.

- [ ] **Step 6: Rodar um backfill real contra o banco local**

```bash
pnpm build
node --input-type=module -e "
import { PrismaClient } from '@prisma/client';
import { Pseudonymizer } from './packages/pii/dist/index.js';
import { UappiTokenProvider, UappiClient } from './packages/uappi-client/dist/index.js';
import { runBackfill } from './packages/uappi-sync/dist/index.js';

const prisma = new PrismaClient();
const org = await prisma.organization.upsert({
  where: { id: 'org_dev' },
  update: {},
  create: { id: 'org_dev', name: 'Loja de Desenvolvimento' },
});
const tokenProvider = new UappiTokenProvider({ baseUrl: process.env.UAPPI_BASE_URL,
  credentials: { apiKey: process.env.UAPPI_API_KEY, secretKey: process.env.UAPPI_SECRET_KEY } });
const result = await runBackfill({
  prisma,
  client: new UappiClient({ baseUrl: process.env.UAPPI_BASE_URL, tokenProvider }),
  pseudonymizer: new Pseudonymizer(process.env.PII_PEPPER),
  organizationId: org.id,
  logger: (m, meta) => console.log(m, meta ?? ''),
}, { days: 30 });
console.log(result);
await prisma.\$disconnect();
"
```

Confirme no banco — e **compare com o painel da Uappi**:

```sql
SELECT "statusGroup", COUNT(*), SUM("totalCents") / 100.0 AS total_reais
FROM "CommerceOrder" WHERE "organizationId" = 'org_dev'
GROUP BY "statusGroup" ORDER BY 2 DESC;

-- Nenhum destes pode retornar linha: seria PII em claro no banco.
SELECT COUNT(*) FROM "CommerceCustomer" WHERE "emailHash" LIKE '%@%';
SELECT COUNT(*) FROM "CommerceOrder" WHERE "visitorHash" LIKE '%.%';
```

A soma de `PAID` precisa bater com o faturamento do mesmo período no painel da Uappi. **Divergência aqui é bloqueio** — investigue o mapa de status antes de seguir, porque toda a Fase 3 é construída sobre esses números.

Rode o mesmo comando uma segunda vez e confirme que `SELECT COUNT(*) FROM "CommerceOrder"` não muda: é a prova de idempotência.

- [ ] **Step 7: Commit**

```bash
git add packages/uappi-sync
git commit -m "feat(uappi-sync): add idempotent backfill and overlapping incremental sync"
```

---

### Task 9: Captura de atribuição no checkout

> **Ordem de execução:** esta task fecha a Fase 1 no papel, mas **é executada no Sprint 7, junto da Fase 6** — ela precisa de `buildServer` e do campo `pseudonymizer` em `AppDeps`, ambos criados na T22. Está documentada aqui porque pertence conceitualmente à ingestão: sem ela, o pedido chega ao read model sem atribuição. Programe-a como a primeira task depois da T23.

**Files:**
- Create: `apps/api/src/routes/attribution.ts`
- Create: `apps/web/public/center-attribution.js`
- Create: `docs/checkout-attribution.md`
- Test: `apps/api/src/__tests__/attribution-routes.test.ts`

**Interfaces:**
- Consumes: `Pseudonymizer` (T3), `PrismaClient`.
- Produces:
  - `POST /public/attribution` (sem autenticação, com CORS restrito e rate limit) body `{ organizationId, clientId, source?, medium?, campaign?, device?, landingPage?, email? }` → `204`
  - `registerAttributionRoutes(app, deps)`
  - Snippet `center-attribution.js` para o checkout da loja

**Como as duas pontas se encontram:** o snippet no site lê o `client_id` do GA4 do cookie `_ga` e as UTMs, e faz duas coisas: (1) posta um `AttributionTouch` para nós e (2) escreve o `centerVisitorId` num campo oculto que a loja envia à Uappi em `informacoesAdicionais`. O caminho (2) é o preciso — o pedido já chega atribuído. O caminho (1) é a rede de segurança: se a loja não conseguir gravar o campo, ainda casamos pelo `emailHash` do cliente dentro de uma janela de 30 dias.

> **Dependência externa explícita.** O caminho (2) exige **uma linha** no template de checkout da loja. Sem ela, o Grupo C cai de 6 perguntas para 1 (`channel_average_ticket`, que usa o campo `canal` nativo da Uappi). Isso é a Premissa 4 do roadmap e o Risco R4.

- [ ] **Step 1: Escrever o teste (falhando)**

`apps/api/src/__tests__/attribution-routes.test.ts`:

Esta task executa depois da T22 (ver a nota de ordem de execução acima), então o helper de configuração de teste já existe.

```ts
import type { PrismaClient } from '@prisma/client';
import { Pseudonymizer } from '@center/pii';
import { SecretBox } from '@center/secrets';
import { buildServer } from '../server.js';
import { testConfig as config } from './helpers/config.js';

const pseudonymizer = new Pseudonymizer(config.piiPepper);
const secretBox = new SecretBox(config.credentialsEncryptionKey);

function setup(organizationExists = true) {
  const create = jest.fn(async () => ({ id: 'touch_1' }));
  const prisma = {
    organization: {
      findUnique: jest.fn(async () => (organizationExists ? { id: 'org_1' } : null)),
    },
    attributionTouch: { create },
  } as unknown as PrismaClient;

  return { prisma, create };
}

const validBody = {
  organizationId: 'org_1',
  clientId: '1234567890.1699999999',
  source: 'google',
  medium: 'cpc',
  campaign: 'Black-Friday',
  device: 'mobile',
  landingPage: '/promocoes',
};

async function build(prisma: PrismaClient) {
  return buildServer({
    config, prisma, pseudonymizer, secretBox,
    gateway: {} as never,
    queue: { enqueue: jest.fn(async () => {}) },
  });
}

describe('POST /public/attribution', () => {
  it('accepts a valid touch and answers 204', async () => {
    const { prisma } = setup();
    const app = await build(prisma);
    const response = await app.inject({ method: 'POST', url: '/public/attribution', payload: validBody });
    expect(response.statusCode).toBe(204);
    await app.close();
  });

  it('stores only the hashed visitor id, never the raw client id', async () => {
    const { prisma, create } = setup();
    const app = await build(prisma);
    await app.inject({ method: 'POST', url: '/public/attribution', payload: validBody });

    const data = create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.visitorHash).toBe(pseudonymizer.hashVisitorId('1234567890.1699999999'));
    expect(JSON.stringify(data)).not.toContain('1234567890.1699999999');
    await app.close();
  });

  it('stores only the hashed email when one is sent', async () => {
    const { prisma, create } = setup();
    const app = await build(prisma);
    await app.inject({
      method: 'POST', url: '/public/attribution',
      payload: { ...validBody, email: 'Ana@Example.com' },
    });

    const data = create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.emailHash).toBe(pseudonymizer.hashEmail('ana@example.com'));
    expect(JSON.stringify(data)).not.toContain('Ana@Example.com');
    await app.close();
  });

  it('lowercases the campaign so grouping does not split', async () => {
    const { prisma, create } = setup();
    const app = await build(prisma);
    await app.inject({ method: 'POST', url: '/public/attribution', payload: validBody });
    expect((create.mock.calls[0]![0].data as Record<string, unknown>).campaign).toBe('black-friday');
    await app.close();
  });

  it('rejects a body without a client id', async () => {
    const { prisma, create } = setup();
    const app = await build(prisma);
    const { clientId: _omitted, ...withoutClient } = validBody;
    const response = await app.inject({ method: 'POST', url: '/public/attribution', payload: withoutClient });
    expect(response.statusCode).toBe(400);
    expect(create).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects an unknown organization instead of creating orphan rows', async () => {
    const { prisma, create } = setup(false);
    const app = await build(prisma);
    const response = await app.inject({ method: 'POST', url: '/public/attribution', payload: validBody });
    expect(response.statusCode).toBe(404);
    expect(create).not.toHaveBeenCalled();
    await app.close();
  });

  it('truncates an oversized landing page instead of rejecting the touch', async () => {
    const { prisma, create } = setup();
    const app = await build(prisma);
    await app.inject({
      method: 'POST', url: '/public/attribution',
      payload: { ...validBody, landingPage: `/${'a'.repeat(5000)}` },
    });
    const landingPage = (create.mock.calls[0]![0].data as Record<string, string>).landingPage;
    expect(landingPage.length).toBeLessThanOrEqual(512);
    await app.close();
  });

  it('never returns data that could identify the visitor', async () => {
    const { prisma } = setup();
    const app = await build(prisma);
    const response = await app.inject({ method: 'POST', url: '/public/attribution', payload: validBody });
    expect(response.body).toBe('');
    await app.close();
  });
});
```

- [ ] **Step 2: Implementar `routes/attribution.ts`**

`apps/api/src/routes/attribution.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';

const MAX_LANDING_PAGE = 512;

const TouchBodySchema = z.object({
  organizationId: z.string().min(1),
  clientId: z.string().min(1),
  source: z.string().max(120).optional(),
  medium: z.string().max(120).optional(),
  campaign: z.string().max(200).optional(),
  device: z.string().max(40).optional(),
  landingPage: z.string().optional(),
  email: z.string().email().optional(),
});

function normalizeTag(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

export async function registerAttributionRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.post(
    '/public/attribution',
    {
      // Endpoint público: chamado do navegador do visitante, sem token.
      // O rate limit é a única defesa contra alguém poluir a atribuição.
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const parsed = TouchBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'bad_request', message: 'payload de atribuição inválido' });
      }
      const body = parsed.data;

      const organization = await deps.prisma.organization.findUnique({
        where: { id: body.organizationId },
        select: { id: true },
      });
      if (!organization) {
        return reply.status(404).send({ error: 'not_found', message: 'organização desconhecida' });
      }

      await deps.prisma.attributionTouch.create({
        data: {
          organizationId: organization.id,
          // Pseudonimização acontece aqui, antes de qualquer gravação.
          visitorHash: deps.pseudonymizer.hashVisitorId(body.clientId),
          emailHash: body.email ? deps.pseudonymizer.hashEmail(body.email) : null,
          source: normalizeTag(body.source),
          medium: normalizeTag(body.medium),
          campaign: normalizeTag(body.campaign),
          device: normalizeTag(body.device),
          landingPage: body.landingPage?.slice(0, MAX_LANDING_PAGE) ?? null,
        },
      });

      // 204 sem corpo: nada que volte daqui pode ajudar a identificar o visitante.
      return reply.status(204).send();
    },
  );
}
```

- [ ] **Step 3: Escrever o snippet do checkout**

`apps/web/public/center-attribution.js`:

```js
/**
 * Captura de atribuição do Center Analytics.
 *
 * Faz duas coisas, e a segunda é a que importa:
 *  1. Envia um "toque" de atribuição para a nossa API (rede de segurança).
 *  2. Escreve o client_id do GA4 num campo oculto do checkout, para que a loja
 *     o envie à Uappi em `informacoesAdicionais.centerVisitorId` — é assim que
 *     o pedido chega já atribuído.
 *
 * Sem PII: o client_id do GA4 é um identificador de navegador, e nós o
 * convertemos em HMAC assim que chega ao servidor. Nenhum e-mail é enviado por
 * este script a menos que a loja preencha explicitamente `centerEmail`.
 */
(function () {
  'use strict';

  var CONFIG = window.CENTER_ATTRIBUTION || {};
  var API_URL = CONFIG.apiUrl;
  var ORGANIZATION_ID = CONFIG.organizationId;
  var STORAGE_KEY = 'center.attribution';
  var TTL_MS = 30 * 24 * 60 * 60 * 1000;

  if (!API_URL || !ORGANIZATION_ID) return;

  /** O cookie _ga tem o formato GA1.1.<client_id>. */
  function readGaClientId() {
    var match = document.cookie.match(/_ga=GA\d\.\d\.(\d+\.\d+)/);
    return match ? match[1] : null;
  }

  function readUtms() {
    var params = new URLSearchParams(window.location.search);
    return {
      source: params.get('utm_source'),
      medium: params.get('utm_medium'),
      campaign: params.get('utm_campaign'),
    };
  }

  function detectDevice() {
    if (/Tablet|iPad/i.test(navigator.userAgent)) return 'tablet';
    if (/Mobi|Android|iPhone/i.test(navigator.userAgent)) return 'mobile';
    return 'desktop';
  }

  function loadStored() {
    try {
      var stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (stored && Date.now() - stored.savedAt < TTL_MS) return stored;
    } catch (error) {
      // localStorage bloqueado (modo privado): seguimos sem persistência.
    }
    return null;
  }

  function save(record) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
    } catch (error) {
      // Sem persistência, a atribuição vale só para esta navegação.
    }
  }

  var clientId = readGaClientId();
  if (!clientId) return;

  var utms = readUtms();
  var stored = loadStored();

  // Primeiro toque com UTM vence: a campanha que trouxe o visitante é a que
  // deve receber o crédito, não a última página que ele visitou.
  var record = {
    clientId: clientId,
    source: utms.source || (stored && stored.source) || null,
    medium: utms.medium || (stored && stored.medium) || null,
    campaign: utms.campaign || (stored && stored.campaign) || null,
    device: detectDevice(),
    landingPage: (stored && stored.landingPage) || window.location.pathname,
    savedAt: (stored && stored.savedAt) || Date.now(),
  };
  save(record);

  // (2) Campo oculto — o caminho preciso. A loja precisa enviá-lo à Uappi.
  function fillHiddenField() {
    var field = document.querySelector('[name="centerVisitorId"]');
    if (field) field.value = clientId;

    var campaignField = document.querySelector('[name="centerUtmCampaign"]');
    if (campaignField) campaignField.value = record.campaign || '';

    var sourceField = document.querySelector('[name="centerUtmSource"]');
    if (sourceField) sourceField.value = record.source || '';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fillHiddenField);
  } else {
    fillHiddenField();
  }

  // (1) Toque para a nossa API — best effort, nunca bloqueia a página.
  var payload = JSON.stringify({
    organizationId: ORGANIZATION_ID,
    clientId: record.clientId,
    source: record.source,
    medium: record.medium,
    campaign: record.campaign,
    device: record.device,
    landingPage: record.landingPage,
  });

  if (navigator.sendBeacon) {
    navigator.sendBeacon(API_URL + '/public/attribution', new Blob([payload], { type: 'application/json' }));
  } else {
    fetch(API_URL + '/public/attribution', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(function () {});
  }
})();
```

- [ ] **Step 4: Escrever o guia de integração para a loja**

`docs/checkout-attribution.md`:

```markdown
# Integração de atribuição no checkout

Esta é a única mudança necessária no site da loja. Ela é o que permite responder
"qual campanha trouxe mais receita" com número exato, em vez de estimativa.

## 1. Incluir o script (todas as páginas)

Coloque antes de `</body>`, **depois** da tag do Google Analytics:

```html
<script>
  window.CENTER_ATTRIBUTION = {
    apiUrl: 'https://api.seudominio.com.br',
    organizationId: 'org_xxxxx'
  };
</script>
<script src="https://app.seudominio.com.br/center-attribution.js" defer></script>
```

## 2. Adicionar os campos ocultos (página de checkout)

Dentro do formulário que gera o pedido:

```html
<input type="hidden" name="centerVisitorId" value="">
<input type="hidden" name="centerUtmSource" value="">
<input type="hidden" name="centerUtmCampaign" value="">
```

## 3. Enviar os campos à Uappi

No ponto onde a loja cria o pedido, inclua-os em `informacoesAdicionais`:

```json
{
  "informacoesAdicionais": {
    "centerVisitorId": "<valor do campo centerVisitorId>",
    "utmSource": "<valor do campo centerUtmSource>",
    "utmCampaign": "<valor do campo centerUtmCampaign>"
  }
}
```

## Como verificar que funcionou

Faça um pedido de teste chegando ao site por
`https://loja.com.br/?utm_source=teste&utm_campaign=validacao`. Depois do sync:

```sql
SELECT "numeroPedido", "attributionSource", "attributionCampaign", "visitorHash"
FROM "CommerceOrder"
WHERE "attributionCampaign" = 'validacao';
```

Precisa retornar uma linha, com `visitorHash` preenchido — 32 caracteres
hexadecimais, nunca o client_id original.

## O que acontece se os passos 2 e 3 não forem feitos

O script continua registrando toques (passo 1), mas o pedido chega sem
atribuição. Nesse caso o sistema tenta casar pelo hash do e-mail dentro de uma
janela de 30 dias — funciona, mas perde os pedidos de clientes que compraram com
e-mail diferente do usado na navegação. Das 6 perguntas do Grupo C, apenas
"quais canais possuem maior ticket médio" continua exata (usa o campo `canal`
nativo da Uappi).

## Privacidade

O `client_id` do GA4 identifica o navegador, não a pessoa. Ele é convertido em
HMAC-SHA256 no servidor, antes de qualquer gravação — não existe coluna no banco
capaz de armazenar o valor original, e não existe chave capaz de revertê-lo.
Nenhum e-mail sai do site por este script.
```

- [ ] **Step 5: Rodar os testes**

Run: `pnpm --filter @center/api test -- attribution-routes.test.ts`
Expected: PASS — 8 testes.

- [ ] **Step 6: Validar a ponta a ponta com um pedido de teste**

Com o snippet publicado e os campos ocultos no checkout, navegue até
`https://loja.com.br/?utm_source=teste&utm_campaign=validacao`, complete um pedido e aguarde o próximo ciclo de sync (até 30 min). Depois:

```sql
SELECT "numeroPedido", "attributionSource", "attributionCampaign", "attributionDevice", "visitorHash"
FROM "CommerceOrder" WHERE "attributionCampaign" = 'validacao';

-- O toque também precisa ter sido registrado pelo caminho (1):
SELECT "campaign", "device", "visitorHash" FROM "AttributionTouch"
WHERE "campaign" = 'validacao' ORDER BY "occurredAt" DESC LIMIT 1;
```

Ambas as consultas precisam retornar uma linha, e o `visitorHash` precisa ser o mesmo nas duas — é a prova de que o caminho preciso (campo oculto → Uappi) e a rede de segurança (beacon → nossa API) concordam.

- [ ] **Step 7: Commit**

```bash
git add apps/api apps/web/public docs/checkout-attribution.md
git commit -m "feat(attribution): capture GA4 client id and UTMs with server side hashing"
```

---

# FASE 2 — Núcleo MCP (Sprint 4)

**Objetivo:** o toolkit que todos os três MCP servers usam, e o gateway com cache que é a única porta de entrada para dados no sistema inteiro.

**A decisão que define esta fase — duas famílias de ferramentas.** O plano anterior tinha só `query_metric`. Metade das 39 perguntas não é série temporal: "qual produto mais vendeu" é ranking, "qual etapa do checkout abandona mais" é funil, "qual produto caiu em vendas" é comparação. Forçá-las em série temporal produziria ferramentas torcidas. Então o toolkit registra:
1. **`list_metrics` + `query_metric`** — contrato uniforme, idêntico em todo server. Alimenta a dashboard sem código específico por fonte.
2. **Ferramentas de análise nomeadas** — cada uma com seu schema de entrada e saída. Alimentam o agente e as telas de ranking.

**Onde os testes entram:** o toolkit é testado com transporte *in-memory*, que exercita o protocolo MCP completo (serialização, validação, formato de erro) dentro do processo de teste, sem subir processo nem tocar rede. É o teste de maior retorno do projeto inteiro.

---

### Task 10: Toolkit de MCP server

**Files:**
- Create: `packages/mcp-core/{package.json,tsconfig.json,jest.config.cjs}`
- Create: `packages/mcp-core/src/{provider.ts,server.ts,series.ts,index.ts}`
- Test: `packages/mcp-core/src/__tests__/{server.test.ts,series.test.ts}`

**Interfaces:**
- Consumes: contratos de `@center/shared` (T2).
- Produces:
  - `interface MetricProvider { readonly descriptors: readonly MetricDescriptor[]; query(q: MetricQuery): Promise<MetricSeries> }`
  - `interface AnalysisTool<TInput = Record<string, unknown>> { name: string; description: string; inputSchema: ZodRawShape; outputSchema: ZodRawShape; handler: (args: TInput) => Promise<Record<string, unknown>> }`
  - `createMetricServer(options: { name: string; version: string; provider?: MetricProvider; tools?: AnalysisTool[] }): McpServer`
  - `startStdio(server: McpServer): Promise<void>`
  - `class MetricNotFoundError extends Error`
  - `interface SeriesRow { date: string; value: number; group: string | null }`
  - `toSeries(rows, query, unit, source): MetricSeries`

- [ ] **Step 1: Criar o pacote**

`packages/mcp-core/package.json`:

```json
{
  "name": "@center/mcp-core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "jest"
  },
  "dependencies": {
    "@center/shared": "workspace:*",
    "@modelcontextprotocol/sdk": "^1.12.0",
    "ioredis": "^5.4.2",
    "zod": "^3.24.1"
  }
}
```

`tsconfig.json` e `jest.config.cjs` seguem o molde da T1, Step 4 (`extends: "../../tsconfig.base.json"`, `require('../../jest.preset.cjs')`).

- [ ] **Step 2: Escrever o teste do server (falhando)**

`packages/mcp-core/src/__tests__/server.test.ts`:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import type { MetricDescriptor, MetricQuery, MetricSeries } from '@center/shared';
import { createMetricServer, MetricNotFoundError, type AnalysisTool, type MetricProvider } from '../server.js';

const descriptors: MetricDescriptor[] = [{
  id: 'commerce.revenue', label: 'Faturamento',
  description: 'Receita de pedidos pagos, em centavos',
  source: 'commerce', unit: 'currency', dimensions: ['channel'],
}];

function buildProvider(overrides: Partial<MetricProvider> = {}): MetricProvider {
  return {
    descriptors,
    async query(q: MetricQuery): Promise<MetricSeries> {
      if (q.metricId !== 'commerce.revenue') throw new MetricNotFoundError(q.metricId);
      return {
        metricId: q.metricId, source: 'commerce', unit: 'currency',
        granularity: q.granularity, total: 30000,
        points: [{ date: '2026-01-01', value: 10000 }, { date: '2026-01-02', value: 20000 }],
      };
    },
    ...overrides,
  };
}

const topProductsTool: AnalysisTool = {
  name: 'top_products',
  description: 'Produtos mais vendidos no período',
  inputSchema: { from: z.string(), to: z.string(), limit: z.number().optional() },
  outputSchema: { rows: z.array(z.object({ key: z.string(), value: z.number() })) },
  handler: async () => ({ rows: [{ key: 'CAM-001', value: 16000 }] }),
};

async function connect(options: Parameters<typeof createMetricServer>[0]) {
  const server = createMetricServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const validQuery = {
  metricId: 'commerce.revenue', from: '2026-01-01', to: '2026-01-02',
  granularity: 'day' as const,
  tenant: { organizationId: 'org_1', externalIds: {} },
};

describe('createMetricServer — família de métricas', () => {
  it('exposes list_metrics and query_metric when a provider is given', async () => {
    const { client, close } = await connect({ name: 's', version: '1.0.0', provider: buildProvider() });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['list_metrics', 'query_metric']);
    await close();
  });

  it('returns the catalog through list_metrics', async () => {
    const { client, close } = await connect({ name: 's', version: '1.0.0', provider: buildProvider() });
    const result = await client.callTool({ name: 'list_metrics', arguments: {} });
    expect(result.structuredContent).toEqual({ metrics: descriptors });
    await close();
  });

  it('returns a metric series through query_metric', async () => {
    const { client, close } = await connect({ name: 's', version: '1.0.0', provider: buildProvider() });
    const result = await client.callTool({ name: 'query_metric', arguments: validQuery });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ metricId: 'commerce.revenue', total: 30000 });
    await close();
  });

  it('reports an unknown metric as a tool error, not a crash', async () => {
    const { client, close } = await connect({ name: 's', version: '1.0.0', provider: buildProvider() });
    const result = await client.callTool({
      name: 'query_metric', arguments: { ...validQuery, metricId: 'commerce.inexistente' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('commerce.inexistente');
    await close();
  });

  it('surfaces a provider failure as a tool error', async () => {
    const provider = buildProvider({ query: async () => { throw new Error('postgres indisponível'); } });
    const { client, close } = await connect({ name: 's', version: '1.0.0', provider });
    const result = await client.callTool({ name: 'query_metric', arguments: validQuery });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('postgres indisponível');
    await close();
  });

  it('rejects a query missing the tenant before reaching the provider', async () => {
    const query = jest.fn();
    const { client, close } = await connect({
      name: 's', version: '1.0.0', provider: buildProvider({ query }),
    });
    const { tenant: _omitted, ...withoutTenant } = validQuery;
    const result = await client.callTool({ name: 'query_metric', arguments: withoutTenant });
    expect(result.isError).toBe(true);
    expect(query).not.toHaveBeenCalled();
    await close();
  });
});

describe('createMetricServer — família de análise', () => {
  it('registers named analysis tools alongside the metric tools', async () => {
    const { client, close } = await connect({
      name: 's', version: '1.0.0', provider: buildProvider(), tools: [topProductsTool],
    });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['list_metrics', 'query_metric', 'top_products']);
    await close();
  });

  it('runs an analysis tool and returns its structured payload', async () => {
    const { client, close } = await connect({
      name: 's', version: '1.0.0', provider: buildProvider(), tools: [topProductsTool],
    });
    const result = await client.callTool({
      name: 'top_products', arguments: { from: '2026-01-01', to: '2026-01-31' },
    });
    expect(result.structuredContent).toEqual({ rows: [{ key: 'CAM-001', value: 16000 }] });
    await close();
  });

  it('turns an analysis tool failure into a tool error', async () => {
    const failing: AnalysisTool = {
      ...topProductsTool,
      handler: async () => { throw new Error('consulta demorou demais'); },
    };
    const { client, close } = await connect({ name: 's', version: '1.0.0', tools: [failing] });
    const result = await client.callTool({
      name: 'top_products', arguments: { from: '2026-01-01', to: '2026-01-31' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('consulta demorou demais');
    await close();
  });

  it('serves a tools-only server with no provider', async () => {
    const { client, close } = await connect({ name: 's', version: '1.0.0', tools: [topProductsTool] });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['top_products']);
    await close();
  });
});
```

- [ ] **Step 3: Rodar e confirmar que falha**

Run: `pnpm --filter @center/mcp-core test`
Expected: FAIL — `Cannot find module '../server.js'`.

- [ ] **Step 4: Implementar `provider.ts` e `server.ts`**

`packages/mcp-core/src/provider.ts`:

```ts
import type { MetricDescriptor, MetricQuery, MetricSeries } from '@center/shared';

/** A única coisa que um server de métricas precisa implementar. */
export interface MetricProvider {
  readonly descriptors: readonly MetricDescriptor[];
  query(query: MetricQuery): Promise<MetricSeries>;
}

export class MetricNotFoundError extends Error {
  constructor(public readonly metricId: string) {
    super(`métrica desconhecida: "${metricId}"`);
    this.name = 'MetricNotFoundError';
  }
}
```

`packages/mcp-core/src/server.ts`:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ZodRawShape } from 'zod';
import { MetricCatalogSchema, MetricQuerySchema, MetricSeriesSchema } from '@center/shared';
import { MetricNotFoundError, type MetricProvider } from './provider.js';

export { MetricNotFoundError };
export type { MetricProvider };

/**
 * Ferramenta de análise nomeada — rankings, funis, comparações. A segunda
 * família de ferramentas: o que não cabe em série temporal mora aqui.
 */
export interface AnalysisTool<TInput = Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema: ZodRawShape;
  outputSchema: ZodRawShape;
  handler: (args: TInput) => Promise<Record<string, unknown>>;
}

export interface CreateMetricServerOptions {
  name: string;
  version: string;
  provider?: MetricProvider;
  tools?: AnalysisTool[];
}

function ok(structured: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

/**
 * Erros viram resultado-de-ferramenta, não exceção de transporte. O modelo
 * precisa conseguir ler a mensagem e decidir o que fazer; um crash de
 * transporte derrubaria a conversa inteira.
 */
function fail(error: unknown) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
  };
}

export function createMetricServer(options: CreateMetricServerOptions): McpServer {
  const server = new McpServer({ name: options.name, version: options.version });

  if (options.provider) {
    const provider = options.provider;

    server.registerTool(
      'list_metrics',
      {
        title: 'Listar métricas',
        description:
          'Lista as métricas disponíveis nesta fonte com unidade e dimensões filtráveis. ' +
          'Chame antes de query_metric quando não souber o metricId exato.',
        inputSchema: {},
        outputSchema: MetricCatalogSchema.shape,
      },
      async () => {
        try {
          return ok({ metrics: [...provider.descriptors] });
        } catch (error) {
          return fail(error);
        }
      },
    );

    server.registerTool(
      'query_metric',
      {
        title: 'Consultar métrica',
        description:
          'Série temporal de uma métrica em um intervalo. Datas em YYYY-MM-DD. ' +
          'Valores monetários voltam em CENTAVOS.',
        inputSchema: MetricQuerySchema.shape,
        outputSchema: MetricSeriesSchema.shape,
      },
      async (args) => {
        try {
          // Revalidamos: o SDK checa a forma, mas as regras de negócio
          // (regex de data, tenant obrigatório) ficam num lugar só.
          const query = MetricQuerySchema.parse(args);
          if (!provider.descriptors.some((d) => d.id === query.metricId)) {
            throw new MetricNotFoundError(query.metricId);
          }
          return ok(MetricSeriesSchema.parse(await provider.query(query)));
        } catch (error) {
          return fail(error);
        }
      },
    );
  }

  for (const tool of options.tools ?? []) {
    server.registerTool(
      tool.name,
      {
        title: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
      },
      async (args: Record<string, unknown>) => {
        try {
          return ok(await tool.handler(args as never));
        } catch (error) {
          return fail(error);
        }
      },
    );
  }

  return server;
}

export async function startStdio(server: McpServer): Promise<void> {
  await server.connect(new StdioServerTransport());
}
```

- [ ] **Step 5: Escrever o teste de `toSeries` (falhando)**

`packages/mcp-core/src/__tests__/series.test.ts`:

```ts
import type { MetricQuery } from '@center/shared';
import { toSeries, type SeriesRow } from '../series.js';

const query: MetricQuery = {
  metricId: 'commerce.revenue', from: '2026-01-01', to: '2026-01-03',
  granularity: 'day', tenant: { organizationId: 'org_1', externalIds: {} },
};

describe('toSeries', () => {
  it('fills missing buckets with zero so charts have no gaps', () => {
    const rows: SeriesRow[] = [{ date: '2026-01-02', value: 500, group: null }];
    expect(toSeries(rows, query, 'currency', 'commerce').points).toEqual([
      { date: '2026-01-01', value: 0 },
      { date: '2026-01-02', value: 500 },
      { date: '2026-01-03', value: 0 },
    ]);
  });

  it('collapses daily rows into month buckets', () => {
    const rows: SeriesRow[] = [
      { date: '2026-01-05', value: 1000, group: null },
      { date: '2026-01-20', value: 1500, group: null },
    ];
    const series = toSeries(rows, { ...query, to: '2026-01-31', granularity: 'month' }, 'currency', 'commerce');
    expect(series.points).toEqual([{ date: '2026-01-01', value: 2500 }]);
    expect(series.total).toBe(2500);
  });

  it('keeps grouped rows separate and deterministically sorted', () => {
    const rows: SeriesRow[] = [
      { date: '2026-01-01', value: 600, group: 'pix' },
      { date: '2026-01-01', value: 400, group: 'cartao' },
    ];
    const series = toSeries(rows, { ...query, to: '2026-01-01', groupBy: 'paymentMethod' }, 'currency', 'commerce');
    expect(series.points).toEqual([
      { date: '2026-01-01', value: 400, group: 'cartao' },
      { date: '2026-01-01', value: 600, group: 'pix' },
    ]);
    expect(series.total).toBe(1000);
  });

  it('sums two rows landing in the same bucket', () => {
    const rows: SeriesRow[] = [
      { date: '2026-01-01', value: 300, group: null },
      { date: '2026-01-01', value: 400, group: null },
    ];
    expect(toSeries(rows, { ...query, to: '2026-01-01' }, 'currency', 'commerce').total).toBe(700);
  });

  it('produces an all-zero series when there are no rows', () => {
    const series = toSeries([], query, 'currency', 'commerce');
    expect(series.total).toBe(0);
    expect(series.points).toHaveLength(3);
  });
});
```

- [ ] **Step 6: Implementar `series.ts`**

`packages/mcp-core/src/series.ts`:

```ts
import {
  bucketStart, eachBucket,
  type MetricQuery, type MetricSeries, type MetricSource, type MetricUnit,
} from '@center/shared';

/** Linha crua de qualquer fonte: uma data diária, um valor, um grupo opcional. */
export interface SeriesRow {
  date: string;
  value: number;
  group: string | null;
}

/**
 * Converte linhas diárias na série canônica: agrupa por bucket, preenche
 * buckets vazios com zero (senão o gráfico ganha buracos e o total mente) e
 * ordena de forma determinística por (data, grupo).
 */
export function toSeries(
  rows: readonly SeriesRow[],
  query: MetricQuery,
  unit: MetricUnit,
  source: MetricSource,
): MetricSeries {
  const totals = new Map<string, number>();

  for (const row of rows) {
    const key = `${bucketStart(row.date, query.granularity)} ${row.group ?? ''}`;
    totals.set(key, (totals.get(key) ?? 0) + row.value);
  }

  const groups = query.groupBy
    ? [...new Set(rows.map((row) => row.group ?? ''))].sort()
    : [''];

  const points = eachBucket(query.from, query.to, query.granularity).flatMap((bucket) =>
    groups.map((group) => {
      const value = totals.get(`${bucket} ${group}`) ?? 0;
      return group ? { date: bucket, value, group } : { date: bucket, value };
    }),
  );

  return {
    metricId: query.metricId,
    source,
    unit,
    granularity: query.granularity,
    total: points.reduce((acc, point) => acc + point.value, 0),
    points,
  };
}
```

`packages/mcp-core/src/index.ts`:

```ts
export * from './provider.js';
export * from './server.js';
export * from './series.js';
```

- [ ] **Step 7: Rodar os testes**

Run: `pnpm --filter @center/mcp-core test`
Expected: PASS — 2 suites, 15 testes.

- [ ] **Step 8: Commit**

```bash
git add packages/mcp-core
git commit -m "feat(mcp-core): add toolkit with metric and named analysis tool families"
```

---

### Task 11: Pool de clientes, cache e gateway

**Files:**
- Create: `packages/mcp-core/src/{pool.ts,cache.ts,gateway.ts}`
- Modify: `packages/mcp-core/src/index.ts`
- Test: `packages/mcp-core/src/__tests__/{pool.test.ts,gateway.test.ts}`

**Interfaces:**
- Consumes: `createMetricServer` (T10).
- Produces:
  - `interface McpServerConfig { source: MetricSource; command: string; args: string[]; env?: Record<string,string> }`
  - `class McpPool` — `static fromConnections(connections)`, `static spawn(configs)`, `listMetrics()`, `queryMetric(query)`, `callTool<T>(source, name, args)`, `close()`
  - `class McpToolError extends Error`, `sourceOf(metricId): MetricSource`
  - `interface CacheStore { get(key): Promise<string|null>; set(key, value, ttlSeconds): Promise<void> }`
  - `class MemoryCacheStore`, `class RedisCacheStore`
  - `cacheKeyFor(query: MetricQuery): string`, `toolCacheKeyFor(source, name, args, organizationId): string`
  - `SHORT_TTL_SECONDS = 300`, `LONG_TTL_SECONDS = 86_400`
  - `class MetricGateway` — `listMetrics()`, `queryMetric(query)`, `queryBatch(queries)`, `callTool<T>(source, name, args, options?)`, `close()`

**A regra de TTL que evita o bug mais comum de cache analítico:** um período que **inclui hoje** ainda está mudando — TTL de 5 minutos. Um período **fechado no passado** é imutável — TTL de 24 horas. Sem essa distinção, ou a dashboard mostra dados velhos, ou o cache nunca serve para nada.

- [ ] **Step 1: Escrever o teste do pool (falhando)**

`packages/mcp-core/src/__tests__/pool.test.ts`:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import type { MetricDescriptor, MetricQuery, MetricSeries, MetricSource } from '@center/shared';
import { createMetricServer, type AnalysisTool, type MetricProvider } from '../server.js';
import { McpPool, McpToolError, sourceOf } from '../pool.js';

function providerFor(source: MetricSource, name: string, total: number): MetricProvider {
  const descriptor: MetricDescriptor = {
    id: `${source}.${name}`, label: name, description: `${name} de ${source}`,
    source, unit: 'count', dimensions: [],
  };
  return {
    descriptors: [descriptor],
    async query(q: MetricQuery): Promise<MetricSeries> {
      return {
        metricId: q.metricId, source, unit: 'count', granularity: q.granularity,
        total, points: [{ date: q.from, value: total }],
      };
    },
  };
}

const echoTool: AnalysisTool = {
  name: 'top_products',
  description: 'echo',
  inputSchema: { limit: z.number() },
  outputSchema: { rows: z.array(z.object({ key: z.string() })) },
  handler: async (args) => ({ rows: [{ key: `limit=${(args as { limit: number }).limit}` }] }),
};

async function linkedClient(provider: MetricProvider, tools: AnalysisTool[] = []): Promise<Client> {
  const server = createMetricServer({ name: 'srv', version: '1.0.0', provider, tools });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'pool-test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const query: MetricQuery = {
  metricId: 'ga4.sessions', from: '2026-01-01', to: '2026-01-01',
  granularity: 'day', tenant: { organizationId: 'org_1', externalIds: {} },
};

describe('sourceOf', () => {
  it('extracts the source from the metric id prefix', () => {
    expect(sourceOf('commerce.revenue')).toBe('commerce');
    expect(sourceOf('ga4.sessions')).toBe('ga4');
  });

  it('throws when there is no dot separator', () => {
    expect(() => sourceOf('revenue')).toThrow('metricId inválido');
  });

  it('throws when the prefix is not a known source', () => {
    expect(() => sourceOf('mixpanel.events')).toThrow('metricId inválido');
  });
});

describe('McpPool', () => {
  let pool: McpPool;

  beforeEach(async () => {
    pool = McpPool.fromConnections([
      { source: 'ga4', client: await linkedClient(providerFor('ga4', 'sessions', 100)) },
      { source: 'commerce', client: await linkedClient(providerFor('commerce', 'revenue', 250), [echoTool]) },
    ]);
  });

  afterEach(async () => { await pool.close(); });

  it('merges the catalogs of every connected server', async () => {
    const metrics = await pool.listMetrics();
    expect(metrics.map((m) => m.id).sort()).toEqual(['commerce.revenue', 'ga4.sessions']);
  });

  it('routes a query to the server named by the metric id prefix', async () => {
    expect((await pool.queryMetric(query)).total).toBe(100);
    expect((await pool.queryMetric({ ...query, metricId: 'commerce.revenue' })).total).toBe(250);
  });

  it('throws when no server serves the metric source', async () => {
    await expect(pool.queryMetric({ ...query, metricId: 'behavior.paths' }))
      .rejects.toThrow('nenhum servidor MCP conectado para a fonte "behavior"');
  });

  it('converts an MCP tool error into McpToolError', async () => {
    await expect(pool.queryMetric({ ...query, metricId: 'ga4.inexistente' }))
      .rejects.toBeInstanceOf(McpToolError);
  });

  it('calls a named analysis tool on the right server', async () => {
    const result = await pool.callTool<{ rows: Array<{ key: string }> }>(
      'commerce', 'top_products', { limit: 5 },
    );
    expect(result.rows[0]?.key).toBe('limit=5');
  });

  it('keeps serving the other sources when one server is absent', async () => {
    const single = McpPool.fromConnections([
      { source: 'ga4', client: await linkedClient(providerFor('ga4', 'sessions', 100)) },
    ]);
    expect((await single.listMetrics()).map((m) => m.id)).toEqual(['ga4.sessions']);
    await single.close();
  });
});
```

- [ ] **Step 2: Implementar `pool.ts`**

`packages/mcp-core/src/pool.ts`:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  MetricDescriptorSchema, MetricSeriesSchema, MetricSourceSchema,
  type MetricDescriptor, type MetricQuery, type MetricSeries, type MetricSource,
} from '@center/shared';

export interface McpServerConfig {
  source: MetricSource;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface McpConnection {
  source: MetricSource;
  client: Client;
}

export class McpToolError extends Error {
  constructor(public readonly source: MetricSource, public readonly toolName: string, message: string) {
    super(`[${source}.${toolName}] ${message}`);
    this.name = 'McpToolError';
  }
}

interface RawToolResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
}

/** `commerce.revenue` → `commerce`. Roteamento sem estado, derivado do id. */
export function sourceOf(metricId: string): MetricSource {
  const parsed = MetricSourceSchema.safeParse(metricId.split('.')[0]);
  if (!parsed.success || !metricId.includes('.')) {
    throw new Error(`metricId inválido: "${metricId}" (esperado "<source>.<nome>")`);
  }
  return parsed.data;
}

export class McpPool {
  private constructor(private readonly connections: Map<MetricSource, Client>) {}

  static fromConnections(connections: McpConnection[]): McpPool {
    return new McpPool(new Map(connections.map((c) => [c.source, c.client])));
  }

  static async spawn(configs: McpServerConfig[]): Promise<McpPool> {
    const connections = await Promise.all(
      configs.map(async (config): Promise<McpConnection> => {
        const transport = new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: { ...(process.env as Record<string, string>), ...(config.env ?? {}) },
        });
        const client = new Client({ name: `center-pool-${config.source}`, version: '1.0.0' });
        await client.connect(transport);
        return { source: config.source, client };
      }),
    );
    return McpPool.fromConnections(connections);
  }

  private clientFor(source: MetricSource): Client {
    const client = this.connections.get(source);
    if (!client) throw new Error(`nenhum servidor MCP conectado para a fonte "${source}"`);
    return client;
  }

  async callTool<T>(source: MetricSource, name: string, args: Record<string, unknown>): Promise<T> {
    const result = (await this.clientFor(source).callTool({ name, arguments: args })) as RawToolResult;

    if (result.isError) {
      const text = result.content?.map((part) => part.text ?? '').join(' ').trim();
      throw new McpToolError(source, name, text || 'erro desconhecido');
    }
    if (result.structuredContent === undefined) {
      throw new McpToolError(source, name, 'resposta sem structuredContent');
    }
    return result.structuredContent as T;
  }

  /** Um server offline não derruba o catálogo dos demais. */
  async listMetrics(): Promise<MetricDescriptor[]> {
    const results = await Promise.allSettled(
      [...this.connections.keys()].map(async (source) => {
        const payload = await this.callTool<{ metrics: unknown[] }>(source, 'list_metrics', {});
        return payload.metrics.map((m) => MetricDescriptorSchema.parse(m));
      }),
    );
    return results
      .filter((r): r is PromiseFulfilledResult<MetricDescriptor[]> => r.status === 'fulfilled')
      .flatMap((r) => r.value);
  }

  async queryMetric(query: MetricQuery): Promise<MetricSeries> {
    const payload = await this.callTool<unknown>(
      sourceOf(query.metricId), 'query_metric', query as unknown as Record<string, unknown>,
    );
    return MetricSeriesSchema.parse(payload);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.connections.values()].map((client) => client.close()));
    this.connections.clear();
  }
}
```

- [ ] **Step 3: Escrever o teste do gateway (falhando)**

`packages/mcp-core/src/__tests__/gateway.test.ts`:

```ts
import type { MetricQuery, MetricSeries } from '@center/shared';
import { MemoryCacheStore, cacheKeyFor, toolCacheKeyFor } from '../cache.js';
import { MetricGateway } from '../gateway.js';
import type { McpPool } from '../pool.js';

const query: MetricQuery = {
  metricId: 'commerce.revenue', from: '2026-01-01', to: '2026-01-31',
  granularity: 'day', tenant: { organizationId: 'org_1', externalIds: {} },
};

const series: MetricSeries = {
  metricId: 'commerce.revenue', source: 'commerce', unit: 'currency',
  granularity: 'day', total: 100000, points: [{ date: '2026-01-01', value: 100000 }],
};

function fakePool() {
  const queryMetric = jest.fn(async () => series);
  const listMetrics = jest.fn(async () => []);
  const callTool = jest.fn(async () => ({ rows: [] }));
  const close = jest.fn(async () => {});
  return {
    pool: { queryMetric, listMetrics, callTool, close } as unknown as McpPool,
    queryMetric, listMetrics, callTool,
  };
}

/** "Hoje" fixo em 2026-03-15 — o range acima está inteiramente no passado. */
const now = () => new Date('2026-03-15T12:00:00Z');

describe('cacheKeyFor', () => {
  it('is stable across filter key ordering', () => {
    expect(cacheKeyFor({ ...query, filters: { a: '1', b: '2' } }))
      .toBe(cacheKeyFor({ ...query, filters: { b: '2', a: '1' } }));
  });

  it('separates tenants', () => {
    expect(cacheKeyFor(query)).not.toBe(cacheKeyFor({
      ...query, tenant: { organizationId: 'org_2', externalIds: {} },
    }));
  });

  it('separates date ranges', () => {
    expect(cacheKeyFor(query)).not.toBe(cacheKeyFor({ ...query, to: '2026-02-28' }));
  });

  it('is namespaced so a targeted purge is possible', () => {
    expect(cacheKeyFor(query)).toMatch(/^metric:v1:org_1:/);
  });
});

describe('toolCacheKeyFor', () => {
  it('separates tools, arguments and tenants', () => {
    const base = toolCacheKeyFor('commerce', 'top_products', { limit: 10 }, 'org_1');
    expect(base).not.toBe(toolCacheKeyFor('commerce', 'top_products', { limit: 20 }, 'org_1'));
    expect(base).not.toBe(toolCacheKeyFor('commerce', 'top_categories', { limit: 10 }, 'org_1'));
    expect(base).not.toBe(toolCacheKeyFor('commerce', 'top_products', { limit: 10 }, 'org_2'));
  });

  it('ignores the tenant object inside the arguments when keying', () => {
    const withTenant = toolCacheKeyFor(
      'commerce', 'top_products',
      { limit: 10, tenant: { organizationId: 'org_1', externalIds: { secret: 'a' } } }, 'org_1',
    );
    const withoutTenant = toolCacheKeyFor('commerce', 'top_products', { limit: 10 }, 'org_1');
    expect(withTenant).toBe(withoutTenant);
  });
});

describe('MetricGateway', () => {
  it('hits the pool on a cache miss', async () => {
    const { pool, queryMetric } = fakePool();
    const gateway = new MetricGateway(pool, new MemoryCacheStore(), { now });
    expect(await gateway.queryMetric(query)).toEqual(series);
    expect(queryMetric).toHaveBeenCalledTimes(1);
  });

  it('serves the second identical query from cache', async () => {
    const { pool, queryMetric } = fakePool();
    const gateway = new MetricGateway(pool, new MemoryCacheStore(), { now });
    await gateway.queryMetric(query);
    await gateway.queryMetric(query);
    expect(queryMetric).toHaveBeenCalledTimes(1);
  });

  it('does not share cache between tenants', async () => {
    const { pool, queryMetric } = fakePool();
    const gateway = new MetricGateway(pool, new MemoryCacheStore(), { now });
    await gateway.queryMetric(query);
    await gateway.queryMetric({ ...query, tenant: { organizationId: 'org_2', externalIds: {} } });
    expect(queryMetric).toHaveBeenCalledTimes(2);
  });

  it('uses a long TTL for a range entirely in the past', async () => {
    const { pool } = fakePool();
    const cache = new MemoryCacheStore();
    const setSpy = jest.spyOn(cache, 'set');
    await new MetricGateway(pool, cache, { now }).queryMetric(query);
    expect(setSpy).toHaveBeenCalledWith(expect.any(String), expect.any(String), 86_400);
  });

  it('uses a short TTL when the range includes today', async () => {
    const { pool } = fakePool();
    const cache = new MemoryCacheStore();
    const setSpy = jest.spyOn(cache, 'set');
    await new MetricGateway(pool, cache, { now }).queryMetric({ ...query, to: '2026-03-31' });
    expect(setSpy).toHaveBeenCalledWith(expect.any(String), expect.any(String), 300);
  });

  it('caches named analysis tools too', async () => {
    const { pool, callTool } = fakePool();
    const gateway = new MetricGateway(pool, new MemoryCacheStore(), { now });
    await gateway.callTool('commerce', 'top_products', { from: '2026-01-01', to: '2026-01-31', limit: 10 });
    await gateway.callTool('commerce', 'top_products', { from: '2026-01-01', to: '2026-01-31', limit: 10 });
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('skips the cache for a tool marked as uncacheable', async () => {
    const { pool, callTool } = fakePool();
    const gateway = new MetricGateway(pool, new MemoryCacheStore(), { now });
    await gateway.callTool('commerce', 'failed_orders', {}, { cache: false });
    await gateway.callTool('commerce', 'failed_orders', {}, { cache: false });
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it('falls through to the pool when the cached payload is corrupt', async () => {
    const { pool, queryMetric } = fakePool();
    const cache = new MemoryCacheStore();
    await cache.set(cacheKeyFor(query), '{not json', 60);
    expect(await new MetricGateway(pool, cache, { now }).queryMetric(query)).toEqual(series);
    expect(queryMetric).toHaveBeenCalledTimes(1);
  });

  it('still answers when the cache backend is down', async () => {
    const { pool, queryMetric } = fakePool();
    const broken = {
      get: jest.fn(async () => { throw new Error('ECONNREFUSED'); }),
      set: jest.fn(async () => { throw new Error('ECONNREFUSED'); }),
    };
    expect(await new MetricGateway(pool, broken, { now }).queryMetric(query)).toEqual(series);
    expect(queryMetric).toHaveBeenCalledTimes(1);
  });

  it('resolves a batch preserving input order', async () => {
    const { pool } = fakePool();
    const gateway = new MetricGateway(pool, new MemoryCacheStore(), { now });
    const results = await gateway.queryBatch([query, { ...query, metricId: 'commerce.orders' }]);
    expect(results).toHaveLength(2);
    expect(results[0]?.metricId).toBe('commerce.revenue');
  });
});
```

- [ ] **Step 4: Implementar `cache.ts` e `gateway.ts`**

`packages/mcp-core/src/cache.ts`:

```ts
import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { MetricQuery, MetricSource } from '@center/shared';

export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export class MemoryCacheStore implements CacheStore {
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }
}

export class RedisCacheStore implements CacheStore {
  constructor(private readonly redis: Redis) {}

  get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value, 'EX', ttlSeconds);
  }
}

/** Ordena as chaves de todo objeto para que a serialização seja canônica. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonicalize(v)]),
    );
  }
  return value;
}

function digest(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(payload))).digest('hex').slice(0, 32);
}

/** `metric:v1:<orgId>:<hash>` — o `v1` permite invalidar tudo com um bump. */
export function cacheKeyFor(query: MetricQuery): string {
  const { tenant, ...rest } = query;
  return `metric:v1:${tenant.organizationId}:${digest({ ...rest, externalIds: tenant.externalIds })}`;
}

/**
 * O `tenant` é removido dos argumentos antes de gerar a chave: ele já está no
 * prefixo, e mantê-lo faria credenciais entrarem no hash sem necessidade.
 */
export function toolCacheKeyFor(
  source: MetricSource,
  name: string,
  args: Record<string, unknown>,
  organizationId: string,
): string {
  const { tenant: _omitted, ...rest } = args;
  return `tool:v1:${organizationId}:${source}:${name}:${digest(rest)}`;
}

/** Período que alcança hoje ainda está sendo escrito pelas fontes. */
export const SHORT_TTL_SECONDS = 300;
/** Período fechado no passado é imutável. */
export const LONG_TTL_SECONDS = 86_400;
```

`packages/mcp-core/src/gateway.ts`:

```ts
import {
  MetricSeriesSchema,
  type MetricDescriptor, type MetricQuery, type MetricSeries, type MetricSource,
} from '@center/shared';
import { LONG_TTL_SECONDS, SHORT_TTL_SECONDS, cacheKeyFor, toolCacheKeyFor, type CacheStore } from './cache.js';
import type { McpPool } from './pool.js';

export interface MetricGatewayOptions {
  now?: () => Date;
}

export interface CallToolOptions {
  /** `false` desliga o cache — use em ferramentas que listam registros voláteis. */
  cache?: boolean;
  /** Sobrescreve o TTL. Sem isto, a regra de "alcança hoje" decide. */
  ttlSeconds?: number;
  /** Necessário para escolher o TTL de ferramentas com período. */
  rangeEnd?: string;
}

/**
 * A única porta de entrada para dados no sistema. Dashboard e agente de IA
 * passam por aqui — é o que garante que não exista lógica de agregação
 * duplicada entre os dois consumidores.
 */
export class MetricGateway {
  private readonly now: () => Date;

  constructor(
    private readonly pool: McpPool,
    private readonly cache: CacheStore,
    options: MetricGatewayOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  listMetrics(): Promise<MetricDescriptor[]> {
    return this.pool.listMetrics();
  }

  async queryMetric(query: MetricQuery): Promise<MetricSeries> {
    const key = cacheKeyFor(query);

    // Falha de cache nunca derruba uma requisição: vira miss.
    try {
      const cached = await this.cache.get(key);
      if (cached !== null) return MetricSeriesSchema.parse(JSON.parse(cached));
    } catch {
      // segue para a origem
    }

    const series = await this.pool.queryMetric(query);

    try {
      await this.cache.set(key, JSON.stringify(series), this.ttlFor(query.to));
    } catch {
      // gravação é best-effort
    }

    return series;
  }

  /** Uma tela carrega vários KPIs de uma vez; isto evita N round-trips em série. */
  queryBatch(queries: MetricQuery[]): Promise<MetricSeries[]> {
    return Promise.all(queries.map((query) => this.queryMetric(query)));
  }

  async callTool<T>(
    source: MetricSource,
    name: string,
    args: Record<string, unknown>,
    options: CallToolOptions = {},
  ): Promise<T> {
    const organizationId =
      (args.tenant as { organizationId?: string } | undefined)?.organizationId ?? 'anon';

    if (options.cache === false) {
      return this.pool.callTool<T>(source, name, args);
    }

    const key = toolCacheKeyFor(source, name, args, organizationId);

    try {
      const cached = await this.cache.get(key);
      if (cached !== null) return JSON.parse(cached) as T;
    } catch {
      // segue para a origem
    }

    const payload = await this.pool.callTool<T>(source, name, args);

    try {
      const ttl = options.ttlSeconds
        ?? this.ttlFor(options.rangeEnd ?? (args.to as string | undefined));
      await this.cache.set(key, JSON.stringify(payload), ttl);
    } catch {
      // best-effort
    }

    return payload;
  }

  close(): Promise<void> {
    return this.pool.close();
  }

  /**
   * Um intervalo que alcança hoje ainda está sendo escrito pelas fontes, então
   * expira rápido. Um intervalo fechado no passado é imutável.
   */
  private ttlFor(rangeEnd: string | undefined): number {
    if (!rangeEnd) return SHORT_TTL_SECONDS;
    const today = this.now().toISOString().slice(0, 10);
    return rangeEnd >= today ? SHORT_TTL_SECONDS : LONG_TTL_SECONDS;
  }
}
```

Adicione a `packages/mcp-core/src/index.ts`:

```ts
export * from './pool.js';
export * from './cache.js';
export * from './gateway.js';
```

- [ ] **Step 5: Rodar os testes**

Run: `pnpm --filter @center/mcp-core test`
Expected: PASS — 4 suites, 36 testes.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-core
git commit -m "feat(mcp-core): add pool, tenant-scoped cache and metric gateway"
```

---

# FASE 3 — MCP Commerce (Sprints 4–5)

**Objetivo:** os Grupos A e C respondíveis. Ao fim desta fase, 20 das 39 perguntas funcionam via MCP Inspector, antes de existir dashboard ou bot.

**Regra que atravessa toda a fase — o que conta como venda.** Faturamento, ticket médio e ranking de produtos consideram **apenas** `statusGroup IN ('PAID','PROCESSING','SHIPPED','DELIVERED')`. Pedidos cancelados, falhos e aguardando pagamento **não são receita**. Isso está numa constante única (`REVENUE_STATUS_GROUPS`) usada por todas as consultas — se cada query decidisse por conta própria, o faturamento da dashboard e o do bot divergiriam e ninguém saberia qual está certo.

**Onde os testes entram:** cada ferramenta é testada contra um Postgres **real** (o do docker-compose), com dados semeados por um helper. Mockar o Prisma aqui testaria o mock, não o SQL — e o SQL é justamente onde mora o risco (janela de timezone, exclusão de status, divisão por zero no ticket médio).

---

### Task 12: Métricas de série do Commerce

**Files:**
- Create: `packages/mcp-commerce/{package.json,tsconfig.json,jest.config.cjs}`
- Create: `packages/mcp-commerce/src/{constants.ts,provider.ts,main.ts}`
- Create: `packages/mcp-commerce/src/__tests__/helpers/seed.ts`
- Test: `packages/mcp-commerce/src/__tests__/provider.test.ts`

**Interfaces:**
- Consumes: `MetricProvider`, `toSeries`, `SeriesRow`, `MetricNotFoundError` de `@center/mcp-core`; models Prisma da T4.
- Produces:
  - `REVENUE_STATUS_GROUPS: readonly OrderStatusGroup[]`
  - `BUSINESS_TIME_ZONE = 'America/Sao_Paulo'`
  - `createCommerceProvider(prisma: PrismaClient): MetricProvider`
  - Métricas: `commerce.revenue` (currency), `commerce.orders` (count), `commerce.average_ticket` (currency), `commerce.items_sold` (count), `commerce.new_customers` (count) — todas com dimensões `channel`, `paymentMethod`, `campaign`, `device`
  - `seedOrders(prisma, orders: SeedOrder[]): Promise<void>` (helper de teste)

- [ ] **Step 1: Criar o pacote**

`packages/mcp-commerce/package.json`:

```json
{
  "name": "@center/mcp-commerce",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/main.js",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "jest --runInBand",
    "start": "node dist/main.js"
  },
  "dependencies": {
    "@center/mcp-core": "workspace:*",
    "@center/shared": "workspace:*",
    "@prisma/client": "^6.1.0",
    "zod": "^3.24.1"
  }
}
```

`jest.config.cjs` — `--runInBand` porque os testes compartilham o mesmo banco:

```js
module.exports = {
  ...require('../../jest.preset.cjs'),
  maxWorkers: 1,
  testTimeout: 20_000,
};
```

`tsconfig.json` segue o molde da T1, Step 4.

- [ ] **Step 2: Escrever o helper de seed**

`packages/mcp-commerce/src/__tests__/helpers/seed.ts`:

```ts
import { PrismaClient } from '@prisma/client';

export const TEST_ORG = 'org_test_commerce';

export interface SeedItem {
  sku: string;
  productName: string;
  categoryName?: string | null;
  quantity: number;
  unitPriceCents: number;
}

export interface SeedOrder {
  numeroPedido: string;
  /** ISO local de São Paulo, ex.: '2026-01-15T10:00:00'. */
  emittedAtLocal: string;
  statusGroup: 'PAID' | 'PENDING_PAYMENT' | 'PROCESSING' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED' | 'FAILED' | 'OTHER';
  totalCents: number;
  customerExternalId?: string;
  paymentMethod?: string;
  canal?: string;
  campaign?: string | null;
  device?: string | null;
  visitorHash?: string | null;
  items?: SeedItem[];
}

export const prisma = new PrismaClient();

/** '2026-01-15T10:00:00' em São Paulo (UTC-3) → Date UTC. */
function toUtc(local: string): Date {
  return new Date(`${local}-03:00`);
}

export async function resetCommerceData(): Promise<void> {
  await prisma.commerceOrderItem.deleteMany({ where: { organizationId: TEST_ORG } });
  await prisma.commerceOrder.deleteMany({ where: { organizationId: TEST_ORG } });
  await prisma.commerceCustomer.deleteMany({ where: { organizationId: TEST_ORG } });
  await prisma.organization.upsert({
    where: { id: TEST_ORG },
    update: {},
    create: { id: TEST_ORG, name: 'Loja de Teste' },
  });
}

export async function seedOrders(orders: SeedOrder[]): Promise<void> {
  for (const order of orders) {
    const emittedAt = toUtc(order.emittedAtLocal);

    let customerId: string | null = null;
    if (order.customerExternalId) {
      const customer = await prisma.commerceCustomer.upsert({
        where: {
          organizationId_externalId: {
            organizationId: TEST_ORG, externalId: order.customerExternalId,
          },
        },
        create: {
          organizationId: TEST_ORG,
          externalId: order.customerExternalId,
          firstOrderAt: emittedAt,
          lastOrderAt: emittedAt,
        },
        update: {},
      });
      customerId = customer.id;
      // firstOrderAt é o mínimo entre o existente e este pedido.
      if (customer.firstOrderAt && emittedAt < customer.firstOrderAt) {
        await prisma.commerceCustomer.update({
          where: { id: customer.id }, data: { firstOrderAt: emittedAt },
        });
      }
    }

    const saved = await prisma.commerceOrder.create({
      data: {
        organizationId: TEST_ORG,
        numeroPedido: order.numeroPedido,
        idPedido: order.numeroPedido,
        statusLabel: order.statusGroup,
        statusId: 1,
        statusGroup: order.statusGroup,
        canal: order.canal ?? 'site',
        emittedAt,
        subtotalCents: order.totalCents,
        freightCents: 0,
        discountCents: 0,
        totalCents: order.totalCents,
        paymentMethod: order.paymentMethod ?? 'pix',
        customerId,
        attributionCampaign: order.campaign ?? null,
        attributionDevice: order.device ?? null,
        visitorHash: order.visitorHash ?? null,
        rawPayload: {},
      },
    });

    if (order.items?.length) {
      await prisma.commerceOrderItem.createMany({
        data: order.items.map((item) => ({
          organizationId: TEST_ORG,
          orderId: saved.id,
          sku: item.sku,
          productName: item.productName,
          categoryName: item.categoryName ?? null,
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents,
          totalPriceCents: item.unitPriceCents * item.quantity,
          emittedAt,
        })),
      });
    }
  }
}
```

- [ ] **Step 3: Escrever o teste do provider (falhando)**

`packages/mcp-commerce/src/__tests__/provider.test.ts`:

```ts
import type { MetricQuery } from '@center/shared';
import { createCommerceProvider } from '../provider.js';
import { prisma, resetCommerceData, seedOrders, TEST_ORG } from './helpers/seed.js';

const provider = createCommerceProvider(prisma);

const tenant = { organizationId: TEST_ORG, externalIds: {} };

function query(overrides: Partial<MetricQuery> = {}): MetricQuery {
  return {
    metricId: 'commerce.revenue',
    from: '2026-01-01', to: '2026-01-31', granularity: 'day', tenant,
    ...overrides,
  };
}

beforeAll(async () => {
  await resetCommerceData();
  await seedOrders([
    // 15/01: duas vendas válidas (R$ 100 + R$ 200)
    { numeroPedido: 'P1', emittedAtLocal: '2026-01-15T10:00:00', statusGroup: 'PAID',
      totalCents: 10000, customerExternalId: 'C1', paymentMethod: 'pix', campaign: 'black-friday', device: 'mobile',
      items: [{ sku: 'CAM-001', productName: 'Camiseta', categoryName: 'Vestuário', quantity: 2, unitPriceCents: 5000 }] },
    { numeroPedido: 'P2', emittedAtLocal: '2026-01-15T18:00:00', statusGroup: 'DELIVERED',
      totalCents: 20000, customerExternalId: 'C2', paymentMethod: 'cartao', campaign: 'black-friday', device: 'desktop',
      items: [{ sku: 'TEN-002', productName: 'Tênis', categoryName: 'Calçados', quantity: 1, unitPriceCents: 20000 }] },
    // 20/01: um cancelado e um aguardando — NÃO são receita
    { numeroPedido: 'P3', emittedAtLocal: '2026-01-20T10:00:00', statusGroup: 'CANCELLED',
      totalCents: 99999, customerExternalId: 'C3' },
    { numeroPedido: 'P4', emittedAtLocal: '2026-01-20T11:00:00', statusGroup: 'PENDING_PAYMENT',
      totalCents: 88888, customerExternalId: 'C4' },
    // 31/01 23:30 São Paulo — prova que a janela usa timezone de negócio
    { numeroPedido: 'P5', emittedAtLocal: '2026-01-31T23:30:00', statusGroup: 'PAID',
      totalCents: 5000, customerExternalId: 'C1' },
    // Fevereiro: fora da janela
    { numeroPedido: 'P6', emittedAtLocal: '2026-02-01T10:00:00', statusGroup: 'PAID',
      totalCents: 77777, customerExternalId: 'C5' },
  ]);
});

afterAll(async () => { await prisma.$disconnect(); });

describe('catálogo', () => {
  it('publishes the five commerce metrics', () => {
    expect(provider.descriptors.map((d) => d.id).sort()).toEqual([
      'commerce.average_ticket', 'commerce.items_sold',
      'commerce.new_customers', 'commerce.orders', 'commerce.revenue',
    ]);
  });

  it('declares revenue and average ticket in currency', () => {
    for (const id of ['commerce.revenue', 'commerce.average_ticket']) {
      expect(provider.descriptors.find((d) => d.id === id)?.unit).toBe('currency');
    }
  });
});

describe('commerce.revenue', () => {
  it('sums only sales-status orders, in cents', async () => {
    // P1 + P2 + P5 = 10000 + 20000 + 5000. P3/P4 excluídos, P6 fora da janela.
    expect((await provider.query(query())).total).toBe(35000);
  });

  it('buckets by the business timezone, not UTC', async () => {
    // P5 é 31/01 23:30 em São Paulo = 01/02 02:30 UTC. Precisa cair em 31/01.
    const series = await provider.query(query());
    expect(series.points.find((p) => p.date === '2026-01-31')?.value).toBe(5000);
  });

  it('fills days without sales with zero', async () => {
    const series = await provider.query(query());
    expect(series.points).toHaveLength(31);
    expect(series.points.find((p) => p.date === '2026-01-02')?.value).toBe(0);
  });

  it('collapses to a single point at month granularity', async () => {
    const series = await provider.query(query({ granularity: 'month' }));
    expect(series.points).toEqual([{ date: '2026-01-01', value: 35000 }]);
  });

  it('groups by payment method', async () => {
    const series = await provider.query(query({ to: '2026-01-15', groupBy: 'paymentMethod' }));
    expect(series.points.filter((p) => p.date === '2026-01-15')).toEqual([
      { date: '2026-01-15', value: 20000, group: 'cartao' },
      { date: '2026-01-15', value: 10000, group: 'pix' },
    ]);
  });

  it('filters by campaign', async () => {
    const series = await provider.query(query({ filters: { campaign: 'black-friday' } }));
    expect(series.total).toBe(30000); // P5 não tem campanha
  });

  it('returns zero for a range with no orders', async () => {
    expect((await provider.query(query({ from: '2025-01-01', to: '2025-01-31' }))).total).toBe(0);
  });

  it('never leaks another organization data', async () => {
    const series = await provider.query(query({
      tenant: { organizationId: 'org_outra', externalIds: {} },
    }));
    expect(series.total).toBe(0);
  });
});

describe('commerce.orders', () => {
  it('counts only sales-status orders', async () => {
    expect((await provider.query(query({ metricId: 'commerce.orders' }))).total).toBe(3);
  });
});

describe('commerce.average_ticket', () => {
  it('divides revenue by order count, in cents', async () => {
    // 35000 / 3 = 11666.67 → arredonda para 11667 centavos.
    const series = await provider.query(query({ metricId: 'commerce.average_ticket', granularity: 'month' }));
    expect(series.points[0]?.value).toBe(11667);
  });

  it('returns zero instead of dividing by zero on an empty day', async () => {
    const series = await provider.query(query({ metricId: 'commerce.average_ticket' }));
    expect(series.points.find((p) => p.date === '2026-01-02')?.value).toBe(0);
  });

  it('reports the period average as the total, not the sum of daily averages', async () => {
    // Somar médias diárias daria 15000+5000 = 20000, que não é o ticket médio.
    const series = await provider.query(query({ metricId: 'commerce.average_ticket' }));
    expect(series.total).toBe(11667);
  });
});

describe('commerce.items_sold', () => {
  it('sums item quantities of sales-status orders', async () => {
    // P1: 2 camisetas, P2: 1 tênis. P5 não tem itens.
    expect((await provider.query(query({ metricId: 'commerce.items_sold' }))).total).toBe(3);
  });
});

describe('commerce.new_customers', () => {
  it('counts customers whose first order falls in the window', async () => {
    // C1, C2, C3, C4 tiveram o primeiro pedido em janeiro. C5 em fevereiro.
    expect((await provider.query(query({ metricId: 'commerce.new_customers' }))).total).toBe(4);
  });

  it('does not count a returning customer twice', async () => {
    // C1 comprou em 15/01 e 31/01; conta uma vez, no dia do primeiro pedido.
    const series = await provider.query(query({ metricId: 'commerce.new_customers' }));
    expect(series.points.find((p) => p.date === '2026-01-31')?.value).toBe(0);
  });
});

describe('métrica desconhecida', () => {
  it('rejects an unknown metric id', async () => {
    await expect(provider.query(query({ metricId: 'commerce.inventado' })))
      .rejects.toThrow('métrica desconhecida');
  });
});
```

- [ ] **Step 4: Rodar e confirmar que falha**

Run: `pnpm --filter @center/mcp-commerce test`
Expected: FAIL — `Cannot find module '../provider.js'`.

- [ ] **Step 5: Implementar `constants.ts`**

`packages/mcp-commerce/src/constants.ts`:

```ts
import { Prisma } from '@prisma/client';

/**
 * O QUE CONTA COMO VENDA. Uma constante só, usada por toda consulta de receita.
 *
 * Cancelado, falho e aguardando pagamento NÃO são receita. Se cada query
 * decidisse isso por conta própria, o faturamento da dashboard e o do bot
 * divergiriam e ninguém saberia qual está certo.
 */
export const REVENUE_STATUS_GROUPS = [
  'PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED',
] as const;

export const BUSINESS_TIME_ZONE = 'America/Sao_Paulo';

/** Colunas do pedido que podem ser filtradas ou agrupadas. */
export const ORDER_DIMENSIONS: Record<string, string> = {
  channel: 'canal',
  paymentMethod: 'paymentMethod',
  campaign: 'attributionCampaign',
  source: 'attributionSource',
  device: 'attributionDevice',
  status: 'statusGroup',
};

export const ORDER_DIMENSION_NAMES = Object.keys(ORDER_DIMENSIONS);

/**
 * Trunca no fuso de negócio. Sem o `AT TIME ZONE`, um pedido das 23h30 de São
 * Paulo cairia no dia seguinte e "quanto vendemos hoje" mentiria toda noite.
 */
export function bucketExpression(granularity: 'day' | 'week' | 'month'): Prisma.Sql {
  const unit = granularity === 'day' ? 'day' : granularity === 'week' ? 'week' : 'month';
  return Prisma.sql`to_char(date_trunc(${unit}, o."emittedAt" AT TIME ZONE ${BUSINESS_TIME_ZONE}), 'YYYY-MM-DD')`;
}

/** Converte o range de datas de negócio nos instantes UTC correspondentes. */
export function rangeToUtc(from: string, to: string): { start: Date; end: Date } {
  return {
    start: new Date(`${from}T00:00:00-03:00`),
    // Fim exclusivo no dia seguinte: cobre 23:59:59.999 sem depender de precisão.
    end: new Date(new Date(`${to}T00:00:00-03:00`).getTime() + 24 * 60 * 60 * 1000),
  };
}

export function assertDimension(name: string): string {
  const column = ORDER_DIMENSIONS[name];
  if (!column) {
    throw new Error(
      `dimensão não suportada: "${name}". Disponíveis: ${ORDER_DIMENSION_NAMES.join(', ')}`,
    );
  }
  return column;
}
```

- [ ] **Step 6: Implementar `provider.ts`**

`packages/mcp-commerce/src/provider.ts`:

```ts
import { Prisma, type PrismaClient } from '@prisma/client';
import type { MetricDescriptor, MetricQuery, MetricSeries, MetricUnit } from '@center/shared';
import { MetricNotFoundError, toSeries, type MetricProvider, type SeriesRow } from '@center/mcp-core';
import {
  REVENUE_STATUS_GROUPS, assertDimension, bucketExpression, rangeToUtc,
  ORDER_DIMENSION_NAMES,
} from './constants.js';

const DESCRIPTORS: MetricDescriptor[] = [
  {
    id: 'commerce.revenue', label: 'Faturamento',
    description: 'Receita dos pedidos com status de venda (pago, em separação, enviado, entregue), em centavos. Exclui cancelados, falhos e aguardando pagamento.',
    source: 'commerce', unit: 'currency', dimensions: ORDER_DIMENSION_NAMES,
  },
  {
    id: 'commerce.orders', label: 'Pedidos',
    description: 'Quantidade de pedidos com status de venda.',
    source: 'commerce', unit: 'count', dimensions: ORDER_DIMENSION_NAMES,
  },
  {
    id: 'commerce.average_ticket', label: 'Ticket médio',
    description: 'Faturamento dividido pela quantidade de pedidos no bucket, em centavos.',
    source: 'commerce', unit: 'currency', dimensions: ORDER_DIMENSION_NAMES,
  },
  {
    id: 'commerce.items_sold', label: 'Itens vendidos',
    description: 'Soma das quantidades dos itens dos pedidos com status de venda.',
    source: 'commerce', unit: 'count', dimensions: ORDER_DIMENSION_NAMES,
  },
  {
    id: 'commerce.new_customers', label: 'Clientes novos',
    description: 'Clientes cujo primeiro pedido caiu no período.',
    source: 'commerce', unit: 'count', dimensions: [],
  },
];

const UNITS: Record<string, MetricUnit> = {
  'commerce.revenue': 'currency',
  'commerce.orders': 'count',
  'commerce.average_ticket': 'currency',
  'commerce.items_sold': 'count',
  'commerce.new_customers': 'count',
};

function statusFilter(): Prisma.Sql {
  return Prisma.sql`o."statusGroup"::text IN (${Prisma.join(REVENUE_STATUS_GROUPS)})`;
}

function dimensionFilters(query: MetricQuery): Prisma.Sql {
  const clauses = Object.entries(query.filters ?? {}).map(([name, value]) =>
    Prisma.sql`AND o.${Prisma.raw(`"${assertDimension(name)}"`)} = ${value}`);
  return clauses.length > 0 ? Prisma.join(clauses, ' ') : Prisma.empty;
}

function groupExpression(query: MetricQuery): Prisma.Sql {
  return query.groupBy
    ? Prisma.sql`o.${Prisma.raw(`"${assertDimension(query.groupBy)}"`)}`
    : Prisma.sql`NULL::text`;
}

interface RawRow { bucket: string; value: bigint | number | string; grp: string | null }

function toSeriesRows(rows: RawRow[]): SeriesRow[] {
  return rows.map((row) => ({
    date: row.bucket,
    value: Number(row.value),
    group: row.grp,
  }));
}

export function createCommerceProvider(prisma: PrismaClient): MetricProvider {
  return {
    descriptors: DESCRIPTORS,

    async query(query: MetricQuery): Promise<MetricSeries> {
      const unit = UNITS[query.metricId];
      if (!unit) throw new MetricNotFoundError(query.metricId);

      const { start, end } = rangeToUtc(query.from, query.to);
      const bucket = bucketExpression(query.granularity);
      const group = groupExpression(query);
      const filters = dimensionFilters(query);
      const orgId = query.tenant.organizationId;

      // Clientes novos não passam pela tabela de pedidos — a data relevante é
      // `firstOrderAt` do cliente, e agrupar por dimensão de pedido não faz sentido.
      if (query.metricId === 'commerce.new_customers') {
        const customerBucket = Prisma.sql`to_char(date_trunc(${
          query.granularity === 'day' ? 'day' : query.granularity === 'week' ? 'week' : 'month'
        }, c."firstOrderAt" AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM-DD')`;

        const rows = await prisma.$queryRaw<RawRow[]>(Prisma.sql`
          SELECT ${customerBucket} AS bucket, COUNT(*)::bigint AS value, NULL::text AS grp
          FROM "CommerceCustomer" c
          WHERE c."organizationId" = ${orgId}
            AND c."firstOrderAt" >= ${start} AND c."firstOrderAt" < ${end}
          GROUP BY 1
        `);
        return toSeries(toSeriesRows(rows), query, unit, 'commerce');
      }

      if (query.metricId === 'commerce.items_sold') {
        const itemBucket = Prisma.sql`to_char(date_trunc(${
          query.granularity === 'day' ? 'day' : query.granularity === 'week' ? 'week' : 'month'
        }, i."emittedAt" AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM-DD')`;

        const rows = await prisma.$queryRaw<RawRow[]>(Prisma.sql`
          SELECT ${itemBucket} AS bucket, SUM(i."quantity")::bigint AS value, ${group} AS grp
          FROM "CommerceOrderItem" i
          JOIN "CommerceOrder" o ON o."id" = i."orderId"
          WHERE i."organizationId" = ${orgId}
            AND i."emittedAt" >= ${start} AND i."emittedAt" < ${end}
            AND ${statusFilter()}
            ${filters}
          GROUP BY 1, 3
        `);
        return toSeries(toSeriesRows(rows), query, unit, 'commerce');
      }

      // O ticket médio é razão, não soma: precisa ser calculado POR BUCKET.
      // Somar médias diárias daria um número sem significado.
      const valueExpression =
        query.metricId === 'commerce.revenue'
          ? Prisma.sql`SUM(o."totalCents")::bigint`
          : query.metricId === 'commerce.orders'
            ? Prisma.sql`COUNT(*)::bigint`
            : Prisma.sql`ROUND(SUM(o."totalCents")::numeric / NULLIF(COUNT(*), 0))::bigint`;

      const rows = await prisma.$queryRaw<RawRow[]>(Prisma.sql`
        SELECT ${bucket} AS bucket, ${valueExpression} AS value, ${group} AS grp
        FROM "CommerceOrder" o
        WHERE o."organizationId" = ${orgId}
          AND o."emittedAt" >= ${start} AND o."emittedAt" < ${end}
          AND ${statusFilter()}
          ${filters}
        GROUP BY 1, 3
      `);

      const series = toSeries(toSeriesRows(rows), query, unit, 'commerce');

      // O total de uma razão é a razão do período inteiro, não a soma dos buckets.
      if (query.metricId === 'commerce.average_ticket') {
        const [aggregate] = await prisma.$queryRaw<Array<{ revenue: bigint | null; orders: bigint }>>(Prisma.sql`
          SELECT SUM(o."totalCents")::bigint AS revenue, COUNT(*)::bigint AS orders
          FROM "CommerceOrder" o
          WHERE o."organizationId" = ${orgId}
            AND o."emittedAt" >= ${start} AND o."emittedAt" < ${end}
            AND ${statusFilter()}
            ${filters}
        `);
        const orders = Number(aggregate?.orders ?? 0);
        return {
          ...series,
          total: orders === 0 ? 0 : Math.round(Number(aggregate?.revenue ?? 0) / orders),
        };
      }

      return series;
    },
  };
}
```

- [ ] **Step 7: Rodar os testes**

```bash
docker compose up -d
cd apps/api && pnpm prisma migrate deploy && cd ../..
pnpm --filter @center/mcp-commerce test
```

Expected: PASS — 21 testes.

- [ ] **Step 8: Commit**

```bash
git add packages/mcp-commerce
git commit -m "feat(mcp-commerce): add revenue, orders, ticket, items and new customer metrics"
```

---

### Task 13: Ferramentas de status, falhas e pagamento

**Files:**
- Create: `packages/mcp-commerce/src/status.ts`
- Test: `packages/mcp-commerce/src/__tests__/status.test.ts`

**Interfaces:**
- Consumes: `AnalysisTool` de `@center/mcp-core`; constantes da T12.
- Produces:
  - `createOrdersByStatusTool(prisma): AnalysisTool` — `orders_by_status` → `{ from, to, groups: Array<{ group, label, orders, revenueCents, share }> }`
  - `createFailedOrdersTool(prisma): AnalysisTool` — `failed_orders` → `{ from, to, total, orders: Array<{ numeroPedido, statusLabel, emittedAt, totalCents, paymentMethod }> }`
  - `createPaymentMethodTool(prisma): AnalysisTool` — `payment_method_performance` → `{ from, to, methods: Array<{ method, paidOrders, failedOrders, conversionRate, revenueCents, averageTicketCents }> }`
  - `STATUS_LABELS: Record<OrderStatusGroup, string>`

**Responde:** A4 (cancelados), A5 (aguardando pagamento), A6 (compras falharam), A12 (método que converte mais).

- [ ] **Step 1: Escrever o teste (falhando)**

`packages/mcp-commerce/src/__tests__/status.test.ts`:

```ts
import { createFailedOrdersTool, createOrdersByStatusTool, createPaymentMethodTool } from '../status.js';
import { prisma, resetCommerceData, seedOrders, TEST_ORG } from './helpers/seed.js';

const tenant = { organizationId: TEST_ORG, externalIds: {} };
const period = { from: '2026-01-01', to: '2026-01-31', tenant };

beforeAll(async () => {
  await resetCommerceData();
  await seedOrders([
    { numeroPedido: 'P1', emittedAtLocal: '2026-01-10T10:00:00', statusGroup: 'PAID', totalCents: 10000, paymentMethod: 'pix' },
    { numeroPedido: 'P2', emittedAtLocal: '2026-01-11T10:00:00', statusGroup: 'PAID', totalCents: 30000, paymentMethod: 'pix' },
    { numeroPedido: 'P3', emittedAtLocal: '2026-01-12T10:00:00', statusGroup: 'DELIVERED', totalCents: 20000, paymentMethod: 'cartao' },
    { numeroPedido: 'P4', emittedAtLocal: '2026-01-13T10:00:00', statusGroup: 'CANCELLED', totalCents: 15000, paymentMethod: 'cartao' },
    { numeroPedido: 'P5', emittedAtLocal: '2026-01-14T10:00:00', statusGroup: 'CANCELLED', totalCents: 5000, paymentMethod: 'boleto' },
    { numeroPedido: 'P6', emittedAtLocal: '2026-01-15T10:00:00', statusGroup: 'PENDING_PAYMENT', totalCents: 8000, paymentMethod: 'boleto' },
    { numeroPedido: 'P7', emittedAtLocal: '2026-01-16T09:00:00', statusGroup: 'FAILED', totalCents: 12000, paymentMethod: 'cartao' },
    { numeroPedido: 'P8', emittedAtLocal: '2026-01-17T09:00:00', statusGroup: 'FAILED', totalCents: 4000, paymentMethod: 'cartao' },
    // Fora da janela
    { numeroPedido: 'P9', emittedAtLocal: '2026-02-05T10:00:00', statusGroup: 'CANCELLED', totalCents: 99999 },
  ]);
});

afterAll(async () => { await prisma.$disconnect(); });

describe('orders_by_status', () => {
  const tool = createOrdersByStatusTool(prisma);

  it('is named orders_by_status', () => {
    expect(tool.name).toBe('orders_by_status');
  });

  it('counts orders and revenue per status group', async () => {
    const result = await tool.handler(period) as { groups: Array<Record<string, unknown>> };
    const byGroup = Object.fromEntries(result.groups.map((g) => [g.group, g]));

    expect(byGroup.PAID).toMatchObject({ orders: 2, revenueCents: 40000 });
    expect(byGroup.DELIVERED).toMatchObject({ orders: 1, revenueCents: 20000 });
    expect(byGroup.CANCELLED).toMatchObject({ orders: 2, revenueCents: 20000 });
    expect(byGroup.PENDING_PAYMENT).toMatchObject({ orders: 1 });
    expect(byGroup.FAILED).toMatchObject({ orders: 2 });
  });

  it('attaches a Portuguese label to every group', async () => {
    const result = await tool.handler(period) as { groups: Array<Record<string, unknown>> };
    expect(result.groups.find((g) => g.group === 'PENDING_PAYMENT')?.label).toBe('Aguardando pagamento');
    expect(result.groups.find((g) => g.group === 'CANCELLED')?.label).toBe('Cancelado');
  });

  it('computes each share of the total order count', async () => {
    const result = await tool.handler(period) as { groups: Array<{ share: number }> };
    const sum = result.groups.reduce((acc, g) => acc + g.share, 0);
    expect(sum).toBeCloseTo(1, 5);
  });

  it('sorts by order count descending', async () => {
    const result = await tool.handler(period) as { groups: Array<{ orders: number }> };
    const counts = result.groups.map((g) => g.orders);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  it('excludes orders outside the window', async () => {
    const result = await tool.handler(period) as { groups: Array<{ group: string; orders: number }> };
    expect(result.groups.find((g) => g.group === 'CANCELLED')?.orders).toBe(2);
  });

  it('returns an empty group list for a period with no orders', async () => {
    const result = await tool.handler({ ...period, from: '2025-01-01', to: '2025-01-31' }) as { groups: unknown[] };
    expect(result.groups).toEqual([]);
  });
});

describe('failed_orders', () => {
  const tool = createFailedOrdersTool(prisma);

  it('returns only FAILED orders, most recent first', async () => {
    const result = await tool.handler(period) as { total: number; orders: Array<{ numeroPedido: string }> };
    expect(result.total).toBe(2);
    expect(result.orders.map((o) => o.numeroPedido)).toEqual(['P8', 'P7']);
  });

  it('respects the limit', async () => {
    const result = await tool.handler({ ...period, limit: 1 }) as { orders: unknown[]; total: number };
    expect(result.orders).toHaveLength(1);
    // O total continua sendo o total real, não o tamanho da página.
    expect(result.total).toBe(2);
  });

  it('exposes no personal data about the customer', async () => {
    const result = await tool.handler(period);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/@/);
    expect(serialized).not.toMatch(/emailHash|documentHash/);
  });
});

describe('payment_method_performance', () => {
  const tool = createPaymentMethodTool(prisma);

  it('computes conversion per payment method', async () => {
    const result = await tool.handler(period) as { methods: Array<Record<string, number | string>> };
    const byMethod = Object.fromEntries(result.methods.map((m) => [m.method, m]));

    // pix: 2 pagos, 0 falhos → 100%
    expect(byMethod.pix).toMatchObject({ paidOrders: 2, failedOrders: 0, conversionRate: 1 });
    // cartao: 1 pago (P3 DELIVERED), 2 falhos (P7,P8) — P4 é cancelado, não falha
    expect(byMethod.cartao).toMatchObject({ paidOrders: 1, failedOrders: 2 });
    expect(byMethod.cartao?.conversionRate).toBeCloseTo(1 / 3, 5);
  });

  it('reports revenue and average ticket per method', async () => {
    const result = await tool.handler(period) as { methods: Array<Record<string, number | string>> };
    const pix = result.methods.find((m) => m.method === 'pix');
    expect(pix).toMatchObject({ revenueCents: 40000, averageTicketCents: 20000 });
  });

  it('sorts by conversion rate descending', async () => {
    const result = await tool.handler(period) as { methods: Array<{ conversionRate: number }> };
    const rates = result.methods.map((m) => m.conversionRate);
    expect([...rates].sort((a, b) => b - a)).toEqual(rates);
  });

  it('does not divide by zero for a method with no attempts in the window', async () => {
    const result = await tool.handler({ ...period, from: '2025-01-01', to: '2025-01-31' }) as { methods: unknown[] };
    expect(result.methods).toEqual([]);
  });
});
```

- [ ] **Step 2: Implementar `status.ts`**

`packages/mcp-commerce/src/status.ts`:

```ts
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { IsoDateSchema, TenantContextSchema } from '@center/shared';
import type { AnalysisTool } from '@center/mcp-core';
import { REVENUE_STATUS_GROUPS, rangeToUtc } from './constants.js';

export const STATUS_LABELS: Record<string, string> = {
  PAID: 'Pago',
  PENDING_PAYMENT: 'Aguardando pagamento',
  PROCESSING: 'Em separação',
  SHIPPED: 'Enviado',
  DELIVERED: 'Entregue',
  CANCELLED: 'Cancelado',
  FAILED: 'Falhou',
  OTHER: 'Outro',
};

const PeriodInput = {
  from: IsoDateSchema,
  to: IsoDateSchema,
  tenant: TenantContextSchema,
};

const PeriodSchema = z.object({ from: IsoDateSchema, to: IsoDateSchema, tenant: TenantContextSchema });

export function createOrdersByStatusTool(prisma: PrismaClient): AnalysisTool {
  return {
    name: 'orders_by_status',
    description:
      'Quantidade de pedidos e valor por situação (pago, aguardando pagamento, cancelado, ' +
      'falhou, entregue…) no período. Use para "quantos pedidos foram cancelados" e ' +
      '"quantos aguardam pagamento".',
    inputSchema: PeriodInput,
    outputSchema: {
      from: z.string(), to: z.string(),
      groups: z.array(z.object({
        group: z.string(), label: z.string(),
        orders: z.number(), revenueCents: z.number(), share: z.number(),
      })),
    },
    handler: async (args) => {
      const { from, to, tenant } = PeriodSchema.parse(args);
      const { start, end } = rangeToUtc(from, to);

      const rows = await prisma.$queryRaw<Array<{ status_group: string; orders: bigint; revenue: bigint | null }>>(Prisma.sql`
        SELECT o."statusGroup"::text AS status_group,
               COUNT(*)::bigint AS orders,
               SUM(o."totalCents")::bigint AS revenue
        FROM "CommerceOrder" o
        WHERE o."organizationId" = ${tenant.organizationId}
          AND o."emittedAt" >= ${start} AND o."emittedAt" < ${end}
        GROUP BY 1
        ORDER BY 2 DESC
      `);

      const totalOrders = rows.reduce((acc, row) => acc + Number(row.orders), 0);

      return {
        from, to,
        groups: rows.map((row) => ({
          group: row.status_group,
          label: STATUS_LABELS[row.status_group] ?? row.status_group,
          orders: Number(row.orders),
          revenueCents: Number(row.revenue ?? 0),
          share: totalOrders === 0 ? 0 : Number(row.orders) / totalOrders,
        })),
      };
    },
  };
}

export function createFailedOrdersTool(prisma: PrismaClient): AnalysisTool {
  const InputSchema = PeriodSchema.extend({ limit: z.number().int().min(1).max(50).default(10) });

  return {
    name: 'failed_orders',
    description:
      'Lista os pedidos cuja compra falhou (pagamento recusado, não autorizado, estornado) ' +
      'no período, do mais recente para o mais antigo. Não expõe dados do cliente.',
    inputSchema: { ...PeriodInput, limit: z.number().optional() },
    outputSchema: {
      from: z.string(), to: z.string(), total: z.number(),
      orders: z.array(z.object({
        numeroPedido: z.string(), statusLabel: z.string(),
        emittedAt: z.string(), totalCents: z.number(), paymentMethod: z.string().nullable(),
      })),
    },
    handler: async (args) => {
      const { from, to, tenant, limit } = InputSchema.parse(args);
      const { start, end } = rangeToUtc(from, to);

      const where = {
        organizationId: tenant.organizationId,
        statusGroup: 'FAILED' as const,
        emittedAt: { gte: start, lt: end },
      };

      const [total, orders] = await Promise.all([
        prisma.commerceOrder.count({ where }),
        prisma.commerceOrder.findMany({
          where,
          orderBy: { emittedAt: 'desc' },
          take: limit,
          // Seleção explícita: nada de cliente entra na resposta.
          select: {
            numeroPedido: true, statusLabel: true, emittedAt: true,
            totalCents: true, paymentMethod: true,
          },
        }),
      ]);

      return {
        from, to, total,
        orders: orders.map((order) => ({
          numeroPedido: order.numeroPedido,
          statusLabel: order.statusLabel,
          emittedAt: order.emittedAt.toISOString(),
          totalCents: order.totalCents,
          paymentMethod: order.paymentMethod,
        })),
      };
    },
  };
}

export function createPaymentMethodTool(prisma: PrismaClient): AnalysisTool {
  return {
    name: 'payment_method_performance',
    description:
      'Compara os métodos de pagamento por taxa de conversão (pedidos concluídos sobre ' +
      'tentativas), faturamento e ticket médio. Use para "qual método de pagamento converte mais".',
    inputSchema: PeriodInput,
    outputSchema: {
      from: z.string(), to: z.string(),
      methods: z.array(z.object({
        method: z.string(), paidOrders: z.number(), failedOrders: z.number(),
        conversionRate: z.number(), revenueCents: z.number(), averageTicketCents: z.number(),
      })),
    },
    handler: async (args) => {
      const { from, to, tenant } = PeriodSchema.parse(args);
      const { start, end } = rangeToUtc(from, to);

      // Conversão = concluídos / (concluídos + falhos). Cancelamentos ficam de
      // fora: cancelar é decisão do cliente, não falha do meio de pagamento.
      const rows = await prisma.$queryRaw<Array<{
        method: string | null; paid: bigint; failed: bigint; revenue: bigint | null;
      }>>(Prisma.sql`
        SELECT o."paymentMethod" AS method,
               COUNT(*) FILTER (WHERE o."statusGroup"::text IN (${Prisma.join(REVENUE_STATUS_GROUPS)}))::bigint AS paid,
               COUNT(*) FILTER (WHERE o."statusGroup"::text = 'FAILED')::bigint AS failed,
               SUM(o."totalCents") FILTER (WHERE o."statusGroup"::text IN (${Prisma.join(REVENUE_STATUS_GROUPS)}))::bigint AS revenue
        FROM "CommerceOrder" o
        WHERE o."organizationId" = ${tenant.organizationId}
          AND o."emittedAt" >= ${start} AND o."emittedAt" < ${end}
          AND o."paymentMethod" IS NOT NULL
        GROUP BY 1
      `);

      const methods = rows.map((row) => {
        const paid = Number(row.paid);
        const failed = Number(row.failed);
        const attempts = paid + failed;
        const revenue = Number(row.revenue ?? 0);
        return {
          method: row.method ?? 'desconhecido',
          paidOrders: paid,
          failedOrders: failed,
          conversionRate: attempts === 0 ? 0 : paid / attempts,
          revenueCents: revenue,
          averageTicketCents: paid === 0 ? 0 : Math.round(revenue / paid),
        };
      });

      methods.sort((a, b) => b.conversionRate - a.conversionRate);
      return { from, to, methods };
    },
  };
}
```

- [ ] **Step 3: Rodar os testes**

Run: `pnpm --filter @center/mcp-commerce test`
Expected: PASS — 34 testes.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp-commerce
git commit -m "feat(mcp-commerce): add status, failed orders and payment method tools"
```

---

### Task 14: Rankings de produtos e categorias

**Files:**
- Create: `packages/mcp-commerce/src/rankings.ts`
- Test: `packages/mcp-commerce/src/__tests__/rankings.test.ts`

**Interfaces:**
- Consumes: `AnalysisTool` de `@center/mcp-core`; `RankingResult`, `ComparisonResult` de `@center/shared`; constantes da T12.
- Produces:
  - `createTopProductsTool(prisma): AnalysisTool` — `top_products` → `RankingResult`
  - `createTopCategoriesTool(prisma): AnalysisTool` — `top_categories` → `RankingResult`
  - `createCompareProductsTool(prisma): AnalysisTool` — `compare_products` → `ComparisonResult`

**Responde:** A7 (produto mais vendeu), A8 (produto caiu mais), A9 (categoria mais vendeu).

- [ ] **Step 1: Escrever o teste (falhando)**

`packages/mcp-commerce/src/__tests__/rankings.test.ts`:

```ts
import { createCompareProductsTool, createTopCategoriesTool, createTopProductsTool } from '../rankings.js';
import { prisma, resetCommerceData, seedOrders, TEST_ORG } from './helpers/seed.js';

const tenant = { organizationId: TEST_ORG, externalIds: {} };

beforeAll(async () => {
  await resetCommerceData();
  await seedOrders([
    { numeroPedido: 'J1', emittedAtLocal: '2026-01-10T10:00:00', statusGroup: 'PAID', totalCents: 30000,
      items: [
        { sku: 'CAM', productName: 'Camiseta', categoryName: 'Vestuário', quantity: 4, unitPriceCents: 5000 },
        { sku: 'MEI', productName: 'Meia', categoryName: 'Vestuário', quantity: 2, unitPriceCents: 5000 },
      ] },
    { numeroPedido: 'J2', emittedAtLocal: '2026-01-20T10:00:00', statusGroup: 'DELIVERED', totalCents: 20000,
      items: [{ sku: 'TEN', productName: 'Tênis', categoryName: 'Calçados', quantity: 1, unitPriceCents: 20000 }] },
    // Cancelado: não pode aparecer em ranking de vendas
    { numeroPedido: 'J3', emittedAtLocal: '2026-01-25T10:00:00', statusGroup: 'CANCELLED', totalCents: 99999,
      items: [{ sku: 'CAM', productName: 'Camiseta', categoryName: 'Vestuário', quantity: 50, unitPriceCents: 5000 }] },
    // Fevereiro: camiseta cai, tênis sobe
    { numeroPedido: 'F1', emittedAtLocal: '2026-02-10T10:00:00', statusGroup: 'PAID', totalCents: 5000,
      items: [{ sku: 'CAM', productName: 'Camiseta', categoryName: 'Vestuário', quantity: 1, unitPriceCents: 5000 }] },
    { numeroPedido: 'F2', emittedAtLocal: '2026-02-15T10:00:00', statusGroup: 'PAID', totalCents: 60000,
      items: [{ sku: 'TEN', productName: 'Tênis', categoryName: 'Calçados', quantity: 3, unitPriceCents: 20000 }] },
  ]);
});

afterAll(async () => { await prisma.$disconnect(); });

const january = { from: '2026-01-01', to: '2026-01-31', tenant };

describe('top_products', () => {
  const tool = createTopProductsTool(prisma);

  it('ranks by revenue in cents by default', async () => {
    const result = await tool.handler(january) as { rows: Array<{ key: string; value: number }> };
    expect(result.rows.map((r) => [r.key, r.value])).toEqual([
      ['CAM', 20000], ['TEN', 20000], ['MEI', 10000],
    ].sort((a, b) => (b[1] as number) - (a[1] as number)));
  });

  it('ranks by quantity when asked', async () => {
    const result = await tool.handler({ ...january, orderBy: 'quantity' }) as { rows: Array<{ key: string; value: number }> };
    expect(result.rows[0]).toMatchObject({ key: 'CAM', value: 4 });
  });

  it('excludes cancelled orders from the ranking', async () => {
    // J3 tem 50 camisetas canceladas; se entrassem, CAM lideraria com folga.
    const result = await tool.handler({ ...january, orderBy: 'quantity' }) as { rows: Array<{ value: number }> };
    expect(result.rows[0]?.value).toBe(4);
  });

  it('carries the product name as the label', async () => {
    const result = await tool.handler(january) as { rows: Array<{ key: string; label: string }> };
    expect(result.rows.find((r) => r.key === 'TEN')?.label).toBe('Tênis');
  });

  it('reports quantity and order count as extra metrics', async () => {
    const result = await tool.handler(january) as { rows: Array<{ key: string; extra: Record<string, number> }> };
    expect(result.rows.find((r) => r.key === 'CAM')?.extra).toMatchObject({ quantity: 4, orders: 1 });
  });

  it('computes each share of the period total', async () => {
    const result = await tool.handler(january) as { total: number; rows: Array<{ share: number }> };
    expect(result.rows.reduce((acc, r) => acc + r.share, 0)).toBeCloseTo(1, 5);
    expect(result.total).toBe(50000);
  });

  it('respects the limit', async () => {
    const result = await tool.handler({ ...january, limit: 2 }) as { rows: unknown[] };
    expect(result.rows).toHaveLength(2);
  });

  it('returns an empty ranking for a period with no sales', async () => {
    const result = await tool.handler({ ...january, from: '2025-01-01', to: '2025-01-31' }) as { rows: unknown[]; total: number };
    expect(result.rows).toEqual([]);
    expect(result.total).toBe(0);
  });
});

describe('top_categories', () => {
  const tool = createTopCategoriesTool(prisma);

  it('aggregates items by category', async () => {
    const result = await tool.handler(january) as { rows: Array<{ key: string; value: number }> };
    const byKey = Object.fromEntries(result.rows.map((r) => [r.key, r.value]));
    expect(byKey['Vestuário']).toBe(30000); // camiseta 20000 + meia 10000
    expect(byKey['Calçados']).toBe(20000);
  });

  it('sorts by revenue descending', async () => {
    const result = await tool.handler(january) as { rows: Array<{ key: string }> };
    expect(result.rows[0]?.key).toBe('Vestuário');
  });

  it('groups items with no category under a visible placeholder', async () => {
    await seedOrders([{
      numeroPedido: 'SC1', emittedAtLocal: '2026-01-28T10:00:00', statusGroup: 'PAID', totalCents: 1000,
      items: [{ sku: 'X', productName: 'Sem categoria', categoryName: null, quantity: 1, unitPriceCents: 1000 }],
    }]);
    const result = await tool.handler(january) as { rows: Array<{ key: string }> };
    expect(result.rows.map((r) => r.key)).toContain('Sem categoria');
  });
});

describe('compare_products', () => {
  const tool = createCompareProductsTool(prisma);

  const comparison = {
    tenant,
    periodA: { from: '2026-01-01', to: '2026-01-31' },
    periodB: { from: '2026-02-01', to: '2026-02-28' },
  };

  it('reports the delta between the two periods', async () => {
    const result = await tool.handler(comparison) as { rows: Array<{ key: string; valueA: number; valueB: number; delta: number }> };
    const cam = result.rows.find((r) => r.key === 'CAM');
    expect(cam).toMatchObject({ valueA: 20000, valueB: 5000, delta: -15000 });
  });

  it('sorts by the biggest drop first so the answer is at the top', async () => {
    const result = await tool.handler(comparison) as { rows: Array<{ key: string }> };
    expect(result.rows[0]?.key).toBe('CAM');
  });

  it('computes the percentage change', async () => {
    const result = await tool.handler(comparison) as { rows: Array<{ key: string; deltaRatio: number | null }> };
    expect(result.rows.find((r) => r.key === 'CAM')?.deltaRatio).toBeCloseTo(-0.75, 5);
  });

  it('reports a null ratio for a product that did not sell in period A', async () => {
    await seedOrders([{
      numeroPedido: 'NOVO', emittedAtLocal: '2026-02-20T10:00:00', statusGroup: 'PAID', totalCents: 7000,
      items: [{ sku: 'NEW', productName: 'Lançamento', quantity: 1, unitPriceCents: 7000 }],
    }]);
    const result = await tool.handler(comparison) as { rows: Array<{ key: string; deltaRatio: number | null; valueA: number }> };
    const novo = result.rows.find((r) => r.key === 'NEW');
    expect(novo?.valueA).toBe(0);
    expect(novo?.deltaRatio).toBeNull();
  });

  it('includes products present in only one of the periods', async () => {
    const result = await tool.handler(comparison) as { rows: Array<{ key: string }> };
    expect(result.rows.map((r) => r.key)).toEqual(expect.arrayContaining(['MEI', 'NEW']));
  });
});
```

- [ ] **Step 2: Implementar `rankings.ts`**

`packages/mcp-commerce/src/rankings.ts`:

```ts
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { IsoDateSchema, TenantContextSchema } from '@center/shared';
import type { AnalysisTool } from '@center/mcp-core';
import { REVENUE_STATUS_GROUPS, rangeToUtc } from './constants.js';

const NO_CATEGORY = 'Sem categoria';

const RankingInputSchema = z.object({
  from: IsoDateSchema,
  to: IsoDateSchema,
  tenant: TenantContextSchema,
  limit: z.number().int().min(1).max(50).default(10),
  orderBy: z.enum(['revenue', 'quantity']).default('revenue'),
});

const RankingInputShape = {
  from: IsoDateSchema,
  to: IsoDateSchema,
  tenant: TenantContextSchema,
  limit: z.number().optional(),
  orderBy: z.enum(['revenue', 'quantity']).optional(),
};

const RankingOutputShape = {
  dimension: z.string(), from: z.string(), to: z.string(),
  total: z.number(), unit: z.string(),
  rows: z.array(z.object({
    key: z.string(), label: z.string(), value: z.number(),
    unit: z.string(), extra: z.record(z.string(), z.number()), share: z.number(),
  })),
};

interface AggregateRow {
  key: string | null;
  label: string | null;
  revenue: bigint | null;
  quantity: bigint | null;
  orders: bigint;
}

/** Agrega itens vendidos por SKU ou por categoria no período. */
function aggregateItems(
  prisma: PrismaClient,
  organizationId: string,
  start: Date,
  end: Date,
  by: 'sku' | 'category',
): Promise<AggregateRow[]> {
  const keyExpression = by === 'sku'
    ? Prisma.sql`i."sku"`
    : Prisma.sql`COALESCE(i."categoryName", ${NO_CATEGORY})`;
  const labelExpression = by === 'sku'
    ? Prisma.sql`MIN(i."productName")`
    : Prisma.sql`COALESCE(i."categoryName", ${NO_CATEGORY})`;

  return prisma.$queryRaw<AggregateRow[]>(Prisma.sql`
    SELECT ${keyExpression} AS key,
           ${labelExpression} AS label,
           SUM(i."totalPriceCents")::bigint AS revenue,
           SUM(i."quantity")::bigint AS quantity,
           COUNT(DISTINCT i."orderId")::bigint AS orders
    FROM "CommerceOrderItem" i
    JOIN "CommerceOrder" o ON o."id" = i."orderId"
    WHERE i."organizationId" = ${organizationId}
      AND i."emittedAt" >= ${start} AND i."emittedAt" < ${end}
      AND o."statusGroup"::text IN (${Prisma.join(REVENUE_STATUS_GROUPS)})
    GROUP BY 1, 2
  `);
}

function buildRanking(
  rows: AggregateRow[],
  orderBy: 'revenue' | 'quantity',
  limit: number,
  dimension: string,
  from: string,
  to: string,
) {
  const unit = orderBy === 'revenue' ? 'currency' : 'count';

  const mapped = rows.map((row) => ({
    key: row.key ?? NO_CATEGORY,
    label: row.label ?? row.key ?? NO_CATEGORY,
    revenue: Number(row.revenue ?? 0),
    quantity: Number(row.quantity ?? 0),
    orders: Number(row.orders),
  }));

  const total = mapped.reduce((acc, row) => acc + (orderBy === 'revenue' ? row.revenue : row.quantity), 0);

  const ranked = [...mapped]
    .sort((a, b) => (orderBy === 'revenue' ? b.revenue - a.revenue : b.quantity - a.quantity))
    .slice(0, limit)
    .map((row) => {
      const value = orderBy === 'revenue' ? row.revenue : row.quantity;
      return {
        key: row.key,
        label: row.label,
        value,
        unit,
        extra: { revenueCents: row.revenue, quantity: row.quantity, orders: row.orders },
        // O share usa o total do PERÍODO, não o dos itens exibidos — senão
        // limitar a 10 faria as fatias somarem 100% indevidamente.
        share: total === 0 ? 0 : value / total,
      };
    });

  return { dimension, from, to, total, unit, rows: ranked };
}

export function createTopProductsTool(prisma: PrismaClient): AnalysisTool {
  return {
    name: 'top_products',
    description:
      'Ranking de produtos mais vendidos no período, por faturamento (padrão) ou por ' +
      'quantidade. Considera apenas pedidos com status de venda. Valores em centavos.',
    inputSchema: RankingInputShape,
    outputSchema: RankingOutputShape,
    handler: async (args) => {
      const { from, to, tenant, limit, orderBy } = RankingInputSchema.parse(args);
      const { start, end } = rangeToUtc(from, to);
      const rows = await aggregateItems(prisma, tenant.organizationId, start, end, 'sku');
      return buildRanking(rows, orderBy, limit, 'product', from, to);
    },
  };
}

export function createTopCategoriesTool(prisma: PrismaClient): AnalysisTool {
  return {
    name: 'top_categories',
    description:
      'Ranking de categorias mais vendidas no período, por faturamento (padrão) ou por ' +
      'quantidade. Itens sem categoria aparecem agrupados como "Sem categoria".',
    inputSchema: RankingInputShape,
    outputSchema: RankingOutputShape,
    handler: async (args) => {
      const { from, to, tenant, limit, orderBy } = RankingInputSchema.parse(args);
      const { start, end } = rangeToUtc(from, to);
      const rows = await aggregateItems(prisma, tenant.organizationId, start, end, 'category');
      return buildRanking(rows, orderBy, limit, 'category', from, to);
    },
  };
}

export function createCompareProductsTool(prisma: PrismaClient): AnalysisTool {
  const InputSchema = z.object({
    tenant: TenantContextSchema,
    periodA: z.object({ from: IsoDateSchema, to: IsoDateSchema }),
    periodB: z.object({ from: IsoDateSchema, to: IsoDateSchema }),
    limit: z.number().int().min(1).max(50).default(10),
    orderBy: z.enum(['revenue', 'quantity']).default('revenue'),
  });

  return {
    name: 'compare_products',
    description:
      'Compara as vendas de cada produto entre dois períodos e ordena pela MAIOR QUEDA ' +
      'primeiro. Use para "qual produto caiu mais em vendas". periodA é o período de ' +
      'referência (o anterior) e periodB o mais recente.',
    inputSchema: {
      tenant: TenantContextSchema,
      periodA: z.object({ from: IsoDateSchema, to: IsoDateSchema }),
      periodB: z.object({ from: IsoDateSchema, to: IsoDateSchema }),
      limit: z.number().optional(),
      orderBy: z.enum(['revenue', 'quantity']).optional(),
    },
    outputSchema: {
      dimension: z.string(),
      periodA: z.object({ from: z.string(), to: z.string() }),
      periodB: z.object({ from: z.string(), to: z.string() }),
      unit: z.string(),
      rows: z.array(z.object({
        key: z.string(), label: z.string(),
        valueA: z.number(), valueB: z.number(),
        delta: z.number(), deltaRatio: z.number().nullable(),
      })),
    },
    handler: async (args) => {
      const { tenant, periodA, periodB, limit, orderBy } = InputSchema.parse(args);
      const rangeA = rangeToUtc(periodA.from, periodA.to);
      const rangeB = rangeToUtc(periodB.from, periodB.to);

      const [rowsA, rowsB] = await Promise.all([
        aggregateItems(prisma, tenant.organizationId, rangeA.start, rangeA.end, 'sku'),
        aggregateItems(prisma, tenant.organizationId, rangeB.start, rangeB.end, 'sku'),
      ]);

      const pick = (row: AggregateRow) =>
        orderBy === 'revenue' ? Number(row.revenue ?? 0) : Number(row.quantity ?? 0);

      const mapA = new Map(rowsA.map((row) => [row.key ?? '', { value: pick(row), label: row.label ?? '' }]));
      const mapB = new Map(rowsB.map((row) => [row.key ?? '', { value: pick(row), label: row.label ?? '' }]));

      // União das chaves: um produto que sumiu é exatamente o que a pergunta procura.
      const keys = [...new Set([...mapA.keys(), ...mapB.keys()])];

      const rows = keys.map((key) => {
        const a = mapA.get(key);
        const b = mapB.get(key);
        const valueA = a?.value ?? 0;
        const valueB = b?.value ?? 0;
        return {
          key,
          label: a?.label || b?.label || key,
          valueA,
          valueB,
          delta: valueB - valueA,
          // Sem base no período A não existe variação percentual — `null` é
          // honesto; qualquer número aqui seria inventado.
          deltaRatio: valueA === 0 ? null : (valueB - valueA) / valueA,
        };
      });

      // Maior queda primeiro: é a resposta da pergunta que motiva a ferramenta.
      rows.sort((left, right) => left.delta - right.delta);

      return {
        dimension: 'product',
        periodA, periodB,
        unit: orderBy === 'revenue' ? 'currency' : 'count',
        rows: rows.slice(0, limit),
      };
    },
  };
}
```

- [ ] **Step 3: Rodar os testes**

Run: `pnpm --filter @center/mcp-commerce test`
Expected: PASS — 50 testes.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp-commerce
git commit -m "feat(mcp-commerce): add product and category rankings with period comparison"
```

---

### Task 15: Spike de estoque e catálogo da Uappi

**Files:**
- Create: `docs/uappi-catalog-spike.md`
- Create (condicional): `packages/uappi-client/src/products.ts`, `packages/mcp-commerce/src/inventory.ts`
- Test (condicional): `packages/mcp-commerce/src/__tests__/inventory.test.ts`

**Interfaces:**
- Consumes: `UappiClient`/`UappiClientLike` (T5, T5B), `SecretBox` (T4B), `PrismaClient`.
- Produces (se os endpoints existirem):
  - `listProducts(params: { offset: number; limit: number; ativo?: boolean }): Promise<ProductPage>` em `UappiClient`
  - `interface OutOfStockDeps { prisma: PrismaClient; secretBox: SecretBox; baseUrl: string }`
  - `createOutOfStockTool(deps: OutOfStockDeps): AnalysisTool` — `out_of_stock_products`; cliente Uappi por organização, cacheado, com credenciais lidas do banco e decifradas no ponto de autenticação
  - `listProducts` acrescentado a `UappiClientLike` e a `MockUappiClient` (T5B)

**Responde:** A10 (produtos sem estoque). **Esta é uma spike com resultado incerto, e o plano assume isso explicitamente.** A documentação pública da Uappi v2 detalha `/v2/auth`, `/v2/ping`, `/v2/collection/{api}` e `/v2/orders`; menciona produtos e clientes mas não os especifica. Sem confirmar o endpoint, escrever a ferramenta seria inventar um contrato.

**Timebox: 1 dia.** Rode no Sprint 1, não no 5 — o resultado muda o escopo.

- [ ] **Step 1: Descobrir os endpoints reais pela coleção Postman**

A própria API expõe sua coleção. Este é o caminho mais rápido e confiável:

```bash
curl -s -H 'App-Token: wapstore' \
  "$UAPPI_BASE_URL/v2/collection/apiv2" | jq -r '
    .. | objects | select(.request?.url?.raw) |
    "\(.request.method) \(.request.url.raw)"
  ' | sort -u | tee docs/uappi-endpoints.txt
```

Repita para `front` e `marketplace`. Procure por `products`, `produtos`, `estoque`, `stock`, `categories`, `customers`.

- [ ] **Step 2: Registrar o resultado**

Crie `docs/uappi-catalog-spike.md` com o que foi encontrado:

```markdown
# Spike — catálogo e estoque na Uappi

**Data:** <preencher>
**Executado por:** <preencher>

## Endpoints encontrados na coleção

<colar a saída de docs/uappi-endpoints.txt>

## Existe endpoint de produtos com saldo de estoque?

- [ ] Sim — path: `_______`, campo de saldo: `_______`, limite de taxa: `___/min`
- [ ] Não

## Decisão

- Se SIM → executar os Steps 3 a 6 desta task.
- Se NÃO → a pergunta A10 ("quais produtos estão sem estoque") sai do escopo da v1.
  O agente responde que não tem acesso ao catálogo (o system prompt da T29 já
  cobre isso). Registrar aqui e abrir chamado no suporte da Uappi.
```

- [ ] **Step 3 (só se o endpoint existir): Escrever o teste da listagem de produtos**

`packages/uappi-client/src/__tests__/products.test.ts`:

```ts
import { RateLimiter } from '../rate-limiter.js';
import { UappiClient } from '../client.js';
import type { UappiTokenProvider } from '../auth.js';

function buildClient(fetchImpl: jest.Mock) {
  const tokenProvider = {
    getToken: jest.fn(async () => 'jwt-1'), invalidate: jest.fn(),
  } as unknown as UappiTokenProvider;
  const noWait = new RateLimiter(1000, () => 0, async () => {});
  return new UappiClient({
    baseUrl: 'https://api.uappi.com.br', tokenProvider,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    listLimiter: noWait, detailLimiter: noWait,
  });
}

describe('UappiClient.listProducts', () => {
  it('requests the products path with pagination', async () => {
    const fetchImpl = jest.fn(async () => new Response(
      JSON.stringify({ produtos: [], info: { offset: 0, limit: 100, total: 0, exibindo: 0 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    await buildClient(fetchImpl).listProducts({ offset: 0, limit: 100 });
    const url = new URL(fetchImpl.mock.calls[0]![0] as string);
    // Ajuste o pathname para o descoberto na spike.
    expect(url.pathname).toBe('/v2/products');
    expect(url.searchParams.get('limit')).toBe('100');
  });

  it('parses products with their stock balance', async () => {
    const fetchImpl = jest.fn(async () => new Response(
      JSON.stringify({
        produtos: [{ sku: 'CAM-001', nome: 'Camiseta', saldoEstoque: 0, ativo: true }],
        info: { offset: 0, limit: 100, total: 1, exibindo: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const page = await buildClient(fetchImpl).listProducts({ offset: 0, limit: 100 });
    expect(page.produtos[0]).toMatchObject({ sku: 'CAM-001', saldoEstoque: 0 });
  });
});
```

Ajuste `pathname` e os nomes dos campos para o que a spike encontrou. **Não invente nomes** — use os da coleção Postman.

- [ ] **Step 4 (condicional): Implementar `listProducts`**

Adicione a `packages/uappi-client/src/client.ts`, dentro da classe `UappiClient`:

```ts
  /**
   * Catálogo com saldo de estoque. Path e nomes de campo confirmados na spike
   * da T15 — se a Uappi mudar, é aqui que muda.
   */
  async listProducts(params: { offset: number; limit: number; ativo?: boolean }): Promise<ProductPage> {
    const url = new URL('/v2/products', this.baseUrl);
    url.searchParams.set('offset', String(params.offset));
    url.searchParams.set('limit', String(Math.min(params.limit, MAX_PAGE_SIZE)));
    if (params.ativo !== undefined) url.searchParams.set('ativo', String(params.ativo));
    return ProductPageSchema.parse(await this.request(url.toString(), this.listLimiter));
  }
```

com os schemas no topo do arquivo:

```ts
const ProductSchema = z.object({
  sku: z.union([z.string(), z.number()]).transform(String),
  nome: z.string().default(''),
  saldoEstoque: z.coerce.number().default(0),
  ativo: z.boolean().default(true),
}).passthrough();

const ProductPageSchema = z.object({
  produtos: z.array(ProductSchema).default([]),
  info: z.object({
    offset: z.coerce.number(), limit: z.coerce.number(),
    total: z.coerce.number(), exibindo: z.coerce.number(),
  }),
});
export type ProductPage = z.infer<typeof ProductPageSchema>;
```

- [ ] **Step 5 (condicional): Implementar a ferramenta**

**Duas decisões de design, ambas por causa de multi-tenancy:**

1. **Um cliente Uappi por organização, nunca um fixo.** Cada loja tem seu próprio `apiKey`/`secretKey`. Uma ferramenta construída com um cliente fixo funcionaria só para a organização cujas credenciais foram usadas no boot do servidor — e responderia errado (ou nada) para todas as outras.
2. **As credenciais são lidas e decifradas aqui, não recebidas pelo `tenant`.** O `TenantContext` atravessa o canal stdio de todos os MCP servers e entra no hash da chave de cache; colocar segredo nele o espalharia por processos que não precisam dele (`mcp-ga4`, `mcp-behavior`). Este servidor já tem Prisma e `DATABASE_URL` — ler a linha da organização e decifrar com o `SecretBox` mantém a credencial confinada ao único processo que a usa.

`packages/mcp-commerce/src/inventory.ts`:

```ts
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { TenantContextSchema } from '@center/shared';
import type { AnalysisTool } from '@center/mcp-core';
import type { SecretBox } from '@center/secrets';
import { UappiClient, UappiTokenProvider, type UappiClientLike } from '@center/uappi-client';

export interface OutOfStockDeps {
  prisma: PrismaClient;
  secretBox: SecretBox;
  baseUrl: string;
}

/**
 * Consulta o catálogo AO VIVO, ao contrário do resto do servidor Commerce.
 * Estoque muda a cada minuto e um valor de 30 minutos atrás seria pior do que
 * nenhum — alguém repõe um produto e a resposta continua dizendo que faltou.
 * Por isso é uma exceção deliberada à regra de ler só o read model, e por isso
 * o gateway a chama com `cache: false`.
 */
export function createOutOfStockTool(deps: OutOfStockDeps): AnalysisTool {
  // Um cliente por organização: cada um cacheia seu próprio token JWT (T5) e
  // não pode ser compartilhado entre lojas com credenciais diferentes.
  const clients = new Map<string, UappiClientLike>();

  async function clientFor(organizationId: string): Promise<UappiClientLike> {
    const cached = clients.get(organizationId);
    if (cached) return cached;

    const organization = await deps.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { uappiApiKey: true, uappiSecretKey: true },
    });

    if (!organization?.uappiApiKey || !organization.uappiSecretKey) {
      throw new Error(`credenciais da Uappi não configuradas para a organização "${organizationId}"`);
    }

    // Decifradas aqui, no ponto exato que autentica — nunca antes.
    const tokenProvider = new UappiTokenProvider({
      baseUrl: deps.baseUrl,
      credentials: {
        apiKey: deps.secretBox.decrypt(organization.uappiApiKey),
        secretKey: deps.secretBox.decrypt(organization.uappiSecretKey),
      },
    });
    const client = new UappiClient({ baseUrl: deps.baseUrl, tokenProvider });
    clients.set(organizationId, client);
    return client;
  }

  const InputSchema = z.object({
    tenant: TenantContextSchema,
    limit: z.number().int().min(1).max(100).default(20),
  });

  return {
    name: 'out_of_stock_products',
    description:
      'Lista produtos ativos com saldo de estoque zerado ou negativo, consultados ao vivo ' +
      'no catálogo. Use para "quais produtos estão sem estoque".',
    inputSchema: { tenant: TenantContextSchema, limit: z.number().optional() },
    outputSchema: {
      total: z.number(),
      products: z.array(z.object({ sku: z.string(), name: z.string(), balance: z.number() })),
    },
    handler: async (args) => {
      const { tenant, limit } = InputSchema.parse(args);
      const client = await clientFor(tenant.organizationId);

      const outOfStock: Array<{ sku: string; name: string; balance: number }> = [];
      let offset = 0;

      for (;;) {
        const page = await client.listProducts({ offset, limit: 100, ativo: true });
        if (page.produtos.length === 0) break;

        for (const product of page.produtos) {
          if (product.saldoEstoque <= 0) {
            outOfStock.push({ sku: product.sku, name: product.nome, balance: product.saldoEstoque });
          }
        }

        offset += page.produtos.length;
        if (offset >= page.info.total) break;
      }

      return { total: outOfStock.length, products: outOfStock.slice(0, limit) };
    },
  };
}
```

> `listProducts` precisa entrar em `UappiClientLike` (T5B) junto dos outros três métodos, já que esta ferramenta depende da interface: adicione `listProducts(params: { offset: number; limit: number; ativo?: boolean }): Promise<ProductPage>` a `packages/uappi-client/src/interface.ts` e implemente-o também em `MockUappiClient`, devolvendo uma página vazia — o mock não simula catálogo.

- [ ] **Step 6 (condicional): Escrever o teste do isolamento por tenant**

`packages/mcp-commerce/src/__tests__/inventory.test.ts`:

```ts
import type { PrismaClient } from '@prisma/client';
import { SecretBox } from '@center/secrets';
import { createOutOfStockTool } from '../inventory.js';

const secretBox = new SecretBox('a'.repeat(64));
const tenantA = { organizationId: 'org_a', externalIds: {} };
const tenantB = { organizationId: 'org_b', externalIds: {} };

/** O banco guarda texto cifrado; o teste cifra para simular isso fielmente. */
const CREDENTIALS: Record<string, { uappiApiKey: string; uappiSecretKey: string } | null> = {
  org_a: { uappiApiKey: secretBox.encrypt('ak-a'), uappiSecretKey: secretBox.encrypt('sk-a') },
  org_b: { uappiApiKey: secretBox.encrypt('ak-b'), uappiSecretKey: secretBox.encrypt('sk-b') },
  org_sem_credencial: null,
};

function fakePrisma(): PrismaClient {
  return {
    organization: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => CREDENTIALS[where.id] ?? null),
    },
  } as unknown as PrismaClient;
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

function buildTool(prisma = fakePrisma()) {
  return createOutOfStockTool({ prisma, secretBox, baseUrl: 'https://api.uappi.com.br' });
}

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('createOutOfStockTool — isolamento por tenant', () => {
  it('authenticates with each organization own decrypted credentials', async () => {
    const authCalls: unknown[] = [];
    globalThis.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(url as string).pathname === '/v2/auth') {
        authCalls.push(JSON.parse(init!.body as string));
        return jsonResponse({ token: 'jwt-1' });
      }
      return jsonResponse({ produtos: [], info: { offset: 0, limit: 100, total: 0, exibindo: 0 } });
    }) as typeof fetch;

    const tool = buildTool();
    await tool.handler!({ tenant: tenantA } as never, {} as never);
    await tool.handler!({ tenant: tenantB } as never, {} as never);

    // Cada organização autentica com a SUA credencial, já decifrada.
    expect(authCalls).toEqual([
      { apiKey: 'ak-a', secretKey: 'sk-a' },
      { apiKey: 'ak-b', secretKey: 'sk-b' },
    ]);
  });

  it('never sends ciphertext as a credential', async () => {
    const authCalls: string[] = [];
    globalThis.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(url as string).pathname === '/v2/auth') {
        authCalls.push(init!.body as string);
        return jsonResponse({ token: 'jwt-1' });
      }
      return jsonResponse({ produtos: [], info: { offset: 0, limit: 100, total: 0, exibindo: 0 } });
    }) as typeof fetch;

    await buildTool().handler!({ tenant: tenantA } as never, {} as never);
    // "v1." é o prefixo do formato cifrado (T4B) — se aparecer aqui, o decrypt
    // não aconteceu e a Uappi responderia 401.
    expect(authCalls[0]).not.toContain('v1.');
  });

  it('reuses the cached client on a second call for the same organization', async () => {
    let authCount = 0;
    globalThis.fetch = jest.fn(async (url: RequestInfo | URL) => {
      if (new URL(url as string).pathname === '/v2/auth') {
        authCount += 1;
        return jsonResponse({ token: 'jwt-1' });
      }
      return jsonResponse({ produtos: [], info: { offset: 0, limit: 100, total: 0, exibindo: 0 } });
    }) as typeof fetch;

    const tool = buildTool();
    await tool.handler!({ tenant: tenantA } as never, {} as never);
    await tool.handler!({ tenant: tenantA } as never, {} as never);

    // O token provider (T5) cacheia por 25 min — a 2ª chamada não reautentica.
    expect(authCount).toBe(1);
  });

  it('reads the credentials from the database only once per organization', async () => {
    globalThis.fetch = jest.fn(async (url: RequestInfo | URL) => {
      if (new URL(url as string).pathname === '/v2/auth') return jsonResponse({ token: 'jwt-1' });
      return jsonResponse({ produtos: [], info: { offset: 0, limit: 100, total: 0, exibindo: 0 } });
    }) as typeof fetch;

    const prisma = fakePrisma();
    const tool = buildTool(prisma);
    await tool.handler!({ tenant: tenantA } as never, {} as never);
    await tool.handler!({ tenant: tenantA } as never, {} as never);

    expect(prisma.organization.findUnique).toHaveBeenCalledTimes(1);
  });

  it('returns a readable error when the organization has no credentials', async () => {
    await expect(
      buildTool().handler!({ tenant: { organizationId: 'org_sem_credencial', externalIds: {} } } as never, {} as never),
    ).rejects.toThrow('credenciais da Uappi não configuradas');
  });

  it('does not take credentials from the tenant, even if someone puts them there', async () => {
    // Guarda contra uma regressão: o tenant nunca deve ser fonte de credencial.
    await expect(
      buildTool().handler!({
        tenant: {
          organizationId: 'org_sem_credencial',
          externalIds: { uappiApiKey: 'ak-forjada', uappiSecretKey: 'sk-forjada' },
        },
      } as never, {} as never),
    ).rejects.toThrow('credenciais da Uappi não configuradas');
  });
});
```

- [ ] **Step 7: Commit**

```bash
git add docs/uappi-catalog-spike.md docs/uappi-endpoints.txt packages/
git commit -m "chore(spike): document Uappi catalog endpoints and per-tenant stock tool"
```

---

### Task 16: Ferramentas de atribuição

**Files:**
- Create: `packages/mcp-commerce/src/attribution.ts`, `packages/mcp-commerce/src/main.ts`
- Test: `packages/mcp-commerce/src/__tests__/attribution.test.ts`

**Interfaces:**
- Consumes: `AnalysisTool` de `@center/mcp-core`; constantes da T12.
- Produces:
  - `createCampaignRevenueTool(prisma): AnalysisTool` — `campaign_revenue`
  - `createChannelTicketTool(prisma): AnalysisTool` — `channel_average_ticket`
  - `createDeviceRevenueTool(prisma): AnalysisTool` — `device_revenue`
  - `createCampaignConversionTool(prisma): AnalysisTool` — `campaign_conversion`
  - `createReturningCustomersTool(prisma): AnalysisTool` — `campaign_returning_customers`
  - `main.ts`: MCP server `center-commerce` com provider + todas as ferramentas

**Responde:** C1, C2, C3, C4 (parcial), C5, C6.

**A base de tudo:** os campos `attributionCampaign`, `attributionDevice` e `visitorHash` gravados pela T9. `campaign_conversion` responde "usuários que clicaram na campanha compraram?" cruzando `AttributionTouch` (quem chegou pela campanha) com `CommerceOrder` (quem comprou) pelo `visitorHash` — o join pseudonimizado que o usuário pediu.

- [ ] **Step 1: Escrever o teste (falhando)**

`packages/mcp-commerce/src/__tests__/attribution.test.ts`:

```ts
import {
  createCampaignConversionTool, createCampaignRevenueTool, createChannelTicketTool,
  createDeviceRevenueTool, createReturningCustomersTool,
} from '../attribution.js';
import { prisma, resetCommerceData, seedOrders, TEST_ORG } from './helpers/seed.js';

const tenant = { organizationId: TEST_ORG, externalIds: {} };
const period = { from: '2026-01-01', to: '2026-01-31', tenant };

beforeAll(async () => {
  await resetCommerceData();
  await seedOrders([
    { numeroPedido: 'A1', emittedAtLocal: '2026-01-05T10:00:00', statusGroup: 'PAID', totalCents: 30000,
      campaign: 'black-friday', device: 'mobile', canal: 'site', visitorHash: 'v1', customerExternalId: 'C1' },
    { numeroPedido: 'A2', emittedAtLocal: '2026-01-06T10:00:00', statusGroup: 'PAID', totalCents: 10000,
      campaign: 'black-friday', device: 'desktop', canal: 'site', visitorHash: 'v2', customerExternalId: 'C2' },
    { numeroPedido: 'A3', emittedAtLocal: '2026-01-07T10:00:00', statusGroup: 'DELIVERED', totalCents: 20000,
      campaign: 'natal', device: 'mobile', canal: 'app', visitorHash: 'v3', customerExternalId: 'C3' },
    // Cliente recorrente que veio de black-friday
    { numeroPedido: 'A4', emittedAtLocal: '2026-01-20T10:00:00', statusGroup: 'PAID', totalCents: 15000,
      campaign: 'black-friday', device: 'mobile', canal: 'site', visitorHash: 'v1', customerExternalId: 'C1' },
    // Cancelado: nunca conta como receita
    { numeroPedido: 'A5', emittedAtLocal: '2026-01-08T10:00:00', statusGroup: 'CANCELLED', totalCents: 99999,
      campaign: 'black-friday', device: 'mobile', visitorHash: 'v9' },
    // Sem campanha
    { numeroPedido: 'A6', emittedAtLocal: '2026-01-09T10:00:00', statusGroup: 'PAID', totalCents: 5000,
      campaign: null, device: 'desktop', canal: 'app', customerExternalId: 'C4' },
  ]);

  // 5 visitantes chegaram por black-friday; 2 deles compraram (v1, v2).
  await prisma.attributionTouch.createMany({
    data: ['v1', 'v2', 'v4', 'v5', 'v6'].map((visitorHash) => ({
      organizationId: TEST_ORG, visitorHash, campaign: 'black-friday',
      source: 'google', medium: 'cpc', device: 'mobile',
      occurredAt: new Date('2026-01-04T10:00:00Z'),
    })),
  });
});

afterAll(async () => {
  await prisma.attributionTouch.deleteMany({ where: { organizationId: TEST_ORG } });
  await prisma.$disconnect();
});

describe('campaign_revenue', () => {
  const tool = createCampaignRevenueTool(prisma);

  it('ranks campaigns by revenue in cents', async () => {
    const result = await tool.handler(period) as { rows: Array<{ key: string; value: number }> };
    expect(result.rows[0]).toMatchObject({ key: 'black-friday', value: 55000 });
    expect(result.rows[1]).toMatchObject({ key: 'natal', value: 20000 });
  });

  it('excludes cancelled orders', async () => {
    const result = await tool.handler(period) as { rows: Array<{ key: string; value: number }> };
    expect(result.rows.find((r) => r.key === 'black-friday')?.value).toBe(55000);
  });

  it('groups orders without a campaign under a visible label', async () => {
    const result = await tool.handler(period) as { rows: Array<{ key: string }> };
    expect(result.rows.map((r) => r.key)).toContain('sem-campanha');
  });

  it('reports order count and average ticket per campaign', async () => {
    const result = await tool.handler(period) as { rows: Array<{ key: string; extra: Record<string, number> }> };
    expect(result.rows.find((r) => r.key === 'black-friday')?.extra)
      .toMatchObject({ orders: 3, averageTicketCents: 18333 });
  });
});

describe('channel_average_ticket', () => {
  const tool = createChannelTicketTool(prisma);

  it('computes the average ticket per channel', async () => {
    const result = await tool.handler(period) as { rows: Array<{ key: string; value: number }> };
    const byKey = Object.fromEntries(result.rows.map((r) => [r.key, r.value]));
    // site: (30000 + 10000 + 15000) / 3 = 18333
    expect(byKey.site).toBe(18333);
    // app: (20000 + 5000) / 2 = 12500
    expect(byKey.app).toBe(12500);
  });

  it('sorts by average ticket descending', async () => {
    const result = await tool.handler(period) as { rows: Array<{ key: string }> };
    expect(result.rows[0]?.key).toBe('site');
  });
});

describe('device_revenue', () => {
  const tool = createDeviceRevenueTool(prisma);

  it('ranks devices by revenue', async () => {
    const result = await tool.handler(period) as { rows: Array<{ key: string; value: number }> };
    const byKey = Object.fromEntries(result.rows.map((r) => [r.key, r.value]));
    expect(byKey.mobile).toBe(65000); // 30000 + 20000 + 15000
    expect(byKey.desktop).toBe(15000); // 10000 + 5000
  });

  it('reports the average ticket per device', async () => {
    const result = await tool.handler(period) as { rows: Array<{ key: string; extra: Record<string, number> }> };
    expect(result.rows.find((r) => r.key === 'desktop')?.extra.averageTicketCents).toBe(7500);
  });
});

describe('campaign_conversion', () => {
  const tool = createCampaignConversionTool(prisma);

  it('reports how many campaign visitors ended up buying', async () => {
    const result = await tool.handler({ ...period, campaign: 'black-friday' }) as Record<string, number>;
    // 5 visitantes tocados, 2 compraram (v1, v2).
    expect(result).toMatchObject({ visitors: 5, buyers: 2 });
    expect(result.conversionRate).toBeCloseTo(0.4, 5);
  });

  it('reports revenue from those visitors only', async () => {
    const result = await tool.handler({ ...period, campaign: 'black-friday' }) as Record<string, number>;
    // v1 comprou A1 (30000) e A4 (15000); v2 comprou A2 (10000).
    expect(result.revenueCents).toBe(55000);
  });

  it('does not count the cancelled order of an untouched visitor', async () => {
    const result = await tool.handler({ ...period, campaign: 'black-friday' }) as Record<string, number>;
    expect(result.buyers).toBe(2);
  });

  it('returns zeros instead of dividing by zero for an unknown campaign', async () => {
    const result = await tool.handler({ ...period, campaign: 'inexistente' }) as Record<string, number>;
    expect(result).toMatchObject({ visitors: 0, buyers: 0, conversionRate: 0, revenueCents: 0 });
  });

  it('never exposes a visitor hash in the response', async () => {
    const result = await tool.handler({ ...period, campaign: 'black-friday' });
    expect(JSON.stringify(result)).not.toContain('v1');
  });
});

describe('campaign_returning_customers', () => {
  const tool = createReturningCustomersTool(prisma);

  it('counts customers with more than one order per campaign', async () => {
    const result = await tool.handler(period) as { rows: Array<{ key: string; extra: Record<string, number> }> };
    const bf = result.rows.find((r) => r.key === 'black-friday');
    // C1 comprou duas vezes; C2 uma.
    expect(bf?.extra).toMatchObject({ customers: 2, returningCustomers: 1 });
  });

  it('reports the returning rate', async () => {
    const result = await tool.handler(period) as { rows: Array<{ key: string; value: number }> };
    expect(result.rows.find((r) => r.key === 'black-friday')?.value).toBeCloseTo(0.5, 5);
  });

  it('sorts by returning rate descending', async () => {
    const result = await tool.handler(period) as { rows: Array<{ value: number }> };
    const values = result.rows.map((r) => r.value);
    expect([...values].sort((a, b) => b - a)).toEqual(values);
  });
});
```

- [ ] **Step 2: Implementar `attribution.ts`**

`packages/mcp-commerce/src/attribution.ts`:

```ts
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { IsoDateSchema, TenantContextSchema } from '@center/shared';
import type { AnalysisTool } from '@center/mcp-core';
import { REVENUE_STATUS_GROUPS, rangeToUtc } from './constants.js';

const NO_CAMPAIGN = 'sem-campanha';

const PeriodShape = { from: IsoDateSchema, to: IsoDateSchema, tenant: TenantContextSchema };
const PeriodSchema = z.object(PeriodShape).extend({
  limit: z.number().int().min(1).max(50).default(10),
});

const RankingOutputShape = {
  dimension: z.string(), from: z.string(), to: z.string(),
  total: z.number(), unit: z.string(),
  rows: z.array(z.object({
    key: z.string(), label: z.string(), value: z.number(),
    unit: z.string(), extra: z.record(z.string(), z.number()), share: z.number(),
  })),
};

interface DimensionRow {
  key: string | null;
  revenue: bigint | null;
  orders: bigint;
  customers: bigint;
  returning: bigint;
}

/**
 * Agrega pedidos com status de venda por uma coluna de atribuição.
 * `returning` conta clientes com mais de um pedido no período.
 */
function aggregateByColumn(
  prisma: PrismaClient,
  organizationId: string,
  start: Date,
  end: Date,
  column: string,
  fallback: string,
): Promise<DimensionRow[]> {
  return prisma.$queryRaw<DimensionRow[]>(Prisma.sql`
    WITH per_customer AS (
      SELECT COALESCE(o.${Prisma.raw(`"${column}"`)}, ${fallback}) AS key,
             o."customerId" AS customer_id,
             COUNT(*) AS customer_orders,
             SUM(o."totalCents") AS customer_revenue
      FROM "CommerceOrder" o
      WHERE o."organizationId" = ${organizationId}
        AND o."emittedAt" >= ${start} AND o."emittedAt" < ${end}
        AND o."statusGroup"::text IN (${Prisma.join(REVENUE_STATUS_GROUPS)})
      GROUP BY 1, 2
    )
    SELECT key,
           SUM(customer_revenue)::bigint AS revenue,
           SUM(customer_orders)::bigint AS orders,
           COUNT(*) FILTER (WHERE customer_id IS NOT NULL)::bigint AS customers,
           COUNT(*) FILTER (WHERE customer_id IS NOT NULL AND customer_orders > 1)::bigint AS returning
    FROM per_customer
    GROUP BY 1
  `);
}

interface RankingRowShape {
  key: string;
  label: string;
  value: number;
  unit: string;
  extra: Record<string, number>;
  share: number;
}

function buildRows(
  rows: DimensionRow[],
  pick: (row: { revenue: number; orders: number; customers: number; returning: number }) => number,
  unit: string,
  limit: number,
): { total: number; rows: RankingRowShape[] } {
  const mapped = rows.map((row) => {
    const revenue = Number(row.revenue ?? 0);
    const orders = Number(row.orders);
    const customers = Number(row.customers);
    const returning = Number(row.returning);
    return {
      key: row.key ?? NO_CAMPAIGN,
      revenue, orders, customers, returning,
      averageTicketCents: orders === 0 ? 0 : Math.round(revenue / orders),
    };
  });

  const total = mapped.reduce((acc, row) => acc + pick(row), 0);

  const ranked = [...mapped]
    .sort((a, b) => pick(b) - pick(a))
    .slice(0, limit)
    .map((row) => ({
      key: row.key,
      label: row.key,
      value: pick(row),
      unit,
      extra: {
        revenueCents: row.revenue,
        orders: row.orders,
        customers: row.customers,
        returningCustomers: row.returning,
        averageTicketCents: row.averageTicketCents,
      },
      share: total === 0 ? 0 : pick(row) / total,
    }));

  return { total, rows: ranked };
}

export function createCampaignRevenueTool(prisma: PrismaClient): AnalysisTool {
  return {
    name: 'campaign_revenue',
    description:
      'Ranking de campanhas por faturamento no período, com pedidos e ticket médio. ' +
      'Usa a UTM capturada no checkout. Use para "qual campanha trouxe mais receita".',
    inputSchema: { ...PeriodShape, limit: z.number().optional() },
    outputSchema: RankingOutputShape,
    handler: async (args) => {
      const { from, to, tenant, limit } = PeriodSchema.parse(args);
      const { start, end } = rangeToUtc(from, to);
      const rows = await aggregateByColumn(
        prisma, tenant.organizationId, start, end, 'attributionCampaign', NO_CAMPAIGN,
      );
      const built = buildRows(rows, (row) => row.revenue, 'currency', limit);
      return { dimension: 'campaign', from, to, unit: 'currency', ...built };
    },
  };
}

export function createChannelTicketTool(prisma: PrismaClient): AnalysisTool {
  return {
    name: 'channel_average_ticket',
    description:
      'Ticket médio por canal de venda (site, app, marketplace…) no período. ' +
      'Use para "quais canais possuem maior ticket médio".',
    inputSchema: { ...PeriodShape, limit: z.number().optional() },
    outputSchema: RankingOutputShape,
    handler: async (args) => {
      const { from, to, tenant, limit } = PeriodSchema.parse(args);
      const { start, end } = rangeToUtc(from, to);
      const rows = await aggregateByColumn(
        prisma, tenant.organizationId, start, end, 'canal', 'sem-canal',
      );
      // Ordenado por ticket médio, não por receita — é o que a pergunta pede.
      const built = buildRows(rows, (row) => (row.orders === 0 ? 0 : Math.round(row.revenue / row.orders)), 'currency', limit);
      return { dimension: 'channel', from, to, unit: 'currency', ...built };
    },
  };
}

export function createDeviceRevenueTool(prisma: PrismaClient): AnalysisTool {
  return {
    name: 'device_revenue',
    description:
      'Faturamento e ticket médio por dispositivo (mobile, desktop, tablet) no período. ' +
      'Use para "quais dispositivos geram maior receita".',
    inputSchema: { ...PeriodShape, limit: z.number().optional() },
    outputSchema: RankingOutputShape,
    handler: async (args) => {
      const { from, to, tenant, limit } = PeriodSchema.parse(args);
      const { start, end } = rangeToUtc(from, to);
      const rows = await aggregateByColumn(
        prisma, tenant.organizationId, start, end, 'attributionDevice', 'desconhecido',
      );
      const built = buildRows(rows, (row) => row.revenue, 'currency', limit);
      return { dimension: 'device', from, to, unit: 'currency', ...built };
    },
  };
}

export function createCampaignConversionTool(prisma: PrismaClient): AnalysisTool {
  const InputSchema = z.object({ ...PeriodShape, campaign: z.string().min(1) });

  return {
    name: 'campaign_conversion',
    description:
      'Quantos visitantes que chegaram por uma campanha acabaram comprando, e quanto ' +
      'gastaram. Use para "usuários que clicaram na campanha compraram?". O cruzamento é ' +
      'feito por identificador pseudonimizado — nenhum dado pessoal é exposto.',
    inputSchema: { ...PeriodShape, campaign: z.string() },
    outputSchema: {
      campaign: z.string(), from: z.string(), to: z.string(),
      visitors: z.number(), buyers: z.number(),
      conversionRate: z.number(), revenueCents: z.number(), averageTicketCents: z.number(),
    },
    handler: async (args) => {
      const { from, to, tenant, campaign } = InputSchema.parse(args);
      const { start, end } = rangeToUtc(from, to);
      const normalized = campaign.trim().toLowerCase();

      // O join acontece pelo visitorHash — HMAC do client_id do GA4, gravado
      // pelas duas pontas (toque e pedido). Nunca há client_id em claro aqui.
      const [row] = await prisma.$queryRaw<Array<{
        visitors: bigint; buyers: bigint; revenue: bigint | null; orders: bigint;
      }>>(Prisma.sql`
        WITH touched AS (
          SELECT DISTINCT t."visitorHash"
          FROM "AttributionTouch" t
          WHERE t."organizationId" = ${tenant.organizationId}
            AND t."campaign" = ${normalized}
            AND t."occurredAt" < ${end}
        ),
        purchases AS (
          SELECT o."visitorHash", SUM(o."totalCents") AS revenue, COUNT(*) AS orders
          FROM "CommerceOrder" o
          JOIN touched ON touched."visitorHash" = o."visitorHash"
          WHERE o."organizationId" = ${tenant.organizationId}
            AND o."emittedAt" >= ${start} AND o."emittedAt" < ${end}
            AND o."statusGroup"::text IN (${Prisma.join(REVENUE_STATUS_GROUPS)})
          GROUP BY 1
        )
        SELECT (SELECT COUNT(*) FROM touched)::bigint AS visitors,
               (SELECT COUNT(*) FROM purchases)::bigint AS buyers,
               (SELECT SUM(revenue) FROM purchases)::bigint AS revenue,
               (SELECT SUM(orders) FROM purchases)::bigint AS orders
      `);

      const visitors = Number(row?.visitors ?? 0);
      const buyers = Number(row?.buyers ?? 0);
      const revenueCents = Number(row?.revenue ?? 0);
      const orders = Number(row?.orders ?? 0);

      return {
        campaign: normalized, from, to,
        visitors, buyers,
        conversionRate: visitors === 0 ? 0 : buyers / visitors,
        revenueCents,
        averageTicketCents: orders === 0 ? 0 : Math.round(revenueCents / orders),
      };
    },
  };
}

export function createReturningCustomersTool(prisma: PrismaClient): AnalysisTool {
  return {
    name: 'campaign_returning_customers',
    description:
      'Proporção de clientes que compraram mais de uma vez, por campanha. Use para ' +
      '"quais campanhas geraram usuários recorrentes". O valor é a taxa de recorrência (0 a 1).',
    inputSchema: { ...PeriodShape, limit: z.number().optional() },
    outputSchema: RankingOutputShape,
    handler: async (args) => {
      const { from, to, tenant, limit } = PeriodSchema.parse(args);
      const { start, end } = rangeToUtc(from, to);
      const rows = await aggregateByColumn(
        prisma, tenant.organizationId, start, end, 'attributionCampaign', NO_CAMPAIGN,
      );
      const built = buildRows(
        rows,
        (row) => (row.customers === 0 ? 0 : row.returning / row.customers),
        'ratio',
        limit,
      );
      return { dimension: 'campaign', from, to, unit: 'ratio', ...built };
    },
  };
}
```

- [ ] **Step 3: Implementar `main.ts`**

`packages/mcp-commerce/src/main.ts`:

```ts
import { PrismaClient } from '@prisma/client';
import { createMetricServer, startStdio } from '@center/mcp-core';
import type { AnalysisTool } from '@center/mcp-core';
import { SecretBox } from '@center/secrets';
import { createCommerceProvider } from './provider.js';
import {
  createFailedOrdersTool, createOrdersByStatusTool, createPaymentMethodTool,
} from './status.js';
import {
  createCompareProductsTool, createTopCategoriesTool, createTopProductsTool,
} from './rankings.js';
import {
  createCampaignConversionTool, createCampaignRevenueTool, createChannelTicketTool,
  createDeviceRevenueTool, createReturningCustomersTool,
} from './attribution.js';
import { createOutOfStockTool } from './inventory.js';

if (!process.env.DATABASE_URL) {
  // stderr, nunca stdout: stdout é o canal do protocolo MCP.
  console.error('mcp-commerce: DATABASE_URL é obrigatório');
  process.exit(1);
}

const prisma = new PrismaClient();

const tools: AnalysisTool[] = [
  createOrdersByStatusTool(prisma),
  createFailedOrdersTool(prisma),
  createPaymentMethodTool(prisma),
  createTopProductsTool(prisma),
  createTopCategoriesTool(prisma),
  createCompareProductsTool(prisma),
  createCampaignRevenueTool(prisma),
  createChannelTicketTool(prisma),
  createDeviceRevenueTool(prisma),
  createCampaignConversionTool(prisma),
  createReturningCustomersTool(prisma),
];

// Condicional à spike da T15: só registra se o endpoint de produtos da Uappi
// foi confirmado em `docs/uappi-catalog-spike.md`. A ferramenta lê e decifra as
// credenciais por organização a cada primeira chamada — este servidor nunca
// guarda uma credencial fixa nem recebe uma pelo tenant.
if (process.env.UAPPI_BASE_URL && process.env.CREDENTIALS_ENCRYPTION_KEY) {
  tools.push(createOutOfStockTool({
    prisma,
    secretBox: new SecretBox(process.env.CREDENTIALS_ENCRYPTION_KEY),
    baseUrl: process.env.UAPPI_BASE_URL,
  }));
}

await startStdio(
  createMetricServer({
    name: 'center-commerce',
    version: '1.0.0',
    provider: createCommerceProvider(prisma),
    tools,
  }),
);
```

- [ ] **Step 4: Rodar os testes**

Run: `pnpm --filter @center/mcp-commerce test`
Expected: PASS — 67 testes.

- [ ] **Step 5: Validar as 18 perguntas no MCP Inspector**

```bash
pnpm build
DATABASE_URL="postgresql://center:center@localhost:5432/center" \
  npx @modelcontextprotocol/inspector node packages/mcp-commerce/dist/main.js
```

Com os dados reais do backfill (T8, Step 6), confirme cada uma — **compare com o painel da Uappi**:

| Pergunta | Ferramenta | Argumentos |
|---|---|---|
| Quanto vendemos este mês? | `query_metric` | `commerce.revenue`, mês corrente, `month` |
| Ticket médio | `query_metric` | `commerce.average_ticket`, mês corrente, `month` |
| Quantos pedidos hoje? | `query_metric` | `commerce.orders`, hoje, `day` |
| Quantos cancelados? | `orders_by_status` | mês corrente |
| Quantos aguardam pagamento? | `orders_by_status` | mês corrente |
| Quais compras falharam? | `failed_orders` | mês corrente |
| Qual produto mais vendeu? | `top_products` | mês corrente |
| Qual produto caiu mais? | `compare_products` | mês anterior vs. corrente |
| Qual categoria vendeu mais? | `top_categories` | mês corrente |
| Clientes novos | `query_metric` | `commerce.new_customers`, mês corrente |
| Método que converte mais | `payment_method_performance` | mês corrente |
| Campanha com mais receita | `campaign_revenue` | mês corrente |
| Canal com maior ticket | `channel_average_ticket` | mês corrente |
| Dispositivo com maior receita | `device_revenue` | mês corrente |
| Campanha gerou compra? | `campaign_conversion` | campanha ativa |
| Campanhas com recorrentes | `campaign_returning_customers` | últimos 90 dias |

**O faturamento precisa bater exatamente com o painel da Uappi.** Divergência é bloqueio — revise `REVENUE_STATUS_GROUPS` e o mapa de status da T6 antes de seguir para a Fase 4.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-commerce
git commit -m "feat(mcp-commerce): add attribution tools and wire the MCP server entrypoint"
```

---

# FASE 4 — MCP GA4 (Sprint 6)

**Objetivo:** Grupo B respondível (14 perguntas).

**A simplificação que esta fase revela:** *Firebase Analytics é o GA4*. Eventos de app e de site chegam à mesma propriedade GA4, separados pela dimensão `platform`. Não existe "Analytics Data API do Firebase" distinta — é a mesma `BetaAnalyticsDataClient`. Por isso `getActiveUsers`, `getNewUsers`, `getEvents` e `getAppVersions` moram aqui, e não num quarto servidor.

**Onde os testes entram:** testa-se a **tradução** — query canônica → parâmetros de `runReport`, e resposta do GA4 → `MetricSeries`/`RankingResult`. Não se testa a API do Google. A validação contra dados reais é o smoke test de cada task.

---

### Task 17: Provider de métricas do GA4

**Files:**
- Create: `packages/mcp-ga4/{package.json,tsconfig.json,jest.config.cjs}`
- Create: `packages/mcp-ga4/src/{dimensions.ts,client.ts,provider.ts}`
- Test: `packages/mcp-ga4/src/__tests__/provider.test.ts`

**Interfaces:**
- Consumes: `MetricProvider`, `toSeries`, `SeriesRow`, `MetricNotFoundError` de `@center/mcp-core`.
- Produces:
  - `GA4_DIMENSIONS: Record<string, string>` — nome canônico → nome GA4
  - `assertGa4Dimension(name: string): string`
  - `interface Ga4ReportParams { propertyId, metricNames, from, to, dimensionNames, dimensionFilters, limit }`
  - `interface Ga4Row { dimensions: Record<string, string>; metrics: Record<string, number> }`
  - `class Ga4Client` — `static fromCredentialsJson(json)`, `runReport(params): Promise<Ga4Row[]>`
  - `createGa4Provider(client: Ga4ClientLike): MetricProvider`
  - Métricas: `ga4.sessions`, `ga4.active_users`, `ga4.new_users`, `ga4.event_count`, `ga4.conversions`, `ga4.purchase_revenue`

- [ ] **Step 1: Criar o pacote**

`packages/mcp-ga4/package.json`:

```json
{
  "name": "@center/mcp-ga4",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/main.js",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "jest",
    "start": "node dist/main.js"
  },
  "dependencies": {
    "@center/mcp-core": "workspace:*",
    "@center/shared": "workspace:*",
    "@google-analytics/data": "^4.12.0",
    "zod": "^3.24.1"
  }
}
```

`tsconfig.json` e `jest.config.cjs` seguem o molde da T1, Step 4.

- [ ] **Step 2: Implementar `dimensions.ts`**

Nomes canônicos em vez dos nomes do Google: o LLM erra menos com `campaign` do que com `sessionCampaignName`, e a tradução fica num lugar só.

`packages/mcp-ga4/src/dimensions.ts`:

```ts
/** Nome canônico → nome de dimensão do GA4. */
export const GA4_DIMENSIONS: Record<string, string> = {
  campaign: 'sessionCampaignName',
  source: 'sessionSource',
  medium: 'sessionMedium',
  sourceMedium: 'sessionSourceMedium',
  channelGroup: 'sessionDefaultChannelGroup',
  device: 'deviceCategory',
  platform: 'platform',
  country: 'country',
  eventName: 'eventName',
  pagePath: 'pagePath',
  appVersion: 'appVersion',
  landingPage: 'landingPage',
};

export const GA4_DIMENSION_NAMES = Object.keys(GA4_DIMENSIONS);

export function assertGa4Dimension(name: string): string {
  const ga4Name = GA4_DIMENSIONS[name];
  if (!ga4Name) {
    throw new Error(
      `dimensão não suportada: "${name}". Disponíveis: ${GA4_DIMENSION_NAMES.join(', ')}`,
    );
  }
  return ga4Name;
}
```

- [ ] **Step 3: Escrever o teste do provider (falhando)**

`packages/mcp-ga4/src/__tests__/provider.test.ts`:

```ts
import type { MetricQuery } from '@center/shared';
import { createGa4Provider } from '../provider.js';
import type { Ga4ReportParams, Ga4Row } from '../client.js';
import type { Ga4ClientLike } from '../interface.js';

function fakeClient(rows: Ga4Row[]) {
  const runReport = jest.fn(async (_params: Ga4ReportParams) => rows);
  return { client: { runReport } as unknown as Ga4ClientLike, runReport };
}

const baseQuery: MetricQuery = {
  metricId: 'ga4.sessions', from: '2026-02-01', to: '2026-02-02', granularity: 'day',
  tenant: { organizationId: 'org_1', externalIds: { ga4PropertyId: '987654321' } },
};

describe('ga4 provider', () => {
  it('publishes the six ga4 metrics', () => {
    const { client } = fakeClient([]);
    expect(createGa4Provider(client).descriptors.map((d) => d.id).sort()).toEqual([
      'ga4.active_users', 'ga4.conversions', 'ga4.event_count',
      'ga4.new_users', 'ga4.purchase_revenue', 'ga4.sessions',
    ]);
  });

  it('always requests the date dimension so the series can be bucketed', async () => {
    const { client, runReport } = fakeClient([]);
    await createGa4Provider(client).query(baseQuery);
    expect(runReport.mock.calls[0]![0]).toMatchObject({
      propertyId: '987654321',
      metricNames: ['sessions'],
      dimensionNames: ['date'],
      from: '2026-02-01', to: '2026-02-02',
    });
  });

  it('maps each metric id to its GA4 metric name', async () => {
    const { client, runReport } = fakeClient([]);
    const provider = createGa4Provider(client);
    for (const id of ['ga4.active_users', 'ga4.new_users', 'ga4.conversions', 'ga4.purchase_revenue']) {
      await provider.query({ ...baseQuery, metricId: id });
    }
    expect(runReport.mock.calls.map((call) => call[0].metricNames[0])).toEqual([
      'activeUsers', 'newUsers', 'conversions', 'purchaseRevenue',
    ]);
  });

  it('translates canonical dimension names into GA4 names', async () => {
    const { client, runReport } = fakeClient([]);
    await createGa4Provider(client).query({
      ...baseQuery, filters: { campaign: 'black-friday' }, groupBy: 'device',
    });
    expect(runReport.mock.calls[0]![0]).toMatchObject({
      dimensionNames: ['date', 'deviceCategory'],
      dimensionFilters: { sessionCampaignName: 'black-friday' },
    });
  });

  it('converts the GA4 compact date into ISO and fills empty buckets', async () => {
    const { client } = fakeClient([
      { dimensions: { date: '20260202' }, metrics: { sessions: 42 } },
    ]);
    const series = await createGa4Provider(client).query(baseQuery);
    expect(series).toEqual({
      metricId: 'ga4.sessions', source: 'ga4', unit: 'count', granularity: 'day',
      total: 42,
      points: [{ date: '2026-02-01', value: 0 }, { date: '2026-02-02', value: 42 }],
    });
  });

  it('returns purchase revenue in cents, not in reais', async () => {
    const { client } = fakeClient([
      { dimensions: { date: '20260201' }, metrics: { purchaseRevenue: 1234.56 } },
    ]);
    const series = await createGa4Provider(client).query({ ...baseQuery, metricId: 'ga4.purchase_revenue' });
    expect(series.unit).toBe('currency');
    expect(series.total).toBe(123456);
  });

  it('groups by the requested dimension', async () => {
    const { client } = fakeClient([
      { dimensions: { date: '20260201', deviceCategory: 'mobile' }, metrics: { sessions: 30 } },
      { dimensions: { date: '20260201', deviceCategory: 'desktop' }, metrics: { sessions: 10 } },
    ]);
    const series = await createGa4Provider(client).query({
      ...baseQuery, to: '2026-02-01', groupBy: 'device',
    });
    expect(series.points).toEqual([
      { date: '2026-02-01', value: 10, group: 'desktop' },
      { date: '2026-02-01', value: 30, group: 'mobile' },
    ]);
  });

  it('refuses to query when the tenant has no GA4 property id', async () => {
    const { client } = fakeClient([]);
    await expect(createGa4Provider(client).query({
      ...baseQuery, tenant: { organizationId: 'org_1', externalIds: {} },
    })).rejects.toThrow('ga4PropertyId não configurado');
  });

  it('rejects an undeclared dimension with a helpful message', async () => {
    const { client } = fakeClient([]);
    await expect(createGa4Provider(client).query({ ...baseQuery, filters: { productSku: 'x' } }))
      .rejects.toThrow('dimensão não suportada: "productSku"');
  });

  it('rejects an unknown metric id', async () => {
    const { client } = fakeClient([]);
    await expect(createGa4Provider(client).query({ ...baseQuery, metricId: 'ga4.inventado' }))
      .rejects.toThrow('métrica desconhecida');
  });
});
```

- [ ] **Step 4: Implementar `client.ts`**

`packages/mcp-ga4/src/client.ts`:

```ts
import { BetaAnalyticsDataClient } from '@google-analytics/data';

export interface Ga4ReportParams {
  propertyId: string;
  metricNames: string[];
  from: string;
  to: string;
  dimensionNames: string[];
  dimensionFilters: Record<string, string>;
  limit?: number;
}

/** Linha achatada: dimensões e métricas por nome, já convertidas. */
export interface Ga4Row {
  dimensions: Record<string, string>;
  metrics: Record<string, number>;
}

export class Ga4Client {
  constructor(private readonly api: BetaAnalyticsDataClient) {}

  static fromCredentialsJson(credentialsJson: string): Ga4Client {
    const credentials = JSON.parse(credentialsJson) as { client_email: string; private_key: string };
    return new Ga4Client(new BetaAnalyticsDataClient({ credentials }));
  }

  async runReport(params: Ga4ReportParams): Promise<Ga4Row[]> {
    const filterEntries = Object.entries(params.dimensionFilters);

    const [response] = await this.api.runReport({
      property: `properties/${params.propertyId}`,
      dateRanges: [{ startDate: params.from, endDate: params.to }],
      dimensions: params.dimensionNames.map((name) => ({ name })),
      metrics: params.metricNames.map((name) => ({ name })),
      limit: params.limit ?? 100_000,
      ...(filterEntries.length > 0
        ? {
            dimensionFilter: {
              andGroup: {
                expressions: filterEntries.map(([name, value]) => ({
                  filter: { fieldName: name, stringFilter: { matchType: 'EXACT' as const, value } },
                })),
              },
            },
          }
        : {}),
    });

    return (response.rows ?? []).map((row): Ga4Row => {
      const dimensions: Record<string, string> = {};
      params.dimensionNames.forEach((name, index) => {
        dimensions[name] = row.dimensionValues?.[index]?.value ?? '';
      });

      const metrics: Record<string, number> = {};
      params.metricNames.forEach((name, index) => {
        metrics[name] = Number(row.metricValues?.[index]?.value ?? 0);
      });

      return { dimensions, metrics };
    });
  }
}

/** `20260201` (formato do GA4) → `2026-02-01`. */
export function fromGa4Date(compact: string): string {
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}
```

- [ ] **Step 5: Implementar `provider.ts`**

`packages/mcp-ga4/src/provider.ts`:

```ts
import type { MetricDescriptor, MetricQuery, MetricSeries, MetricUnit } from '@center/shared';
import { MetricNotFoundError, toSeries, type MetricProvider, type SeriesRow } from '@center/mcp-core';
import { fromGa4Date } from './client.js';
import type { Ga4ClientLike } from './interface.js';
import { GA4_DIMENSION_NAMES, assertGa4Dimension } from './dimensions.js';

const DESCRIPTORS: MetricDescriptor[] = [
  { id: 'ga4.sessions', label: 'Sessões', description: 'Sessões no site e no app.',
    source: 'ga4', unit: 'count', dimensions: GA4_DIMENSION_NAMES },
  { id: 'ga4.active_users', label: 'Usuários ativos', description: 'Usuários distintos ativos no período. Filtre por platform para separar app de site.',
    source: 'ga4', unit: 'count', dimensions: GA4_DIMENSION_NAMES },
  { id: 'ga4.new_users', label: 'Novos usuários', description: 'Usuários que interagiram pela primeira vez.',
    source: 'ga4', unit: 'count', dimensions: GA4_DIMENSION_NAMES },
  { id: 'ga4.event_count', label: 'Eventos', description: 'Contagem total de eventos. Filtre por eventName para um evento específico.',
    source: 'ga4', unit: 'count', dimensions: GA4_DIMENSION_NAMES },
  { id: 'ga4.conversions', label: 'Conversões', description: 'Eventos marcados como conversão no GA4.',
    source: 'ga4', unit: 'count', dimensions: GA4_DIMENSION_NAMES },
  { id: 'ga4.purchase_revenue', label: 'Receita (GA4)', description: 'Receita medida pelo GA4, em centavos. Pode divergir do faturamento da Uappi — a fonte de verdade de faturamento é commerce.revenue.',
    source: 'ga4', unit: 'currency', dimensions: GA4_DIMENSION_NAMES },
];

const GA4_METRIC_NAME: Record<string, string> = {
  'ga4.sessions': 'sessions',
  'ga4.active_users': 'activeUsers',
  'ga4.new_users': 'newUsers',
  'ga4.event_count': 'eventCount',
  'ga4.conversions': 'conversions',
  'ga4.purchase_revenue': 'purchaseRevenue',
};

const UNITS: Record<string, MetricUnit> = {
  'ga4.purchase_revenue': 'currency',
};

export function createGa4Provider(client: Ga4ClientLike): MetricProvider {
  return {
    descriptors: DESCRIPTORS,

    async query(query: MetricQuery): Promise<MetricSeries> {
      const propertyId = query.tenant.externalIds.ga4PropertyId;
      if (!propertyId) {
        throw new Error(`ga4PropertyId não configurado para a organização "${query.tenant.organizationId}"`);
      }

      const metricName = GA4_METRIC_NAME[query.metricId];
      if (!metricName) throw new MetricNotFoundError(query.metricId);

      const filters = query.filters ?? {};
      const dimensionFilters: Record<string, string> = {};
      for (const [name, value] of Object.entries(filters)) {
        dimensionFilters[assertGa4Dimension(name)] = value;
      }

      const groupDimension = query.groupBy ? assertGa4Dimension(query.groupBy) : null;
      const dimensionNames = groupDimension ? ['date', groupDimension] : ['date'];

      const rows = await client.runReport({
        propertyId,
        metricNames: [metricName],
        from: query.from,
        to: query.to,
        dimensionNames,
        dimensionFilters,
      });

      const unit = UNITS[query.metricId] ?? 'count';

      const seriesRows: SeriesRow[] = rows.map((row) => ({
        date: fromGa4Date(row.dimensions.date ?? ''),
        // Dinheiro vira centavos na borda, como no resto do sistema.
        value: unit === 'currency'
          ? Math.round((row.metrics[metricName] ?? 0) * 100)
          : (row.metrics[metricName] ?? 0),
        group: groupDimension ? (row.dimensions[groupDimension] ?? '') : null,
      }));

      return toSeries(seriesRows, query, unit, 'ga4');
    },
  };
}
```

- [ ] **Step 6: Rodar os testes**

Run: `pnpm --filter @center/mcp-ga4 test`
Expected: PASS — 10 testes.

- [ ] **Step 7: Commit**

```bash
git add packages/mcp-ga4
git commit -m "feat(mcp-ga4): add GA4 metric provider with canonical dimension names"
```

---

### Task 17B: Cliente mock e fixtures do GA4

**Files:**
- Create: `packages/mcp-ga4/src/interface.ts`
- Modify: `packages/mcp-ga4/src/client.ts` (implementa a interface extraída)
- Create: `packages/mcp-ga4/src/mock-client.ts`
- Test: `packages/mcp-ga4/src/__tests__/mock-client.test.ts`

**Interfaces:**
- Consumes: `Ga4ReportParams`, `Ga4Row`, `fromGa4Date` (T17).
- Produces:
  - `interface Ga4ClientLike { runReport(params: Ga4ReportParams): Promise<Ga4Row[]> }`
  - `FIXTURE_CATEGORIES: Record<string, string[]>`
  - `class MockGa4Client implements Ga4ClientLike`

**Por que o mock é generativo, não uma tabela estática de respostas:** o GA4 aceita qualquer combinação de `dimensionNames`/`metricNames`, e sete ferramentas diferentes (T17–T19) fazem sete combinações diferentes. Enumerar cada combinação à mão seria a mesma explosão combinatória que o design de `ranking` (T30) evita nas ferramentas do agente. Em vez disso, o mock **gera** valores determinísticos a partir de um hash do pedido — mesma entrada sempre produz a mesma saída, sem depender da rede nem de uma tabela que precisaria crescer a cada ferramenta nova.

- [ ] **Step 1: Extrair a interface e declarar o cliente real**

`packages/mcp-ga4/src/interface.ts`:

```ts
import type { Ga4ReportParams, Ga4Row } from './client.js';

export interface Ga4ClientLike {
  runReport(params: Ga4ReportParams): Promise<Ga4Row[]>;
}
```

Em `packages/mcp-ga4/src/client.ts` (T17), adicione o import e a cláusula `implements`:

```ts
import type { Ga4ClientLike } from './interface.js';
```

```ts
export class Ga4Client implements Ga4ClientLike {
```

- [ ] **Step 2: Escrever o teste (falhando)**

`packages/mcp-ga4/src/__tests__/mock-client.test.ts`:

```ts
import { fromGa4Date } from '../client.js';
import { FIXTURE_CATEGORIES, MockGa4Client } from '../mock-client.js';

describe('MockGa4Client — série por data', () => {
  it('returns one row per day in the requested range', async () => {
    const rows = await new MockGa4Client().runReport({
      propertyId: '1', metricNames: ['sessions'], from: '2026-02-01', to: '2026-02-05',
      dimensionNames: ['date'], dimensionFilters: {},
    });
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.dimensions.date).sort()).toEqual([
      '20260201', '20260202', '20260203', '20260204', '20260205',
    ]);
  });

  it('is deterministic — the same request produces the same values', async () => {
    const request = {
      propertyId: '1', metricNames: ['sessions'], from: '2026-02-01', to: '2026-02-01',
      dimensionNames: ['date'], dimensionFilters: {},
    };
    const first = await new MockGa4Client().runReport(request);
    const second = await new MockGa4Client().runReport(request);
    expect(first).toEqual(second);
  });

  it('produces a positive integer for count metrics', async () => {
    const rows = await new MockGa4Client().runReport({
      propertyId: '1', metricNames: ['activeUsers'], from: '2026-02-01', to: '2026-02-01',
      dimensionNames: ['date'], dimensionFilters: {},
    });
    expect(Number.isInteger(rows[0]!.metrics.activeUsers)).toBe(true);
    expect(rows[0]!.metrics.activeUsers).toBeGreaterThan(0);
  });

  it('adds the second dimension when grouping is requested', async () => {
    const rows = await new MockGa4Client().runReport({
      propertyId: '1', metricNames: ['sessions'], from: '2026-02-01', to: '2026-02-01',
      dimensionNames: ['date', 'deviceCategory'], dimensionFilters: {},
    });
    expect(rows.length).toBe(FIXTURE_CATEGORIES.deviceCategory!.length);
    expect(rows.every((r) => FIXTURE_CATEGORIES.deviceCategory!.includes(r.dimensions.deviceCategory!))).toBe(true);
  });

  it('dates come out in the compact GA4 format, decodable by fromGa4Date', async () => {
    const rows = await new MockGa4Client().runReport({
      propertyId: '1', metricNames: ['sessions'], from: '2026-02-01', to: '2026-02-01',
      dimensionNames: ['date'], dimensionFilters: {},
    });
    expect(fromGa4Date(rows[0]!.dimensions.date!)).toBe('2026-02-01');
  });
});

describe('MockGa4Client — ranking por dimensão', () => {
  it('returns the known fixture categories for a recognised dimension', async () => {
    const rows = await new MockGa4Client().runReport({
      propertyId: '1', metricNames: ['activeUsers', 'sessions'], from: '2026-02-01', to: '2026-02-28',
      dimensionNames: ['sessionSourceMedium'], dimensionFilters: {},
    });
    expect(rows.map((r) => r.dimensions.sessionSourceMedium).sort())
      .toEqual([...FIXTURE_CATEGORIES.sessionSourceMedium!].sort());
  });

  it('produces a value between 0 and 1 for a ratio-shaped metric like bounceRate', async () => {
    const rows = await new MockGa4Client().runReport({
      propertyId: '1', metricNames: ['bounceRate'], from: '2026-02-01', to: '2026-02-28',
      dimensionNames: ['pagePath'], dimensionFilters: {},
    });
    for (const row of rows) {
      expect(row.metrics.bounceRate).toBeGreaterThanOrEqual(0);
      expect(row.metrics.bounceRate).toBeLessThanOrEqual(1);
    }
  });

  it('includes the five standard e-commerce events plus page_view for eventName', async () => {
    const rows = await new MockGa4Client().runReport({
      propertyId: '1', metricNames: ['eventCount', 'activeUsers'], from: '2026-02-01', to: '2026-02-28',
      dimensionNames: ['eventName'], dimensionFilters: {},
    });
    const names = rows.map((r) => r.dimensions.eventName);
    for (const expected of ['view_item', 'add_to_cart', 'begin_checkout', 'add_payment_info', 'purchase']) {
      expect(names).toContain(expected);
    }
  });

  it('falls back to a generic three-category fixture for an unmapped dimension', async () => {
    const rows = await new MockGa4Client().runReport({
      propertyId: '1', metricNames: ['sessions'], from: '2026-02-01', to: '2026-02-28',
      dimensionNames: ['country'], dimensionFilters: {},
    });
    expect(rows).toHaveLength(3);
  });
});
```

- [ ] **Step 3: Implementar `mock-client.ts`**

`packages/mcp-ga4/src/mock-client.ts`:

```ts
import type { Ga4ClientLike } from './interface.js';
import type { Ga4ReportParams, Ga4Row } from './client.js';

/** Categorias plausíveis por dimensão. Dimensão fora daqui cai no fallback genérico. */
export const FIXTURE_CATEGORIES: Record<string, string[]> = {
  sessionSourceMedium: ['google / organic', 'facebook / cpc', 'direto / (none)'],
  sessionCampaignName: ['black-friday', 'natal', '(not set)'],
  deviceCategory: ['mobile', 'desktop', 'tablet'],
  pagePath: ['/', '/produto/camiseta', '/checkout'],
  appVersion: ['5.8.0', '5.7.2'],
  eventName: ['page_view', 'view_item', 'add_to_cart', 'begin_checkout', 'add_payment_info', 'purchase'],
};
const GENERIC_FALLBACK = ['categoria-a', 'categoria-b', 'categoria-c'];

/** Métricas cujo valor plausível é uma taxa entre 0 e 1, não uma contagem. */
const RATIO_METRICS = new Set(['bounceRate', 'conversions']);

function stringHash(input: string): number {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function deterministicValue(seedInput: string, metricName: string): number {
  const fraction = (stringHash(seedInput) % 1000) / 1000; // 0 .. 0.999, estável para a mesma entrada
  if (metricName === 'bounceRate') return Number((0.1 + fraction * 0.6).toFixed(3));
  if (metricName === 'conversions' && RATIO_METRICS.has(metricName)) return Math.round(fraction * 50);
  if (metricName === 'purchaseRevenue') return Number((50 + fraction * 950).toFixed(2));
  // Contagens (sessions, activeUsers, newUsers, eventCount): 10 a 500.
  return Math.round(10 + fraction * 490);
}

function eachCompactDate(from: string, to: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    dates.push(cursor.toISOString().slice(0, 10).replace(/-/g, ''));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function metricsFor(seed: string, metricNames: string[]): Record<string, number> {
  return Object.fromEntries(metricNames.map((name) => [name, deterministicValue(seed, name)]));
}

/**
 * Gera respostas plausíveis e determinísticas para qualquer combinação de
 * dimensões e métricas do GA4, sem tocar a rede. Ligado por
 * `MOCK_EXTERNAL_APIS=true` (T4). O funil gerado NÃO é garantidamente
 * monotônico — é ilustrativo, não uma simulação de comportamento real.
 */
export class MockGa4Client implements Ga4ClientLike {
  async runReport(params: Ga4ReportParams): Promise<Ga4Row[]> {
    if (params.dimensionNames.includes('date')) {
      return this.dateSeriesRows(params);
    }
    return this.categoryRows(params);
  }

  private dateSeriesRows(params: Ga4ReportParams): Ga4Row[] {
    const dates = eachCompactDate(params.from, params.to);
    const secondDimension = params.dimensionNames.find((name) => name !== 'date');
    const groups = secondDimension ? (FIXTURE_CATEGORIES[secondDimension] ?? GENERIC_FALLBACK) : [undefined];

    const rows: Ga4Row[] = [];
    for (const date of dates) {
      for (const group of groups) {
        const dimensions: Record<string, string> = { date };
        if (secondDimension && group) dimensions[secondDimension] = group;
        rows.push({
          dimensions,
          metrics: metricsFor(`${date}|${group ?? ''}`, params.metricNames),
        });
      }
    }
    return rows;
  }

  private categoryRows(params: Ga4ReportParams): Ga4Row[] {
    const dimensionName = params.dimensionNames[0];
    if (!dimensionName) return [];
    const categories = FIXTURE_CATEGORIES[dimensionName] ?? GENERIC_FALLBACK;

    return categories.map((category) => ({
      dimensions: { [dimensionName]: category },
      metrics: metricsFor(category, params.metricNames),
    }));
  }
}
```

Adicione a `packages/mcp-ga4/src/index.ts` (crie o arquivo se ainda não existir — a T17 não precisou de um, já que `main.ts` importava diretamente de `client.ts`/`provider.ts`):

```ts
export * from './client.js';
export * from './interface.js';
export * from './mock-client.js';
export * from './provider.js';
```

- [ ] **Step 4: Rodar os testes**

Run: `pnpm --filter @center/mcp-ga4 test`
Expected: PASS — 9 testes novos.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-ga4
git commit -m "feat(mcp-ga4): add deterministic mock client for credential-free dev"
```

---

### Task 18: Ferramentas de dimensão do GA4

**Files:**
- Create: `packages/mcp-ga4/src/rankings.ts`
- Test: `packages/mcp-ga4/src/__tests__/rankings.test.ts`

**Interfaces:**
- Consumes: `Ga4ClientLike` (T17B), `assertGa4Dimension` (T17); `AnalysisTool` de `@center/mcp-core`.
- Produces:
  - `createDimensionRankingTool(client, spec): AnalysisTool` — fábrica genérica
  - `createTrafficSourcesTool(client)` — `traffic_sources`
  - `createCampaignUsersTool(client)` — `campaign_users`
  - `createDevicePerformanceTool(client)` — `device_performance`
  - `createPagePerformanceTool(client)` — `page_performance`
  - `createAppVersionsTool(client)` — `app_versions`
  - `createTopEventsTool(client)` — `top_events`
  - `createCompareEventsTool(client)` — `compare_events`

**Responde:** B4, B5, B6, B7, B8, B9, B10.

**Por que uma fábrica:** seis dessas sete ferramentas são a mesma consulta com dimensão e métrica diferentes. Escrevê-las à mão seria repetir o mesmo bug seis vezes.

- [ ] **Step 1: Escrever o teste (falhando)**

`packages/mcp-ga4/src/__tests__/rankings.test.ts`:

```ts
import {
  createAppVersionsTool, createCompareEventsTool, createDevicePerformanceTool,
  createPagePerformanceTool, createTopEventsTool, createTrafficSourcesTool,
} from '../rankings.js';
import type { Ga4ReportParams, Ga4Row } from '../client.js';
import type { Ga4ClientLike } from '../interface.js';

function fakeClient(pages: Ga4Row[][]) {
  let call = 0;
  const runReport = jest.fn(async (_params: Ga4ReportParams) => pages[call++] ?? []);
  return { client: { runReport } as unknown as Ga4ClientLike, runReport };
}

const tenant = { organizationId: 'org_1', externalIds: { ga4PropertyId: '111' } };
const period = { from: '2026-02-01', to: '2026-02-28', tenant };

describe('traffic_sources', () => {
  it('requests sessions grouped by sourceMedium', async () => {
    const { client, runReport } = fakeClient([[]]);
    await createTrafficSourcesTool(client).handler(period);
    expect(runReport.mock.calls[0]![0]).toMatchObject({
      dimensionNames: ['sessionSourceMedium'],
      metricNames: ['sessions', 'activeUsers'],
    });
  });

  it('ranks by users and reports sessions as extra', async () => {
    const { client } = fakeClient([[
      { dimensions: { sessionSourceMedium: 'google / organic' }, metrics: { sessions: 300, activeUsers: 200 } },
      { dimensions: { sessionSourceMedium: 'facebook / cpc' }, metrics: { sessions: 100, activeUsers: 80 } },
    ]]);
    const result = await createTrafficSourcesTool(client).handler(period) as { rows: Array<Record<string, unknown>> };
    expect(result.rows[0]).toMatchObject({ key: 'google / organic', value: 200 });
    expect(result.rows[0]?.extra).toMatchObject({ sessions: 300 });
  });

  it('computes each share of the period total', async () => {
    const { client } = fakeClient([[
      { dimensions: { sessionSourceMedium: 'a' }, metrics: { sessions: 0, activeUsers: 75 } },
      { dimensions: { sessionSourceMedium: 'b' }, metrics: { sessions: 0, activeUsers: 25 } },
    ]]);
    const result = await createTrafficSourcesTool(client).handler(period) as { rows: Array<{ share: number }> };
    expect(result.rows[0]?.share).toBeCloseTo(0.75, 5);
  });

  it('respects the limit', async () => {
    const { client } = fakeClient([[
      { dimensions: { sessionSourceMedium: 'a' }, metrics: { activeUsers: 3, sessions: 3 } },
      { dimensions: { sessionSourceMedium: 'b' }, metrics: { activeUsers: 2, sessions: 2 } },
      { dimensions: { sessionSourceMedium: 'c' }, metrics: { activeUsers: 1, sessions: 1 } },
    ]]);
    const result = await createTrafficSourcesTool(client).handler({ ...period, limit: 2 }) as { rows: unknown[] };
    expect(result.rows).toHaveLength(2);
  });

  it('refuses without a GA4 property id', async () => {
    const { client } = fakeClient([[]]);
    await expect(createTrafficSourcesTool(client).handler({
      ...period, tenant: { organizationId: 'org_1', externalIds: {} },
    })).rejects.toThrow('ga4PropertyId não configurado');
  });
});

describe('campaign_users', () => {
  it('groups by campaign name', async () => {
    const { client, runReport } = fakeClient([[]]);
    await createCampaignUsersTool(client).handler(period);
    expect(runReport.mock.calls[0]![0].dimensionNames).toEqual(['sessionCampaignName']);
  });
});

describe('device_performance', () => {
  it('reports sessions, users and conversion rate per device', async () => {
    const { client } = fakeClient([[
      { dimensions: { deviceCategory: 'mobile' }, metrics: { sessions: 1000, activeUsers: 800, conversions: 50 } },
      { dimensions: { deviceCategory: 'desktop' }, metrics: { sessions: 200, activeUsers: 150, conversions: 20 } },
    ]]);
    const result = await createDevicePerformanceTool(client).handler(period) as { rows: Array<Record<string, unknown>> };
    // desktop converte 10%, mobile 5% — desktop lidera mesmo com menos tráfego.
    expect(result.rows[0]?.key).toBe('desktop');
    expect(result.rows[0]?.value).toBeCloseTo(0.1, 5);
  });

  it('does not divide by zero for a device with no sessions', async () => {
    const { client } = fakeClient([[
      { dimensions: { deviceCategory: 'tablet' }, metrics: { sessions: 0, activeUsers: 0, conversions: 0 } },
    ]]);
    const result = await createDevicePerformanceTool(client).handler(period) as { rows: Array<{ value: number }> };
    expect(result.rows[0]?.value).toBe(0);
  });
});

describe('page_performance', () => {
  it('ranks pages by bounce rate so the worst page surfaces first', async () => {
    const { client } = fakeClient([[
      { dimensions: { pagePath: '/checkout' }, metrics: { screenPageViews: 500, bounceRate: 0.8 } },
      { dimensions: { pagePath: '/home' }, metrics: { screenPageViews: 2000, bounceRate: 0.2 } },
    ]]);
    const result = await createPagePerformanceTool(client).handler(period) as { rows: Array<Record<string, unknown>> };
    expect(result.rows[0]).toMatchObject({ key: '/checkout', value: 0.8 });
    expect(result.rows[0]?.extra).toMatchObject({ pageViews: 500 });
  });
});

describe('app_versions', () => {
  it('filters to app platforms and groups by version', async () => {
    const { client, runReport } = fakeClient([[]]);
    await createAppVersionsTool(client).handler(period);
    expect(runReport.mock.calls[0]![0]).toMatchObject({
      dimensionNames: ['appVersion'],
      metricNames: ['activeUsers', 'sessions'],
    });
  });

  it('ignores the empty version bucket that web traffic produces', async () => {
    const { client } = fakeClient([[
      { dimensions: { appVersion: '' }, metrics: { activeUsers: 900, sessions: 1000 } },
      { dimensions: { appVersion: '5.8.0' }, metrics: { activeUsers: 500, sessions: 700 } },
    ]]);
    const result = await createAppVersionsTool(client).handler(period) as { rows: Array<{ key: string }> };
    expect(result.rows.map((r) => r.key)).toEqual(['5.8.0']);
  });
});

describe('top_events', () => {
  it('ranks events by count', async () => {
    const { client } = fakeClient([[
      { dimensions: { eventName: 'page_view' }, metrics: { eventCount: 5000 } },
      { dimensions: { eventName: 'purchase' }, metrics: { eventCount: 120 } },
    ]]);
    const result = await createTopEventsTool(client).handler(period) as { rows: Array<{ key: string; value: number }> };
    expect(result.rows[0]).toMatchObject({ key: 'page_view', value: 5000 });
  });
});

describe('compare_events', () => {
  const comparison = {
    tenant,
    periodA: { from: '2026-01-01', to: '2026-01-31' },
    periodB: { from: '2026-02-01', to: '2026-02-28' },
  };

  it('reports the delta per event, biggest growth first', async () => {
    const { client } = fakeClient([
      [{ dimensions: { eventName: 'add_to_cart' }, metrics: { eventCount: 100 } },
       { dimensions: { eventName: 'purchase' }, metrics: { eventCount: 50 } }],
      [{ dimensions: { eventName: 'add_to_cart' }, metrics: { eventCount: 400 } },
       { dimensions: { eventName: 'purchase' }, metrics: { eventCount: 40 } }],
    ]);
    const result = await createCompareEventsTool(client).handler(comparison) as { rows: Array<Record<string, unknown>> };
    expect(result.rows[0]).toMatchObject({ key: 'add_to_cart', valueA: 100, valueB: 400, delta: 300 });
    expect(result.rows[0]?.deltaRatio).toBeCloseTo(3, 5);
  });

  it('reports a null ratio for an event absent from period A', async () => {
    const { client } = fakeClient([
      [],
      [{ dimensions: { eventName: 'novo_evento' }, metrics: { eventCount: 90 } }],
    ]);
    const result = await createCompareEventsTool(client).handler(comparison) as { rows: Array<{ deltaRatio: number | null }> };
    expect(result.rows[0]?.deltaRatio).toBeNull();
  });

  it('includes events that disappeared in period B', async () => {
    const { client } = fakeClient([
      [{ dimensions: { eventName: 'sumiu' }, metrics: { eventCount: 70 } }],
      [],
    ]);
    const result = await createCompareEventsTool(client).handler(comparison) as { rows: Array<{ key: string; delta: number }> };
    expect(result.rows.find((r) => r.key === 'sumiu')?.delta).toBe(-70);
  });
});
```

- [ ] **Step 2: Implementar `rankings.ts`**

`packages/mcp-ga4/src/rankings.ts`:

```ts
import { z } from 'zod';
import { IsoDateSchema, TenantContextSchema } from '@center/shared';
import type { AnalysisTool } from '@center/mcp-core';
import type { Ga4Row } from './client.js';
import type { Ga4ClientLike } from './interface.js';

const PeriodShape = { from: IsoDateSchema, to: IsoDateSchema, tenant: TenantContextSchema };
const PeriodSchema = z.object(PeriodShape).extend({
  limit: z.number().int().min(1).max(50).default(10),
});

const RankingOutputShape = {
  dimension: z.string(), from: z.string(), to: z.string(),
  total: z.number(), unit: z.string(),
  rows: z.array(z.object({
    key: z.string(), label: z.string(), value: z.number(),
    unit: z.string(), extra: z.record(z.string(), z.number()), share: z.number(),
  })),
};

function requirePropertyId(tenant: { organizationId: string; externalIds: Record<string, string> }): string {
  const propertyId = tenant.externalIds.ga4PropertyId;
  if (!propertyId) {
    throw new Error(`ga4PropertyId não configurado para a organização "${tenant.organizationId}"`);
  }
  return propertyId;
}

interface RankingSpec {
  name: string;
  description: string;
  dimension: string;
  /** Métricas pedidas ao GA4. A primeira nomeia o valor principal, salvo `value`. */
  metrics: string[];
  unit: 'count' | 'ratio' | 'currency';
  /** Calcula o valor de ordenação a partir das métricas da linha. */
  value: (metrics: Record<string, number>) => number;
  /** Métricas secundárias expostas em `extra`. */
  extra: (metrics: Record<string, number>) => Record<string, number>;
  /** Descarta linhas irrelevantes, ex.: versão de app vazia vinda do tráfego web. */
  keep?: (key: string) => boolean;
}

/**
 * Fábrica de rankings por dimensão. Seis das sete ferramentas desta task são a
 * mesma consulta com dimensão e métrica diferentes — escrevê-las à mão seria
 * repetir o mesmo bug seis vezes.
 */
export function createDimensionRankingTool(client: Ga4ClientLike, spec: RankingSpec): AnalysisTool {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: { ...PeriodShape, limit: z.number().optional() },
    outputSchema: RankingOutputShape,
    handler: async (args) => {
      const { from, to, tenant, limit } = PeriodSchema.parse(args);
      const propertyId = requirePropertyId(tenant);

      const rows = await client.runReport({
        propertyId,
        metricNames: spec.metrics,
        from, to,
        dimensionNames: [spec.dimension],
        dimensionFilters: {},
      });

      const mapped = rows
        .map((row: Ga4Row) => ({
          key: row.dimensions[spec.dimension] ?? '',
          value: spec.value(row.metrics),
          extra: spec.extra(row.metrics),
        }))
        .filter((row) => (spec.keep ? spec.keep(row.key) : row.key !== ''));

      const total = mapped.reduce((acc, row) => acc + row.value, 0);

      return {
        dimension: spec.dimension,
        from, to, total, unit: spec.unit,
        rows: [...mapped]
          .sort((a, b) => b.value - a.value)
          .slice(0, limit)
          .map((row) => ({
            key: row.key,
            label: row.key,
            value: row.value,
            unit: spec.unit,
            extra: row.extra,
            share: total === 0 ? 0 : row.value / total,
          })),
      };
    },
  };
}

export function createTrafficSourcesTool(client: Ga4ClientLike): AnalysisTool {
  return createDimensionRankingTool(client, {
    name: 'traffic_sources',
    description: 'Ranking de origens de tráfego (origem/mídia) por usuários no período. Use para "qual origem trouxe mais usuários".',
    dimension: 'sessionSourceMedium',
    metrics: ['sessions', 'activeUsers'],
    unit: 'count',
    value: (m) => m.activeUsers ?? 0,
    extra: (m) => ({ sessions: m.sessions ?? 0, users: m.activeUsers ?? 0 }),
  });
}

export function createCampaignUsersTool(client: Ga4ClientLike): AnalysisTool {
  return createDimensionRankingTool(client, {
    name: 'campaign_users',
    description: 'Ranking de campanhas por usuários e sessões no período. Use para "qual campanha trouxe mais usuários". Para receita por campanha, use campaign_revenue (fonte Uappi).',
    dimension: 'sessionCampaignName',
    metrics: ['sessions', 'activeUsers'],
    unit: 'count',
    value: (m) => m.activeUsers ?? 0,
    extra: (m) => ({ sessions: m.sessions ?? 0, users: m.activeUsers ?? 0 }),
  });
}

export function createDevicePerformanceTool(client: Ga4ClientLike): AnalysisTool {
  return createDimensionRankingTool(client, {
    name: 'device_performance',
    description: 'Taxa de conversão por dispositivo (conversões sobre sessões) no período. Use para "qual dispositivo converte melhor". O valor é a taxa, de 0 a 1.',
    dimension: 'deviceCategory',
    metrics: ['sessions', 'activeUsers', 'conversions'],
    unit: 'ratio',
    value: (m) => (m.sessions ? (m.conversions ?? 0) / m.sessions : 0),
    extra: (m) => ({ sessions: m.sessions ?? 0, users: m.activeUsers ?? 0, conversions: m.conversions ?? 0 }),
  });
}

export function createPagePerformanceTool(client: Ga4ClientLike): AnalysisTool {
  return createDimensionRankingTool(client, {
    name: 'page_performance',
    description: 'Páginas com maior taxa de rejeição no período, da pior para a melhor. Use para "qual página possui maior abandono". O valor é a taxa de rejeição, de 0 a 1.',
    dimension: 'pagePath',
    metrics: ['screenPageViews', 'bounceRate'],
    unit: 'ratio',
    value: (m) => m.bounceRate ?? 0,
    extra: (m) => ({ pageViews: m.screenPageViews ?? 0 }),
  });
}

export function createAppVersionsTool(client: Ga4ClientLike): AnalysisTool {
  return createDimensionRankingTool(client, {
    name: 'app_versions',
    description: 'Usuários ativos por versão do aplicativo no período. Use para "qual versão do app possui mais usuários".',
    dimension: 'appVersion',
    metrics: ['activeUsers', 'sessions'],
    unit: 'count',
    value: (m) => m.activeUsers ?? 0,
    extra: (m) => ({ sessions: m.sessions ?? 0 }),
    // Tráfego web chega com appVersion vazia; incluí-la dominaria o ranking.
    keep: (key) => key !== '' && key !== '(not set)',
  });
}

export function createTopEventsTool(client: Ga4ClientLike): AnalysisTool {
  return createDimensionRankingTool(client, {
    name: 'top_events',
    description: 'Eventos mais registrados no período, com contagem e usuários. Use para "quais eventos ocorreram hoje".',
    dimension: 'eventName',
    metrics: ['eventCount', 'activeUsers'],
    unit: 'count',
    value: (m) => m.eventCount ?? 0,
    extra: (m) => ({ users: m.activeUsers ?? 0 }),
  });
}

export function createCompareEventsTool(client: Ga4ClientLike): AnalysisTool {
  const InputSchema = z.object({
    tenant: TenantContextSchema,
    periodA: z.object({ from: IsoDateSchema, to: IsoDateSchema }),
    periodB: z.object({ from: IsoDateSchema, to: IsoDateSchema }),
    limit: z.number().int().min(1).max(50).default(10),
  });

  return {
    name: 'compare_events',
    description:
      'Compara a contagem de cada evento entre dois períodos, ordenando pelo MAIOR CRESCIMENTO ' +
      'primeiro. Use para "quais eventos cresceram após a última atualização" — periodA é antes ' +
      'da atualização, periodB depois.',
    inputSchema: {
      tenant: TenantContextSchema,
      periodA: z.object({ from: IsoDateSchema, to: IsoDateSchema }),
      periodB: z.object({ from: IsoDateSchema, to: IsoDateSchema }),
      limit: z.number().optional(),
    },
    outputSchema: {
      dimension: z.string(),
      periodA: z.object({ from: z.string(), to: z.string() }),
      periodB: z.object({ from: z.string(), to: z.string() }),
      unit: z.string(),
      rows: z.array(z.object({
        key: z.string(), label: z.string(),
        valueA: z.number(), valueB: z.number(),
        delta: z.number(), deltaRatio: z.number().nullable(),
      })),
    },
    handler: async (args) => {
      const { tenant, periodA, periodB, limit } = InputSchema.parse(args);
      const propertyId = requirePropertyId(tenant);

      const request = (period: { from: string; to: string }) =>
        client.runReport({
          propertyId,
          metricNames: ['eventCount'],
          from: period.from, to: period.to,
          dimensionNames: ['eventName'],
          dimensionFilters: {},
        });

      const [rowsA, rowsB] = await Promise.all([request(periodA), request(periodB)]);

      const toMap = (rows: Ga4Row[]) =>
        new Map(rows.map((row) => [row.dimensions.eventName ?? '', row.metrics.eventCount ?? 0]));

      const mapA = toMap(rowsA);
      const mapB = toMap(rowsB);
      // União: um evento que sumiu é informação, não ruído.
      const keys = [...new Set([...mapA.keys(), ...mapB.keys()])].filter((key) => key !== '');

      const rows = keys.map((key) => {
        const valueA = mapA.get(key) ?? 0;
        const valueB = mapB.get(key) ?? 0;
        return {
          key, label: key, valueA, valueB,
          delta: valueB - valueA,
          deltaRatio: valueA === 0 ? null : (valueB - valueA) / valueA,
        };
      });

      // Maior crescimento primeiro: é a pergunta que motiva a ferramenta.
      rows.sort((left, right) => right.delta - left.delta);

      return { dimension: 'eventName', periodA, periodB, unit: 'count', rows: rows.slice(0, limit) };
    },
  };
}
```

- [ ] **Step 3: Rodar os testes**

Run: `pnpm --filter @center/mcp-ga4 test`
Expected: PASS — 24 testes.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp-ga4
git commit -m "feat(mcp-ga4): add dimension ranking tools and event comparison"
```

---

### Task 19: Funil de checkout do GA4

**Files:**
- Create: `packages/mcp-ga4/src/funnel.ts`, `packages/mcp-ga4/src/main.ts`
- Test: `packages/mcp-ga4/src/__tests__/funnel.test.ts`

**Interfaces:**
- Consumes: `Ga4ClientLike` (T17B); `FunnelResult` de `@center/shared`.
- Produces:
  - `CHECKOUT_FUNNEL_STEPS: Array<{ key: string; label: string }>`
  - `createCheckoutFunnelTool(client: Ga4ClientLike): AnalysisTool` — `checkout_funnel` → `FunnelResult`
  - `main.ts`: MCP server `center-ga4` com provider + todas as ferramentas

**Responde:** B11, B12, B13, B14.

**A honestidade embutida na ferramenta:** o GA4 é agregado e não expõe identidade. "Quais clientes abandonaram o carrinho" só pode ser respondido como *quantos* e *em que etapa*. A ferramenta devolve um campo `identifiesUsers: false` para que o agente diga isso ao usuário em vez de fingir que tem a lista.

- [ ] **Step 1: Escrever o teste (falhando)**

`packages/mcp-ga4/src/__tests__/funnel.test.ts`:

```ts
import { createCheckoutFunnelTool } from '../funnel.js';
import type { Ga4ReportParams, Ga4Row } from '../client.js';
import type { Ga4ClientLike } from '../interface.js';

function fakeClient(rows: Ga4Row[]) {
  const runReport = jest.fn(async (_params: Ga4ReportParams) => rows);
  return { client: { runReport } as unknown as Ga4ClientLike, runReport };
}

const tenant = { organizationId: 'org_1', externalIds: { ga4PropertyId: '111' } };
const period = { from: '2026-02-01', to: '2026-02-28', tenant };

function eventRows(counts: Record<string, number>): Ga4Row[] {
  return Object.entries(counts).map(([eventName, activeUsers]) => ({
    dimensions: { eventName }, metrics: { activeUsers, eventCount: activeUsers },
  }));
}

describe('checkout_funnel', () => {
  it('requests active users grouped by event name', async () => {
    const { client, runReport } = fakeClient([]);
    await createCheckoutFunnelTool(client).handler(period);
    expect(runReport.mock.calls[0]![0]).toMatchObject({
      dimensionNames: ['eventName'], metricNames: ['activeUsers', 'eventCount'],
    });
  });

  it('builds the five standard e-commerce steps in order', async () => {
    const { client } = fakeClient(eventRows({
      view_item: 1000, add_to_cart: 400, begin_checkout: 200, add_payment_info: 120, purchase: 100,
    }));
    const result = await createCheckoutFunnelTool(client).handler(period) as { steps: Array<{ key: string; users: number }> };
    expect(result.steps.map((s) => s.key)).toEqual([
      'view_item', 'add_to_cart', 'begin_checkout', 'add_payment_info', 'purchase',
    ]);
    expect(result.steps.map((s) => s.users)).toEqual([1000, 400, 200, 120, 100]);
  });

  it('computes step conversion and drop-off', async () => {
    const { client } = fakeClient(eventRows({
      view_item: 1000, add_to_cart: 400, begin_checkout: 200, add_payment_info: 120, purchase: 100,
    }));
    const result = await createCheckoutFunnelTool(client).handler(period) as { steps: Array<Record<string, number | null>> };
    expect(result.steps[0]?.stepConversion).toBeNull();
    expect(result.steps[0]?.dropOff).toBe(0);
    expect(result.steps[1]?.stepConversion).toBeCloseTo(0.4, 5);
    expect(result.steps[1]?.dropOff).toBe(600);
  });

  it('identifies the step with the largest absolute drop-off', async () => {
    const { client } = fakeClient(eventRows({
      view_item: 1000, add_to_cart: 400, begin_checkout: 200, add_payment_info: 120, purchase: 100,
    }));
    const result = await createCheckoutFunnelTool(client).handler(period) as { worstStepKey: string };
    // A maior perda absoluta é de view_item para add_to_cart: 600 usuários.
    expect(result.worstStepKey).toBe('add_to_cart');
  });

  it('computes the overall conversion from first to last step', async () => {
    const { client } = fakeClient(eventRows({
      view_item: 1000, add_to_cart: 400, begin_checkout: 200, add_payment_info: 120, purchase: 100,
    }));
    const result = await createCheckoutFunnelTool(client).handler(period) as { overallConversion: number };
    expect(result.overallConversion).toBeCloseTo(0.1, 5);
  });

  it('states plainly that it cannot identify individual users', async () => {
    const { client } = fakeClient(eventRows({ view_item: 10, purchase: 1 }));
    const result = await createCheckoutFunnelTool(client).handler(period) as { identifiesUsers: boolean; note: string };
    expect(result.identifiesUsers).toBe(false);
    expect(result.note).toMatch(/não identifica/i);
  });

  it('treats a missing event as zero instead of dropping the step', async () => {
    const { client } = fakeClient(eventRows({ view_item: 500, purchase: 20 }));
    const result = await createCheckoutFunnelTool(client).handler(period) as { steps: Array<{ key: string; users: number }> };
    expect(result.steps).toHaveLength(5);
    expect(result.steps.find((s) => s.key === 'begin_checkout')?.users).toBe(0);
  });

  it('does not divide by zero when the first step has no users', async () => {
    const { client } = fakeClient([]);
    const result = await createCheckoutFunnelTool(client).handler(period) as {
      overallConversion: number; worstStepKey: string | null; steps: Array<{ stepConversion: number | null }>;
    };
    expect(result.overallConversion).toBe(0);
    expect(result.worstStepKey).toBeNull();
    expect(result.steps[1]?.stepConversion).toBe(0);
  });

  it('refuses without a GA4 property id', async () => {
    const { client } = fakeClient([]);
    await expect(createCheckoutFunnelTool(client).handler({
      ...period, tenant: { organizationId: 'org_1', externalIds: {} },
    })).rejects.toThrow('ga4PropertyId não configurado');
  });
});
```

- [ ] **Step 2: Implementar `funnel.ts`**

`packages/mcp-ga4/src/funnel.ts`:

```ts
import { z } from 'zod';
import { IsoDateSchema, TenantContextSchema } from '@center/shared';
import type { AnalysisTool } from '@center/mcp-core';
import type { Ga4ClientLike } from './interface.js';

/**
 * Eventos padrão de e-commerce do GA4, na ordem do funil. Se a loja não os
 * dispara, os passos vêm zerados — o que é informação, não erro.
 */
export const CHECKOUT_FUNNEL_STEPS: Array<{ key: string; label: string }> = [
  { key: 'view_item', label: 'Viu produto' },
  { key: 'add_to_cart', label: 'Adicionou ao carrinho' },
  { key: 'begin_checkout', label: 'Iniciou o checkout' },
  { key: 'add_payment_info', label: 'Informou pagamento' },
  { key: 'purchase', label: 'Comprou' },
];

const NOTE =
  'O GA4 é agregado e não identifica pessoas: este funil informa QUANTOS usuários ' +
  'abandonaram e EM QUAL etapa, nunca quais clientes. Para recuperar contatos de ' +
  'carrinho abandonado seria necessário um endpoint administrativo da loja.';

export function createCheckoutFunnelTool(client: Ga4ClientLike): AnalysisTool {
  const InputSchema = z.object({
    from: IsoDateSchema, to: IsoDateSchema, tenant: TenantContextSchema,
  });

  return {
    name: 'checkout_funnel',
    description:
      'Funil de compra no período (viu produto → carrinho → checkout → pagamento → compra), ' +
      'com usuários por etapa, conversão entre etapas e abandono. Responde "qual etapa do ' +
      'checkout possui maior abandono", "qual funil converte menos" e quantos abandonaram ' +
      'o carrinho. NÃO identifica clientes individualmente.',
    inputSchema: { from: IsoDateSchema, to: IsoDateSchema, tenant: TenantContextSchema },
    outputSchema: {
      from: z.string(), to: z.string(),
      steps: z.array(z.object({
        key: z.string(), label: z.string(), users: z.number(),
        stepConversion: z.number().nullable(), dropOff: z.number(),
      })),
      worstStepKey: z.string().nullable(),
      overallConversion: z.number(),
      identifiesUsers: z.boolean(),
      note: z.string(),
    },
    handler: async (args) => {
      const { from, to, tenant } = InputSchema.parse(args);
      const propertyId = tenant.externalIds.ga4PropertyId;
      if (!propertyId) {
        throw new Error(`ga4PropertyId não configurado para a organização "${tenant.organizationId}"`);
      }

      const rows = await client.runReport({
        propertyId,
        metricNames: ['activeUsers', 'eventCount'],
        from, to,
        dimensionNames: ['eventName'],
        dimensionFilters: {},
      });

      const usersByEvent = new Map(
        rows.map((row) => [row.dimensions.eventName ?? '', row.metrics.activeUsers ?? 0]),
      );

      let previousUsers: number | null = null;
      const steps = CHECKOUT_FUNNEL_STEPS.map((step) => {
        const users = usersByEvent.get(step.key) ?? 0;
        const stepConversion = previousUsers === null
          ? null
          : previousUsers === 0 ? 0 : users / previousUsers;
        const dropOff = previousUsers === null ? 0 : Math.max(0, previousUsers - users);
        previousUsers = users;
        return { key: step.key, label: step.label, users, stepConversion, dropOff };
      });

      const firstUsers = steps[0]?.users ?? 0;
      const lastUsers = steps[steps.length - 1]?.users ?? 0;

      // Maior perda ABSOLUTA — é onde consertar rende mais, e é o que a
      // pergunta "qual etapa abandona mais" realmente quer saber.
      const worst = steps.reduce<{ key: string; dropOff: number } | null>(
        (best, step) => (best === null || step.dropOff > best.dropOff
          ? { key: step.key, dropOff: step.dropOff }
          : best),
        null,
      );

      return {
        from, to, steps,
        worstStepKey: worst && worst.dropOff > 0 ? worst.key : null,
        overallConversion: firstUsers === 0 ? 0 : lastUsers / firstUsers,
        identifiesUsers: false,
        note: NOTE,
      };
    },
  };
}
```

- [ ] **Step 3: Implementar `main.ts`**

`packages/mcp-ga4/src/main.ts`:

```ts
import { createMetricServer, startStdio } from '@center/mcp-core';
import { Ga4Client } from './client.js';
import { MockGa4Client } from './mock-client.js';
import type { Ga4ClientLike } from './interface.js';
import { createGa4Provider } from './provider.js';
import {
  createAppVersionsTool, createCampaignUsersTool, createCompareEventsTool,
  createDevicePerformanceTool, createPagePerformanceTool, createTopEventsTool,
  createTrafficSourcesTool,
} from './rankings.js';
import { createCheckoutFunnelTool } from './funnel.js';

// MOCK_EXTERNAL_APIS=true (T4, T17B) roda o servidor inteiro contra fixtures
// determinísticas — sem service account, sem propriedade GA4 real.
const mockMode = process.env.MOCK_EXTERNAL_APIS === 'true';

let client: Ga4ClientLike;
if (mockMode) {
  client = new MockGa4Client();
} else {
  const credentialsJson = process.env.GA4_CREDENTIALS_JSON;
  if (!credentialsJson) {
    console.error('mcp-ga4: GA4_CREDENTIALS_JSON é obrigatório (JSON da service account)');
    process.exit(1);
  }
  client = Ga4Client.fromCredentialsJson(credentialsJson);
}

await startStdio(
  createMetricServer({
    name: 'center-ga4',
    version: '1.0.0',
    provider: createGa4Provider(client),
    tools: [
      createTrafficSourcesTool(client),
      createCampaignUsersTool(client),
      createDevicePerformanceTool(client),
      createPagePerformanceTool(client),
      createAppVersionsTool(client),
      createTopEventsTool(client),
      createCompareEventsTool(client),
      createCheckoutFunnelTool(client),
    ],
  }),
);
```

- [ ] **Step 4: Rodar os testes**

Run: `pnpm --filter @center/mcp-ga4 test`
Expected: PASS — 33 testes.

- [ ] **Step 5: Smoke test contra o GA4 real**

Pré-requisitos: a service account precisa do papel **Viewer** na propriedade (Admin → Property Access Management) e a **Google Analytics Data API** habilitada no projeto GCP.

```bash
pnpm --filter @center/mcp-ga4 build
GA4_CREDENTIALS_JSON="$(cat ./ga4-service-account.json)" \
  npx @modelcontextprotocol/inspector node packages/mcp-ga4/dist/main.js
```

Valide as 14 perguntas do Grupo B e compare os totais com a interface do GA4. **Divergências de até ~2% são esperadas** (sampling e freshness); acima disso, investigue antes de seguir.

Se `checkout_funnel` retornar zeros em todas as etapas, a loja não dispara os eventos padrão de e-commerce — isso é a Premissa 5 do roadmap. Registre e trate como bloqueio das perguntas B11–B14.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-ga4
git commit -m "feat(mcp-ga4): add checkout funnel tool and wire the MCP server entrypoint"
```

---

# FASE 5 — Correlação entre fontes (Sprint 6)

**Objetivo:** Grupo D respondível.

**A decisão que evita o pior erro possível deste projeto.** Perguntas como "o aumento de usuários impactou o faturamento?" pedem que o sistema relacione duas séries de fontes diferentes. Há três formas de fazer isso, e duas são ruins:
- **Deixar o LLM correlacionar de cabeça** — inaceitável. O system prompt proíbe o modelo de fazer aritmética; se ele calculasse correlação, calcularia errado com confiança total.
- **Ferramenta por pergunta** — 13 ferramentas quase idênticas, 13 lugares para o mesmo bug.
- **Uma ferramenta que compõe duas séries quaisquer do gateway** — determinística, testável, e serve a todas as perguntas de correlação temporal. É esta.

`correlate_metrics` roda **dentro do gateway**, não num MCP server: ela precisa consultar duas fontes diferentes, e é o gateway que enxerga todas.

**Onde os testes entram:** correlação é matemática pura. Os testes usam séries construídas à mão com resultado conhecido — correlação perfeita positiva, perfeita negativa, ausência de correlação, variância zero. É o tipo de código onde um teste vale mais do que uma revisão.

---

### Task 20: Ferramenta de correlação de métricas

**Files:**
- Create: `packages/mcp-core/src/correlate.ts`
- Modify: `packages/mcp-core/src/index.ts`
- Test: `packages/mcp-core/src/__tests__/correlate.test.ts`

**Interfaces:**
- Consumes: `MetricGateway` (T11); `MetricSeries` de `@center/shared`.
- Produces:
  - `pearson(a: number[], b: number[]): number | null`
  - `interface CorrelationResult { metricA, metricB, from, to, granularity, buckets, coefficient, strength, direction, totalA, totalB, series, caveat }`
  - `type CorrelationStrength = 'forte' | 'moderada' | 'fraca' | 'desprezivel' | 'indeterminada'`
  - `describeStrength(coefficient: number | null): CorrelationStrength`
  - `correlateMetrics(gateway, input: CorrelateInput): Promise<CorrelationResult>`
  - `interface CorrelateInput { metricIdA, metricIdB, from, to, granularity, tenant }`

- [ ] **Step 1: Escrever o teste (falhando)**

`packages/mcp-core/src/__tests__/correlate.test.ts`:

```ts
import type { MetricSeries } from '@center/shared';
import { correlateMetrics, describeStrength, pearson } from '../correlate.js';
import type { MetricGateway } from '../gateway.js';

describe('pearson', () => {
  it('returns 1 for a perfectly increasing pair', () => {
    expect(pearson([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 6);
  });

  it('returns -1 for a perfectly inverse pair', () => {
    expect(pearson([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 6);
  });

  it('returns roughly zero for unrelated series', () => {
    expect(Math.abs(pearson([1, 2, 3, 4], [5, 5.1, 4.9, 5]) ?? 1)).toBeLessThan(0.5);
  });

  it('returns null when one series has no variance', () => {
    expect(pearson([1, 2, 3], [7, 7, 7])).toBeNull();
  });

  it('returns null for fewer than three points', () => {
    expect(pearson([1, 2], [3, 4])).toBeNull();
  });

  it('returns null when the lengths differ', () => {
    expect(pearson([1, 2, 3], [1, 2])).toBeNull();
  });
});

describe('describeStrength', () => {
  it.each([
    [0.9, 'forte'], [-0.85, 'forte'],
    [0.6, 'moderada'], [-0.55, 'moderada'],
    [0.35, 'fraca'], [-0.3, 'fraca'],
    [0.1, 'desprezivel'], [0, 'desprezivel'],
  ])('classifies %s as %s', (coefficient, expected) => {
    expect(describeStrength(coefficient)).toBe(expected);
  });

  it('classifies null as indeterminada', () => {
    expect(describeStrength(null)).toBe('indeterminada');
  });
});

const tenant = { organizationId: 'org_1', externalIds: {} };

function series(metricId: string, values: number[], unit: MetricSeries['unit'] = 'count'): MetricSeries {
  return {
    metricId,
    source: metricId.startsWith('commerce') ? 'commerce' : 'ga4',
    unit,
    granularity: 'day',
    total: values.reduce((acc, value) => acc + value, 0),
    points: values.map((value, index) => ({
      date: `2026-02-${String(index + 1).padStart(2, '0')}`, value,
    })),
  };
}

function fakeGateway(map: Record<string, MetricSeries>) {
  const queryBatch = jest.fn(async (queries: Array<{ metricId: string }>) =>
    queries.map((query) => map[query.metricId]!));
  return { gateway: { queryBatch } as unknown as MetricGateway, queryBatch };
}

const input = {
  metricIdA: 'ga4.active_users',
  metricIdB: 'commerce.revenue',
  from: '2026-02-01', to: '2026-02-05',
  granularity: 'day' as const,
  tenant,
};

describe('correlateMetrics', () => {
  it('fetches both series in a single batch', async () => {
    const { gateway, queryBatch } = fakeGateway({
      'ga4.active_users': series('ga4.active_users', [10, 20, 30, 40, 50]),
      'commerce.revenue': series('commerce.revenue', [100, 200, 300, 400, 500], 'currency'),
    });
    await correlateMetrics(gateway, input);
    expect(queryBatch).toHaveBeenCalledTimes(1);
    expect(queryBatch.mock.calls[0]![0]).toHaveLength(2);
  });

  it('reports a strong positive correlation', async () => {
    const { gateway } = fakeGateway({
      'ga4.active_users': series('ga4.active_users', [10, 20, 30, 40, 50]),
      'commerce.revenue': series('commerce.revenue', [100, 200, 300, 400, 500], 'currency'),
    });
    const result = await correlateMetrics(gateway, input);
    expect(result.coefficient).toBeCloseTo(1, 6);
    expect(result.strength).toBe('forte');
    expect(result.direction).toBe('positiva');
  });

  it('reports a negative direction when one metric falls as the other rises', async () => {
    const { gateway } = fakeGateway({
      'ga4.active_users': series('ga4.active_users', [10, 20, 30, 40, 50]),
      'commerce.revenue': series('commerce.revenue', [500, 400, 300, 200, 100], 'currency'),
    });
    const result = await correlateMetrics(gateway, input);
    expect(result.direction).toBe('negativa');
    expect(result.coefficient).toBeCloseTo(-1, 6);
  });

  it('aligns the two series by bucket date', async () => {
    const { gateway } = fakeGateway({
      'ga4.active_users': series('ga4.active_users', [10, 20, 30, 40, 50]),
      'commerce.revenue': series('commerce.revenue', [100, 200, 300, 400, 500], 'currency'),
    });
    const result = await correlateMetrics(gateway, input);
    expect(result.series).toHaveLength(5);
    expect(result.series[0]).toEqual({ date: '2026-02-01', valueA: 10, valueB: 100 });
  });

  it('drops buckets present in only one series instead of pairing them wrongly', async () => {
    const short = series('commerce.revenue', [100, 200, 300], 'currency');
    const { gateway } = fakeGateway({
      'ga4.active_users': series('ga4.active_users', [10, 20, 30, 40, 50]),
      'commerce.revenue': short,
    });
    const result = await correlateMetrics(gateway, input);
    expect(result.buckets).toBe(3);
  });

  it('returns an indeterminate result when a metric never changes', async () => {
    const { gateway } = fakeGateway({
      'ga4.active_users': series('ga4.active_users', [10, 20, 30, 40, 50]),
      'commerce.revenue': series('commerce.revenue', [7, 7, 7, 7, 7], 'currency'),
    });
    const result = await correlateMetrics(gateway, input);
    expect(result.coefficient).toBeNull();
    expect(result.strength).toBe('indeterminada');
    expect(result.direction).toBe('indefinida');
  });

  it('returns an indeterminate result for a period too short to correlate', async () => {
    const { gateway } = fakeGateway({
      'ga4.active_users': series('ga4.active_users', [10, 20]),
      'commerce.revenue': series('commerce.revenue', [100, 200], 'currency'),
    });
    const result = await correlateMetrics(gateway, { ...input, to: '2026-02-02' });
    expect(result.coefficient).toBeNull();
    expect(result.strength).toBe('indeterminada');
  });

  it('always carries the causality caveat', async () => {
    const { gateway } = fakeGateway({
      'ga4.active_users': series('ga4.active_users', [10, 20, 30, 40, 50]),
      'commerce.revenue': series('commerce.revenue', [100, 200, 300, 400, 500], 'currency'),
    });
    const result = await correlateMetrics(gateway, input);
    expect(result.caveat).toMatch(/não (implica|prova) causa/i);
  });

  it('reports the totals and units of both metrics', async () => {
    const { gateway } = fakeGateway({
      'ga4.active_users': series('ga4.active_users', [10, 20, 30, 40, 50]),
      'commerce.revenue': series('commerce.revenue', [100, 200, 300, 400, 500], 'currency'),
    });
    const result = await correlateMetrics(gateway, input);
    expect(result.metricA).toMatchObject({ id: 'ga4.active_users', unit: 'count', total: 150 });
    expect(result.metricB).toMatchObject({ id: 'commerce.revenue', unit: 'currency', total: 1500 });
  });

  it('rejects correlating a metric with itself', async () => {
    const { gateway } = fakeGateway({
      'ga4.active_users': series('ga4.active_users', [10, 20, 30, 40, 50]),
    });
    await expect(correlateMetrics(gateway, { ...input, metricIdB: 'ga4.active_users' }))
      .rejects.toThrow('correlacionar uma métrica com ela mesma');
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `pnpm --filter @center/mcp-core test -- correlate.test.ts`
Expected: FAIL — `Cannot find module '../correlate.js'`.

- [ ] **Step 3: Implementar `correlate.ts`**

`packages/mcp-core/src/correlate.ts`:

```ts
import type {
  Granularity, MetricQuery, MetricUnit, TenantContext,
} from '@center/shared';
import type { MetricGateway } from './gateway.js';

export type CorrelationStrength = 'forte' | 'moderada' | 'fraca' | 'desprezivel' | 'indeterminada';
export type CorrelationDirection = 'positiva' | 'negativa' | 'indefinida';

/** Menos de 3 pontos não sustenta nenhuma afirmação sobre relação entre séries. */
const MIN_POINTS = 3;

const CAVEAT =
  'Correlação não implica causa. Este número mede se as duas séries se moveram juntas ' +
  'no período — não prova que uma causou a outra, e um fator externo pode explicar as duas.';

/**
 * Coeficiente de Pearson. Devolve `null` — não zero — quando o cálculo não é
 * definido: séries curtas demais, tamanhos diferentes ou variância zero.
 * Zero significaria "não há relação", o que é uma afirmação; `null` significa
 * "não dá para dizer", que é a verdade nesses casos.
 */
export function pearson(a: readonly number[], b: readonly number[]): number | null {
  if (a.length !== b.length || a.length < MIN_POINTS) return null;

  const n = a.length;
  const meanA = a.reduce((acc, value) => acc + value, 0) / n;
  const meanB = b.reduce((acc, value) => acc + value, 0) / n;

  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;

  for (let index = 0; index < n; index += 1) {
    const deltaA = (a[index] ?? 0) - meanA;
    const deltaB = (b[index] ?? 0) - meanB;
    covariance += deltaA * deltaB;
    varianceA += deltaA * deltaA;
    varianceB += deltaB * deltaB;
  }

  const denominator = Math.sqrt(varianceA * varianceB);
  if (denominator === 0) return null;

  return covariance / denominator;
}

export function describeStrength(coefficient: number | null): CorrelationStrength {
  if (coefficient === null || Number.isNaN(coefficient)) return 'indeterminada';
  const magnitude = Math.abs(coefficient);
  if (magnitude >= 0.7) return 'forte';
  if (magnitude >= 0.4) return 'moderada';
  if (magnitude >= 0.2) return 'fraca';
  return 'desprezivel';
}

export interface CorrelateInput {
  metricIdA: string;
  metricIdB: string;
  from: string;
  to: string;
  granularity: Granularity;
  tenant: TenantContext;
}

export interface CorrelationResult {
  metricA: { id: string; unit: MetricUnit; total: number };
  metricB: { id: string; unit: MetricUnit; total: number };
  from: string;
  to: string;
  granularity: Granularity;
  buckets: number;
  coefficient: number | null;
  strength: CorrelationStrength;
  direction: CorrelationDirection;
  series: Array<{ date: string; valueA: number; valueB: number }>;
  caveat: string;
}

/**
 * Correlaciona duas métricas quaisquer no tempo.
 *
 * Vive no gateway, não num MCP server, porque precisa enxergar todas as fontes —
 * é o que permite cruzar `ga4.active_users` com `commerce.revenue` sem que
 * nenhum servidor conheça o outro.
 */
export async function correlateMetrics(
  gateway: MetricGateway,
  input: CorrelateInput,
): Promise<CorrelationResult> {
  if (input.metricIdA === input.metricIdB) {
    throw new Error('não faz sentido correlacionar uma métrica com ela mesma');
  }

  const base = {
    from: input.from, to: input.to,
    granularity: input.granularity, tenant: input.tenant,
  };
  const queries: MetricQuery[] = [
    { ...base, metricId: input.metricIdA },
    { ...base, metricId: input.metricIdB },
  ];

  const [seriesA, seriesB] = await gateway.queryBatch(queries);
  if (!seriesA || !seriesB) throw new Error('não foi possível obter as duas séries');

  // Alinhamento por data: séries de fontes diferentes podem ter buckets
  // distintos, e parear por índice cruzaria dias errados silenciosamente.
  const mapB = new Map(seriesB.points.map((point) => [point.date, point.value]));
  const aligned = seriesA.points
    .filter((point) => mapB.has(point.date))
    .map((point) => ({ date: point.date, valueA: point.value, valueB: mapB.get(point.date)! }));

  const coefficient = pearson(
    aligned.map((row) => row.valueA),
    aligned.map((row) => row.valueB),
  );

  return {
    metricA: { id: seriesA.metricId, unit: seriesA.unit, total: seriesA.total },
    metricB: { id: seriesB.metricId, unit: seriesB.unit, total: seriesB.total },
    from: input.from, to: input.to, granularity: input.granularity,
    buckets: aligned.length,
    coefficient,
    strength: describeStrength(coefficient),
    direction: coefficient === null ? 'indefinida' : coefficient >= 0 ? 'positiva' : 'negativa',
    series: aligned,
    caveat: CAVEAT,
  };
}
```

Adicione a `packages/mcp-core/src/index.ts`:

```ts
export * from './correlate.js';
```

- [ ] **Step 4: Rodar os testes**

Run: `pnpm --filter @center/mcp-core test`
Expected: PASS — 5 suites, 59 testes.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-core
git commit -m "feat(mcp-core): add cross-source metric correlation with honest null handling"
```

---

### Task 21: Impacto de versão do aplicativo

**Files:**
- Create: `apps/api/src/analysis/app-version-impact.ts`
- Test: `apps/api/src/__tests__/app-version-impact.test.ts`

**Interfaces:**
- Consumes: `MetricGateway` (T11); `correlateMetrics` (T20).
- Produces:
  - `interface VersionImpactInput { gateway, tenant, version, releaseDate, windowDays?, today }`
  - `interface VersionImpactResult { version, releaseDate, before, after, revenueDelta, revenueDeltaRatio, ordersDelta, usersDelta, adoption, verdict, caveat }`
  - `type ImpactVerdict = 'melhorou' | 'piorou' | 'sem-mudanca-relevante' | 'inconclusivo'`
  - `analyzeAppVersionImpact(input: VersionImpactInput): Promise<VersionImpactResult>`
  - `RELEVANCE_THRESHOLD = 0.05`

**Responde:** D1 ("quanto vendemos após a versão 5.8?"), D2 ("a atualização aumentou as vendas?").

**Por que não é uma correlação:** a pergunta é sobre um **evento pontual** (o lançamento), não sobre duas séries se movendo juntas. A ferramenta correta compara janelas simétricas antes e depois, e diz explicitamente que outros fatores podem explicar a diferença. Vive em `apps/api` e não num MCP server porque compõe duas fontes, como a T20.

- [ ] **Step 1: Escrever o teste (falhando)**

`apps/api/src/__tests__/app-version-impact.test.ts`:

```ts
import type { MetricSeries } from '@center/shared';
import type { MetricGateway } from '@center/mcp-core';
import { analyzeAppVersionImpact } from '../analysis/app-version-impact.js';

const tenant = { organizationId: 'org_1', externalIds: { ga4PropertyId: '111' } };

function series(metricId: string, total: number, unit: MetricSeries['unit'] = 'count'): MetricSeries {
  return {
    metricId, source: metricId.startsWith('commerce') ? 'commerce' : 'ga4',
    unit, granularity: 'day', total,
    points: [{ date: '2026-02-01', value: total }],
  };
}

/** Devolve valores diferentes conforme a janela pedida (antes vs. depois). */
function fakeGateway(before: Record<string, number>, after: Record<string, number>, adoptionRows = 0) {
  const queryBatch = jest.fn(async (queries: Array<{ metricId: string; from: string }>) =>
    queries.map((query) => {
      const window = query.from < '2026-02-01' ? before : after;
      const unit = query.metricId === 'commerce.revenue' ? 'currency' : 'count';
      return series(query.metricId, window[query.metricId] ?? 0, unit);
    }));

  const callTool = jest.fn(async () => ({
    rows: adoptionRows === 0 ? [] : [
      { key: '5.8.0', label: '5.8.0', value: adoptionRows, unit: 'count', extra: {}, share: 0.6 },
      { key: '5.7.0', label: '5.7.0', value: 100, unit: 'count', extra: {}, share: 0.4 },
    ],
  }));

  return { gateway: { queryBatch, callTool } as unknown as MetricGateway, queryBatch, callTool };
}

const base = {
  tenant, version: '5.8.0', releaseDate: '2026-02-01',
  windowDays: 14, today: '2026-03-01',
};

describe('analyzeAppVersionImpact', () => {
  it('compares symmetric windows around the release date', async () => {
    const { gateway, queryBatch } = fakeGateway(
      { 'commerce.revenue': 100000 }, { 'commerce.revenue': 150000 },
    );
    await analyzeAppVersionImpact({ gateway, ...base });

    const froms = queryBatch.mock.calls.flatMap((call) => call[0].map((q) => `${q.from}`));
    // 14 dias antes: 2026-01-18 a 2026-01-31. 14 dias depois: 2026-02-01 a 2026-02-14.
    expect(froms).toContain('2026-01-18');
    expect(froms).toContain('2026-02-01');
  });

  it('reports the revenue delta and its ratio', async () => {
    const { gateway } = fakeGateway(
      { 'commerce.revenue': 100000, 'commerce.orders': 50, 'ga4.active_users': 1000 },
      { 'commerce.revenue': 150000, 'commerce.orders': 60, 'ga4.active_users': 1200 },
    );
    const result = await analyzeAppVersionImpact({ gateway, ...base });
    expect(result.revenueDelta).toBe(50000);
    expect(result.revenueDeltaRatio).toBeCloseTo(0.5, 5);
    expect(result.ordersDelta).toBe(10);
    expect(result.usersDelta).toBe(200);
  });

  it('judges a meaningful rise as "melhorou"', async () => {
    const { gateway } = fakeGateway({ 'commerce.revenue': 100000 }, { 'commerce.revenue': 150000 });
    expect((await analyzeAppVersionImpact({ gateway, ...base })).verdict).toBe('melhorou');
  });

  it('judges a meaningful drop as "piorou"', async () => {
    const { gateway } = fakeGateway({ 'commerce.revenue': 150000 }, { 'commerce.revenue': 100000 });
    expect((await analyzeAppVersionImpact({ gateway, ...base })).verdict).toBe('piorou');
  });

  it('judges a change under the relevance threshold as no real change', async () => {
    // 2% de variação não sustenta afirmar que a atualização mudou as vendas.
    const { gateway } = fakeGateway({ 'commerce.revenue': 100000 }, { 'commerce.revenue': 102000 });
    expect((await analyzeAppVersionImpact({ gateway, ...base })).verdict).toBe('sem-mudanca-relevante');
  });

  it('is inconclusive when there was no revenue before the release', async () => {
    const { gateway } = fakeGateway({ 'commerce.revenue': 0 }, { 'commerce.revenue': 90000 });
    const result = await analyzeAppVersionImpact({ gateway, ...base });
    expect(result.verdict).toBe('inconclusivo');
    expect(result.revenueDeltaRatio).toBeNull();
  });

  it('is inconclusive when the after window has not fully elapsed', async () => {
    const result = await analyzeAppVersionImpact({
      gateway: fakeGateway({ 'commerce.revenue': 100000 }, { 'commerce.revenue': 150000 }).gateway,
      ...base, releaseDate: '2026-02-25', today: '2026-03-01',
    });
    // Só 5 dias desde o lançamento contra uma janela de 14: comparar seria injusto.
    expect(result.verdict).toBe('inconclusivo');
  });

  it('reports the adoption share of the version', async () => {
    const { gateway } = fakeGateway(
      { 'commerce.revenue': 100000 }, { 'commerce.revenue': 150000 }, 150,
    );
    const result = await analyzeAppVersionImpact({ gateway, ...base });
    expect(result.adoption).toMatchObject({ users: 150, share: 0.6 });
  });

  it('reports null adoption when the version never appears in GA4', async () => {
    const { gateway } = fakeGateway({ 'commerce.revenue': 100000 }, { 'commerce.revenue': 150000 }, 0);
    expect((await analyzeAppVersionImpact({ gateway, ...base })).adoption).toBeNull();
  });

  it('always carries the causality caveat', async () => {
    const { gateway } = fakeGateway({ 'commerce.revenue': 100000 }, { 'commerce.revenue': 150000 });
    const result = await analyzeAppVersionImpact({ gateway, ...base });
    expect(result.caveat).toMatch(/outros fatores/i);
  });

  it('rejects a release date in the future', async () => {
    const { gateway } = fakeGateway({}, {});
    await expect(analyzeAppVersionImpact({
      gateway, ...base, releaseDate: '2026-06-01', today: '2026-03-01',
    })).rejects.toThrow('data de lançamento no futuro');
  });
});
```

- [ ] **Step 2: Implementar `app-version-impact.ts`**

`apps/api/src/analysis/app-version-impact.ts`:

```ts
import type { MetricQuery, TenantContext } from '@center/shared';
import type { MetricGateway } from '@center/mcp-core';

/** Abaixo de 5% de variação não afirmamos que houve mudança. */
export const RELEVANCE_THRESHOLD = 0.05;
const DEFAULT_WINDOW_DAYS = 14;

const CAVEAT =
  'Outros fatores podem explicar a diferença — sazonalidade, campanhas ativas, promoções ' +
  'ou mudanças de preço no mesmo período. Esta comparação mostra o que aconteceu antes e ' +
  'depois do lançamento, não prova que a atualização foi a causa.';

export type ImpactVerdict = 'melhorou' | 'piorou' | 'sem-mudanca-relevante' | 'inconclusivo';

export interface VersionImpactInput {
  gateway: MetricGateway;
  tenant: TenantContext;
  version: string;
  releaseDate: string;
  windowDays?: number;
  today: string;
}

export interface VersionImpactResult {
  version: string;
  releaseDate: string;
  windowDays: number;
  before: { from: string; to: string; revenueCents: number; orders: number; users: number };
  after: { from: string; to: string; revenueCents: number; orders: number; users: number };
  revenueDelta: number;
  revenueDeltaRatio: number | null;
  ordersDelta: number;
  usersDelta: number;
  adoption: { users: number; share: number } | null;
  verdict: ImpactVerdict;
  caveat: string;
}

function shiftDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  );
}

const METRIC_IDS = ['commerce.revenue', 'commerce.orders', 'ga4.active_users'] as const;

/**
 * Compara janelas simétricas antes e depois do lançamento de uma versão.
 *
 * Não é correlação: a pergunta é sobre um evento pontual, não sobre duas séries
 * se movendo juntas. Janelas simétricas evitam a comparação injusta de "duas
 * semanas antes contra três dias depois", que sempre favorece o "antes".
 */
export async function analyzeAppVersionImpact(
  input: VersionImpactInput,
): Promise<VersionImpactResult> {
  const windowDays = input.windowDays ?? DEFAULT_WINDOW_DAYS;

  const elapsed = daysBetween(input.releaseDate, input.today);
  if (elapsed < 0) {
    throw new Error(`data de lançamento no futuro: ${input.releaseDate}`);
  }

  const before = { from: shiftDays(input.releaseDate, -windowDays), to: shiftDays(input.releaseDate, -1) };
  // A janela "depois" nunca ultrapassa hoje.
  const afterEnd = shiftDays(input.releaseDate, windowDays - 1);
  const after = { from: input.releaseDate, to: afterEnd <= input.today ? afterEnd : input.today };

  const buildQueries = (window: { from: string; to: string }): MetricQuery[] =>
    METRIC_IDS.map((metricId) => ({
      metricId, from: window.from, to: window.to,
      granularity: 'day' as const, tenant: input.tenant,
    }));

  const [beforeSeries, afterSeries] = await Promise.all([
    input.gateway.queryBatch(buildQueries(before)),
    input.gateway.queryBatch(buildQueries(after)),
  ]);

  const totalOf = (list: typeof beforeSeries, metricId: string): number =>
    list.find((item) => item.metricId === metricId)?.total ?? 0;

  const beforeTotals = {
    ...before,
    revenueCents: totalOf(beforeSeries, 'commerce.revenue'),
    orders: totalOf(beforeSeries, 'commerce.orders'),
    users: totalOf(beforeSeries, 'ga4.active_users'),
  };
  const afterTotals = {
    ...after,
    revenueCents: totalOf(afterSeries, 'commerce.revenue'),
    orders: totalOf(afterSeries, 'commerce.orders'),
    users: totalOf(afterSeries, 'ga4.active_users'),
  };

  const revenueDelta = afterTotals.revenueCents - beforeTotals.revenueCents;
  const revenueDeltaRatio = beforeTotals.revenueCents === 0
    ? null
    : revenueDelta / beforeTotals.revenueCents;

  // Adoção da versão: se quase ninguém atualizou, a comparação não diz nada
  // sobre a versão — diz sobre o período.
  let adoption: { users: number; share: number } | null = null;
  try {
    const ranking = await input.gateway.callTool<{
      rows: Array<{ key: string; value: number; share: number }>;
    }>('ga4', 'app_versions', { from: after.from, to: after.to, tenant: input.tenant, limit: 50 });
    const row = ranking.rows.find((item) => item.key === input.version);
    if (row) adoption = { users: row.value, share: row.share };
  } catch {
    // Adoção é informação de apoio; sua ausência não invalida a comparação.
  }

  const windowIncomplete = elapsed < windowDays;
  const verdict: ImpactVerdict =
    windowIncomplete || revenueDeltaRatio === null
      ? 'inconclusivo'
      : Math.abs(revenueDeltaRatio) < RELEVANCE_THRESHOLD
        ? 'sem-mudanca-relevante'
        : revenueDeltaRatio > 0 ? 'melhorou' : 'piorou';

  return {
    version: input.version,
    releaseDate: input.releaseDate,
    windowDays,
    before: beforeTotals,
    after: afterTotals,
    revenueDelta,
    revenueDeltaRatio,
    ordersDelta: afterTotals.orders - beforeTotals.orders,
    usersDelta: afterTotals.users - beforeTotals.users,
    adoption,
    verdict,
    caveat: CAVEAT,
  };
}
```

- [ ] **Step 3: Rodar os testes**

Run: `pnpm --filter @center/api test -- app-version-impact.test.ts`
Expected: PASS — 11 testes.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/analysis apps/api/src/__tests__/app-version-impact.test.ts
git commit -m "feat(analysis): add app version impact comparison with symmetric windows"
```

---

# FASE 6 — API e Dashboard (Sprints 7–8)

**Objetivo:** expor tudo por HTTP com autenticação e escopo de tenant, e uma dashboard navegável.

**Invariante de segurança da fase:** o corpo das requisições **não contém tenant**. Ele vem exclusivamente do JWT, via `resolveTenant`. Um cliente não tem como pedir dados de outra organização porque não existe campo onde escrevê-lo. Quatro testes guardam essa propriedade (T23); enfraquecer qualquer um deles é bloqueio de merge.

**Onde os testes entram:** tudo por `fastify.inject()` — sem porta, sem rede. No frontend, MSW intercepta HTTP, então nenhum teste faz `jest.mock` do cliente de API: os testes ficam acoplados ao contrato HTTP, não à implementação.

**Ordem de execução:** T22 → T23 → **T9** (atribuição, adiada da Fase 1) → T24 → T25 → T26 → T27 → T28.

---

### Task 22: Servidor Fastify, autenticação e resolução de tenant

**Files:**
- Create: `apps/api/src/auth/{password.ts,jwt.ts,routes.ts}`, `apps/api/src/{tenant.ts,deps.ts,server.ts}`
- Test: `apps/api/src/__tests__/{password.test.ts,tenant.test.ts,auth-routes.test.ts}`

**Interfaces:**
- Consumes: `AppConfig` (T4), `MetricGateway` (T11), `Pseudonymizer` (T3).
- Produces:
  - `hashPassword(plain): Promise<string>`, `verifyPassword(plain, stored): Promise<boolean>`
  - `interface AuthPayload { userId: string; organizationId: string; role: 'ADMIN' | 'VIEWER' }`
  - `requireAuth(request, reply): Promise<void>`; `request.auth: AuthPayload`
  - `resolveTenant(prisma, organizationId): Promise<TenantContext>`
  - `interface AppDeps { config: AppConfig; prisma: PrismaClient; gateway: MetricGateway; pseudonymizer: Pseudonymizer; secretBox: SecretBox; queue: MessageQueue }`
  - `buildServer(deps: AppDeps): Promise<FastifyInstance>`
  - Rotas: `GET /health`, `POST /auth/login`, `GET /auth/me`

- [ ] **Step 1: Adicionar dependências**

```bash
pnpm --filter @center/api add fastify@^5.2.0 @fastify/jwt@^9.0.2 @fastify/cors@^10.0.1 \
  @fastify/rate-limit@^10.2.1 ioredis@^5.4.2 \
  @center/mcp-core@workspace:* @center/secrets@workspace:* \
  @center/uappi-client@workspace:* @center/uappi-sync@workspace:*
```

`@center/uappi-client`/`@center/uappi-sync` só são consumidos pelo processo de sync (T24), e `@center/secrets` pelo sync e pelas rotas de configuração (T24B) — mas todos entram aqui, no primeiro momento em que `apps/api` ganha dependências além do que a T4 já declarou, para não espalhar `pnpm add` por três tasks diferentes.

- [ ] **Step 2: Escrever o teste de senha (falhando)**

`apps/api/src/__tests__/password.test.ts`:

```ts
import { hashPassword, verifyPassword } from '../auth/password.js';

describe('password hashing', () => {
  it('accepts the correct password', async () => {
    expect(await verifyPassword('senha-correta-123', await hashPassword('senha-correta-123'))).toBe(true);
  });

  it('rejects the wrong password', async () => {
    expect(await verifyPassword('errada', await hashPassword('senha-correta-123'))).toBe(false);
  });

  it('produces a different hash for the same password (salted)', async () => {
    expect(await hashPassword('mesma')).not.toBe(await hashPassword('mesma'));
  });

  it('returns false instead of throwing on a malformed stored hash', async () => {
    expect(await verifyPassword('qualquer', 'lixo-sem-separador')).toBe(false);
  });
});
```

- [ ] **Step 3: Implementar `password.ts`**

Usa `scrypt` do Node — sem dependência nativa para compilar em CI.

`apps/api/src/auth/password.ts`:

```ts
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string, salt: Buffer, keylen: number,
) => Promise<Buffer>;

const KEY_LENGTH = 64;

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(plain, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  try {
    const derived = await scryptAsync(plain, Buffer.from(saltHex, 'hex'), KEY_LENGTH);
    const expected = Buffer.from(hashHex, 'hex');
    if (expected.length !== derived.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
```

Run: `pnpm --filter @center/api test -- password.test.ts` → PASS, 4 testes.

- [ ] **Step 4: Escrever o teste de tenant (falhando)**

`apps/api/src/__tests__/tenant.test.ts`:

```ts
import type { PrismaClient } from '@prisma/client';
import { resolveTenant } from '../tenant.js';

function fakePrisma(organization: unknown): PrismaClient {
  return { organization: { findUnique: jest.fn(async () => organization) } } as unknown as PrismaClient;
}

describe('resolveTenant', () => {
  it('builds externalIds from the organization row', async () => {
    const prisma = fakePrisma({
      id: 'org_1', ga4PropertyId: '111', ga4BigQueryDataset: 'analytics_111',
    });
    expect(await resolveTenant(prisma, 'org_1')).toEqual({
      organizationId: 'org_1',
      externalIds: { ga4PropertyId: '111', ga4BigQueryDataset: 'analytics_111' },
    });
  });

  it('omits unconfigured external ids instead of sending empty strings', async () => {
    const prisma = fakePrisma({ id: 'org_1', ga4PropertyId: '111', ga4BigQueryDataset: null });
    expect(await resolveTenant(prisma, 'org_1')).toEqual({
      organizationId: 'org_1', externalIds: { ga4PropertyId: '111' },
    });
  });

  it('never puts Uappi credentials in the tenant', async () => {
    // O tenant atravessa todos os MCP servers e entra no hash da chave de
    // cache. Segredo aqui é segredo espalhado por processo que não precisa dele.
    const prisma = fakePrisma({
      id: 'org_1', ga4PropertyId: '111', ga4BigQueryDataset: null,
      uappiApiKey: 'v1.deadbeef.cafe.1234', uappiSecretKey: 'v1.feedface.babe.5678',
    });
    const tenant = await resolveTenant(prisma, 'org_1');
    expect(tenant.externalIds).not.toHaveProperty('uappiApiKey');
    expect(tenant.externalIds).not.toHaveProperty('uappiSecretKey');
    expect(JSON.stringify(tenant)).not.toContain('v1.');
  });

  it('does not even select the credential columns from the database', async () => {
    const prisma = fakePrisma({ id: 'org_1', ga4PropertyId: '111', ga4BigQueryDataset: null });
    await resolveTenant(prisma, 'org_1');
    const select = (prisma.organization.findUnique as jest.Mock).mock.calls[0]![0].select;
    expect(select).not.toHaveProperty('uappiApiKey');
    expect(select).not.toHaveProperty('uappiSecretKey');
  });

  it('throws when the organization does not exist', async () => {
    await expect(resolveTenant(fakePrisma(null), 'org_missing'))
      .rejects.toThrow('organização não encontrada: org_missing');
  });
});
```

- [ ] **Step 5: Implementar `tenant.ts`, `jwt.ts` e `deps.ts`**

`apps/api/src/tenant.ts`:

```ts
import type { PrismaClient } from '@prisma/client';
import type { TenantContext } from '@center/shared';

/**
 * Traduz a linha da Organization no TenantContext que os MCP servers consomem.
 * Ids não configurados são omitidos — assim o provider falha com "X não
 * configurado" em vez de mandar string vazia para a API externa.
 */
export async function resolveTenant(
  prisma: PrismaClient,
  organizationId: string,
): Promise<TenantContext> {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, ga4PropertyId: true, ga4BigQueryDataset: true },
  });
  if (!organization) throw new Error(`organização não encontrada: ${organizationId}`);

  // SÓ IDENTIFICADORES, NUNCA CREDENCIAIS.
  //
  // `ga4PropertyId` e `ga4BigQueryDataset` são identificadores públicos — quem
  // os tem não consegue ler nada sem a service account. Já `uappiApiKey` e
  // `uappiSecretKey` são segredos, e ficam deliberadamente FORA daqui: o tenant
  // atravessa o canal stdio de todos os MCP servers e entra no hash da chave de
  // cache, então colocar segredo nele os espalharia por processos que não
  // precisam deles. Quem precisa de credencial da Uappi (o sync, em T24; a
  // ferramenta de estoque, em T15) lê e decifra do banco por conta própria.
  const externalIds: Record<string, string> = {};
  if (organization.ga4PropertyId) externalIds.ga4PropertyId = organization.ga4PropertyId;
  if (organization.ga4BigQueryDataset) externalIds.ga4BigQueryDataset = organization.ga4BigQueryDataset;

  return { organizationId: organization.id, externalIds };
}
```

`apps/api/src/auth/jwt.ts`:

```ts
import type { FastifyReply, FastifyRequest } from 'fastify';

export interface AuthPayload {
  userId: string;
  organizationId: string;
  role: 'ADMIN' | 'VIEWER';
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthPayload;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AuthPayload;
    user: AuthPayload;
  }
}

/** preHandler: valida o Bearer token e popula `request.auth`. */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    request.auth = await request.jwtVerify<AuthPayload>();
  } catch {
    await reply.status(401).send({ error: 'unauthorized', message: 'token ausente ou inválido' });
  }
}
```

`apps/api/src/deps.ts`:

```ts
import type { PrismaClient } from '@prisma/client';
import type { MetricGateway } from '@center/mcp-core';
import type { Pseudonymizer } from '@center/pii';
import type { SecretBox } from '@center/secrets';
import type { AppConfig } from './config.js';
import type { MessageQueue } from './whatsapp/queue.js';

export interface AppDeps {
  config: AppConfig;
  prisma: PrismaClient;
  gateway: MetricGateway;
  pseudonymizer: Pseudonymizer;
  /** Decifra `uappiApiKey`/`uappiSecretKey` — usado pelas rotas de configuração (T24B). */
  secretBox: SecretBox;
  queue: MessageQueue;
}
```

`apps/api/src/whatsapp/queue.ts` (só a interface por enquanto; a implementação BullMQ vem na T33):

```ts
import type { InboundMessage } from './parse.js';

export interface MessageQueue {
  enqueue(message: InboundMessage): Promise<void>;
}
```

`apps/api/src/whatsapp/parse.ts` (só o tipo por enquanto; o parser vem na T32):

```ts
export interface InboundMessage {
  wamid: string;
  fromPhoneE164: string;
  text: string;
  timestamp: number;
}
```

- [ ] **Step 6: Escrever o helper de configuração de teste**

Cinco suítes precisam do mesmo `AppConfig`. Ele vive num **helper**, não num arquivo `.test.ts` — importar de um arquivo de teste faria o Jest executar aquelas suítes novamente dentro de cada importadora.

`apps/api/src/__tests__/helpers/config.ts`:

```ts
import type { AppConfig } from '../../config.js';

export const testConfig = {
  port: 0, databaseUrl: 'postgresql://x', redisUrl: 'redis://x',
  jwtSecret: 'x'.repeat(32), piiPepper: 'y'.repeat(32),
  credentialsEncryptionKey: 'a'.repeat(64),
  anthropicApiKey: 'sk-ant-test',
  uappiBaseUrl: 'https://api.uappi.com.br', ga4CredentialsJson: '',
  syncIntervalMinutes: 30, syncBackfillDays: 90, mockExternalApis: false,
  whatsapp: { appSecret: 's', verifyToken: 'v', accessToken: 'a', phoneNumberId: '1' },
} satisfies AppConfig;
```

O `testMatch` do preset (`**/__tests__/**/*.test.ts?(x)`) exige o sufixo `.test`, então este arquivo não é coletado como suíte.

- [ ] **Step 7: Escrever o teste das rotas de auth (falhando)**

`apps/api/src/__tests__/auth-routes.test.ts`:

```ts
import type { PrismaClient } from '@prisma/client';
import type { MetricGateway } from '@center/mcp-core';
import { Pseudonymizer } from '@center/pii';
import { SecretBox } from '@center/secrets';
import { buildServer } from '../server.js';
import { hashPassword } from '../auth/password.js';
import { testConfig } from './helpers/config.js';

const validUser = {
  id: 'user_1', email: 'ana@example.com', name: 'Ana',
  role: 'ADMIN' as const, organizationId: 'org_1', passwordHash: '',
};

async function buildTestServer(userRow: unknown) {
  const prisma = {
    user: { findUnique: jest.fn(async () => userRow) },
    organization: {
      findUnique: jest.fn(async () => ({
        id: 'org_1', ga4PropertyId: '111', ga4BigQueryDataset: null,
        uappiApiKey: null, uappiSecretKey: null,
      })),
    },
  } as unknown as PrismaClient;

  return buildServer({
    config: testConfig,
    prisma,
    gateway: { listMetrics: jest.fn(async () => []) } as unknown as MetricGateway,
    pseudonymizer: new Pseudonymizer(testConfig.piiPepper),
    secretBox: new SecretBox(testConfig.credentialsEncryptionKey),
    queue: { enqueue: jest.fn(async () => {}) },
  });
}

describe('GET /health', () => {
  it('answers without authentication', async () => {
    const app = await buildTestServer(null);
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    await app.close();
  });
});

describe('POST /auth/login', () => {
  it('returns a token for valid credentials', async () => {
    const app = await buildTestServer({ ...validUser, passwordHash: await hashPassword('segredo123') });
    const response = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: 'ana@example.com', password: 'segredo123' },
    });
    expect(response.statusCode).toBe(200);
    expect(typeof response.json().token).toBe('string');
    await app.close();
  });

  it('rejects a wrong password with 401', async () => {
    const app = await buildTestServer({ ...validUser, passwordHash: await hashPassword('segredo123') });
    const response = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: 'ana@example.com', password: 'errada' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().message).toBe('credenciais inválidas');
    await app.close();
  });

  it('gives the same 401 for an unknown email (no user enumeration)', async () => {
    const app = await buildTestServer(null);
    const response = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: 'ninguem@example.com', password: 'qualquer' },
    });
    expect(response.json().message).toBe('credenciais inválidas');
    await app.close();
  });

  it('rejects a malformed body with 400', async () => {
    const app = await buildTestServer(null);
    const response = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'x' } });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('blocks the eleventh login attempt from the same address with 429', async () => {
    const app = await buildTestServer(null);
    const attempt = () => app.inject({
      method: 'POST', url: '/auth/login',
      headers: { 'x-forwarded-for': '203.0.113.7' },
      payload: { email: 'ana@example.com', password: 'errada' },
    });
    for (let i = 0; i < 10; i += 1) expect((await attempt()).statusCode).toBe(401);
    expect((await attempt()).statusCode).toBe(429);
    await app.close();
  });
});

describe('GET /auth/me', () => {
  it('returns 401 without a token', async () => {
    const app = await buildTestServer(validUser);
    expect((await app.inject({ method: 'GET', url: '/auth/me' })).statusCode).toBe(401);
    await app.close();
  });

  it('returns 401 for a token signed with another secret', async () => {
    const app = await buildTestServer(validUser);
    const response = await app.inject({
      method: 'GET', url: '/auth/me',
      headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ4In0.invalid' },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('returns the authenticated identity for a valid token', async () => {
    const app = await buildTestServer({ ...validUser, passwordHash: await hashPassword('segredo123') });
    const login = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: 'ana@example.com', password: 'segredo123' },
    });
    const response = await app.inject({
      method: 'GET', url: '/auth/me',
      headers: { authorization: `Bearer ${login.json().token}` },
    });
    expect(response.json()).toEqual({ userId: 'user_1', organizationId: 'org_1', role: 'ADMIN' });
    await app.close();
  });
});
```

- [ ] **Step 8: Implementar `auth/routes.ts` e `server.ts`**

`apps/api/src/auth/routes.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import { verifyPassword } from './password.js';
import { requireAuth, type AuthPayload } from './jwt.js';

const LoginBodySchema = z.object({ email: z.string().email(), password: z.string().min(1) });

export async function registerAuthRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.post(
    '/auth/login',
    // Força bruta é o risco real desta rota; o limite global de 300/min não basta.
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = LoginBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'bad_request', message: 'email e password são obrigatórios' });
      }

      const user = await deps.prisma.user.findUnique({ where: { email: parsed.data.email } });
      // Mesma resposta para email inexistente e senha errada: sem enumeração.
      const valid = user ? await verifyPassword(parsed.data.password, user.passwordHash) : false;
      if (!user || !valid) {
        return reply.status(401).send({ error: 'unauthorized', message: 'credenciais inválidas' });
      }

      const payload: AuthPayload = {
        userId: user.id, organizationId: user.organizationId, role: user.role,
      };
      return reply.send({
        token: app.jwt.sign(payload, { expiresIn: '12h' }),
        user: { id: user.id, name: user.name, email: user.email, role: user.role },
      });
    },
  );

  app.get('/auth/me', { preHandler: requireAuth }, async (request) => request.auth);
}
```

`apps/api/src/server.ts`:

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import type { AppDeps } from './deps.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerMetricRoutes } from './routes/metrics.js';
import { registerAnalysisRoutes } from './routes/analysis.js';
import { registerAttributionRoutes } from './routes/attribution.js';
import { registerWhatsAppRoutes } from './whatsapp/routes.js';
import { registerLinkRoutes } from './whatsapp/link-routes.js';

export async function buildServer(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  // O corpo cru é necessário para validar a assinatura do webhook do WhatsApp
  // (T32). Guardamos aqui, no único ponto onde o buffer ainda existe.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    (request as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
    if ((body as Buffer).length === 0) return done(null, {});
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')));
    } catch {
      done(Object.assign(new Error('JSON inválido'), { statusCode: 400 }), undefined);
    }
  });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(jwt, { secret: deps.config.jwtSecret });
  await app.register(rateLimit, {
    global: true, max: 300, timeWindow: '1 minute',
    allowList: (request) => request.url === '/health',
  });

  app.get('/health', async () => ({ status: 'ok' }));

  await registerAuthRoutes(app, deps);
  await registerMetricRoutes(app, deps);
  await registerAnalysisRoutes(app, deps);
  await registerAttributionRoutes(app, deps);
  await registerWhatsAppRoutes(app, deps);
  await registerLinkRoutes(app, deps);

  app.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) request.log.error({ err: error }, 'erro não tratado');
    return reply.status(statusCode).send({
      error: statusCode >= 500 ? 'internal_error' : 'bad_request',
      // Nunca vaza mensagem de erro interno para o cliente.
      message: statusCode >= 500 ? 'erro interno' : error.message,
    });
  });

  return app;
}
```

> As rotas registradas acima nascem nas tasks T23 (metrics, analysis), T9 (attribution) e T32/T34 (whatsapp, link). Ao executar a T22 isoladamente, comente as linhas ainda inexistentes e descomente conforme cada task chega — o teste de auth só depende de `registerAuthRoutes`.

- [ ] **Step 9: Rodar os testes**

Run: `pnpm --filter @center/api test`
Expected: PASS — 3 suites novas, 15 testes.

- [ ] **Step 10: Commit**

```bash
git add apps/api
git commit -m "feat(api): add fastify server, scrypt auth, rate limiting and tenant resolution"
```

---

### Task 23: Rotas de métricas, rankings e análises

**Files:**
- Create: `apps/api/src/routes/{metrics.ts,analysis.ts}`
- Test: `apps/api/src/__tests__/metrics-routes.test.ts`

**Interfaces:**
- Consumes: `requireAuth`, `resolveTenant` (T22); `MetricGateway` (T11); `correlateMetrics` (T20); `analyzeAppVersionImpact` (T21).
- Produces:
  - `GET /api/metrics/catalog` → `{ metrics: MetricDescriptor[] }`
  - `POST /api/metrics/query` → `MetricSeries`
  - `POST /api/metrics/batch` (máx. 12) → `{ series: MetricSeries[] }`
  - `POST /api/tools/:source/:name` → payload da ferramenta
  - `POST /api/analysis/correlate` → `CorrelationResult`
  - `POST /api/analysis/app-version-impact` → `VersionImpactResult`
  - `registerMetricRoutes(app, deps)`, `registerAnalysisRoutes(app, deps)`
  - `ALLOWED_TOOLS: Record<MetricSource, readonly string[]>`

**A rota genérica de ferramentas e sua trava:** `POST /api/tools/:source/:name` evita escrever 19 rotas quase idênticas. Mas expor um nome livre deixaria o cliente chamar qualquer coisa registrada no MCP server. Por isso existe `ALLOWED_TOOLS` — uma allowlist explícita, com teste.

- [ ] **Step 1: Escrever o teste (falhando)**

`apps/api/src/__tests__/metrics-routes.test.ts`:

```ts
import type { PrismaClient } from '@prisma/client';
import type { MetricGateway } from '@center/mcp-core';
import type { MetricSeries } from '@center/shared';
import { Pseudonymizer } from '@center/pii';
import { SecretBox } from '@center/secrets';
import { buildServer } from '../server.js';
import { hashPassword } from '../auth/password.js';
import { testConfig } from './helpers/config.js';

const series: MetricSeries = {
  metricId: 'commerce.revenue', source: 'commerce', unit: 'currency',
  granularity: 'day', total: 55000, points: [{ date: '2026-01-01', value: 55000 }],
};

async function setup(organizationId = 'org_1') {
  const gateway = {
    listMetrics: jest.fn(async () => [{
      id: 'commerce.revenue', label: 'Faturamento', description: 'd',
      source: 'commerce' as const, unit: 'currency' as const, dimensions: ['campaign'],
    }]),
    queryMetric: jest.fn(async () => series),
    queryBatch: jest.fn(async () => [series, series]),
    callTool: jest.fn(async () => ({ rows: [{ key: 'CAM-001', value: 16000 }] })),
  } as unknown as MetricGateway;

  const prisma = {
    user: {
      findUnique: jest.fn(async () => ({
        id: 'user_1', email: 'ana@example.com', name: 'Ana', role: 'ADMIN' as const,
        organizationId, passwordHash: await hashPassword('segredo123'),
      })),
    },
    organization: {
      findUnique: jest.fn(async () => ({
        id: organizationId, ga4PropertyId: `prop_${organizationId}`,
        ga4BigQueryDataset: null, uappiApiKey: null, uappiSecretKey: null,
      })),
    },
  } as unknown as PrismaClient;

  const app = await buildServer({
    config: testConfig, prisma, gateway,
    pseudonymizer: new Pseudonymizer(testConfig.piiPepper),
    secretBox: new SecretBox(testConfig.credentialsEncryptionKey),
    queue: { enqueue: jest.fn(async () => {}) },
  });
  const login = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { email: 'ana@example.com', password: 'segredo123' },
  });
  return { app, gateway, token: login.json().token as string };
}

const validQuery = {
  metricId: 'commerce.revenue', from: '2026-01-01', to: '2026-01-31', granularity: 'day',
};

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe('GET /api/metrics/catalog', () => {
  it('requires a token', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'GET', url: '/api/metrics/catalog' })).statusCode).toBe(401);
    await app.close();
  });

  it('returns the merged catalog', async () => {
    const { app, token } = await setup();
    const response = await app.inject({
      method: 'GET', url: '/api/metrics/catalog', headers: auth(token),
    });
    expect(response.json().metrics).toHaveLength(1);
    await app.close();
  });
});

describe('POST /api/metrics/query', () => {
  it('requires a token', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'POST', url: '/api/metrics/query', payload: validQuery })).statusCode).toBe(401);
    await app.close();
  });

  it('returns the series', async () => {
    const { app, token } = await setup();
    const response = await app.inject({
      method: 'POST', url: '/api/metrics/query', headers: auth(token), payload: validQuery,
    });
    expect(response.json().total).toBe(55000);
    await app.close();
  });

  it('injects the tenant from the token, never from the body', async () => {
    const { app, gateway, token } = await setup('org_1');
    await app.inject({
      method: 'POST', url: '/api/metrics/query', headers: auth(token),
      // Cliente malicioso tentando forjar outro tenant:
      payload: { ...validQuery, tenant: { organizationId: 'org_ATACANTE', externalIds: { ga4PropertyId: 'roubado' } } },
    });
    expect(gateway.queryMetric).toHaveBeenCalledWith({
      ...validQuery,
      tenant: { organizationId: 'org_1', externalIds: { ga4PropertyId: 'prop_org_1' } },
    });
    await app.close();
  });

  it('rejects an invalid date format with 400', async () => {
    const { app, token } = await setup();
    const response = await app.inject({
      method: 'POST', url: '/api/metrics/query', headers: auth(token),
      payload: { ...validQuery, from: '01/01/2026' },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('rejects an inverted date range with 400', async () => {
    const { app, token } = await setup();
    const response = await app.inject({
      method: 'POST', url: '/api/metrics/query', headers: auth(token),
      payload: { ...validQuery, from: '2026-02-01', to: '2026-01-01' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/anterior/);
    await app.close();
  });

  it('rejects a range longer than 400 days with 400', async () => {
    const { app, token } = await setup();
    const response = await app.inject({
      method: 'POST', url: '/api/metrics/query', headers: auth(token),
      payload: { ...validQuery, from: '2024-01-01', to: '2026-01-01' },
    });
    expect(response.json().message).toMatch(/400 dias/);
    await app.close();
  });

  it('turns an upstream failure into 502, not 500', async () => {
    const { app, gateway, token } = await setup();
    (gateway.queryMetric as jest.Mock).mockRejectedValueOnce(new Error('GA4 indisponível'));
    const response = await app.inject({
      method: 'POST', url: '/api/metrics/query', headers: auth(token), payload: validQuery,
    });
    expect(response.statusCode).toBe(502);
    await app.close();
  });
});

describe('POST /api/metrics/batch', () => {
  it('resolves several queries at once', async () => {
    const { app, token } = await setup();
    const response = await app.inject({
      method: 'POST', url: '/api/metrics/batch', headers: auth(token),
      payload: { queries: [validQuery, { ...validQuery, metricId: 'commerce.orders' }] },
    });
    expect(response.json().series).toHaveLength(2);
    await app.close();
  });

  it('rejects more than 12 queries with 400', async () => {
    const { app, token } = await setup();
    const response = await app.inject({
      method: 'POST', url: '/api/metrics/batch', headers: auth(token),
      payload: { queries: Array.from({ length: 13 }, () => validQuery) },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

describe('POST /api/tools/:source/:name', () => {
  it('calls an allowlisted tool with the tenant injected', async () => {
    const { app, gateway, token } = await setup();
    const response = await app.inject({
      method: 'POST', url: '/api/tools/commerce/top_products', headers: auth(token),
      payload: { from: '2026-01-01', to: '2026-01-31', limit: 5 },
    });
    expect(response.statusCode).toBe(200);
    expect(gateway.callTool).toHaveBeenCalledWith(
      'commerce', 'top_products',
      expect.objectContaining({ tenant: expect.objectContaining({ organizationId: 'org_1' }) }),
      expect.anything(),
    );
    await app.close();
  });

  it('refuses a tool that is not on the allowlist', async () => {
    const { app, gateway, token } = await setup();
    const response = await app.inject({
      method: 'POST', url: '/api/tools/commerce/drop_everything', headers: auth(token), payload: {},
    });
    expect(response.statusCode).toBe(404);
    expect(gateway.callTool).not.toHaveBeenCalled();
    await app.close();
  });

  it('refuses an unknown source', async () => {
    const { app, token } = await setup();
    const response = await app.inject({
      method: 'POST', url: '/api/tools/mixpanel/top_products', headers: auth(token), payload: {},
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('overrides a tenant forged in the tool arguments', async () => {
    const { app, gateway, token } = await setup('org_1');
    await app.inject({
      method: 'POST', url: '/api/tools/commerce/top_products', headers: auth(token),
      payload: { from: '2026-01-01', to: '2026-01-31', tenant: { organizationId: 'org_ATACANTE', externalIds: {} } },
    });
    const args = (gateway.callTool as jest.Mock).mock.calls[0]![2] as { tenant: { organizationId: string } };
    expect(args.tenant.organizationId).toBe('org_1');
    await app.close();
  });

  it('requires a token', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'POST', url: '/api/tools/commerce/top_products', payload: {} });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});

describe('POST /api/analysis/correlate', () => {
  it('returns the correlation result', async () => {
    const { app, gateway, token } = await setup();
    (gateway.queryBatch as jest.Mock).mockResolvedValueOnce([
      { ...series, metricId: 'ga4.active_users', unit: 'count', points: [
        { date: '2026-01-01', value: 10 }, { date: '2026-01-02', value: 20 }, { date: '2026-01-03', value: 30 },
      ] },
      { ...series, points: [
        { date: '2026-01-01', value: 100 }, { date: '2026-01-02', value: 200 }, { date: '2026-01-03', value: 300 },
      ] },
    ]);
    const response = await app.inject({
      method: 'POST', url: '/api/analysis/correlate', headers: auth(token),
      payload: {
        metricIdA: 'ga4.active_users', metricIdB: 'commerce.revenue',
        from: '2026-01-01', to: '2026-01-03', granularity: 'day',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().coefficient).toBeCloseTo(1, 5);
    expect(response.json().caveat).toBeTruthy();
    await app.close();
  });

  it('rejects correlating a metric with itself with 400', async () => {
    const { app, token } = await setup();
    const response = await app.inject({
      method: 'POST', url: '/api/analysis/correlate', headers: auth(token),
      payload: {
        metricIdA: 'commerce.revenue', metricIdB: 'commerce.revenue',
        from: '2026-01-01', to: '2026-01-31', granularity: 'day',
      },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
```

- [ ] **Step 2: Implementar `routes/metrics.ts`**

`apps/api/src/routes/metrics.ts`:

```ts
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { GranularitySchema, IsoDateSchema, MetricSourceSchema, type MetricQuery, type MetricSource } from '@center/shared';
import { requireAuth } from '../auth/jwt.js';
import { resolveTenant } from '../tenant.js';
import type { AppDeps } from '../deps.js';

const MAX_RANGE_DAYS = 400;
const MAX_BATCH_SIZE = 12;

/**
 * Allowlist explícita de ferramentas expostas por HTTP.
 *
 * A rota genérica evita 19 rotas quase idênticas, mas sem esta trava um cliente
 * poderia invocar qualquer ferramenta registrada no MCP server — inclusive as
 * que venham a existir depois e não tenham sido pensadas para uso externo.
 */
export const ALLOWED_TOOLS: Record<MetricSource, readonly string[]> = {
  commerce: [
    'orders_by_status', 'failed_orders', 'payment_method_performance',
    'top_products', 'top_categories', 'compare_products',
    'campaign_revenue', 'channel_average_ticket', 'device_revenue',
    'campaign_conversion', 'campaign_returning_customers', 'out_of_stock_products',
  ],
  ga4: [
    'traffic_sources', 'campaign_users', 'device_performance', 'page_performance',
    'app_versions', 'top_events', 'compare_events', 'checkout_funnel',
  ],
  behavior: ['events_before_purchase', 'screen_abandon_impact'],
};

/** Ferramentas que listam registros voláteis não devem ser cacheadas. */
const UNCACHEABLE_TOOLS = new Set(['failed_orders', 'out_of_stock_products']);

/** Igual ao MetricQuerySchema, MENOS o tenant — que vem do JWT. */
const QueryBodySchema = z.object({
  metricId: z.string().min(1),
  from: IsoDateSchema,
  to: IsoDateSchema,
  granularity: GranularitySchema,
  filters: z.record(z.string(), z.string()).optional(),
  groupBy: z.string().optional(),
});
type QueryBody = z.infer<typeof QueryBodySchema>;

const BatchBodySchema = z.object({ queries: z.array(QueryBodySchema).min(1).max(MAX_BATCH_SIZE) });

class BadRequestError extends Error {}

function assertRange(body: { from: string; to: string }): void {
  if (body.from > body.to) {
    throw new BadRequestError(`"from" (${body.from}) é anterior a "to" (${body.to})`);
  }
  const spanDays =
    (Date.parse(`${body.to}T00:00:00Z`) - Date.parse(`${body.from}T00:00:00Z`)) / 86_400_000;
  if (spanDays > MAX_RANGE_DAYS) {
    throw new BadRequestError(`intervalo excede o máximo de ${MAX_RANGE_DAYS} dias`);
  }
}

export function badRequest(reply: FastifyReply, message: string) {
  return reply.status(400).send({ error: 'bad_request', message });
}

/** Falha de fonte externa é 502 (problema deles), não 500 (problema nosso). */
export function upstreamError(reply: FastifyReply, error: unknown) {
  return reply.status(502).send({
    error: 'upstream_error',
    message: error instanceof Error ? error.message : 'fonte de dados indisponível',
  });
}

export async function registerMetricRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get('/api/metrics/catalog', { preHandler: requireAuth }, async (_request, reply) => {
    try {
      return reply.send({ metrics: await deps.gateway.listMetrics() });
    } catch (error) {
      return upstreamError(reply, error);
    }
  });

  app.post('/api/metrics/query', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = QueryBodySchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues[0]?.message ?? 'corpo inválido');

    try {
      assertRange(parsed.data);
      const tenant = await resolveTenant(deps.prisma, request.auth.organizationId);
      const query: MetricQuery = { ...parsed.data, tenant };
      return reply.send(await deps.gateway.queryMetric(query));
    } catch (error) {
      if (error instanceof BadRequestError) return badRequest(reply, error.message);
      return upstreamError(reply, error);
    }
  });

  app.post('/api/metrics/batch', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = BatchBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, `queries precisa ter entre 1 e ${MAX_BATCH_SIZE} itens`);
    }

    try {
      for (const item of parsed.data.queries) assertRange(item);
      const tenant = await resolveTenant(deps.prisma, request.auth.organizationId);
      const queries: MetricQuery[] = parsed.data.queries.map((item: QueryBody) => ({ ...item, tenant }));
      return reply.send({ series: await deps.gateway.queryBatch(queries) });
    } catch (error) {
      if (error instanceof BadRequestError) return badRequest(reply, error.message);
      return upstreamError(reply, error);
    }
  });

  app.post<{ Params: { source: string; name: string } }>(
    '/api/tools/:source/:name',
    { preHandler: requireAuth },
    async (request, reply) => {
      const source = MetricSourceSchema.safeParse(request.params.source);
      if (!source.success) {
        return reply.status(404).send({ error: 'not_found', message: 'fonte desconhecida' });
      }
      const name = request.params.name;
      if (!ALLOWED_TOOLS[source.data].includes(name)) {
        return reply.status(404).send({ error: 'not_found', message: `ferramenta não exposta: ${name}` });
      }

      try {
        const tenant = await resolveTenant(deps.prisma, request.auth.organizationId);
        const body = (request.body ?? {}) as Record<string, unknown>;
        if (typeof body.from === 'string' && typeof body.to === 'string') {
          assertRange({ from: body.from, to: body.to });
        }
        // O tenant é escrito por último: sobrescreve qualquer valor forjado.
        const args = { ...body, tenant };
        return reply.send(await deps.gateway.callTool(source.data, name, args, {
          cache: !UNCACHEABLE_TOOLS.has(name),
          rangeEnd: typeof body.to === 'string' ? body.to : undefined,
        }));
      } catch (error) {
        if (error instanceof BadRequestError) return badRequest(reply, error.message);
        return upstreamError(reply, error);
      }
    },
  );
}
```

- [ ] **Step 3: Implementar `routes/analysis.ts`**

`apps/api/src/routes/analysis.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GranularitySchema, IsoDateSchema } from '@center/shared';
import { correlateMetrics } from '@center/mcp-core';
import { requireAuth } from '../auth/jwt.js';
import { resolveTenant } from '../tenant.js';
import { analyzeAppVersionImpact } from '../analysis/app-version-impact.js';
import { badRequest, upstreamError } from './metrics.js';
import type { AppDeps } from '../deps.js';

const BUSINESS_TIME_ZONE = 'America/Sao_Paulo';

const CorrelateBodySchema = z.object({
  metricIdA: z.string().min(1),
  metricIdB: z.string().min(1),
  from: IsoDateSchema,
  to: IsoDateSchema,
  granularity: GranularitySchema,
});

const VersionImpactBodySchema = z.object({
  version: z.string().min(1),
  releaseDate: IsoDateSchema,
  windowDays: z.number().int().min(3).max(90).optional(),
});

function today(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: BUSINESS_TIME_ZONE });
}

export async function registerAnalysisRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.post('/api/analysis/correlate', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = CorrelateBodySchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues[0]?.message ?? 'corpo inválido');

    try {
      const tenant = await resolveTenant(deps.prisma, request.auth.organizationId);
      return reply.send(await correlateMetrics(deps.gateway, { ...parsed.data, tenant }));
    } catch (error) {
      // "métrica com ela mesma" é erro do cliente, não da fonte.
      if (error instanceof Error && error.message.includes('ela mesma')) {
        return badRequest(reply, error.message);
      }
      return upstreamError(reply, error);
    }
  });

  app.post('/api/analysis/app-version-impact', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = VersionImpactBodySchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues[0]?.message ?? 'corpo inválido');

    try {
      const tenant = await resolveTenant(deps.prisma, request.auth.organizationId);
      return reply.send(await analyzeAppVersionImpact({
        gateway: deps.gateway, tenant, today: today(), ...parsed.data,
      }));
    } catch (error) {
      if (error instanceof Error && error.message.includes('futuro')) {
        return badRequest(reply, error.message);
      }
      return upstreamError(reply, error);
    }
  });
}
```

- [ ] **Step 4: Rodar os testes**

Run: `pnpm --filter @center/api test`
Expected: PASS — 18 testes novos.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): add metric, allowlisted tool and analysis routes"
```

---

### Task 24: Composition root e agendador de sync

**Files:**
- Create: `apps/api/src/main.ts`, `apps/api/src/sync/{scheduler.ts,sync-worker-main.ts}`, `apps/api/prisma/seed.ts`
- Test: `apps/api/src/__tests__/sync-scheduler.test.ts`

**Interfaces:**
- Consumes: `loadConfig` (T4), `buildServer` (T22), `McpPool.spawn`/`MetricGateway`/`RedisCacheStore` (T10–T11), `runIncrementalSync` (T8), `SecretBox` (T4B), `MockUappiClient` (T5B).
- Produces:
  - `syncAllOrganizations(deps: SchedulerDeps): Promise<SchedulerReport>`
  - `interface SchedulerDeps { prisma, config, pseudonymizer, secretBox, buildClient, logger?, now? }`
  - `interface SchedulerReport { organizations: number; succeeded: number; failed: number }`
  - Binários `node dist/main.js` (API) e `node dist/sync/sync-worker-main.js` (sync)
  - `pnpm --filter @center/api db:seed`

- [ ] **Step 1: Escrever o teste do agendador (falhando)**

`apps/api/src/__tests__/sync-scheduler.test.ts`:

```ts
import type { PrismaClient } from '@prisma/client';
import { Pseudonymizer } from '@center/pii';
import type { SecretBox } from '@center/secrets';
import type { UappiClientLike } from '@center/uappi-client';
import { syncAllOrganizations } from '../sync/scheduler.js';
import { testConfig } from './helpers/config.js';

jest.mock('@center/uappi-sync', () => ({
  runIncrementalSync: jest.fn(async () => ({
    ordersProcessed: 3, ordersFailed: 0, from: '2026-07-01', to: '2026-07-20',
  })),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runIncrementalSync } = require('@center/uappi-sync') as { runIncrementalSync: jest.Mock };

// As credenciais chegam do Postgres CIFRADAS (T24B); o fake abaixo simula o
// decrypt como identidade, então os testes continuam legíveis sem precisar
// gerar texto cifrado real.
function fakeSecretBox(): SecretBox {
  return { decryptOrNull: jest.fn((v: string | null) => v) } as unknown as SecretBox;
}

function buildDeps(organizations: unknown[]) {
  const prisma = {
    organization: { findMany: jest.fn(async () => organizations) },
  } as unknown as PrismaClient;

  return {
    prisma,
    config: testConfig,
    pseudonymizer: new Pseudonymizer(testConfig.piiPepper),
    secretBox: fakeSecretBox(),
    buildClient: jest.fn(() => ({}) as UappiClientLike),
    logger: jest.fn(),
  };
}

const configured = {
  id: 'org_1', uappiApiKey: 'ak', uappiSecretKey: 'sk', statusMapping: { '7': 'CANCELLED' },
};

beforeEach(() => { runIncrementalSync.mockClear(); });

describe('syncAllOrganizations', () => {
  it('syncs every organization with credentials', async () => {
    const deps = buildDeps([configured, { ...configured, id: 'org_2' }]);
    const report = await syncAllOrganizations(deps);
    expect(report).toEqual({ organizations: 2, succeeded: 2, failed: 0 });
    expect(runIncrementalSync).toHaveBeenCalledTimes(2);
  });

  it('skips organizations with no Uappi credentials', async () => {
    const deps = buildDeps([configured, { id: 'org_2', uappiApiKey: null, uappiSecretKey: null, statusMapping: null }]);
    const report = await syncAllOrganizations(deps);
    expect(report).toEqual({ organizations: 1, succeeded: 1, failed: 0 });
    expect(runIncrementalSync).toHaveBeenCalledTimes(1);
  });

  it('passes the per-store status overrides down to the sync', async () => {
    await syncAllOrganizations(buildDeps([configured]));
    expect(runIncrementalSync).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org_1', statusOverrides: { '7': 'CANCELLED' } }),
    );
  });

  it('keeps syncing the other organizations when one fails', async () => {
    runIncrementalSync
      .mockRejectedValueOnce(new Error('Uappi 503'))
      .mockResolvedValueOnce({ ordersProcessed: 1, ordersFailed: 0, from: 'a', to: 'b' });
    const deps = buildDeps([configured, { ...configured, id: 'org_2' }]);
    const report = await syncAllOrganizations(deps);
    expect(report).toEqual({ organizations: 2, succeeded: 1, failed: 1 });
  });

  it('logs the failure with the organization id', async () => {
    runIncrementalSync.mockRejectedValueOnce(new Error('Uappi 503'));
    const deps = buildDeps([configured]);
    await syncAllOrganizations(deps);
    expect(deps.logger).toHaveBeenCalledWith(
      expect.stringContaining('falha'),
      expect.objectContaining({ organizationId: 'org_1' }),
    );
  });

  it('decrypts each credential before building the client', async () => {
    const deps = buildDeps([configured]);
    await syncAllOrganizations(deps);
    expect(deps.secretBox.decryptOrNull).toHaveBeenCalledWith('ak');
    expect(deps.secretBox.decryptOrNull).toHaveBeenCalledWith('sk');
  });

  it('builds one Uappi client per organization, never shared', async () => {
    const deps = buildDeps([configured, { ...configured, id: 'org_2', uappiApiKey: 'ak2' }]);
    await syncAllOrganizations(deps);
    expect(deps.buildClient).toHaveBeenCalledTimes(2);
    expect(deps.buildClient).toHaveBeenNthCalledWith(1, { apiKey: 'ak', secretKey: 'sk' });
    expect(deps.buildClient).toHaveBeenNthCalledWith(2, { apiKey: 'ak2', secretKey: 'sk' });
  });

  it('reports zero work when there is no organization', async () => {
    expect(await syncAllOrganizations(buildDeps([])))
      .toEqual({ organizations: 0, succeeded: 0, failed: 0 });
  });
});
```

- [ ] **Step 2: Implementar `sync/scheduler.ts`**

`apps/api/src/sync/scheduler.ts`:

```ts
import type { PrismaClient } from '@prisma/client';
import type { Pseudonymizer } from '@center/pii';
import type { SecretBox } from '@center/secrets';
import type { UappiClientLike, UappiCredentials } from '@center/uappi-client';
import { runIncrementalSync } from '@center/uappi-sync';
import type { AppConfig } from '../config.js';

export interface SchedulerDeps {
  prisma: PrismaClient;
  config: AppConfig;
  pseudonymizer: Pseudonymizer;
  /** Decifra `uappiApiKey`/`uappiSecretKey`, gravados cifrados pela T24B. */
  secretBox: SecretBox;
  buildClient: (credentials: UappiCredentials) => UappiClientLike;
  logger?: (message: string, meta?: Record<string, unknown>) => void;
  now?: () => Date;
}

export interface SchedulerReport {
  organizations: number;
  succeeded: number;
  failed: number;
}

/**
 * Sincroniza todas as organizações, uma por vez.
 *
 * Sequencial de propósito: cada organização tem sua própria cota na Uappi, mas
 * o banco é compartilhado, e paralelizar aqui trocaria um gargalo previsível
 * por contenção imprevisível. Uma falha nunca interrompe as demais.
 */
export async function syncAllOrganizations(deps: SchedulerDeps): Promise<SchedulerReport> {
  const log = deps.logger ?? (() => {});

  const organizations = await deps.prisma.organization.findMany({
    select: { id: true, uappiApiKey: true, uappiSecretKey: true, statusMapping: true },
  });

  const eligible = organizations.filter((org) => org.uappiApiKey && org.uappiSecretKey);

  let succeeded = 0;
  let failed = 0;

  for (const organization of eligible) {
    try {
      // As duas colunas guardam texto cifrado (T24B) — nunca a credencial em
      // claro. O decrypt acontece aqui, no único ponto que precisa do valor real.
      const client = deps.buildClient({
        apiKey: deps.secretBox.decryptOrNull(organization.uappiApiKey)!,
        secretKey: deps.secretBox.decryptOrNull(organization.uappiSecretKey)!,
      });

      const result = await runIncrementalSync({
        prisma: deps.prisma,
        client,
        pseudonymizer: deps.pseudonymizer,
        organizationId: organization.id,
        statusOverrides: (organization.statusMapping as Record<string, string> | null) ?? null,
        ...(deps.now ? { now: deps.now } : {}),
        logger: log,
      }, { backfillDays: deps.config.syncBackfillDays });

      succeeded += 1;
      log('sync concluído', {
        organizationId: organization.id,
        processed: result.ordersProcessed,
        failedOrders: result.ordersFailed,
      });
    } catch (error) {
      failed += 1;
      log('falha no sync da organização', {
        organizationId: organization.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { organizations: eligible.length, succeeded, failed };
}
```

- [ ] **Step 3: Implementar o processo do sync**

Roda separado da API: um backfill de horas não pode degradar a dashboard.

`apps/api/src/sync/sync-worker-main.ts`:

```ts
import { PrismaClient } from '@prisma/client';
import { Pseudonymizer } from '@center/pii';
import { SecretBox } from '@center/secrets';
import { UappiClient, UappiTokenProvider, MockUappiClient, type UappiClientLike, type UappiCredentials } from '@center/uappi-client';
import { loadConfig } from '../config.js';
import { syncAllOrganizations } from './scheduler.js';

const config = loadConfig(process.env);
const prisma = new PrismaClient();
const pseudonymizer = new Pseudonymizer(config.piiPepper);
const secretBox = new SecretBox(config.credentialsEncryptionKey);

function buildClient(credentials: UappiCredentials): UappiClientLike {
  // MOCK_EXTERNAL_APIS=true (T4, T5B) ignora as credenciais e roda contra a
  // fixture — permite subir o sync sem apiKey/secretKey reais da Uappi.
  if (config.mockExternalApis) return new MockUappiClient();

  // Um token provider por organização: as credenciais são diferentes e o cache
  // de token não pode vazar entre lojas.
  const tokenProvider = new UappiTokenProvider({ baseUrl: config.uappiBaseUrl, credentials });
  return new UappiClient({ baseUrl: config.uappiBaseUrl, tokenProvider });
}

let running = false;

async function tick(): Promise<void> {
  // Trava simples: um ciclo longo (backfill) não pode disparar em cima de si mesmo.
  if (running) {
    console.warn('ciclo anterior ainda em execução, pulando este');
    return;
  }
  running = true;
  const startedAt = Date.now();
  try {
    const report = await syncAllOrganizations({
      prisma, config, pseudonymizer, secretBox, buildClient,
      logger: (message, meta) => console.log(message, meta ?? ''),
    });
    console.log(`ciclo concluído em ${Date.now() - startedAt}ms`, report);
  } finally {
    running = false;
  }
}

const intervalMs = config.syncIntervalMinutes * 60_000;
console.log(`sync worker iniciado — intervalo de ${config.syncIntervalMinutes} minutos`);

await tick();
const timer = setInterval(() => void tick(), intervalMs);

async function shutdown(): Promise<void> {
  clearInterval(timer);
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
```

- [ ] **Step 4: Implementar o composition root da API**

`apps/api/src/main.ts`:

```ts
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { McpPool, MetricGateway, RedisCacheStore, type McpServerConfig } from '@center/mcp-core';
import { Pseudonymizer } from '@center/pii';
import { SecretBox } from '@center/secrets';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';
import { BullMessageQueue } from './whatsapp/queue.js';

const config = loadConfig(process.env);
const prisma = new PrismaClient();
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });

// Cada MCP server roda como processo filho, conectado por stdio. Adicionar
// uma quarta fonte é uma entrada neste array.
const mcpServers: McpServerConfig[] = [
  {
    source: 'commerce',
    command: process.execPath,
    args: ['../../packages/mcp-commerce/dist/main.js'],
    // UAPPI_BASE_URL habilita out_of_stock_products (T15) condicionalmente — o
    // servidor só a registra se a variável existir, sem precisar de credencial fixa.
    env: { DATABASE_URL: config.databaseUrl, UAPPI_BASE_URL: config.uappiBaseUrl,
      CREDENTIALS_ENCRYPTION_KEY: config.credentialsEncryptionKey },
  },
  {
    source: 'ga4',
    command: process.execPath,
    args: ['../../packages/mcp-ga4/dist/main.js'],
    env: { GA4_CREDENTIALS_JSON: config.ga4CredentialsJson, MOCK_EXTERNAL_APIS: String(config.mockExternalApis) },
  },
];

const pool = await McpPool.spawn(mcpServers);
const gateway = new MetricGateway(pool, new RedisCacheStore(redis));
const queue = new BullMessageQueue(redis);
// Decifra uappiApiKey/uappiSecretKey (T24B) — nunca lidos em claro do Postgres.
const secretBox = new SecretBox(config.credentialsEncryptionKey);

const app = await buildServer({
  config, prisma, gateway,
  pseudonymizer: new Pseudonymizer(config.piiPepper),
  secretBox,
  queue,
});

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'encerrando');
  await app.close();
  await queue.close();
  await gateway.close();
  await prisma.$disconnect();
  redis.disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.port, host: '0.0.0.0' });
```

- [ ] **Step 5: Escrever o seed**

`apps/api/prisma/seed.ts`:

```ts
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/auth/password.js';

const prisma = new PrismaClient();

const organization = await prisma.organization.upsert({
  where: { id: 'org_dev' },
  update: {},
  create: {
    id: 'org_dev',
    name: 'Loja de Desenvolvimento',
    uappiApiKey: process.env.SEED_UAPPI_API_KEY ?? null,
    uappiSecretKey: process.env.SEED_UAPPI_SECRET_KEY ?? null,
    ga4PropertyId: process.env.SEED_GA4_PROPERTY_ID ?? null,
  },
});

await prisma.user.upsert({
  where: { email: 'admin@center.local' },
  update: {},
  create: {
    email: 'admin@center.local',
    name: 'Admin Dev',
    role: 'ADMIN',
    passwordHash: await hashPassword('center-dev-123'),
    organizationId: organization.id,
  },
});

console.log('seed concluído: admin@center.local / center-dev-123');
await prisma.$disconnect();
```

Adicione a `apps/api/package.json`:

```json
  "prisma": { "seed": "node --experimental-strip-types prisma/seed.ts" }
```

e ao bloco `scripts`:

```json
  "db:seed": "prisma db seed",
  "start": "node dist/main.js",
  "start:sync": "node dist/sync/sync-worker-main.js",
  "dev": "node --watch --experimental-strip-types src/main.ts",
  "dev:sync": "node --watch --experimental-strip-types src/sync/sync-worker-main.ts"
```

- [ ] **Step 6: Validar de ponta a ponta**

```bash
pnpm build
pnpm --filter @center/api db:seed
cd apps/api && node dist/main.js
```

Noutro terminal:

```bash
TOKEN=$(curl -s -X POST localhost:3333/auth/login -H 'content-type: application/json' \
  -d '{"email":"admin@center.local","password":"center-dev-123"}' | jq -r .token)

curl -s localhost:3333/api/metrics/catalog -H "authorization: Bearer $TOKEN" | jq '.metrics | length'

curl -s -X POST localhost:3333/api/metrics/query -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"metricId":"commerce.revenue","from":"2026-07-01","to":"2026-07-31","granularity":"day"}' | jq .total

curl -s -X POST localhost:3333/api/tools/commerce/top_products -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"from":"2026-07-01","to":"2026-07-31","limit":5}' | jq '.rows[].label'
```

Expected: o catálogo lista 11 métricas (5 commerce + 6 GA4); a receita bate com o painel da Uappi; o ranking devolve nomes de produtos reais. Rode a query duas vezes e confirme no log que a segunda não gerou chamada ao MCP server.

- [ ] **Step 7: Commit**

```bash
git add apps/api
git commit -m "feat(api): add composition root, sync scheduler process and dev seed"
```

---

### Task 24B: Rotas de configuração — credenciais de integração

**Files:**
- Create: `apps/api/src/routes/settings.ts`
- Modify: `apps/api/src/auth/jwt.ts` (adiciona `requireAdmin`)
- Modify: `apps/api/src/server.ts` (registra a rota)
- Modify: `apps/api/src/main.ts` e `apps/api/src/whatsapp/worker-main.ts` (instanciam `SecretBox` e passam a `AppDeps`/`WorkerDeps`)
- Test: `apps/api/src/__tests__/settings-routes.test.ts`

**Interfaces:**
- Consumes: `SecretBox` (T4B), `requireAuth` (T22).
- Produces:
  - `requireAdmin(request, reply): Promise<void>` — preHandler que roda depois de `requireAuth` e barra `role !== 'ADMIN'`
  - `GET /api/settings/integrations` → `{ uappi: { configured: boolean }, ga4: { propertyId: string | null, bigQueryDataset: string | null } }`
  - `PUT /api/settings/integrations` body `{ uappiApiKey?, uappiSecretKey?, ga4PropertyId?, ga4BigQueryDataset? }` → o mesmo formato do GET
  - `registerSettingsRoutes(app, deps)`
  - `AppDeps.secretBox: SecretBox` (novo campo)

**Por que as credenciais nunca voltam em claro no GET, nem parcialmente mascaradas:** mostrar os quatro últimos caracteres de uma `secretKey` pareceria inofensivo, mas reduz o espaço de busca de quem tenta adivinhá-la — e não existe usuário legítimo que precise *conferir* a própria secret key depois de configurada, só saber que ela está configurada. Por isso a resposta do Uappi é só `{ configured: boolean }`. `ga4PropertyId` e `ga4BigQueryDataset` não são segredos (são identificadores, não credenciais), então aparecem em claro — é o que permite ao admin conferir se digitou certo.

- [ ] **Step 1: Adicionar `requireAdmin` a `auth/jwt.ts`**

Em `apps/api/src/auth/jwt.ts` (T22), acrescente ao final do arquivo:

```ts
/** Roda depois de `requireAuth`. Barra qualquer papel que não seja ADMIN. */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.auth.role !== 'ADMIN') {
    await reply.status(403).send({ error: 'forbidden', message: 'requer papel de administrador' });
  }
}
```

- [ ] **Step 2: Escrever o teste (falhando)**

`apps/api/src/__tests__/settings-routes.test.ts`:

```ts
import type { PrismaClient } from '@prisma/client';
import type { MetricGateway } from '@center/mcp-core';
import { Pseudonymizer } from '@center/pii';
import { SecretBox } from '@center/secrets';
import { buildServer } from '../server.js';
import { hashPassword } from '../auth/password.js';
import { testConfig } from './helpers/config.js';

const secretBox = new SecretBox(testConfig.credentialsEncryptionKey);

function buildOrgRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'org_1', ga4PropertyId: null, ga4BigQueryDataset: null,
    uappiApiKey: null, uappiSecretKey: null,
    ...overrides,
  };
}

async function setup(role: 'ADMIN' | 'VIEWER', orgRow: Record<string, unknown>) {
  const update = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...orgRow, ...data }));
  const prisma = {
    user: {
      findUnique: jest.fn(async () => ({
        id: 'user_1', email: 'ana@example.com', name: 'Ana', role,
        organizationId: 'org_1', passwordHash: await hashPassword('segredo123'),
      })),
    },
    organization: {
      findUnique: jest.fn(async () => orgRow),
      update,
    },
  } as unknown as PrismaClient;

  const app = await buildServer({
    config: testConfig, prisma,
    gateway: {} as unknown as MetricGateway,
    pseudonymizer: new Pseudonymizer(testConfig.piiPepper),
    secretBox,
    queue: { enqueue: jest.fn(async () => {}) },
  });
  const login = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { email: 'ana@example.com', password: 'segredo123' },
  });
  return { app, prisma, update, token: login.json().token as string };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe('GET /api/settings/integrations', () => {
  it('requires a token', async () => {
    const { app } = await setup('ADMIN', buildOrgRow());
    expect((await app.inject({ method: 'GET', url: '/api/settings/integrations' })).statusCode).toBe(401);
    await app.close();
  });

  it('reports uappi as not configured and ga4 fields as null by default', async () => {
    const { app, token } = await setup('ADMIN', buildOrgRow());
    const response = await app.inject({ method: 'GET', url: '/api/settings/integrations', headers: auth(token) });
    expect(response.json()).toEqual({
      uappi: { configured: false }, ga4: { propertyId: null, bigQueryDataset: null },
    });
    await app.close();
  });

  it('reports uappi as configured without ever returning the ciphertext or the plaintext', async () => {
    const orgRow = buildOrgRow({
      uappiApiKey: secretBox.encrypt('ak-real'), uappiSecretKey: secretBox.encrypt('sk-real'),
      ga4PropertyId: '111', ga4BigQueryDataset: 'analytics_111',
    });
    const { app, token } = await setup('ADMIN', orgRow);
    const response = await app.inject({ method: 'GET', url: '/api/settings/integrations', headers: auth(token) });
    const body = response.json();
    expect(body).toEqual({
      uappi: { configured: true }, ga4: { propertyId: '111', bigQueryDataset: 'analytics_111' },
    });
    expect(JSON.stringify(body)).not.toMatch(/ak-real|sk-real|v1\./);
    await app.close();
  });

  it('is readable by a VIEWER — seeing what is configured is not sensitive', async () => {
    const { app, token } = await setup('VIEWER', buildOrgRow());
    expect((await app.inject({ method: 'GET', url: '/api/settings/integrations', headers: auth(token) })).statusCode).toBe(200);
    await app.close();
  });
});

describe('PUT /api/settings/integrations', () => {
  it('requires ADMIN — a VIEWER gets 403', async () => {
    const { app, token } = await setup('VIEWER', buildOrgRow());
    const response = await app.inject({
      method: 'PUT', url: '/api/settings/integrations', headers: auth(token),
      payload: { ga4PropertyId: '111' },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it('encrypts the Uappi credentials before writing to the database', async () => {
    const { app, prisma, token } = await setup('ADMIN', buildOrgRow());
    await app.inject({
      method: 'PUT', url: '/api/settings/integrations', headers: auth(token),
      payload: { uappiApiKey: 'ak-nova', uappiSecretKey: 'sk-nova' },
    });
    const call = (prisma.organization.update as jest.Mock).mock.calls[0]![0] as { data: Record<string, string> };
    expect(call.data.uappiApiKey).not.toBe('ak-nova');
    expect(call.data.uappiApiKey!.startsWith('v1.')).toBe(true);
    expect(secretBox.decrypt(call.data.uappiApiKey!)).toBe('ak-nova');
    expect(secretBox.decrypt(call.data.uappiSecretKey!)).toBe('sk-nova');
    await app.close();
  });

  it('writes ga4PropertyId and ga4BigQueryDataset in the clear — they are not secrets', async () => {
    const { app, prisma, token } = await setup('ADMIN', buildOrgRow());
    await app.inject({
      method: 'PUT', url: '/api/settings/integrations', headers: auth(token),
      payload: { ga4PropertyId: '222', ga4BigQueryDataset: 'analytics_222' },
    });
    const call = (prisma.organization.update as jest.Mock).mock.calls[0]![0] as { data: Record<string, string> };
    expect(call.data).toMatchObject({ ga4PropertyId: '222', ga4BigQueryDataset: 'analytics_222' });
    await app.close();
  });

  it('leaves a field untouched when it is omitted from the body', async () => {
    const orgRow = buildOrgRow({ ga4PropertyId: '111' });
    const { app, prisma, token } = await setup('ADMIN', orgRow);
    await app.inject({
      method: 'PUT', url: '/api/settings/integrations', headers: auth(token),
      payload: { ga4BigQueryDataset: 'analytics_111' },
    });
    const call = (prisma.organization.update as jest.Mock).mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(call.data).not.toHaveProperty('ga4PropertyId');
  });

  it('rejects an empty body with 400 instead of a no-op write', async () => {
    const { app, prisma, token } = await setup('ADMIN', buildOrgRow());
    const response = await app.inject({
      method: 'PUT', url: '/api/settings/integrations', headers: auth(token), payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(prisma.organization.update).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns the updated masked view, not the raw values', async () => {
    const { app, token } = await setup('ADMIN', buildOrgRow());
    const response = await app.inject({
      method: 'PUT', url: '/api/settings/integrations', headers: auth(token),
      payload: { uappiApiKey: 'ak-nova', uappiSecretKey: 'sk-nova' },
    });
    expect(response.json()).toMatchObject({ uappi: { configured: true } });
  });
});
```

- [ ] **Step 3: Implementar `routes/settings.ts`**

`apps/api/src/routes/settings.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin, requireAuth } from '../auth/jwt.js';
import type { AppDeps } from '../deps.js';

const UpdateBodySchema = z.object({
  uappiApiKey: z.string().min(1).optional(),
  uappiSecretKey: z.string().min(1).optional(),
  ga4PropertyId: z.string().min(1).optional(),
  ga4BigQueryDataset: z.string().min(1).optional(),
}).refine((body) => Object.keys(body).length > 0, { message: 'informe ao menos um campo' });

interface IntegrationsView {
  uappi: { configured: boolean };
  ga4: { propertyId: string | null; bigQueryDataset: string | null };
}

function toView(org: {
  uappiApiKey: string | null; uappiSecretKey: string | null;
  ga4PropertyId: string | null; ga4BigQueryDataset: string | null;
}): IntegrationsView {
  return {
    // As duas credenciais são configuradas juntas ou não — reportamos "true"
    // só quando ambas existem, para não sugerir que a integração funciona
    // com metade das credenciais.
    uappi: { configured: Boolean(org.uappiApiKey && org.uappiSecretKey) },
    ga4: { propertyId: org.ga4PropertyId, bigQueryDataset: org.ga4BigQueryDataset },
  };
}

export async function registerSettingsRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get('/api/settings/integrations', { preHandler: requireAuth }, async (request, reply) => {
    const org = await deps.prisma.organization.findUnique({
      where: { id: request.auth.organizationId },
      select: { uappiApiKey: true, uappiSecretKey: true, ga4PropertyId: true, ga4BigQueryDataset: true },
    });
    if (!org) return reply.status(404).send({ error: 'not_found', message: 'organização não encontrada' });
    return reply.send(toView(org));
  });

  app.put(
    '/api/settings/integrations',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const parsed = UpdateBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'bad_request', message: parsed.error.issues[0]?.message ?? 'corpo inválido' });
      }
      const body = parsed.data;

      const data: Record<string, string> = {};
      // Cifra na borda — a partir daqui, o valor em claro não existe mais em
      // nenhuma variável deste processo.
      if (body.uappiApiKey) data.uappiApiKey = deps.secretBox.encrypt(body.uappiApiKey);
      if (body.uappiSecretKey) data.uappiSecretKey = deps.secretBox.encrypt(body.uappiSecretKey);
      if (body.ga4PropertyId) data.ga4PropertyId = body.ga4PropertyId;
      if (body.ga4BigQueryDataset) data.ga4BigQueryDataset = body.ga4BigQueryDataset;

      const updated = await deps.prisma.organization.update({
        where: { id: request.auth.organizationId },
        data,
        select: { uappiApiKey: true, uappiSecretKey: true, ga4PropertyId: true, ga4BigQueryDataset: true },
      });

      return reply.send(toView(updated));
    },
  );
}
```

- [ ] **Step 4: Registrar a rota**

`AppDeps.secretBox` já está declarado em `apps/api/src/deps.ts` (T22, já escrita prevendo esta task). Falta só registrar a rota.

Em `apps/api/src/server.ts` (T22), adicione o import e a chamada:

```ts
import { registerSettingsRoutes } from './routes/settings.js';
```

```ts
  await registerSettingsRoutes(app, deps);
```

`apps/api/src/main.ts` (T24) já cria o `SecretBox` e o passa a `buildServer` — o código da T24 foi escrito prevendo esta task.

- [ ] **Step 5: Rodar os testes**

Run: `pnpm --filter @center/api test`
Expected: PASS — 10 testes novos.

- [ ] **Step 6: Validar manualmente**

Com a API no ar (T24, Step 6):

```bash
curl -s -X PUT localhost:3333/api/settings/integrations -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"uappiApiKey":"<apiKey real>","uappiSecretKey":"<secretKey real>"}'

curl -s localhost:3333/api/settings/integrations -H "authorization: Bearer $TOKEN"
```

Expected: o `PUT` devolve `{"uappi":{"configured":true},...}`; confira no Postgres que a coluna guarda texto no formato `v1.<hex>.<hex>.<hex>`, nunca a credencial em claro:

```sql
SELECT "uappiApiKey" FROM "Organization" WHERE id = 'org_dev';
```

**O teste que fecha o ciclo:** com a credencial gravada pela UI, reinicie o processo de sync e confirme que ele autentica de verdade:

```bash
cd apps/api && node dist/sync/sync-worker-main.js
```

Expected: o log mostra `sync concluído` com `processed` maior que zero. Se aparecer `autenticação na Uappi falhou (401)`, o `decryptOrNull` do scheduler (T24) não está sendo aplicado — o worker estaria mandando o texto cifrado como `apiKey`. Este é exatamente o modo de falha que os testes de contrato da T15 e da T24B previnem.

- [ ] **Step 7: Commit**

```bash
git add apps/api
git commit -m "feat(settings): add admin-only routes to configure integration credentials"
```

---

### Task 25: Scaffold do frontend, paleta e cliente de API

**Files:**
- Create: `apps/web/{package.json,tsconfig.json,vite.config.ts,tailwind.config.ts,postcss.config.js,index.html,jest.config.cjs}`
- Create: `apps/web/src/{index.css,main.tsx,App.tsx}`
- Create: `apps/web/src/lib/{viz-colors.ts,api-client.ts,format.ts,query-keys.ts}`
- Create: `apps/web/src/test/{setup.ts,style-stub.cjs,msw-server.ts,render.tsx}`
- Test: `apps/web/src/__tests__/{api-client.test.ts,viz-colors.test.ts}`

**Interfaces:**
- Consumes: contrato HTTP da T23.
- Produces:
  - `SERIES_SLOT_BY_SOURCE: Record<MetricSource, 1|2|3>`, `SERIES_COLOR_BY_SOURCE`, `SERIES_COLOR_SLOTS`, `SOURCE_LABEL`
  - `class ApiError extends Error { status: number }`
  - `apiClient: { login, getCatalog, queryMetric, queryBatch, callTool, correlate, appVersionImpact }`
  - `setAuthToken(token: string | null)`, `getAuthToken()`
  - `formatMetricValue(value: number, unit: MetricUnit): string`, `formatBucketLabel(date, granularity): string`
  - `queryKeys: { catalog, series, batch, tool, correlate }`
  - `renderWithProviders(ui, options?)`

**A regra de cor, validada e não negociável:** slots `#2a78d6` / `#eb6834` / `#1baf7a` / `#eda100` (light) e `#3987e5` / `#d95926` / `#199e70` / `#c98500` (dark), **nesta ordem, atribuídos por entidade e nunca reciclados**. Três slots do modo claro ficam abaixo de 3:1 de contraste com a superfície — por isso **todo gráfico embarca visão de tabela** (T27). Não é um extra: é o mecanismo que torna o gráfico legível para quem não distingue as cores.

**A conversão de centavos acontece só na formatação.** O sistema inteiro carrega dinheiro como inteiro de centavos; `formatMetricValue` é o único lugar que divide por 100.

- [ ] **Step 1: Criar o pacote e configurar o build**

`apps/web/package.json`:

```json
{
  "name": "@center/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "typecheck": "tsc --noEmit",
    "test": "jest"
  },
  "dependencies": {
    "@tanstack/react-query": "^5.62.7",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router-dom": "^7.1.1",
    "recharts": "^2.15.0",
    "clsx": "^2.1.1",
    "tailwind-merge": "^2.6.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.6.3",
    "@testing-library/react": "^16.1.0",
    "@testing-library/user-event": "^14.5.2",
    "@types/react": "^19.0.2",
    "@types/react-dom": "^19.0.2",
    "@vitejs/plugin-react": "^4.3.4",
    "autoprefixer": "^10.4.20",
    "jest-environment-jsdom": "^29.7.0",
    "msw": "^2.7.0",
    "postcss": "^8.4.49",
    "tailwindcss": "^3.4.17",
    "vite": "^6.0.5"
  }
}
```

**Abordagem Tremor Raw, não `@tremor/react`.** O Tremor Raw é o modelo copy-paste do próprio Tremor: os componentes de gráfico vivem no nosso repositório, construídos diretamente sobre Recharts, em vez de virem de um pacote. Três razões, nesta ordem:

1. **React 19.** O `@tremor/react` 3.x declara peer `react@^18` e usa padrões (`defaultProps` em componentes de função, `forwardRef` encadeado) que o React 19 removeu ou mudou. Adotar o pacote significaria assumir esse risco em runtime e ficar esperando um release.
2. **Controle sobre a paleta.** Nossos slots de cor são variáveis CSS (`--viz-1`…), não classes Tailwind estáticas. O prop `colors` do `@tremor/react` espera nomes de cor que ele mapeia para classes geradas em runtime — o que obriga o `safelist` frágil que este plano tinha na versão anterior. Com Recharts direto, passamos `stroke="var(--viz-1)"` e a troca de tema acontece sem safelist nenhum.
3. **Dependência a menos.** Recharts já é a dependência real do Tremor; usá-lo direto remove uma camada sem perder nada que este projeto use.

O custo é escrever o `TimeSeriesChart` à mão (T27) — cerca de 60 linhas. `ChartFrame`, `KpiCard`, `RankingTable` e `FunnelChart` nunca dependeram de Tremor.

`apps/web/vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3333', changeOrigin: true },
      '/auth': { target: 'http://localhost:3333', changeOrigin: true },
    },
  },
});
```

`apps/web/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "types": ["jest", "@testing-library/jest-dom"]
  },
  "include": ["src"]
}
```

`apps/web/postcss.config.js`:

```js
export default { plugins: { tailwindcss: {}, autoprefixer: {} } };
```

`apps/web/index.html`:

```html
<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Center Analytics</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Configurar Tailwind com as cores de visualização**

As cores de série viram **variáveis CSS**, não hex fixo — é o que permite o mesmo `className` trocar de valor entre claro e escuro sem duplicar componente.

`apps/web/tailwind.config.ts`:

```ts
import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        viz: { 1: 'var(--viz-1)', 2: 'var(--viz-2)', 3: 'var(--viz-3)', 4: 'var(--viz-4)' },
      },
    },
  },
  // Sem `safelist`. Toda classe `bg-viz-N` deste projeto é escrita literalmente
  // no código-fonte, então o scanner do Tailwind a encontra. Onde a cor é
  // escolhida em runtime (série de gráfico, swatch por fonte), usamos
  // `var(--viz-N)` em `style`, não uma classe montada por template string —
  // classes dinâmicas seriam invisíveis ao scanner e sumiriam no build.
} satisfies Config;
```

`apps/web/src/index.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

/*
 * Paleta categórica validada (light e dark, pairlist adjacente).
 * A ORDEM DOS SLOTS É O MECANISMO DE SEGURANÇA PARA DALTONISMO — não reordene
 * nem troque um hex sem revalidar a paleta inteira.
 */
:root {
  color-scheme: light;
  --viz-1: #2a78d6; --viz-2: #eb6834; --viz-3: #1baf7a; --viz-4: #eda100;
  --surface-1: #fcfcfb; --page-plane: #f9f9f7;
  --text-primary: #0b0b0b; --text-secondary: #52514e; --text-muted: #898781;
  --gridline: #e1e0d9; --hairline: rgba(11, 11, 11, 0.1);
  --good: #006300; --critical: #d03b3b;
}

@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme='light'])) {
    color-scheme: dark;
    --viz-1: #3987e5; --viz-2: #d95926; --viz-3: #199e70; --viz-4: #c98500;
    --surface-1: #1a1a19; --page-plane: #0d0d0d;
    --text-primary: #ffffff; --text-secondary: #c3c2b7; --text-muted: #898781;
    --gridline: #2c2c2a; --hairline: rgba(255, 255, 255, 0.1);
    --good: #0ca30c; --critical: #d03b3b;
  }
}

:root[data-theme='dark'] {
  color-scheme: dark;
  --viz-1: #3987e5; --viz-2: #d95926; --viz-3: #199e70; --viz-4: #c98500;
  --surface-1: #1a1a19; --page-plane: #0d0d0d;
  --text-primary: #ffffff; --text-secondary: #c3c2b7; --text-muted: #898781;
  --gridline: #2c2c2a; --hairline: rgba(255, 255, 255, 0.1);
  --good: #0ca30c; --critical: #d03b3b;
}

body {
  background-color: var(--page-plane);
  color: var(--text-primary);
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
}
```

- [ ] **Step 3: Escrever o teste de cores (falhando)**

`apps/web/src/__tests__/viz-colors.test.ts`:

```ts
import {
  SERIES_COLOR_BY_SOURCE, SERIES_COLOR_SLOTS, SERIES_SLOT_BY_SOURCE, SOURCE_LABEL,
} from '../lib/viz-colors.js';

describe('viz color assignment', () => {
  it('assigns a distinct slot to each source', () => {
    const slots = Object.values(SERIES_SLOT_BY_SOURCE);
    expect(new Set(slots).size).toBe(slots.length);
  });

  it('keeps the CSS variable in sync with the slot number', () => {
    for (const [source, slot] of Object.entries(SERIES_SLOT_BY_SOURCE)) {
      expect(SERIES_COLOR_BY_SOURCE[source as keyof typeof SERIES_COLOR_BY_SOURCE])
        .toBe(`var(--viz-${slot})`);
    }
  });

  it('labels every source in Portuguese', () => {
    for (const source of Object.keys(SERIES_SLOT_BY_SOURCE)) {
      expect(SOURCE_LABEL[source as keyof typeof SOURCE_LABEL]).toBeTruthy();
    }
  });

  it('exposes exactly four positional slots, all as CSS variables', () => {
    expect(SERIES_COLOR_SLOTS).toEqual([
      'var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)', 'var(--viz-4)',
    ]);
  });

  it('never emits a Tailwind class name — colours are resolved at paint time', () => {
    // Uma classe montada por template string (`bg-viz-${n}`) seria invisível ao
    // scanner do Tailwind e sumiria no build de produção. Este teste trava a
    // decisão de usar `var(--viz-N)` em `style`.
    for (const value of Object.values(SERIES_COLOR_BY_SOURCE)) {
      expect(value).toMatch(/^var\(--viz-\d\)$/);
    }
  });
});
```

- [ ] **Step 4: Implementar `viz-colors.ts`**

`apps/web/src/lib/viz-colors.ts`:

```ts
export type MetricSource = 'commerce' | 'ga4' | 'behavior';

/**
 * A cor segue a ENTIDADE (a fonte), nunca a posição na lista. Se um filtro
 * esconde o GA4, Commerce mantém exatamente a mesma cor.
 */
export const SERIES_SLOT_BY_SOURCE: Record<MetricSource, 1 | 2 | 3> = {
  commerce: 1,
  ga4: 2,
  behavior: 3,
};

/**
 * Referência à variável CSS, não um hex nem um nome de classe.
 *
 * Passada direto para `stroke`/`fill` do Recharts e para `style` de swatches:
 * o navegador resolve `var(--viz-1)` no momento da pintura, então a troca entre
 * claro e escuro acontece sem re-render e sem duplicar componente.
 */
export const SERIES_COLOR_BY_SOURCE: Record<MetricSource, string> = {
  commerce: 'var(--viz-1)',
  ga4: 'var(--viz-2)',
  behavior: 'var(--viz-3)',
};

/** Slots por posição, para séries que não são "por fonte" (ex.: campanhas). */
export const SERIES_COLOR_SLOTS = [
  'var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)', 'var(--viz-4)',
] as const;

export const SOURCE_LABEL: Record<MetricSource, string> = {
  commerce: 'Loja (Uappi)',
  ga4: 'Analytics',
  behavior: 'Comportamento',
};
```

- [ ] **Step 5: Configurar Jest e MSW**

`apps/web/jest.config.cjs`:

```js
const preset = require('../../jest.preset.cjs');

module.exports = {
  ...preset,
  testEnvironment: 'jsdom',
  setupFilesAfterEach: undefined,
  setupFilesAfterEnv: ['<rootDir>/src/test/setup.ts'],
  moduleNameMapper: {
    ...preset.moduleNameMapper,
    '\\.css$': '<rootDir>/src/test/style-stub.cjs',
  },
};
```

`apps/web/src/test/style-stub.cjs`:

```js
module.exports = {};
```

`apps/web/src/test/msw-server.ts`:

```ts
import { setupServer } from 'msw/node';

export const mswServer = setupServer();
```

`apps/web/src/test/setup.ts`:

```ts
import '@testing-library/jest-dom';
import { TextDecoder, TextEncoder } from 'node:util';
import { mswServer } from './msw-server.js';

// MSW 2 e o Recharts precisam destas APIs, ausentes no jsdom.
Object.assign(globalThis, { TextEncoder, TextDecoder });

globalThis.ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver;

// O Recharts mede o container; em jsdom toda medida é 0 e o gráfico não
// renderiza. Forçamos um tamanho para que os elementos existam no DOM.
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 800 });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 400 });

// `onUnhandledRequest: 'error'` obriga cada teste a declarar o que a tela chama.
beforeAll(() => mswServer.listen({ onUnhandledRequest: 'error' }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());
```

`apps/web/src/test/render.tsx`:

```tsx
import type { ReactElement } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

export function renderWithProviders(
  ui: ReactElement,
  options: { route?: string } = {},
): RenderResult {
  const queryClient = new QueryClient({
    // Sem retry nos testes: um erro precisa aparecer de imediato, não depois
    // de três tentativas silenciosas.
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[options.route ?? '/']}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}
```

- [ ] **Step 6: Escrever o teste do cliente de API (falhando)**

`apps/web/src/__tests__/api-client.test.ts`:

```ts
import { http, HttpResponse } from 'msw';
import { mswServer } from '../test/msw-server.js';
import { ApiError, apiClient, setAuthToken } from '../lib/api-client.js';
import { formatBucketLabel, formatMetricValue } from '../lib/format.js';

const series = {
  metricId: 'commerce.revenue', source: 'commerce', unit: 'currency', granularity: 'day',
  total: 55000, points: [{ date: '2026-01-01', value: 55000 }],
};

const query = {
  metricId: 'commerce.revenue', from: '2026-01-01', to: '2026-01-31', granularity: 'day' as const,
};

afterEach(() => setAuthToken(null));

describe('apiClient.queryMetric', () => {
  it('posts the query and returns the series', async () => {
    mswServer.use(http.post('/api/metrics/query', () => HttpResponse.json(series)));
    expect(await apiClient.queryMetric(query)).toEqual(series);
  });

  it('sends the bearer token once it is set', async () => {
    let received: string | null = null;
    mswServer.use(http.post('/api/metrics/query', ({ request }) => {
      received = request.headers.get('authorization');
      return HttpResponse.json(series);
    }));
    setAuthToken('token-abc');
    await apiClient.queryMetric(query);
    expect(received).toBe('Bearer token-abc');
  });

  it('throws ApiError carrying the status and message on 400', async () => {
    mswServer.use(http.post('/api/metrics/query', () =>
      HttpResponse.json({ message: 'intervalo excede o máximo de 400 dias' }, { status: 400 })));
    await expect(apiClient.queryMetric(query)).rejects.toMatchObject({
      name: 'ApiError', status: 400, message: 'intervalo excede o máximo de 400 dias',
    });
  });

  it('throws ApiError on 502', async () => {
    mswServer.use(http.post('/api/metrics/query', () =>
      HttpResponse.json({ message: 'Uappi indisponível' }, { status: 502 })));
    await expect(apiClient.queryMetric(query)).rejects.toBeInstanceOf(ApiError);
  });

  it('clears the token on 401 so the guard can redirect', async () => {
    mswServer.use(http.post('/api/metrics/query', () =>
      HttpResponse.json({ message: 'token inválido' }, { status: 401 })));
    setAuthToken('token-expirado');
    await expect(apiClient.queryMetric(query)).rejects.toMatchObject({ status: 401 });
    expect(localStorage.getItem('center.token')).toBeNull();
  });
});

describe('apiClient.callTool', () => {
  it('posts to the tool route of the given source', async () => {
    let path = '';
    mswServer.use(http.post('/api/tools/:source/:name', ({ request }) => {
      path = new URL(request.url).pathname;
      return HttpResponse.json({ rows: [] });
    }));
    await apiClient.callTool('commerce', 'top_products', { from: '2026-01-01', to: '2026-01-31' });
    expect(path).toBe('/api/tools/commerce/top_products');
  });
});

describe('formatMetricValue', () => {
  it('formats currency from cents to BRL', () => {
    expect(formatMetricValue(123456, 'currency').replace(/ /g, ' ')).toBe('R$ 1.234,56');
  });

  it('formats zero cents', () => {
    expect(formatMetricValue(0, 'currency').replace(/ /g, ' ')).toBe('R$ 0,00');
  });

  it('formats counts with thousand separators and no decimals', () => {
    expect(formatMetricValue(1234567, 'count')).toBe('1.234.567');
  });

  it('formats ratios as percentages', () => {
    expect(formatMetricValue(0.1234, 'ratio')).toBe('12,3%');
  });

  it('formats durations in minutes and seconds', () => {
    expect(formatMetricValue(125, 'duration')).toBe('2min 5s');
  });
});

describe('formatBucketLabel', () => {
  it('shows day and month for day granularity', () => {
    expect(formatBucketLabel('2026-03-09', 'day')).toBe('09/03');
  });

  it('shows the month name for month granularity', () => {
    expect(formatBucketLabel('2026-03-01', 'month')).toBe('mar/26');
  });

  it('shows the week start for week granularity', () => {
    expect(formatBucketLabel('2026-03-09', 'week')).toBe('sem. 09/03');
  });
});
```

- [ ] **Step 7: Implementar `api-client.ts`, `format.ts` e `query-keys.ts`**

`apps/web/src/lib/api-client.ts`:

```ts
export type { MetricSource } from './viz-colors.js';
import type { MetricSource } from './viz-colors.js';

export type MetricUnit = 'count' | 'currency' | 'ratio' | 'duration';
export type Granularity = 'day' | 'week' | 'month';

export interface MetricDescriptor {
  id: string; label: string; description: string;
  source: MetricSource; unit: MetricUnit; dimensions: string[];
}

export interface MetricPoint { date: string; value: number; group?: string }

export interface MetricSeries {
  metricId: string; source: MetricSource; unit: MetricUnit;
  granularity: Granularity; total: number; points: MetricPoint[];
}

/** O cliente NUNCA envia tenant — ele vem do JWT no servidor. */
export interface MetricQueryInput {
  metricId: string; from: string; to: string; granularity: Granularity;
  filters?: Record<string, string>; groupBy?: string;
}

export interface RankingRow {
  key: string; label: string; value: number; unit: MetricUnit;
  extra: Record<string, number>; share: number;
}

export interface RankingResult {
  dimension: string; from: string; to: string;
  total: number; unit: MetricUnit; rows: RankingRow[];
}

export interface FunnelResult {
  from: string; to: string;
  steps: Array<{ key: string; label: string; users: number; stepConversion: number | null; dropOff: number }>;
  worstStepKey: string | null;
  overallConversion: number;
  identifiesUsers: boolean;
  note: string;
}

export interface CorrelationResult {
  metricA: { id: string; unit: MetricUnit; total: number };
  metricB: { id: string; unit: MetricUnit; total: number };
  from: string; to: string; granularity: Granularity; buckets: number;
  coefficient: number | null;
  strength: string; direction: string;
  series: Array<{ date: string; valueA: number; valueB: number }>;
  caveat: string;
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

const TOKEN_KEY = 'center.token';

export function setAuthToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function getAuthToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getAuthToken();
  const response = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

  if (!response.ok) {
    // Token expirado: limpamos aqui para que o guard redirecione sem cada tela
    // ter de tratar 401 individualmente.
    if (response.status === 401) setAuthToken(null);
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(response.status, body.message ?? `requisição falhou (${response.status})`);
  }

  return (await response.json()) as T;
}

export const apiClient = {
  login(email: string, password: string) {
    return request<{ token: string; user: { id: string; name: string; email: string; role: string } }>(
      '/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) },
    );
  },

  async getCatalog(): Promise<MetricDescriptor[]> {
    return (await request<{ metrics: MetricDescriptor[] }>('/api/metrics/catalog')).metrics;
  },

  queryMetric(query: MetricQueryInput): Promise<MetricSeries> {
    return request('/api/metrics/query', { method: 'POST', body: JSON.stringify(query) });
  },

  async queryBatch(queries: MetricQueryInput[]): Promise<MetricSeries[]> {
    return (await request<{ series: MetricSeries[] }>('/api/metrics/batch', {
      method: 'POST', body: JSON.stringify({ queries }),
    })).series;
  },

  callTool<T>(source: MetricSource, name: string, args: Record<string, unknown>): Promise<T> {
    return request(`/api/tools/${source}/${name}`, { method: 'POST', body: JSON.stringify(args) });
  },

  correlate(input: {
    metricIdA: string; metricIdB: string; from: string; to: string; granularity: Granularity;
  }): Promise<CorrelationResult> {
    return request('/api/analysis/correlate', { method: 'POST', body: JSON.stringify(input) });
  },

  appVersionImpact(input: { version: string; releaseDate: string; windowDays?: number }) {
    return request<Record<string, unknown>>('/api/analysis/app-version-impact', {
      method: 'POST', body: JSON.stringify(input),
    });
  },

  getIntegrations(): Promise<IntegrationsView> {
    return request('/api/settings/integrations');
  },

  updateIntegrations(patch: IntegrationsUpdate): Promise<IntegrationsView> {
    return request('/api/settings/integrations', { method: 'PUT', body: JSON.stringify(patch) });
  },
};
```

Adicione também os dois tipos, junto dos demais tipos deste arquivo (T25):

```ts
export interface IntegrationsView {
  uappi: { configured: boolean };
  ga4: { propertyId: string | null; bigQueryDataset: string | null };
}

export interface IntegrationsUpdate {
  uappiApiKey?: string;
  uappiSecretKey?: string;
  ga4PropertyId?: string;
  ga4BigQueryDataset?: string;
}
```

`apps/web/src/lib/format.ts`:

```ts
import type { Granularity, MetricUnit } from './api-client.js';

const LOCALE = 'pt-BR';

const currency = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'BRL' });
const count = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const ratio = new Intl.NumberFormat(LOCALE, { style: 'percent', maximumFractionDigits: 1 });

/**
 * O ÚNICO lugar que divide por 100. Dinheiro circula como inteiro de centavos
 * em todo o resto do sistema — se outra função dividir, os dois números vão
 * divergir e ninguém vai saber qual está certo.
 */
export function formatMetricValue(value: number, unit: MetricUnit): string {
  switch (unit) {
    case 'currency': return currency.format(value / 100);
    case 'ratio': return ratio.format(value);
    case 'duration': {
      const minutes = Math.floor(value / 60);
      const seconds = Math.round(value % 60);
      return minutes > 0 ? `${minutes}min ${seconds}s` : `${seconds}s`;
    }
    default: return count.format(value);
  }
}

const MONTH_ABBR = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/** Rótulo curto de eixo. Deliberadamente compacto: eixos não comportam datas longas. */
export function formatBucketLabel(isoDate: string, granularity: Granularity): string {
  const [year, month, day] = isoDate.split('-') as [string, string, string];
  if (granularity === 'month') return `${MONTH_ABBR[Number(month) - 1]}/${year.slice(2)}`;
  const short = `${day}/${month}`;
  return granularity === 'week' ? `sem. ${short}` : short;
}
```

`apps/web/src/lib/query-keys.ts`:

```ts
import type { MetricQueryInput, MetricSource } from './api-client.js';

/**
 * Chaves hierárquicas: invalidar `['metrics']` invalida tudo de métricas.
 * O objeto entra inteiro na chave — o TanStack Query o serializa de forma
 * estável, então a ordem das propriedades não gera cache duplicado.
 */
export const queryKeys = {
  catalog: () => ['metrics', 'catalog'] as const,
  series: (query: MetricQueryInput) => ['metrics', 'series', query] as const,
  batch: (queries: MetricQueryInput[]) => ['metrics', 'batch', queries] as const,
  tool: (source: MetricSource, name: string, args: Record<string, unknown>) =>
    ['tool', source, name, args] as const,
  correlate: (input: Record<string, unknown>) => ['analysis', 'correlate', input] as const,
};
```

- [ ] **Step 8: Implementar `App.tsx` e `main.tsx` provisórios**

`apps/web/src/App.tsx` (as rotas reais chegam na T28):

```tsx
import { Route, Routes } from 'react-router-dom';

export function App() {
  return (
    <div className="min-h-screen">
      <header role="banner" className="border-b px-6 py-4" style={{ borderColor: 'var(--hairline)' }}>
        <h1 className="text-lg font-semibold">Center Analytics</h1>
      </header>
      <main className="p-6">
        <Routes>
          <Route path="/" element={<p>Carregando painel…</p>} />
        </Routes>
      </main>
    </div>
  );
}
```

`apps/web/src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 60_000, refetchOnWindowFocus: false, retry: 1 },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
```

- [ ] **Step 9: Instalar, testar e verificar o build**

```bash
pnpm install
pnpm --filter @center/web test
pnpm --filter @center/web build
```

Expected: 20 testes PASS; `dist/assets/*.css` contém as declarações `--viz-1` … `--viz-4` nos três escopos de tema (`:root`, o `@media` de dark e `:root[data-theme='dark']`).

Confirme também que o `pnpm install` não emitiu aviso de peer dependency: com Recharts direto, nenhum pacote de gráfico declara `react@^18`, então o React 19 é satisfeito sem exceção. Se aparecer aviso, algum pacote entrou por engano — investigue antes de seguir.

- [ ] **Step 10: Commit**

```bash
git add apps/web
git commit -m "feat(web): scaffold vite + react 19 + tailwind with validated palette and api client"
```

---

### Task 26: Filtros globais e hooks de dados

**Files:**
- Create: `apps/web/src/hooks/{use-filters.ts,use-metric-catalog.ts,use-metric-series.ts,use-tool.ts,use-auth.ts}`
- Create: `apps/web/src/components/filters/{PeriodPicker.tsx,SourceFilter.tsx}`
- Test: `apps/web/src/__tests__/{use-filters.test.tsx,period-picker.test.tsx}`

**Interfaces:**
- Consumes: `apiClient`, `queryKeys` (T25).
- Produces:
  - `type PeriodPreset = 'today' | 'last7' | 'last30' | 'last90' | 'monthToDate' | 'lastMonth'`
  - `resolvePreset(preset, today): { from: string; to: string; granularity: Granularity }`
  - `interface DashboardFilters { from, to, granularity, sources }`
  - `useFilters(today?): { filters, setFilters, applyPreset }`
  - `useMetricCatalog()`, `useMetricSeries(query, options?)`, `useMetricBatch(queries, options?)`
  - `useTool<T>(source, name, args, options?)`
  - `useAuth(): { isAuthenticated, login, logout, isLoggingIn, loginError }`
  - `<PeriodPicker today />`, `<SourceFilter today />`

**Por que os filtros vivem na URL e não em contexto React:** o usuário precisa poder mandar o link da tela filtrada para um colega. Estado em memória perde isso e obriga a reimplementar deep-link depois.

- [ ] **Step 1: Escrever o teste dos filtros (falhando)**

`apps/web/src/__tests__/use-filters.test.tsx`:

```tsx
import { act, renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { resolvePreset, useFilters } from '../hooks/use-filters.js';

function wrapperFor(route: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>;
  };
}

const TODAY = '2026-03-15';

describe('resolvePreset', () => {
  it('today covers a single day', () => {
    expect(resolvePreset('today', TODAY)).toEqual({ from: TODAY, to: TODAY, granularity: 'day' });
  });

  it('last7 covers today and the six previous days', () => {
    expect(resolvePreset('last7', TODAY)).toEqual({ from: '2026-03-09', to: TODAY, granularity: 'day' });
  });

  it('last30 stays on day granularity', () => {
    expect(resolvePreset('last30', TODAY)).toEqual({ from: '2026-02-14', to: TODAY, granularity: 'day' });
  });

  it('last90 switches to week so the axis stays readable', () => {
    expect(resolvePreset('last90', TODAY)).toEqual({ from: '2025-12-16', to: TODAY, granularity: 'week' });
  });

  it('monthToDate starts on the first of the month', () => {
    expect(resolvePreset('monthToDate', TODAY)).toEqual({ from: '2026-03-01', to: TODAY, granularity: 'day' });
  });

  it('lastMonth covers the whole previous month', () => {
    expect(resolvePreset('lastMonth', TODAY)).toEqual({
      from: '2026-02-01', to: '2026-02-28', granularity: 'day',
    });
  });

  it('handles a January lastMonth crossing the year boundary', () => {
    expect(resolvePreset('lastMonth', '2026-01-10')).toEqual({
      from: '2025-12-01', to: '2025-12-31', granularity: 'day',
    });
  });

  it('handles February in a leap year', () => {
    expect(resolvePreset('lastMonth', '2024-03-10')).toEqual({
      from: '2024-02-01', to: '2024-02-29', granularity: 'day',
    });
  });
});

describe('useFilters', () => {
  it('defaults to the last 30 days when the URL has no params', () => {
    const { result } = renderHook(() => useFilters(TODAY), { wrapper: wrapperFor('/') });
    expect(result.current.filters).toEqual({
      from: '2026-02-14', to: TODAY, granularity: 'day', sources: ['commerce', 'ga4'],
    });
  });

  it('reads the filters from the URL', () => {
    const { result } = renderHook(() => useFilters(TODAY), {
      wrapper: wrapperFor('/?from=2026-01-01&to=2026-01-31&granularity=month&sources=commerce'),
    });
    expect(result.current.filters).toEqual({
      from: '2026-01-01', to: '2026-01-31', granularity: 'month', sources: ['commerce'],
    });
  });

  it('falls back to the default on an invalid granularity', () => {
    const { result } = renderHook(() => useFilters(TODAY), { wrapper: wrapperFor('/?granularity=hour') });
    expect(result.current.filters.granularity).toBe('day');
  });

  it('ignores an unknown source in the URL', () => {
    const { result } = renderHook(() => useFilters(TODAY), {
      wrapper: wrapperFor('/?sources=commerce,mixpanel'),
    });
    expect(result.current.filters.sources).toEqual(['commerce']);
  });

  it('writes a patch back to the URL without dropping the other filters', () => {
    const { result } = renderHook(() => useFilters(TODAY), {
      wrapper: wrapperFor('/?from=2026-01-01&to=2026-01-31&granularity=day'),
    });
    act(() => result.current.setFilters({ granularity: 'month' }));
    expect(result.current.filters).toMatchObject({
      from: '2026-01-01', to: '2026-01-31', granularity: 'month',
    });
  });

  it('applies a preset to the URL', () => {
    const { result } = renderHook(() => useFilters(TODAY), { wrapper: wrapperFor('/') });
    act(() => result.current.applyPreset('lastMonth'));
    expect(result.current.filters).toMatchObject({ from: '2026-02-01', to: '2026-02-28' });
  });
});
```

- [ ] **Step 2: Implementar `use-filters.ts`**

`apps/web/src/hooks/use-filters.ts`:

```ts
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Granularity, MetricSource } from '../lib/api-client.js';

export type PeriodPreset = 'today' | 'last7' | 'last30' | 'last90' | 'monthToDate' | 'lastMonth';

export interface DashboardFilters {
  from: string;
  to: string;
  granularity: Granularity;
  sources: MetricSource[];
}

/** `behavior` fica de fora do padrão: só existe depois da Fase 8. */
const DEFAULT_SOURCES: MetricSource[] = ['commerce', 'ga4'];
const ALL_SOURCES: MetricSource[] = ['commerce', 'ga4', 'behavior'];
const GRANULARITIES: Granularity[] = ['day', 'week', 'month'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function shiftDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return toIso(date);
}

export function resolvePreset(
  preset: PeriodPreset,
  today: string,
): { from: string; to: string; granularity: Granularity } {
  const [year, month] = today.split('-').map(Number) as [number, number];

  switch (preset) {
    case 'today':
      return { from: today, to: today, granularity: 'day' };
    case 'last7':
      return { from: shiftDays(today, -6), to: today, granularity: 'day' };
    case 'last30':
      return { from: shiftDays(today, -29), to: today, granularity: 'day' };
    case 'last90':
      // 90 pontos diários deixam o eixo ilegível; semana é a leitura certa.
      return { from: shiftDays(today, -89), to: today, granularity: 'week' };
    case 'monthToDate':
      return { from: toIso(new Date(Date.UTC(year, month - 1, 1))), to: today, granularity: 'day' };
    case 'lastMonth': {
      const first = new Date(Date.UTC(year, month - 2, 1));
      // Dia 0 do mês seguinte = último dia do anterior. Cobre bissexto.
      const last = new Date(Date.UTC(year, month - 1, 0));
      return { from: toIso(first), to: toIso(last), granularity: 'day' };
    }
  }
}

export function useFilters(today: string = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })) {
  const [searchParams, setSearchParams] = useSearchParams();

  const filters = useMemo<DashboardFilters>(() => {
    const fallback = resolvePreset('last30', today);

    const from = searchParams.get('from');
    const to = searchParams.get('to');
    const granularity = searchParams.get('granularity') as Granularity | null;
    const sourcesParam = searchParams.get('sources');

    const parsedSources = sourcesParam
      ? sourcesParam.split(',').filter((s): s is MetricSource => ALL_SOURCES.includes(s as MetricSource))
      : DEFAULT_SOURCES;

    return {
      // Valor inválido na URL nunca quebra a tela — cai no default.
      from: from && ISO_DATE.test(from) ? from : fallback.from,
      to: to && ISO_DATE.test(to) ? to : fallback.to,
      granularity: granularity && GRANULARITIES.includes(granularity) ? granularity : fallback.granularity,
      sources: parsedSources.length > 0 ? parsedSources : DEFAULT_SOURCES,
    };
  }, [searchParams, today]);

  const setFilters = useCallback(
    (patch: Partial<DashboardFilters>) => {
      const next = { ...filters, ...patch };
      setSearchParams({
        from: next.from, to: next.to,
        granularity: next.granularity, sources: next.sources.join(','),
      }, { replace: true });
    },
    [filters, setSearchParams],
  );

  const applyPreset = useCallback(
    (preset: PeriodPreset) => setFilters(resolvePreset(preset, today)),
    [setFilters, today],
  );

  return { filters, setFilters, applyPreset };
}
```

- [ ] **Step 3: Implementar os hooks de dados**

`apps/web/src/hooks/use-metric-catalog.ts`:

```ts
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../lib/api-client.js';
import { queryKeys } from '../lib/query-keys.js';

export function useMetricCatalog() {
  return useQuery({
    queryKey: queryKeys.catalog(),
    queryFn: () => apiClient.getCatalog(),
    // O catálogo praticamente não muda; recarregá-lo a cada navegação é desperdício.
    staleTime: 10 * 60_000,
  });
}
```

`apps/web/src/hooks/use-metric-series.ts`:

```ts
import { useQuery } from '@tanstack/react-query';
import { apiClient, type MetricQueryInput } from '../lib/api-client.js';
import { queryKeys } from '../lib/query-keys.js';

export function useMetricSeries(query: MetricQueryInput, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.series(query),
    queryFn: () => apiClient.queryMetric(query),
    enabled: options.enabled ?? true,
  });
}

/** Uma chamada HTTP para os N KPIs da tela, cada série com sua própria chave. */
export function useMetricBatch(queries: MetricQueryInput[], options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.batch(queries),
    queryFn: () => apiClient.queryBatch(queries),
    enabled: (options.enabled ?? true) && queries.length > 0,
  });
}
```

`apps/web/src/hooks/use-tool.ts`:

```ts
import { useQuery } from '@tanstack/react-query';
import { apiClient, type MetricSource } from '../lib/api-client.js';
import { queryKeys } from '../lib/query-keys.js';

export function useTool<T>(
  source: MetricSource,
  name: string,
  args: Record<string, unknown>,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: queryKeys.tool(source, name, args),
    queryFn: () => apiClient.callTool<T>(source, name, args),
    enabled: options.enabled ?? true,
  });
}
```

`apps/web/src/hooks/use-auth.ts`:

```ts
import { useCallback, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient, getAuthToken, setAuthToken } from '../lib/api-client.js';

export function useAuth() {
  const queryClient = useQueryClient();
  const [isAuthenticated, setIsAuthenticated] = useState(() => getAuthToken() !== null);

  const mutation = useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) =>
      apiClient.login(email, password),
    onSuccess: (data) => {
      setAuthToken(data.token);
      setIsAuthenticated(true);
    },
  });

  const login = useCallback(
    async (email: string, password: string) => { await mutation.mutateAsync({ email, password }); },
    [mutation],
  );

  const logout = useCallback(() => {
    setAuthToken(null);
    setIsAuthenticated(false);
    // Sem isto, o próximo usuário veria os dados em cache do anterior.
    queryClient.clear();
  }, [queryClient]);

  return {
    isAuthenticated, login, logout,
    isLoggingIn: mutation.isPending,
    loginError: mutation.error instanceof Error ? mutation.error : null,
  };
}
```

- [ ] **Step 4: Escrever o teste dos componentes de filtro (falhando)**

`apps/web/src/__tests__/period-picker.test.tsx`:

```tsx
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/render.js';
import { PeriodPicker } from '../components/filters/PeriodPicker.js';
import { SourceFilter } from '../components/filters/SourceFilter.js';

describe('PeriodPicker', () => {
  it('exposes every preset as a button', () => {
    renderWithProviders(<PeriodPicker today="2026-03-15" />);
    for (const label of ['Hoje', '7 dias', '30 dias', '90 dias', 'Mês atual', 'Mês passado']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('marks the active preset with aria-pressed', async () => {
    renderWithProviders(<PeriodPicker today="2026-03-15" />, { route: '/' });
    await userEvent.click(screen.getByRole('button', { name: 'Mês passado' }));
    expect(screen.getByRole('button', { name: 'Mês passado' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '30 dias' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows the resolved range as text so it is never ambiguous', async () => {
    renderWithProviders(<PeriodPicker today="2026-03-15" />, { route: '/' });
    await userEvent.click(screen.getByRole('button', { name: 'Mês passado' }));
    expect(screen.getByText('01/02/2026 – 28/02/2026')).toBeInTheDocument();
  });
});

describe('SourceFilter', () => {
  it('renders one checkbox per source, checked by default', () => {
    renderWithProviders(<SourceFilter today="2026-03-15" />, { route: '/' });
    expect(screen.getByRole('checkbox', { name: 'Loja (Uappi)' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Analytics' })).toBeChecked();
  });

  it('unchecking a source removes it from the filters', async () => {
    renderWithProviders(<SourceFilter today="2026-03-15" />, { route: '/' });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Analytics' }));
    expect(screen.getByRole('checkbox', { name: 'Analytics' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Loja (Uappi)' })).toBeChecked();
  });

  it('refuses to uncheck the last remaining source', async () => {
    renderWithProviders(<SourceFilter today="2026-03-15" />, { route: '/?sources=commerce' });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Loja (Uappi)' }));
    expect(screen.getByRole('checkbox', { name: 'Loja (Uappi)' })).toBeChecked();
  });
});
```

- [ ] **Step 5: Implementar os componentes de filtro**

`apps/web/src/components/filters/PeriodPicker.tsx`:

```tsx
import { resolvePreset, useFilters, type PeriodPreset } from '../../hooks/use-filters.js';

const PRESETS: Array<{ id: PeriodPreset; label: string }> = [
  { id: 'today', label: 'Hoje' },
  { id: 'last7', label: '7 dias' },
  { id: 'last30', label: '30 dias' },
  { id: 'last90', label: '90 dias' },
  { id: 'monthToDate', label: 'Mês atual' },
  { id: 'lastMonth', label: 'Mês passado' },
];

function formatBr(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  return `${day}/${month}/${year}`;
}

export function PeriodPicker({ today }: { today: string }) {
  const { filters, applyPreset } = useFilters(today);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div role="group" aria-label="Período" className="flex flex-wrap gap-1">
        {PRESETS.map((preset) => {
          const resolved = resolvePreset(preset.id, today);
          const active = resolved.from === filters.from && resolved.to === filters.to;
          return (
            <button
              key={preset.id}
              type="button"
              aria-pressed={active}
              onClick={() => applyPreset(preset.id)}
              className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                active ? 'bg-viz-1 text-white' : 'hover:bg-black/5 dark:hover:bg-white/10'
              }`}
              style={active ? undefined : { color: 'var(--text-secondary)' }}
            >
              {preset.label}
            </button>
          );
        })}
      </div>
      {/* O intervalo resolvido fica sempre visível: "30 dias" sozinho é ambíguo. */}
      <span className="text-sm tabular-nums" style={{ color: 'var(--text-muted)' }}>
        {formatBr(filters.from)} – {formatBr(filters.to)}
      </span>
    </div>
  );
}
```

`apps/web/src/components/filters/SourceFilter.tsx`:

```tsx
import { useFilters } from '../../hooks/use-filters.js';
import { SERIES_COLOR_BY_SOURCE, SOURCE_LABEL } from '../../lib/viz-colors.js';
import type { MetricSource } from '../../lib/api-client.js';

const SOURCES: MetricSource[] = ['commerce', 'ga4'];

export function SourceFilter({ today }: { today: string }) {
  const { filters, setFilters } = useFilters(today);

  function toggle(source: MetricSource): void {
    const active = filters.sources.includes(source);
    // Desmarcar a última fonte deixaria a tela vazia sem explicação.
    if (active && filters.sources.length === 1) return;
    setFilters({
      sources: active
        ? filters.sources.filter((item) => item !== source)
        : [...filters.sources, source],
    });
  }

  return (
    <fieldset className="flex flex-wrap items-center gap-4">
      <legend className="sr-only">Fontes de dados</legend>
      {SOURCES.map((source) => (
        <label key={source} className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={filters.sources.includes(source)}
            onChange={() => toggle(source)}
            className="h-4 w-4 rounded"
          />
          {/* Swatch ao lado do rótulo: a identidade nunca depende só da cor.
              A cor vai em `style`, não em classe — uma classe montada em runtime
              seria removida pelo Tailwind no build de produção. */}
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 rounded-sm"
            style={{ backgroundColor: SERIES_COLOR_BY_SOURCE[source] }}
          />
          <span style={{ color: 'var(--text-secondary)' }}>{SOURCE_LABEL[source]}</span>
        </label>
      ))}
    </fieldset>
  );
}
```

- [ ] **Step 6: Rodar os testes**

Run: `pnpm --filter @center/web test`
Expected: PASS — 34 testes.

- [ ] **Step 7: Commit**

```bash
git add apps/web
git commit -m "feat(web): add url-synced filters and typed data hooks"
```

---

### Task 27: Componentes de gráfico e ranking

**Files:**
- Create: `apps/web/src/components/charts/{ChartFrame.tsx,KpiCard.tsx,TimeSeriesChart.tsx,RankingTable.tsx,FunnelChart.tsx}`
- Test: `apps/web/src/__tests__/{chart-frame.test.tsx,kpi-card.test.tsx,time-series-chart.test.tsx,ranking-table.test.tsx}`

**Interfaces:**
- Consumes: `MetricSeries`, `RankingResult`, `FunnelResult`, `formatMetricValue`, `formatBucketLabel`, `SERIES_COLOR_BY_SOURCE`, `SERIES_COLOR_SLOTS`, `SOURCE_LABEL`; `recharts`.
- Produces:
  - `<ChartFrame title description? tableColumns tableRows isLoading? error? children />`
  - `<KpiCard label value unit previousValue? isLoading? error? />`
  - `<TimeSeriesChart title description? seriesList granularity unit isLoading? error? />`
  - `<RankingTable title description? result isLoading? error? />`
  - `<FunnelChart title result isLoading? error? />`

**As regras de visualização aplicadas, todas verificáveis por teste:**
1. **Tabela sempre disponível** — três cores do modo claro ficam abaixo de 3:1 de contraste; a regra de relevo obriga rótulos visíveis ou visão de tabela. O `ChartFrame` a embute para que nenhum gráfico possa esquecê-la.
2. **Legenda com ≥ 2 séries; nenhuma com 1** (o título já nomeia a série única).
3. **Nunca dois eixos Y.** Escalas diferentes → dois gráficos.
4. **Traço fino, grade recessiva, sem rótulo em todo ponto.**
5. **Cor por entidade**, via `SERIES_COLOR_BY_SOURCE` — sempre `var(--viz-N)` em prop de cor do Recharts, nunca uma classe Tailwind montada em runtime.
6. **Valor monetário passa por `formatMetricValue` também na tooltip e no eixo Y.** O padrão do Recharts imprimiria o número cru, e dinheiro chega aqui em centavos.

- [ ] **Step 1: Escrever o teste do ChartFrame (falhando)**

`apps/web/src/__tests__/chart-frame.test.tsx`:

```tsx
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/render.js';
import { ChartFrame } from '../components/charts/ChartFrame.js';

const tableColumns = ['Data', 'Faturamento'];
const tableRows = [['01/01', 'R$ 550,00'], ['02/01', 'R$ 610,00']];

describe('ChartFrame', () => {
  it('renders the chart by default and hides the table', () => {
    renderWithProviders(
      <ChartFrame title="Faturamento" tableColumns={tableColumns} tableRows={tableRows}>
        <div data-testid="chart" />
      </ChartFrame>,
    );
    expect(screen.getByTestId('chart')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('swaps to the accessible table view on toggle', async () => {
    renderWithProviders(
      <ChartFrame title="Faturamento" tableColumns={tableColumns} tableRows={tableRows}>
        <div data-testid="chart" />
      </ChartFrame>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Ver como tabela' }));
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Faturamento' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'R$ 550,00' })).toBeInTheDocument();
    expect(screen.queryByTestId('chart')).not.toBeInTheDocument();
  });

  it('goes back to the chart on a second toggle', async () => {
    renderWithProviders(
      <ChartFrame title="Faturamento" tableColumns={tableColumns} tableRows={tableRows}>
        <div data-testid="chart" />
      </ChartFrame>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Ver como tabela' }));
    await userEvent.click(screen.getByRole('button', { name: 'Ver como gráfico' }));
    expect(screen.getByTestId('chart')).toBeInTheDocument();
  });

  it('shows a loading state instead of the chart', () => {
    renderWithProviders(
      <ChartFrame title="Faturamento" tableColumns={tableColumns} tableRows={[]} isLoading>
        <div data-testid="chart" />
      </ChartFrame>,
    );
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByTestId('chart')).not.toBeInTheDocument();
  });

  it('shows the error and hides the table toggle', () => {
    renderWithProviders(
      <ChartFrame title="Faturamento" tableColumns={tableColumns} tableRows={[]} error={new Error('Uappi fora do ar')}>
        <div data-testid="chart" />
      </ChartFrame>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Uappi fora do ar');
    expect(screen.queryByRole('button', { name: 'Ver como tabela' })).not.toBeInTheDocument();
  });

  it('shows an empty state when there is no data', () => {
    renderWithProviders(
      <ChartFrame title="Faturamento" tableColumns={tableColumns} tableRows={[]}>
        <div data-testid="chart" />
      </ChartFrame>,
    );
    expect(screen.getByText('Sem dados no período selecionado')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Implementar `ChartFrame.tsx`**

`apps/web/src/components/charts/ChartFrame.tsx`:

```tsx
import { useState, type ReactNode } from 'react';

interface ChartFrameProps {
  title: string;
  description?: string;
  tableColumns: string[];
  tableRows: string[][];
  isLoading?: boolean;
  error?: Error | null;
  children: ReactNode;
}

/**
 * Envelope de todo gráfico. Três das quatro cores do modo claro ficam abaixo de
 * 3:1 de contraste com a superfície — a visão de tabela não é um extra, é o
 * mecanismo de relevo que torna o gráfico legível para quem não distingue as
 * cores. Por isso vive aqui, e não em cada gráfico.
 */
export function ChartFrame({
  title, description, tableColumns, tableRows, isLoading = false, error = null, children,
}: ChartFrameProps) {
  const [showTable, setShowTable] = useState(false);
  const isEmpty = !isLoading && !error && tableRows.length === 0;

  return (
    <section
      className="rounded-lg border p-4"
      style={{ backgroundColor: 'var(--surface-1)', borderColor: 'var(--hairline)' }}
      aria-label={title}
    >
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h3>
          {description ? (
            <p className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>{description}</p>
          ) : null}
        </div>
        {!error && !isLoading && tableRows.length > 0 ? (
          <button
            type="button"
            onClick={() => setShowTable((current) => !current)}
            className="shrink-0 rounded-md border px-2 py-1 text-xs"
            style={{ borderColor: 'var(--hairline)', color: 'var(--text-secondary)' }}
          >
            {showTable ? 'Ver como gráfico' : 'Ver como tabela'}
          </button>
        ) : null}
      </div>

      {isLoading ? (
        <div role="status" className="h-64 animate-pulse rounded-md" style={{ backgroundColor: 'var(--gridline)' }}>
          <span className="sr-only">Carregando dados de {title}</span>
        </div>
      ) : error ? (
        <div role="alert" className="rounded-md p-4 text-sm" style={{ color: 'var(--text-secondary)' }}>
          <strong className="block font-medium" style={{ color: 'var(--critical)' }}>
            Não foi possível carregar
          </strong>
          {error.message}
        </div>
      ) : isEmpty ? (
        <p className="py-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
          Sem dados no período selecionado
        </p>
      ) : showTable ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                {tableColumns.map((column) => (
                  <th
                    key={column} scope="col"
                    className="border-b px-2 py-1.5 text-left font-medium"
                    style={{ borderColor: 'var(--gridline)', color: 'var(--text-secondary)' }}
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableRows.map((row) => (
                <tr key={row.join('|')}>
                  {row.map((cell, index) => (
                    <td
                      key={`${row[0]}-${index}`}
                      className={`border-b px-2 py-1.5 ${index === 0 ? '' : 'tabular-nums'}`}
                      style={{ borderColor: 'var(--gridline)', color: 'var(--text-primary)' }}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        children
      )}
    </section>
  );
}
```

- [ ] **Step 3: Escrever o teste do KpiCard e implementá-lo**

`apps/web/src/__tests__/kpi-card.test.tsx`:

```tsx
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../test/render.js';
import { KpiCard } from '../components/charts/KpiCard.js';

describe('KpiCard', () => {
  it('formats currency from cents', () => {
    renderWithProviders(<KpiCard label="Faturamento" value={1234560} unit="currency" />);
    expect(screen.getByText(/12\.345,60/)).toBeInTheDocument();
  });

  it('shows a positive delta with a direction word, not only a colour', () => {
    renderWithProviders(<KpiCard label="Pedidos" value={120} previousValue={100} unit="count" />);
    expect(screen.getByText('+20,0%')).toBeInTheDocument();
    expect(screen.getByText(/aumento/i)).toBeInTheDocument();
  });

  it('shows a negative delta', () => {
    renderWithProviders(<KpiCard label="Pedidos" value={80} previousValue={100} unit="count" />);
    expect(screen.getByText('-20,0%')).toBeInTheDocument();
    expect(screen.getByText(/queda/i)).toBeInTheDocument();
  });

  it('omits the delta when there is no previous value', () => {
    renderWithProviders(<KpiCard label="Pedidos" value={120} unit="count" />);
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it('omits the delta when the previous value is zero', () => {
    renderWithProviders(<KpiCard label="Pedidos" value={120} previousValue={0} unit="count" />);
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it('shows the error instead of a stale value', () => {
    renderWithProviders(<KpiCard label="Pedidos" value={0} unit="count" error={new Error('fonte fora do ar')} />);
    expect(screen.getByRole('alert')).toHaveTextContent('fonte fora do ar');
  });
});
```

`apps/web/src/components/charts/KpiCard.tsx`:

```tsx
import type { MetricUnit } from '../../lib/api-client.js';
import { formatMetricValue } from '../../lib/format.js';

interface KpiCardProps {
  label: string;
  value: number;
  unit: MetricUnit;
  previousValue?: number;
  isLoading?: boolean;
  error?: Error | null;
}

const percent = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: 'always',
});

/**
 * Número-herói sem gráfico. A variação carrega SEMPRE uma palavra ("aumento"
 * / "queda") além da cor — cor sozinha não é canal acessível.
 */
export function KpiCard({ label, value, unit, previousValue, isLoading = false, error = null }: KpiCardProps) {
  const hasDelta = previousValue !== undefined && previousValue !== 0;
  const deltaRatio = hasDelta ? ((value - previousValue) / Math.abs(previousValue)) * 100 : 0;
  const rising = deltaRatio >= 0;

  return (
    <div className="rounded-lg border p-4" style={{ backgroundColor: 'var(--surface-1)', borderColor: 'var(--hairline)' }}>
      <p className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
        {label}
      </p>

      {isLoading ? (
        <div role="status" className="mt-2 h-8 w-24 animate-pulse rounded" style={{ backgroundColor: 'var(--gridline)' }}>
          <span className="sr-only">Carregando {label}</span>
        </div>
      ) : error ? (
        <p role="alert" className="mt-2 text-sm" style={{ color: 'var(--critical)' }}>{error.message}</p>
      ) : (
        <>
          <p className="mt-1 text-3xl font-semibold" style={{ color: 'var(--text-primary)' }}>
            {formatMetricValue(value, unit)}
          </p>
          {hasDelta ? (
            <p className="mt-1 flex items-center gap-1.5 text-sm">
              <span aria-hidden="true" style={{ color: rising ? 'var(--good)' : 'var(--critical)' }}>
                {rising ? '▲' : '▼'}
              </span>
              <span className="tabular-nums" style={{ color: rising ? 'var(--good)' : 'var(--critical)' }}>
                {percent.format(deltaRatio)}%
              </span>
              <span style={{ color: 'var(--text-muted)' }}>
                {rising ? 'de aumento' : 'de queda'} vs. período anterior
              </span>
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Escrever o teste do TimeSeriesChart e do RankingTable (falhando)**

`apps/web/src/__tests__/time-series-chart.test.tsx`:

```tsx
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/render.js';
import { TimeSeriesChart } from '../components/charts/TimeSeriesChart.js';
import type { MetricSeries } from '../lib/api-client.js';

const commerce: MetricSeries = {
  metricId: 'commerce.orders', source: 'commerce', unit: 'count', granularity: 'day', total: 12,
  points: [{ date: '2026-01-01', value: 5 }, { date: '2026-01-02', value: 7 }],
};

const ga4: MetricSeries = {
  metricId: 'ga4.sessions', source: 'ga4', unit: 'count', granularity: 'day', total: 116,
  points: [{ date: '2026-01-01', value: 55 }, { date: '2026-01-02', value: 61 }],
};

describe('TimeSeriesChart', () => {
  it('renders inside a frame labelled with the title', () => {
    renderWithProviders(<TimeSeriesChart title="Pedidos" seriesList={[commerce]} granularity="day" unit="count" />);
    expect(screen.getByRole('region', { name: 'Pedidos' })).toBeInTheDocument();
  });

  it('builds a table row per bucket with a column per series', async () => {
    renderWithProviders(<TimeSeriesChart title="Volume" seriesList={[commerce, ga4]} granularity="day" unit="count" />);
    await userEvent.click(screen.getByRole('button', { name: 'Ver como tabela' }));
    expect(screen.getByRole('columnheader', { name: 'Loja (Uappi)' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Analytics' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '01/01' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '55' })).toBeInTheDocument();
  });

  it('aligns buckets across series that do not share every date', async () => {
    const sparse: MetricSeries = { ...ga4, points: [{ date: '2026-01-02', value: 61 }] };
    renderWithProviders(<TimeSeriesChart title="Volume" seriesList={[commerce, sparse]} granularity="day" unit="count" />);
    await userEvent.click(screen.getByRole('button', { name: 'Ver como tabela' }));
    // 01/01 só existe no commerce — a coluna do GA4 mostra zero, não some.
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });

  it('propagates the error to the frame', () => {
    renderWithProviders(
      <TimeSeriesChart title="Pedidos" seriesList={[]} granularity="day" unit="count" error={new Error('fora do ar')} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('fora do ar');
  });

  it('shows the empty state when every series is empty', () => {
    renderWithProviders(
      <TimeSeriesChart title="Pedidos" seriesList={[{ ...commerce, points: [] }]} granularity="day" unit="count" />,
    );
    expect(screen.getByText('Sem dados no período selecionado')).toBeInTheDocument();
  });

  it('formats currency in the table view from cents to reais', async () => {
    const revenue: MetricSeries = {
      metricId: 'commerce.revenue', source: 'commerce', unit: 'currency',
      granularity: 'day', total: 480000,
      points: [{ date: '2026-01-01', value: 480000 }],
    };
    renderWithProviders(
      <TimeSeriesChart title="Faturamento" seriesList={[revenue]} granularity="day" unit="currency" />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Ver como tabela' }));
    // 480000 centavos são R$ 4.800,00 — nunca R$ 480.000,00.
    expect(screen.getByRole('cell', { name: /4\.800,00/ })).toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: /480\.000,00/ })).not.toBeInTheDocument();
  });
});
```

> **Sobre testar o gráfico em si:** o jsdom não faz layout, então o Recharts renderiza um SVG vazio mesmo com o `offsetWidth` forçado no setup (T25). Por isso os testes acima verificam o que um usuário consegue ler de fato — a visão de tabela, a legenda e os estados de erro/vazio — e nunca contam elementos `<path>`. A conferência visual do gráfico é o Step 6 desta task, feita à mão nos dois temas.

`apps/web/src/__tests__/ranking-table.test.tsx`:

```tsx
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../test/render.js';
import { RankingTable } from '../components/charts/RankingTable.js';
import type { RankingResult } from '../lib/api-client.js';

const result: RankingResult = {
  dimension: 'product', from: '2026-01-01', to: '2026-01-31',
  total: 50000, unit: 'currency',
  rows: [
    { key: 'CAM', label: 'Camiseta', value: 30000, unit: 'currency', extra: { quantity: 6, orders: 3 }, share: 0.6 },
    { key: 'TEN', label: 'Tênis', value: 20000, unit: 'currency', extra: { quantity: 1, orders: 1 }, share: 0.4 },
  ],
};

describe('RankingTable', () => {
  it('renders one row per entry with formatted values', () => {
    renderWithProviders(<RankingTable title="Produtos" result={result} />);
    expect(screen.getByRole('cell', { name: 'Camiseta' })).toBeInTheDocument();
    expect(screen.getByText(/300,00/)).toBeInTheDocument();
  });

  it('shows the share as a percentage', () => {
    renderWithProviders(<RankingTable title="Produtos" result={result} />);
    expect(screen.getByText('60,0%')).toBeInTheDocument();
  });

  it('numbers the positions so the ranking is explicit', () => {
    renderWithProviders(<RankingTable title="Produtos" result={result} />);
    expect(screen.getByRole('cell', { name: '1' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '2' })).toBeInTheDocument();
  });

  it('shows the loading state', () => {
    renderWithProviders(<RankingTable title="Produtos" result={undefined} isLoading />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows the error', () => {
    renderWithProviders(<RankingTable title="Produtos" result={undefined} error={new Error('sem dados')} />);
    expect(screen.getByRole('alert')).toHaveTextContent('sem dados');
  });

  it('shows the empty state for a ranking with no rows', () => {
    renderWithProviders(<RankingTable title="Produtos" result={{ ...result, rows: [], total: 0 }} />);
    expect(screen.getByText('Sem dados no período selecionado')).toBeInTheDocument();
  });
});
```

- [ ] **Step 5: Implementar `TimeSeriesChart.tsx`, `RankingTable.tsx` e `FunnelChart.tsx`**

`apps/web/src/components/charts/TimeSeriesChart.tsx`:

```tsx
import {
  Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
  type TooltipProps,
} from 'recharts';
import type { Granularity, MetricSeries, MetricUnit } from '../../lib/api-client.js';
import { formatBucketLabel, formatMetricValue } from '../../lib/format.js';
import { SERIES_COLOR_BY_SOURCE, SOURCE_LABEL } from '../../lib/viz-colors.js';
import { ChartFrame } from './ChartFrame.js';

interface TimeSeriesChartProps {
  title: string;
  description?: string;
  seriesList: MetricSeries[];
  granularity: Granularity;
  unit: MetricUnit;
  isLoading?: boolean;
  error?: Error | null;
}

interface ChartRow { bucket: string; [seriesName: string]: string | number }

/**
 * Uma única escala Y, sempre. Duas métricas de grandezas diferentes (reais e
 * contagem) NUNCA compartilham este componente — são dois gráficos lado a lado.
 */
function buildRows(seriesList: MetricSeries[], granularity: Granularity): ChartRow[] {
  const buckets = [...new Set(seriesList.flatMap((series) => series.points.map((p) => p.date)))].sort();

  return buckets.map((bucket) => {
    const row: ChartRow = { bucket: formatBucketLabel(bucket, granularity) };
    for (const series of seriesList) {
      // Bucket ausente vira 0, não `undefined` — senão a linha ganha um furo.
      row[SOURCE_LABEL[series.source]] = series.points.find((p) => p.date === bucket)?.value ?? 0;
    }
    return row;
  });
}

/**
 * Tooltip própria em vez da padrão do Recharts: a padrão imprime o número cru,
 * e valores monetários chegam aqui em CENTAVOS. Sem `formatMetricValue`, o
 * usuário leria "480000" onde são R$ 4.800,00.
 */
function ChartTooltip({ active, payload, label, unit }: TooltipProps<number, string> & { unit: MetricUnit }) {
  if (!active || !payload?.length) return null;

  return (
    <div
      className="rounded-md border px-3 py-2 text-sm shadow-sm"
      style={{ backgroundColor: 'var(--surface-1)', borderColor: 'var(--hairline)' }}
    >
      <p className="mb-1 font-medium" style={{ color: 'var(--text-primary)' }}>{label}</p>
      {payload.map((entry) => (
        <p key={String(entry.dataKey)} className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="h-2 w-2 shrink-0 rounded-sm"
            style={{ backgroundColor: entry.color }}
          />
          <span style={{ color: 'var(--text-secondary)' }}>{entry.name}</span>
          <span className="ml-auto tabular-nums" style={{ color: 'var(--text-primary)' }}>
            {formatMetricValue(Number(entry.value ?? 0), unit)}
          </span>
        </p>
      ))}
    </div>
  );
}

export function TimeSeriesChart({
  title, description, seriesList, granularity, unit, isLoading = false, error = null,
}: TimeSeriesChartProps) {
  const rows = buildRows(seriesList, granularity);
  const categories = seriesList.map((series) => SOURCE_LABEL[series.source]);

  return (
    <ChartFrame
      title={title}
      {...(description ? { description } : {})}
      tableColumns={['Período', ...categories]}
      tableRows={rows.map((row) => [
        String(row.bucket),
        ...categories.map((category) => formatMetricValue(Number(row[category] ?? 0), unit)),
      ])}
      isLoading={isLoading}
      error={error}
    >
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
            <defs>
              {seriesList.map((series) => (
                <linearGradient
                  key={series.source}
                  id={`fill-${series.source}`}
                  x1="0" y1="0" x2="0" y2="1"
                >
                  {/* Preenchimento discreto: a área dá contexto, a linha carrega o dado. */}
                  <stop offset="0%" stopColor={SERIES_COLOR_BY_SOURCE[series.source]} stopOpacity={0.22} />
                  <stop offset="100%" stopColor={SERIES_COLOR_BY_SOURCE[series.source]} stopOpacity={0.02} />
                </linearGradient>
              ))}
            </defs>

            {/* Grade recessiva: só horizontal, cor de hairline. */}
            <CartesianGrid stroke="var(--gridline)" strokeDasharray="0" vertical={false} />

            <XAxis
              dataKey="bucket"
              tick={{ fill: 'var(--text-muted)', fontSize: 12 }}
              tickLine={false}
              axisLine={{ stroke: 'var(--gridline)' }}
              minTickGap={24}
            />
            <YAxis
              width={80}
              tick={{ fill: 'var(--text-muted)', fontSize: 12 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(value: number) => formatMetricValue(value, unit)}
            />

            <Tooltip
              content={<ChartTooltip unit={unit} />}
              cursor={{ stroke: 'var(--text-muted)', strokeWidth: 1 }}
            />

            {/* Legenda só com 2+ séries: com uma, o título já a nomeia. */}
            {categories.length > 1 ? (
              <Legend
                verticalAlign="bottom"
                height={28}
                iconType="square"
                wrapperStyle={{ fontSize: 12, color: 'var(--text-secondary)' }}
              />
            ) : null}

            {seriesList.map((series) => (
              <Area
                key={series.source}
                type="monotone"
                dataKey={SOURCE_LABEL[series.source]}
                stroke={SERIES_COLOR_BY_SOURCE[series.source]}
                strokeWidth={2}
                fill={`url(#fill-${series.source})`}
                // Sem ponto em cada bucket: só o do hover. Rotular todos os
                // pontos é o anti-padrão que polui a leitura da linha.
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface-1)' }}
                isAnimationActive={false}
                connectNulls
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </ChartFrame>
  );
}
```

`apps/web/src/components/charts/RankingTable.tsx`:

```tsx
import type { RankingResult } from '../../lib/api-client.js';
import { formatMetricValue } from '../../lib/format.js';

interface RankingTableProps {
  title: string;
  description?: string;
  result: RankingResult | undefined;
  isLoading?: boolean;
  error?: Error | null;
}

const percent = new Intl.NumberFormat('pt-BR', {
  style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1,
});

/**
 * Ranking é tabela, não gráfico de barras. Com nomes de produto de comprimento
 * variável, a barra rouba espaço do rótulo e o usuário perde a informação que
 * veio buscar — o nome. A participação percentual dá a proporção sem a barra.
 */
export function RankingTable({ title, description, result, isLoading = false, error = null }: RankingTableProps) {
  return (
    <section
      className="rounded-lg border p-4"
      style={{ backgroundColor: 'var(--surface-1)', borderColor: 'var(--hairline)' }}
      aria-label={title}
    >
      <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h3>
      {description ? (
        <p className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>{description}</p>
      ) : null}

      {isLoading ? (
        <div role="status" className="mt-3 h-48 animate-pulse rounded-md" style={{ backgroundColor: 'var(--gridline)' }}>
          <span className="sr-only">Carregando {title}</span>
        </div>
      ) : error ? (
        <p role="alert" className="mt-3 text-sm" style={{ color: 'var(--critical)' }}>{error.message}</p>
      ) : !result || result.rows.length === 0 ? (
        <p className="py-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
          Sem dados no período selecionado
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                {['#', 'Item', 'Valor', 'Part.'].map((column) => (
                  <th
                    key={column} scope="col"
                    className="border-b px-2 py-1.5 text-left font-medium"
                    style={{ borderColor: 'var(--gridline)', color: 'var(--text-secondary)' }}
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, index) => (
                <tr key={row.key}>
                  <td className="border-b px-2 py-1.5 tabular-nums" style={{ borderColor: 'var(--gridline)', color: 'var(--text-muted)' }}>
                    {index + 1}
                  </td>
                  <td className="border-b px-2 py-1.5" style={{ borderColor: 'var(--gridline)', color: 'var(--text-primary)' }}>
                    {row.label}
                  </td>
                  <td className="border-b px-2 py-1.5 tabular-nums" style={{ borderColor: 'var(--gridline)', color: 'var(--text-primary)' }}>
                    {formatMetricValue(row.value, row.unit)}
                  </td>
                  <td className="border-b px-2 py-1.5 tabular-nums" style={{ borderColor: 'var(--gridline)', color: 'var(--text-secondary)' }}>
                    {percent.format(row.share)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
```

`apps/web/src/components/charts/FunnelChart.tsx`:

```tsx
import type { FunnelResult } from '../../lib/api-client.js';
import { formatMetricValue } from '../../lib/format.js';
import { SERIES_COLOR_SLOTS } from '../../lib/viz-colors.js';

interface FunnelChartProps {
  title: string;
  result: FunnelResult | undefined;
  isLoading?: boolean;
  error?: Error | null;
}

const percent = new Intl.NumberFormat('pt-BR', {
  style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1,
});

/**
 * O funil é desenhado com barras proporcionais ao primeiro passo, e a etapa de
 * maior abandono recebe um rótulo textual — não apenas cor — porque é
 * exatamente a informação que a pergunta procura.
 */
export function FunnelChart({ title, result, isLoading = false, error = null }: FunnelChartProps) {
  const firstUsers = result?.steps[0]?.users ?? 0;

  return (
    <section
      className="rounded-lg border p-4"
      style={{ backgroundColor: 'var(--surface-1)', borderColor: 'var(--hairline)' }}
      aria-label={title}
    >
      <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h3>

      {isLoading ? (
        <div role="status" className="mt-3 h-48 animate-pulse rounded-md" style={{ backgroundColor: 'var(--gridline)' }}>
          <span className="sr-only">Carregando {title}</span>
        </div>
      ) : error ? (
        <p role="alert" className="mt-3 text-sm" style={{ color: 'var(--critical)' }}>{error.message}</p>
      ) : !result || firstUsers === 0 ? (
        <p className="py-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
          Sem dados no período selecionado
        </p>
      ) : (
        <>
          <ol className="mt-3 space-y-2">
            {result.steps.map((step) => {
              const worst = step.key === result.worstStepKey;
              return (
                <li key={step.key}>
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span style={{ color: 'var(--text-primary)' }}>
                      {step.label}
                      {worst ? (
                        <span className="ml-2 text-xs font-medium" style={{ color: 'var(--critical)' }}>
                          maior abandono
                        </span>
                      ) : null}
                    </span>
                    <span className="tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                      {formatMetricValue(step.users, 'count')}
                      {step.stepConversion !== null ? ` · ${percent.format(step.stepConversion)}` : ''}
                    </span>
                  </div>
                  <div className="mt-1 h-2 rounded-sm" style={{ backgroundColor: 'var(--gridline)' }}>
                    {/* Uma série só, então o slot posicional 1 — não há
                        identidade de fonte para preservar aqui. */}
                    <div
                      className="h-2 rounded-sm"
                      style={{
                        width: `${Math.max(2, (step.users / firstUsers) * 100)}%`,
                        backgroundColor: SERIES_COLOR_SLOTS[0],
                      }}
                    />
                  </div>
                </li>
              );
            })}
          </ol>
          <p className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
            Conversão total: {percent.format(result.overallConversion)}. {result.note}
          </p>
        </>
      )}
    </section>
  );
}
```

- [ ] **Step 6: Rodar os testes e inspecionar visualmente**

Run: `pnpm --filter @center/web test`
Expected: PASS — 57 testes.

```bash
pnpm --filter @center/web dev
```

O validador de paleta checa cor, não layout. Confirme nos dois temas do sistema: rótulos do eixo X não colidem no range de 90 dias; a legenda aparece com 2+ séries e some com 1; o toggle de tabela mantém a altura do card estável; nenhuma barra de rolagem horizontal no `body` a 375px.

- [ ] **Step 7: Commit**

```bash
git add apps/web
git commit -m "feat(web): add accessible chart, ranking and funnel components"
```

---

### Task 28: Páginas e autenticação na interface

**Files:**
- Create: `apps/web/src/components/layout/{AppShell.tsx,RequireAuth.tsx}`
- Create: `apps/web/src/pages/{LoginPage.tsx,OverviewPage.tsx,ProductsPage.tsx,AcquisitionPage.tsx,SettingsPage.tsx}`
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/src/__tests__/{login-page.test.tsx,overview-page.test.tsx,products-page.test.tsx}`

**Interfaces:**
- Consumes: hooks da T26, componentes da T27.
- Produces: `<AppShell />`, `<RequireAuth />`, as cinco páginas; rotas `/`, `/produtos`, `/aquisicao`, `/configuracoes`, `/login`.

**Mapa de telas → perguntas:**
| Página | Responde |
|---|---|
| Visão geral | A1, A2, A3, A4, A5, A11, B1, B2, B3 |
| Produtos | A6, A7, A8, A9, A10, A12 |
| Aquisição | B7, B8, B9, B10, B13, B14, C1, C2, C3 |
| Configurações | vínculo do WhatsApp (T34) |

- [ ] **Step 1: Escrever o teste da Overview (falhando)**

`apps/web/src/__tests__/overview-page.test.tsx`:

```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../test/msw-server.js';
import { renderWithProviders } from '../test/render.js';
import { OverviewPage } from '../pages/OverviewPage.js';

function seriesFor(metricId: string, total: number) {
  const source = metricId.startsWith('commerce') ? 'commerce' : 'ga4';
  const unit = metricId === 'commerce.revenue' || metricId === 'commerce.average_ticket' ? 'currency' : 'count';
  return {
    metricId, source, unit, granularity: 'day', total,
    points: [{ date: '2026-03-14', value: total / 2 }, { date: '2026-03-15', value: total / 2 }],
  };
}

function mockEndpoints(batchHandler?: jest.Mock) {
  mswServer.use(
    http.post('/api/metrics/batch', async ({ request }) => {
      const body = (await request.json()) as { queries: Array<{ metricId: string }> };
      batchHandler?.(body);
      return HttpResponse.json({
        series: body.queries.map((q) => seriesFor(q.metricId, q.metricId === 'commerce.revenue' ? 480000 : 120)),
      });
    }),
    http.post('/api/tools/commerce/orders_by_status', () => HttpResponse.json({
      from: '2026-03-01', to: '2026-03-15',
      groups: [
        { group: 'PAID', label: 'Pago', orders: 40, revenueCents: 400000, share: 0.8 },
        { group: 'CANCELLED', label: 'Cancelado', orders: 6, revenueCents: 60000, share: 0.12 },
        { group: 'PENDING_PAYMENT', label: 'Aguardando pagamento', orders: 4, revenueCents: 20000, share: 0.08 },
      ],
    })),
  );
}

describe('OverviewPage', () => {
  it('renders one KPI card per headline metric', async () => {
    mockEndpoints();
    renderWithProviders(<OverviewPage today="2026-03-15" />, { route: '/' });
    await waitFor(() => expect(screen.getByText('Faturamento')).toBeInTheDocument());
    for (const label of ['Pedidos', 'Ticket médio', 'Clientes novos']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('sends the filter period in every query', async () => {
    const handler = jest.fn();
    mockEndpoints(handler);
    renderWithProviders(<OverviewPage today="2026-03-15" />, {
      route: '/?from=2026-01-01&to=2026-01-31&granularity=day&sources=commerce,ga4',
    });
    await waitFor(() => expect(handler).toHaveBeenCalled());
    expect(handler.mock.calls[0][0].queries.every((q: { from: string }) => q.from === '2026-01-01')).toBe(true);
  });

  it('drops queries for a deselected source', async () => {
    const handler = jest.fn();
    mockEndpoints(handler);
    renderWithProviders(<OverviewPage today="2026-03-15" />, { route: '/?sources=commerce' });
    await waitFor(() => expect(handler).toHaveBeenCalled());
    const ids = handler.mock.calls[0][0].queries.map((q: { metricId: string }) => q.metricId);
    expect(ids.every((id: string) => id.startsWith('commerce.'))).toBe(true);
  });

  it('refetches when the user picks another period', async () => {
    const handler = jest.fn();
    mockEndpoints(handler);
    renderWithProviders(<OverviewPage today="2026-03-15" />, { route: '/' });
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole('button', { name: '7 dias' }));
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    expect(handler.mock.calls[1][0].queries[0].from).toBe('2026-03-09');
  });

  it('shows the order status breakdown', async () => {
    mockEndpoints();
    renderWithProviders(<OverviewPage today="2026-03-15" />, { route: '/' });
    await waitFor(() => expect(screen.getByText('Cancelado')).toBeInTheDocument());
    expect(screen.getByText('Aguardando pagamento')).toBeInTheDocument();
  });

  it('shows the error on every card when the batch fails', async () => {
    mswServer.use(
      http.post('/api/metrics/batch', () => HttpResponse.json({ message: 'fontes indisponíveis' }, { status: 502 })),
      http.post('/api/tools/commerce/orders_by_status', () => HttpResponse.json({ groups: [] })),
    );
    renderWithProviders(<OverviewPage today="2026-03-15" />, { route: '/' });
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect(screen.getAllByRole('alert')[0]).toHaveTextContent('fontes indisponíveis');
  });
});
```

- [ ] **Step 2: Implementar `AppShell.tsx` e `RequireAuth.tsx`**

`apps/web/src/components/layout/AppShell.tsx`:

```tsx
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/use-auth.js';

const LINKS = [
  { to: '/', label: 'Visão geral', end: true },
  { to: '/produtos', label: 'Produtos', end: false },
  { to: '/aquisicao', label: 'Aquisição', end: false },
  { to: '/configuracoes', label: 'Configurações', end: false },
];

export function AppShell() {
  const { logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="min-h-screen">
      <header
        role="banner"
        className="border-b px-6 py-4"
        style={{ borderColor: 'var(--hairline)', backgroundColor: 'var(--surface-1)' }}
      >
        <div className="mx-auto flex max-w-7xl items-center gap-8">
          <h1 className="text-lg font-semibold">Center Analytics</h1>
          <nav aria-label="Principal" className="flex flex-wrap gap-1">
            {LINKS.map((link) => (
              <NavLink
                key={link.to} to={link.to} end={link.end}
                className={({ isActive }) =>
                  `rounded-md px-3 py-1.5 text-sm ${isActive ? 'bg-viz-1 text-white' : ''}`}
                style={({ isActive }) => (isActive ? undefined : { color: 'var(--text-secondary)' })}
              >
                {link.label}
              </NavLink>
            ))}
          </nav>
          <button
            type="button"
            onClick={() => { logout(); navigate('/login', { replace: true }); }}
            className="ml-auto rounded-md border px-3 py-1.5 text-sm"
            style={{ borderColor: 'var(--hairline)', color: 'var(--text-secondary)' }}
          >
            Sair
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-7xl p-6">
        <Outlet />
      </main>
    </div>
  );
}
```

`apps/web/src/components/layout/RequireAuth.tsx`:

```tsx
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { getAuthToken } from '../../lib/api-client.js';

export function RequireAuth() {
  const location = useLocation();
  // Lemos o token direto do storage: o cliente de API o remove em qualquer 401,
  // então uma sessão expirada derruba o guard sem precisar de estado global.
  if (getAuthToken() === null) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <Outlet />;
}
```

- [ ] **Step 3: Implementar `OverviewPage.tsx`**

`apps/web/src/pages/OverviewPage.tsx`:

```tsx
import { useMemo } from 'react';
import { useFilters } from '../hooks/use-filters.js';
import { useMetricBatch } from '../hooks/use-metric-series.js';
import { useTool } from '../hooks/use-tool.js';
import { PeriodPicker } from '../components/filters/PeriodPicker.js';
import { SourceFilter } from '../components/filters/SourceFilter.js';
import { KpiCard } from '../components/charts/KpiCard.js';
import { TimeSeriesChart } from '../components/charts/TimeSeriesChart.js';
import type { MetricQueryInput, MetricSeries, MetricSource, MetricUnit } from '../lib/api-client.js';
import { formatMetricValue } from '../lib/format.js';

interface HeadlineMetric {
  metricId: string; source: MetricSource; label: string; unit: MetricUnit;
}

const HEADLINE_METRICS: HeadlineMetric[] = [
  { metricId: 'commerce.revenue', source: 'commerce', label: 'Faturamento', unit: 'currency' },
  { metricId: 'commerce.orders', source: 'commerce', label: 'Pedidos', unit: 'count' },
  { metricId: 'commerce.average_ticket', source: 'commerce', label: 'Ticket médio', unit: 'currency' },
  { metricId: 'commerce.new_customers', source: 'commerce', label: 'Clientes novos', unit: 'count' },
  { metricId: 'ga4.sessions', source: 'ga4', label: 'Sessões', unit: 'count' },
  { metricId: 'ga4.active_users', source: 'ga4', label: 'Usuários ativos', unit: 'count' },
];

interface StatusGroups {
  groups: Array<{ group: string; label: string; orders: number; revenueCents: number; share: number }>;
}

const percent = new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 1 });

export function OverviewPage({ today }: { today: string }) {
  const { filters } = useFilters(today);

  const visibleMetrics = HEADLINE_METRICS.filter((metric) => filters.sources.includes(metric.source));

  const queries = useMemo<MetricQueryInput[]>(
    () => visibleMetrics.map((metric) => ({
      metricId: metric.metricId, from: filters.from, to: filters.to, granularity: filters.granularity,
    })),
    // `visibleMetrics` deriva de `filters`; depender de `filters` basta e evita
    // recriar o array a cada render.
    [filters],
  );

  const { data, isLoading, error } = useMetricBatch(queries);
  const queryError = error instanceof Error ? error : null;

  const statusQuery = useTool<StatusGroups>('commerce', 'orders_by_status', {
    from: filters.from, to: filters.to,
  }, { enabled: filters.sources.includes('commerce') });

  const seriesById = new Map((data ?? []).map((series) => [series.metricId, series]));
  const pick = (ids: string[]): MetricSeries[] =>
    ids.map((id) => seriesById.get(id)).filter((series): series is MetricSeries => series !== undefined);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PeriodPicker today={today} />
        <SourceFilter today={today} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {visibleMetrics.map((metric) => (
          <KpiCard
            key={metric.metricId}
            label={metric.label}
            unit={metric.unit}
            value={seriesById.get(metric.metricId)?.total ?? 0}
            isLoading={isLoading}
            error={queryError}
          />
        ))}
      </div>

      {/* Reais e contagem em gráficos separados: nunca dois eixos Y. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <TimeSeriesChart
          title="Faturamento"
          description="Receita de pedidos com status de venda."
          seriesList={pick(['commerce.revenue'])}
          granularity={filters.granularity}
          unit="currency"
          isLoading={isLoading}
          error={queryError}
        />
        <TimeSeriesChart
          title="Volume"
          description="Pedidos e sessões no período."
          seriesList={pick(['commerce.orders', 'ga4.sessions'])}
          granularity={filters.granularity}
          unit="count"
          isLoading={isLoading}
          error={queryError}
        />
      </div>

      <section
        className="rounded-lg border p-4"
        style={{ backgroundColor: 'var(--surface-1)', borderColor: 'var(--hairline)' }}
        aria-label="Situação dos pedidos"
      >
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Situação dos pedidos</h3>
        {statusQuery.error instanceof Error ? (
          <p role="alert" className="mt-3 text-sm" style={{ color: 'var(--critical)' }}>
            {statusQuery.error.message}
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  {['Situação', 'Pedidos', 'Valor', 'Part.'].map((column) => (
                    <th key={column} scope="col" className="border-b px-2 py-1.5 text-left font-medium"
                      style={{ borderColor: 'var(--gridline)', color: 'var(--text-secondary)' }}>
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(statusQuery.data?.groups ?? []).map((group) => (
                  <tr key={group.group}>
                    <td className="border-b px-2 py-1.5" style={{ borderColor: 'var(--gridline)' }}>{group.label}</td>
                    <td className="border-b px-2 py-1.5 tabular-nums" style={{ borderColor: 'var(--gridline)' }}>
                      {formatMetricValue(group.orders, 'count')}
                    </td>
                    <td className="border-b px-2 py-1.5 tabular-nums" style={{ borderColor: 'var(--gridline)' }}>
                      {formatMetricValue(group.revenueCents, 'currency')}
                    </td>
                    <td className="border-b px-2 py-1.5 tabular-nums" style={{ borderColor: 'var(--gridline)', color: 'var(--text-secondary)' }}>
                      {percent.format(group.share)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Escrever o teste da página de Produtos e implementá-la**

`apps/web/src/__tests__/products-page.test.tsx`:

```tsx
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../test/msw-server.js';
import { renderWithProviders } from '../test/render.js';
import { ProductsPage } from '../pages/ProductsPage.js';

function ranking(dimension: string, rows: Array<{ key: string; label: string; value: number }>) {
  return {
    dimension, from: '2026-03-01', to: '2026-03-15',
    total: rows.reduce((acc, row) => acc + row.value, 0), unit: 'currency',
    rows: rows.map((row) => ({ ...row, unit: 'currency', extra: { quantity: 1, orders: 1 }, share: 0.5 })),
  };
}

function mockEndpoints() {
  mswServer.use(
    http.post('/api/tools/commerce/top_products', () => HttpResponse.json(
      ranking('product', [{ key: 'CAM', label: 'Camiseta', value: 30000 }]))),
    http.post('/api/tools/commerce/top_categories', () => HttpResponse.json(
      ranking('category', [{ key: 'Vestuário', label: 'Vestuário', value: 30000 }]))),
    http.post('/api/tools/commerce/compare_products', () => HttpResponse.json({
      dimension: 'product',
      periodA: { from: '2026-02-01', to: '2026-02-28' },
      periodB: { from: '2026-03-01', to: '2026-03-15' },
      unit: 'currency',
      rows: [{ key: 'TEN', label: 'Tênis', valueA: 50000, valueB: 10000, delta: -40000, deltaRatio: -0.8 }],
    })),
    http.post('/api/tools/commerce/payment_method_performance', () => HttpResponse.json({
      from: '2026-03-01', to: '2026-03-15',
      methods: [{ method: 'pix', paidOrders: 20, failedOrders: 0, conversionRate: 1, revenueCents: 200000, averageTicketCents: 10000 }],
    })),
    http.post('/api/tools/commerce/failed_orders', () => HttpResponse.json({
      from: '2026-03-01', to: '2026-03-15', total: 1,
      orders: [{ numeroPedido: 'P9', statusLabel: 'Recusado', emittedAt: '2026-03-10T12:00:00Z', totalCents: 12000, paymentMethod: 'cartao' }],
    })),
  );
}

describe('ProductsPage', () => {
  it('shows the top products ranking', async () => {
    mockEndpoints();
    renderWithProviders(<ProductsPage today="2026-03-15" />, { route: '/produtos' });
    await waitFor(() => expect(screen.getByRole('cell', { name: 'Camiseta' })).toBeInTheDocument());
  });

  it('shows the top categories ranking', async () => {
    mockEndpoints();
    renderWithProviders(<ProductsPage today="2026-03-15" />, { route: '/produtos' });
    await waitFor(() => expect(screen.getByRole('cell', { name: 'Vestuário' })).toBeInTheDocument());
  });

  it('highlights the product that fell the most', async () => {
    mockEndpoints();
    renderWithProviders(<ProductsPage today="2026-03-15" />, { route: '/produtos' });
    await waitFor(() => expect(screen.getByText('Tênis')).toBeInTheDocument());
    expect(screen.getByText(/-80,0%/)).toBeInTheDocument();
  });

  it('lists the failed orders', async () => {
    mockEndpoints();
    renderWithProviders(<ProductsPage today="2026-03-15" />, { route: '/produtos' });
    await waitFor(() => expect(screen.getByText('P9')).toBeInTheDocument());
  });

  it('shows the payment method conversion', async () => {
    mockEndpoints();
    renderWithProviders(<ProductsPage today="2026-03-15" />, { route: '/produtos' });
    await waitFor(() => expect(screen.getByText('pix')).toBeInTheDocument());
    expect(screen.getByText('100,0%')).toBeInTheDocument();
  });
});
```

`apps/web/src/pages/ProductsPage.tsx`:

```tsx
import { useFilters, resolvePreset } from '../hooks/use-filters.js';
import { useTool } from '../hooks/use-tool.js';
import { PeriodPicker } from '../components/filters/PeriodPicker.js';
import { RankingTable } from '../components/charts/RankingTable.js';
import { formatMetricValue } from '../lib/format.js';
import type { RankingResult } from '../lib/api-client.js';

interface ComparisonResult {
  rows: Array<{ key: string; label: string; valueA: number; valueB: number; delta: number; deltaRatio: number | null }>;
}

interface PaymentResult {
  methods: Array<{ method: string; paidOrders: number; failedOrders: number; conversionRate: number; averageTicketCents: number }>;
}

interface FailedOrdersResult {
  total: number;
  orders: Array<{ numeroPedido: string; statusLabel: string; emittedAt: string; totalCents: number; paymentMethod: string | null }>;
}

const percent = new Intl.NumberFormat('pt-BR', {
  style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: 'exceptZero',
});
const plainPercent = new Intl.NumberFormat('pt-BR', {
  style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1,
});

export function ProductsPage({ today }: { today: string }) {
  const { filters } = useFilters(today);
  const period = { from: filters.from, to: filters.to };

  const topProducts = useTool<RankingResult>('commerce', 'top_products', { ...period, limit: 10 });
  const topCategories = useTool<RankingResult>('commerce', 'top_categories', { ...period, limit: 10 });
  const payments = useTool<PaymentResult>('commerce', 'payment_method_performance', period);
  const failed = useTool<FailedOrdersResult>('commerce', 'failed_orders', { ...period, limit: 10 });

  // A comparação usa o mês anterior como referência — é o que "caiu em vendas"
  // significa para quem pergunta.
  const previousMonth = resolvePreset('lastMonth', filters.from);
  const comparison = useTool<ComparisonResult>('commerce', 'compare_products', {
    periodA: { from: previousMonth.from, to: previousMonth.to },
    periodB: period,
    limit: 10,
  });

  const asError = (value: unknown) => (value instanceof Error ? value : null);

  return (
    <div className="space-y-6">
      <PeriodPicker today={today} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <RankingTable
          title="Produtos mais vendidos"
          description="Por faturamento no período."
          result={topProducts.data}
          isLoading={topProducts.isLoading}
          error={asError(topProducts.error)}
        />
        <RankingTable
          title="Categorias mais vendidas"
          description="Por faturamento no período."
          result={topCategories.data}
          isLoading={topCategories.isLoading}
          error={asError(topCategories.error)}
        />
      </div>

      <section className="rounded-lg border p-4" style={{ backgroundColor: 'var(--surface-1)', borderColor: 'var(--hairline)' }}
        aria-label="Maiores quedas em vendas">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Maiores quedas em vendas</h3>
        <p className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>
          Comparado com {previousMonth.from} a {previousMonth.to}.
        </p>
        {asError(comparison.error) ? (
          <p role="alert" className="mt-3 text-sm" style={{ color: 'var(--critical)' }}>
            {(comparison.error as Error).message}
          </p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr>
                {['Produto', 'Antes', 'Agora', 'Variação'].map((column) => (
                  <th key={column} scope="col" className="border-b px-2 py-1.5 text-left font-medium"
                    style={{ borderColor: 'var(--gridline)', color: 'var(--text-secondary)' }}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(comparison.data?.rows ?? []).map((row) => (
                <tr key={row.key}>
                  <td className="border-b px-2 py-1.5" style={{ borderColor: 'var(--gridline)' }}>{row.label}</td>
                  <td className="border-b px-2 py-1.5 tabular-nums" style={{ borderColor: 'var(--gridline)' }}>
                    {formatMetricValue(row.valueA, 'currency')}
                  </td>
                  <td className="border-b px-2 py-1.5 tabular-nums" style={{ borderColor: 'var(--gridline)' }}>
                    {formatMetricValue(row.valueB, 'currency')}
                  </td>
                  <td className="border-b px-2 py-1.5 tabular-nums" style={{
                    borderColor: 'var(--gridline)',
                    color: row.delta < 0 ? 'var(--critical)' : 'var(--good)',
                  }}>
                    {row.deltaRatio === null ? 'novo' : percent.format(row.deltaRatio)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="rounded-lg border p-4" style={{ backgroundColor: 'var(--surface-1)', borderColor: 'var(--hairline)' }}
          aria-label="Conversão por meio de pagamento">
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Conversão por meio de pagamento</h3>
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr>
                {['Meio', 'Concluídos', 'Falhos', 'Conversão'].map((column) => (
                  <th key={column} scope="col" className="border-b px-2 py-1.5 text-left font-medium"
                    style={{ borderColor: 'var(--gridline)', color: 'var(--text-secondary)' }}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(payments.data?.methods ?? []).map((method) => (
                <tr key={method.method}>
                  <td className="border-b px-2 py-1.5" style={{ borderColor: 'var(--gridline)' }}>{method.method}</td>
                  <td className="border-b px-2 py-1.5 tabular-nums" style={{ borderColor: 'var(--gridline)' }}>{method.paidOrders}</td>
                  <td className="border-b px-2 py-1.5 tabular-nums" style={{ borderColor: 'var(--gridline)' }}>{method.failedOrders}</td>
                  <td className="border-b px-2 py-1.5 tabular-nums" style={{ borderColor: 'var(--gridline)' }}>
                    {plainPercent.format(method.conversionRate)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="rounded-lg border p-4" style={{ backgroundColor: 'var(--surface-1)', borderColor: 'var(--hairline)' }}
          aria-label="Compras que falharam">
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            Compras que falharam {failed.data ? `(${failed.data.total})` : ''}
          </h3>
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr>
                {['Pedido', 'Situação', 'Valor'].map((column) => (
                  <th key={column} scope="col" className="border-b px-2 py-1.5 text-left font-medium"
                    style={{ borderColor: 'var(--gridline)', color: 'var(--text-secondary)' }}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(failed.data?.orders ?? []).map((order) => (
                <tr key={order.numeroPedido}>
                  <td className="border-b px-2 py-1.5" style={{ borderColor: 'var(--gridline)' }}>{order.numeroPedido}</td>
                  <td className="border-b px-2 py-1.5" style={{ borderColor: 'var(--gridline)' }}>{order.statusLabel}</td>
                  <td className="border-b px-2 py-1.5 tabular-nums" style={{ borderColor: 'var(--gridline)' }}>
                    {formatMetricValue(order.totalCents, 'currency')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Implementar `AcquisitionPage.tsx`**

`apps/web/src/pages/AcquisitionPage.tsx`:

```tsx
import { useFilters } from '../hooks/use-filters.js';
import { useTool } from '../hooks/use-tool.js';
import { PeriodPicker } from '../components/filters/PeriodPicker.js';
import { RankingTable } from '../components/charts/RankingTable.js';
import { FunnelChart } from '../components/charts/FunnelChart.js';
import type { FunnelResult, RankingResult } from '../lib/api-client.js';

export function AcquisitionPage({ today }: { today: string }) {
  const { filters } = useFilters(today);
  const period = { from: filters.from, to: filters.to };
  const withLimit = { ...period, limit: 10 };

  const trafficSources = useTool<RankingResult>('ga4', 'traffic_sources', withLimit);
  const campaignUsers = useTool<RankingResult>('ga4', 'campaign_users', withLimit);
  const campaignRevenue = useTool<RankingResult>('commerce', 'campaign_revenue', withLimit);
  const channelTicket = useTool<RankingResult>('commerce', 'channel_average_ticket', withLimit);
  const deviceRevenue = useTool<RankingResult>('commerce', 'device_revenue', withLimit);
  const devicePerformance = useTool<RankingResult>('ga4', 'device_performance', withLimit);
  const pagePerformance = useTool<RankingResult>('ga4', 'page_performance', withLimit);
  const funnel = useTool<FunnelResult>('ga4', 'checkout_funnel', period);

  const asError = (value: unknown) => (value instanceof Error ? value : null);

  return (
    <div className="space-y-6">
      <PeriodPicker today={today} />

      <FunnelChart
        title="Funil de compra"
        result={funnel.data}
        isLoading={funnel.isLoading}
        error={asError(funnel.error)}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <RankingTable title="Origens de tráfego" description="Usuários por origem/mídia."
          result={trafficSources.data} isLoading={trafficSources.isLoading} error={asError(trafficSources.error)} />
        <RankingTable title="Campanhas por usuários" description="Medido pelo Analytics."
          result={campaignUsers.data} isLoading={campaignUsers.isLoading} error={asError(campaignUsers.error)} />
        {/* Receita vem da Uappi, não do GA4: a fonte de verdade de faturamento
            é a loja, e misturar as duas geraria dois números para a mesma coisa. */}
        <RankingTable title="Campanhas por receita" description="Receita real dos pedidos atribuídos."
          result={campaignRevenue.data} isLoading={campaignRevenue.isLoading} error={asError(campaignRevenue.error)} />
        <RankingTable title="Ticket médio por canal" description="Canal de venda registrado no pedido."
          result={channelTicket.data} isLoading={channelTicket.isLoading} error={asError(channelTicket.error)} />
        <RankingTable title="Receita por dispositivo" description="Dispositivo capturado no checkout."
          result={deviceRevenue.data} isLoading={deviceRevenue.isLoading} error={asError(deviceRevenue.error)} />
        <RankingTable title="Conversão por dispositivo" description="Conversões sobre sessões, no Analytics."
          result={devicePerformance.data} isLoading={devicePerformance.isLoading} error={asError(devicePerformance.error)} />
      </div>

      <RankingTable title="Páginas com maior abandono" description="Taxa de rejeição, da pior para a melhor."
        result={pagePerformance.data} isLoading={pagePerformance.isLoading} error={asError(pagePerformance.error)} />
    </div>
  );
}
```

- [ ] **Step 6: Implementar `LoginPage.tsx`, `SettingsPage.tsx` e ligar as rotas**

`apps/web/src/pages/LoginPage.tsx`:

```tsx
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/use-auth.js';

export function LoginPage() {
  const navigate = useNavigate();
  const { login, isLoggingIn, loginError } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!email || !password) return;
    try {
      await login(email, password);
      navigate('/', { replace: true });
    } catch {
      // O erro já está exposto por `loginError`; o catch existe só para não
      // deixar uma promise rejeitada sem tratamento.
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4 rounded-lg border p-6"
        style={{ backgroundColor: 'var(--surface-1)', borderColor: 'var(--hairline)' }}>
        <h1 className="text-xl font-semibold">Center Analytics</h1>

        <div className="space-y-1">
          <label htmlFor="email" className="block text-sm" style={{ color: 'var(--text-secondary)' }}>E-mail</label>
          <input id="email" type="email" value={email} autoComplete="username"
            onChange={(event) => setEmail(event.target.value)}
            className="w-full rounded-md border px-3 py-2"
            style={{ borderColor: 'var(--hairline)', backgroundColor: 'var(--page-plane)' }} />
        </div>

        <div className="space-y-1">
          <label htmlFor="password" className="block text-sm" style={{ color: 'var(--text-secondary)' }}>Senha</label>
          <input id="password" type="password" value={password} autoComplete="current-password"
            onChange={(event) => setPassword(event.target.value)}
            className="w-full rounded-md border px-3 py-2"
            style={{ borderColor: 'var(--hairline)', backgroundColor: 'var(--page-plane)' }} />
        </div>

        {loginError ? (
          <p role="alert" className="text-sm" style={{ color: 'var(--critical)' }}>{loginError.message}</p>
        ) : null}

        <button type="submit" disabled={isLoggingIn}
          className="w-full rounded-md bg-viz-1 px-3 py-2 text-white disabled:opacity-60">
          {isLoggingIn ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </div>
  );
}
```

`apps/web/src/pages/SettingsPage.tsx`:

```tsx
import { useMutation } from '@tanstack/react-query';
import { getAuthToken } from '../lib/api-client.js';

interface LinkCodeResponse { code: string; expiresAt: string; ttlMinutes: number }

async function requestLinkCode(): Promise<LinkCodeResponse> {
  const response = await fetch('/api/whatsapp/link-code', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${getAuthToken() ?? ''}` },
  });
  if (!response.ok) throw new Error('Não foi possível gerar o código. Tente novamente.');
  return (await response.json()) as LinkCodeResponse;
}

export function SettingsPage() {
  const mutation = useMutation({ mutationFn: requestLinkCode });

  return (
    <section className="max-w-xl space-y-4">
      <h2 className="text-lg font-semibold">Vincular o WhatsApp</h2>
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        Gere um código e envie-o pelo WhatsApp para o número do assistente. Ele vale alguns
        minutos e só pode ser usado uma vez.
      </p>

      <button type="button" onClick={() => mutation.mutate()} disabled={mutation.isPending}
        className="rounded-md bg-viz-1 px-4 py-2 text-white disabled:opacity-60">
        {mutation.isPending ? 'Gerando…' : 'Gerar código'}
      </button>

      {mutation.data ? (
        <div className="rounded-lg border p-4" style={{ backgroundColor: 'var(--surface-1)', borderColor: 'var(--hairline)' }}>
          <p className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Seu código</p>
          <p className="mt-1 font-mono text-3xl tracking-[0.3em]">{mutation.data.code}</p>
          <p className="mt-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
            Válido por {mutation.data.ttlMinutes} minutos.
          </p>
        </div>
      ) : null}

      {mutation.error ? (
        <p role="alert" className="text-sm" style={{ color: 'var(--critical)' }}>
          {(mutation.error as Error).message}
        </p>
      ) : null}
    </section>
  );
}
```

`apps/web/src/App.tsx`:

```tsx
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell.js';
import { RequireAuth } from './components/layout/RequireAuth.js';
import { LoginPage } from './pages/LoginPage.js';
import { OverviewPage } from './pages/OverviewPage.js';
import { ProductsPage } from './pages/ProductsPage.js';
import { AcquisitionPage } from './pages/AcquisitionPage.js';
import { SettingsPage } from './pages/SettingsPage.js';

/** "Hoje" desce como prop a partir daqui: nenhum componente chama `new Date()`. */
export function App() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route path="/" element={<OverviewPage today={today} />} />
          <Route path="/produtos" element={<ProductsPage today={today} />} />
          <Route path="/aquisicao" element={<AcquisitionPage today={today} />} />
          <Route path="/configuracoes" element={<SettingsPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
```

- [ ] **Step 7: Escrever o teste de login**

`apps/web/src/__tests__/login-page.test.tsx`:

```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../test/msw-server.js';
import { renderWithProviders } from '../test/render.js';
import { LoginPage } from '../pages/LoginPage.js';
import { getAuthToken, setAuthToken } from '../lib/api-client.js';

afterEach(() => setAuthToken(null));

async function submit(email: string, password: string) {
  await userEvent.type(screen.getByLabelText('E-mail'), email);
  await userEvent.type(screen.getByLabelText('Senha'), password);
  await userEvent.click(screen.getByRole('button', { name: 'Entrar' }));
}

describe('LoginPage', () => {
  it('stores the token on success', async () => {
    mswServer.use(http.post('/auth/login', () => HttpResponse.json({
      token: 'jwt-token', user: { id: 'u1', name: 'Ana', email: 'ana@example.com', role: 'ADMIN' },
    })));
    renderWithProviders(<LoginPage />, { route: '/login' });
    await submit('ana@example.com', 'segredo123');
    await waitFor(() => expect(getAuthToken()).toBe('jwt-token'));
  });

  it('shows the server message on invalid credentials', async () => {
    mswServer.use(http.post('/auth/login', () =>
      HttpResponse.json({ message: 'credenciais inválidas' }, { status: 401 })));
    renderWithProviders(<LoginPage />, { route: '/login' });
    await submit('ana@example.com', 'errada');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('credenciais inválidas'));
    expect(getAuthToken()).toBeNull();
  });

  it('disables the submit button while the request is in flight', async () => {
    mswServer.use(http.post('/auth/login', async () => {
      await new Promise((resolve) => { setTimeout(resolve, 50); });
      return HttpResponse.json({ token: 't', user: { id: 'u1', name: 'A', email: 'a@b.c', role: 'ADMIN' } });
    }));
    renderWithProviders(<LoginPage />, { route: '/login' });
    await submit('ana@example.com', 'segredo123');
    expect(screen.getByRole('button', { name: 'Entrando…' })).toBeDisabled();
  });

  it('requires both fields before submitting', async () => {
    const handler = jest.fn(() => HttpResponse.json({ token: 't' }));
    mswServer.use(http.post('/auth/login', handler));
    renderWithProviders(<LoginPage />, { route: '/login' });
    await userEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(handler).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 8: Rodar todos os testes e validar manualmente**

Run: `pnpm --filter @center/web test`
Expected: PASS — 76 testes.

Com a API rodando (T24, Step 6):

```bash
pnpm --filter @center/web dev
```

Confirme: `/` redireciona para `/login`; login com `admin@center.local` / `center-dev-123` leva à Visão geral com dados reais da Uappi; o faturamento bate com o painel da Uappi; trocar o período muda a URL e os gráficos; "Sair" volta ao login e um refresh não restaura a sessão.

- [ ] **Step 9: Commit**

```bash
git add apps/web
git commit -m "feat(web): add overview, products, acquisition and settings pages with auth guard"
```

---

### Task 28B: Formulário de credenciais de integração

**Files:**
- Create: `apps/web/src/components/settings/IntegrationCredentialsForm.tsx`
- Modify: `apps/web/src/pages/SettingsPage.tsx` (monta o formulário)
- Test: `apps/web/src/__tests__/integration-credentials-form.test.tsx`

**Interfaces:**
- Consumes: `apiClient.getIntegrations`/`updateIntegrations`, `IntegrationsView` (T25).
- Produces: `<IntegrationCredentialsForm />`

**A regra que evita o erro mais comum de formulário de credencial:** os campos de `apiKey`/`secretKey` da Uappi nunca são preenchidos com o valor salvo — o backend nunca devolve o valor em claro (T24B), então não há o que preencher. Em vez disso, o formulário mostra um selo "Configurado" e trata o campo vazio no `submit` como "não mudar este valor" (não como "apagar"). Só `ga4PropertyId`/`ga4BigQueryDataset` vêm preenchidos, porque não são segredos.

- [ ] **Step 1: Escrever o teste (falhando)**

`apps/web/src/__tests__/integration-credentials-form.test.tsx`:

```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../test/msw-server.js';
import { renderWithProviders } from '../test/render.js';
import { IntegrationCredentialsForm } from '../components/settings/IntegrationCredentialsForm.js';

function mockGet(view: object) {
  mswServer.use(http.get('/api/settings/integrations', () => HttpResponse.json(view)));
}

const unconfigured = {
  uappi: { configured: false }, ga4: { propertyId: null, bigQueryDataset: null },
};
const configured = {
  uappi: { configured: true }, ga4: { propertyId: '111', bigQueryDataset: 'analytics_111' },
};

describe('IntegrationCredentialsForm — leitura', () => {
  it('shows "não configurado" when the Uappi credentials are absent', async () => {
    mockGet(unconfigured);
    renderWithProviders(<IntegrationCredentialsForm />);
    await waitFor(() => expect(screen.getByText('Não configurado')).toBeInTheDocument());
  });

  it('shows a "Configurado" badge without ever displaying a secret value', async () => {
    mockGet(configured);
    renderWithProviders(<IntegrationCredentialsForm />);
    await waitFor(() => expect(screen.getByText('Configurado')).toBeInTheDocument());
    expect(screen.queryByDisplayValue(/./)).not.toHaveAttribute('name', 'uappiApiKey');
  });

  it('pre-fills the GA4 fields — they are not secrets', async () => {
    mockGet(configured);
    renderWithProviders(<IntegrationCredentialsForm />);
    await waitFor(() => expect(screen.getByLabelText('ID da propriedade GA4')).toHaveValue('111'));
    expect(screen.getByLabelText('Dataset do BigQuery')).toHaveValue('analytics_111');
  });

  it('leaves the apiKey and secretKey inputs empty even when configured', async () => {
    mockGet(configured);
    renderWithProviders(<IntegrationCredentialsForm />);
    await waitFor(() => expect(screen.getByText('Configurado')).toBeInTheDocument());
    expect(screen.getByLabelText('Chave de API da Uappi')).toHaveValue('');
    expect(screen.getByLabelText('Chave secreta da Uappi')).toHaveValue('');
  });
});

describe('IntegrationCredentialsForm — escrita', () => {
  it('sends only the fields the admin actually typed', async () => {
    mockGet(unconfigured);
    const handler = jest.fn(() => HttpResponse.json(configured));
    mswServer.use(http.put('/api/settings/integrations', async ({ request }) => {
      handler(await request.json());
      return HttpResponse.json(configured);
    }));

    renderWithProviders(<IntegrationCredentialsForm />);
    await waitFor(() => expect(screen.getByLabelText('ID da propriedade GA4')).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText('ID da propriedade GA4'), '222');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(handler).toHaveBeenCalledWith({ ga4PropertyId: '222' }));
  });

  it('includes the Uappi fields only when the admin typed something in them', async () => {
    mockGet(unconfigured);
    const handler = jest.fn(() => HttpResponse.json(configured));
    mswServer.use(http.put('/api/settings/integrations', async ({ request }) => {
      handler(await request.json());
      return HttpResponse.json(configured);
    }));

    renderWithProviders(<IntegrationCredentialsForm />);
    await waitFor(() => expect(screen.getByLabelText('Chave de API da Uappi')).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText('Chave de API da Uappi'), 'ak-nova');
    await userEvent.type(screen.getByLabelText('Chave secreta da Uappi'), 'sk-nova');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(handler).toHaveBeenCalledWith({
      uappiApiKey: 'ak-nova', uappiSecretKey: 'sk-nova',
    }));
  });

  it('disables the button and shows saving state while the request is in flight', async () => {
    mockGet(unconfigured);
    mswServer.use(http.put('/api/settings/integrations', async () => {
      await new Promise((resolve) => { setTimeout(resolve, 50); });
      return HttpResponse.json(configured);
    }));
    renderWithProviders(<IntegrationCredentialsForm />);
    await waitFor(() => expect(screen.getByLabelText('ID da propriedade GA4')).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText('ID da propriedade GA4'), '222');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(screen.getByRole('button', { name: 'Salvando…' })).toBeDisabled();
  });

  it('clears the secret inputs after a successful save — they never linger in the DOM', async () => {
    mockGet(unconfigured);
    mswServer.use(http.put('/api/settings/integrations', () => HttpResponse.json(configured)));
    renderWithProviders(<IntegrationCredentialsForm />);
    await waitFor(() => expect(screen.getByLabelText('Chave de API da Uappi')).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText('Chave de API da Uappi'), 'ak-nova');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(screen.getByLabelText('Chave de API da Uappi')).toHaveValue(''));
  });

  it('shows the error message when the save fails', async () => {
    mockGet(unconfigured);
    mswServer.use(http.put('/api/settings/integrations', () =>
      HttpResponse.json({ message: 'requer papel de administrador' }, { status: 403 })));
    renderWithProviders(<IntegrationCredentialsForm />);
    await waitFor(() => expect(screen.getByLabelText('ID da propriedade GA4')).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText('ID da propriedade GA4'), '222');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('requer papel de administrador'));
  });
});
```

- [ ] **Step 2: Implementar `IntegrationCredentialsForm.tsx`**

`apps/web/src/components/settings/IntegrationCredentialsForm.tsx`:

```tsx
import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, type IntegrationsUpdate } from '../../lib/api-client.js';

const QUERY_KEY = ['settings', 'integrations'];

/**
 * Campos de segredo (apiKey/secretKey) NUNCA vêm preenchidos: o backend nunca
 * devolve o valor em claro (T24B), só se está configurado ou não. Um campo
 * deixado vazio no submit significa "não mudar", nunca "apagar" — só um botão
 * de remoção explícito (fora de escopo aqui) apagaria uma credencial.
 */
export function IntegrationCredentialsForm() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: QUERY_KEY, queryFn: () => apiClient.getIntegrations() });

  const [uappiApiKey, setUappiApiKey] = useState('');
  const [uappiSecretKey, setUappiSecretKey] = useState('');
  const [ga4PropertyId, setGa4PropertyId] = useState('');
  const [ga4BigQueryDataset, setGa4BigQueryDataset] = useState('');

  // Só os campos não-secretos são pré-preenchidos, e só quando o valor do
  // servidor chega — evita sobrescrever o que o admin já digitou num refetch.
  useEffect(() => {
    if (data) {
      setGa4PropertyId(data.ga4.propertyId ?? '');
      setGa4BigQueryDataset(data.ga4.bigQueryDataset ?? '');
    }
  }, [data]);

  const mutation = useMutation({
    mutationFn: (patch: IntegrationsUpdate) => apiClient.updateIntegrations(patch),
    onSuccess: (updated) => {
      queryClient.setQueryData(QUERY_KEY, updated);
      // Os segredos nunca voltam do servidor — limpar aqui é o que impede um
      // valor sensível de continuar visível na tela depois de salvo.
      setUappiApiKey('');
      setUappiSecretKey('');
    },
  });

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    const patch: IntegrationsUpdate = {};
    if (uappiApiKey.trim()) patch.uappiApiKey = uappiApiKey.trim();
    if (uappiSecretKey.trim()) patch.uappiSecretKey = uappiSecretKey.trim();
    if (ga4PropertyId.trim()) patch.ga4PropertyId = ga4PropertyId.trim();
    if (ga4BigQueryDataset.trim()) patch.ga4BigQueryDataset = ga4BigQueryDataset.trim();
    mutation.mutate(patch);
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-xl space-y-6">
      <div className="space-y-3 rounded-lg border p-4" style={{ backgroundColor: 'var(--surface-1)', borderColor: 'var(--hairline)' }}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Uappi</h3>
          <span
            className="rounded-full px-2 py-0.5 text-xs font-medium"
            style={
              data?.uappi.configured
                ? { backgroundColor: 'var(--good)', color: 'white' }
                : { backgroundColor: 'var(--gridline)', color: 'var(--text-secondary)' }
            }
          >
            {data?.uappi.configured ? 'Configurado' : 'Não configurado'}
          </span>
        </div>

        <div className="space-y-1">
          <label htmlFor="uappiApiKey" className="block text-sm" style={{ color: 'var(--text-secondary)' }}>
            Chave de API da Uappi
          </label>
          <input
            id="uappiApiKey" name="uappiApiKey" type="password" autoComplete="off"
            value={uappiApiKey} onChange={(event) => setUappiApiKey(event.target.value)}
            placeholder={data?.uappi.configured ? '••••••••' : 'apiKey'}
            className="w-full rounded-md border px-3 py-2"
            style={{ borderColor: 'var(--hairline)', backgroundColor: 'var(--page-plane)' }}
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="uappiSecretKey" className="block text-sm" style={{ color: 'var(--text-secondary)' }}>
            Chave secreta da Uappi
          </label>
          <input
            id="uappiSecretKey" name="uappiSecretKey" type="password" autoComplete="off"
            value={uappiSecretKey} onChange={(event) => setUappiSecretKey(event.target.value)}
            placeholder={data?.uappi.configured ? '••••••••' : 'secretKey'}
            className="w-full rounded-md border px-3 py-2"
            style={{ borderColor: 'var(--hairline)', backgroundColor: 'var(--page-plane)' }}
          />
        </div>
      </div>

      <div className="space-y-3 rounded-lg border p-4" style={{ backgroundColor: 'var(--surface-1)', borderColor: 'var(--hairline)' }}>
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Google Analytics 4</h3>

        <div className="space-y-1">
          <label htmlFor="ga4PropertyId" className="block text-sm" style={{ color: 'var(--text-secondary)' }}>
            ID da propriedade GA4
          </label>
          <input
            id="ga4PropertyId" name="ga4PropertyId" type="text"
            value={ga4PropertyId} onChange={(event) => setGa4PropertyId(event.target.value)}
            className="w-full rounded-md border px-3 py-2"
            style={{ borderColor: 'var(--hairline)', backgroundColor: 'var(--page-plane)' }}
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="ga4BigQueryDataset" className="block text-sm" style={{ color: 'var(--text-secondary)' }}>
            Dataset do BigQuery
          </label>
          <input
            id="ga4BigQueryDataset" name="ga4BigQueryDataset" type="text"
            value={ga4BigQueryDataset} onChange={(event) => setGa4BigQueryDataset(event.target.value)}
            placeholder="analytics_123456789"
            className="w-full rounded-md border px-3 py-2"
            style={{ borderColor: 'var(--hairline)', backgroundColor: 'var(--page-plane)' }}
          />
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Necessário só para as duas perguntas de comportamento avançado (Fase 8).</p>
        </div>
      </div>

      {mutation.isError ? (
        <p role="alert" className="text-sm" style={{ color: 'var(--critical)' }}>
          {(mutation.error as Error).message}
        </p>
      ) : null}

      <button
        type="submit" disabled={mutation.isPending}
        className="rounded-md bg-viz-1 px-4 py-2 text-white disabled:opacity-60"
      >
        {mutation.isPending ? 'Salvando…' : 'Salvar'}
      </button>
    </form>
  );
}
```

- [ ] **Step 3: Montar no `SettingsPage.tsx`**

Em `apps/web/src/pages/SettingsPage.tsx` (T28), adicione o import e monte o formulário como uma segunda seção, acima ou abaixo da seção de vínculo do WhatsApp:

```tsx
import { IntegrationCredentialsForm } from '../components/settings/IntegrationCredentialsForm.js';
```

```tsx
      <hr style={{ borderColor: 'var(--hairline)' }} />

      <h2 className="text-lg font-semibold">Integrações de dados</h2>
      <IntegrationCredentialsForm />
```

(insira este bloco logo antes do `</section>` de fechamento).

- [ ] **Step 4: Rodar os testes**

Run: `pnpm --filter @center/web test`
Expected: PASS — 9 testes novos.

- [ ] **Step 5: Validar manualmente**

```bash
pnpm --filter @center/web dev
```

Em Configurações: preencha a chave de API e a secreta da Uappi, salve, atualize a página (F5). O selo precisa mostrar "Configurado" e os dois campos de senha precisam continuar vazios — nunca preenchidos com o valor salvo.

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "feat(web): add integration credentials form to the settings page"
```

---

# FASE 7 — Agente de IA e WhatsApp (Sprints 9–10)

**Objetivo:** as 39 perguntas respondidas por WhatsApp.

**Onde os testes entram — a estratégia que torna um agente testável:**
1. **O resolvedor de datas é função pura** e recebe a maior bateria da fase. "Mês passado" resolver errado é o bug mais provável e mais caro: o usuário recebe número errado com confiança total.
2. **As ferramentas são testadas sem LLM** — `buildAgentTools()` devolve objetos com `execute()`, chamados diretamente.
3. **O agente é testado com `MockLanguageModelV2`**, controlando quais tool calls o "modelo" emite. Zero chamadas à API da Anthropic, zero instabilidade.
4. **A qualidade das respostas é avaliada à mão**, com o roteiro de 20 perguntas da T31.

**A restrição que desenha a integração:** a Meta exige HTTP 200 em até 20 segundos, senão reenvia o evento — e o agente leva de 3 a 12 segundos. Processar na thread do webhook geraria reentrega em loop e respostas duplicadas. Por isso: o webhook **valida, enfileira e responde 200 imediatamente**; um worker separado processa e envia.

---

### Task 29: Resolvedor de períodos em português

**Files:**
- Create: `apps/api/src/agent/date-resolver.ts`
- Test: `apps/api/src/__tests__/date-resolver.test.ts`

**Interfaces:**
- Consumes: `Granularity` de `@center/shared`.
- Produces:
  - `interface ResolvedPeriod { from: string; to: string; granularity: Granularity; label: string }`
  - `resolvePeriodPhrase(phrase: string, today: string): ResolvedPeriod | null`
  - `MONTH_NAMES_PT: Record<string, number>`

**Por que isto existe e não fica a cargo do LLM:** pedir ao modelo que calcule datas é onde agentes analíticos erram com mais frequência e mais silêncio. Resolvendo aqui, "mês passado" é determinístico e coberto por teste; o LLM só escolhe *qual* frase resolver.

- [ ] **Step 1: Escrever o teste (falhando)**

`apps/api/src/__tests__/date-resolver.test.ts`:

```ts
import { resolvePeriodPhrase } from '../agent/date-resolver.js';

const TODAY = '2026-03-15'; // domingo

describe('resolvePeriodPhrase — relativos', () => {
  it.each([
    ['hoje', '2026-03-15', '2026-03-15', 'day'],
    ['ontem', '2026-03-14', '2026-03-14', 'day'],
    ['esta semana', '2026-03-09', '2026-03-15', 'day'],
    ['semana passada', '2026-03-02', '2026-03-08', 'day'],
    ['este mês', '2026-03-01', '2026-03-15', 'day'],
    ['mês passado', '2026-02-01', '2026-02-28', 'day'],
    ['este ano', '2026-01-01', '2026-03-15', 'month'],
    ['ano passado', '2025-01-01', '2025-12-31', 'month'],
  ])('resolves "%s"', (phrase, from, to, granularity) => {
    expect(resolvePeriodPhrase(phrase, TODAY)).toMatchObject({ from, to, granularity });
  });

  it('resolves "mês passado" in January crossing the year', () => {
    expect(resolvePeriodPhrase('mês passado', '2026-01-20')).toMatchObject({
      from: '2025-12-01', to: '2025-12-31',
    });
  });

  it('resolves "mês passado" in a leap year March with 29 days', () => {
    expect(resolvePeriodPhrase('mês passado', '2024-03-10')).toMatchObject({
      from: '2024-02-01', to: '2024-02-29',
    });
  });

  it('accepts the unaccented spelling', () => {
    expect(resolvePeriodPhrase('mes passado', TODAY)).toMatchObject({ from: '2026-02-01' });
  });
});

describe('resolvePeriodPhrase — "últimos N"', () => {
  it('resolves "últimos 7 dias" including today', () => {
    expect(resolvePeriodPhrase('últimos 7 dias', TODAY)).toMatchObject({
      from: '2026-03-09', to: '2026-03-15', granularity: 'day',
    });
  });

  it('accepts the unaccented form', () => {
    expect(resolvePeriodPhrase('ultimos 30 dias', TODAY)).toMatchObject({ from: '2026-02-14' });
  });

  it('switches to week granularity above 60 days', () => {
    expect(resolvePeriodPhrase('últimos 90 dias', TODAY)).toMatchObject({ granularity: 'week' });
  });

  it('resolves "últimos 3 meses"', () => {
    expect(resolvePeriodPhrase('últimos 3 meses', TODAY)).toMatchObject({
      from: '2025-12-01', to: '2026-03-15', granularity: 'month',
    });
  });

  it('resolves "últimas 2 semanas"', () => {
    expect(resolvePeriodPhrase('últimas 2 semanas', TODAY)).toMatchObject({
      from: '2026-03-02', to: '2026-03-15', granularity: 'week',
    });
  });
});

describe('resolvePeriodPhrase — mês nomeado', () => {
  it('resolves "janeiro" as the most recent January that already happened', () => {
    expect(resolvePeriodPhrase('janeiro', TODAY)).toMatchObject({ from: '2026-01-01', to: '2026-01-31' });
  });

  it('resolves a future month in the current year as last year', () => {
    // Em 15/03/2026, "dezembro" só pode significar dez/2025.
    expect(resolvePeriodPhrase('dezembro', TODAY)).toMatchObject({ from: '2025-12-01', to: '2025-12-31' });
  });

  it('resolves "fevereiro de 2024" with 29 days', () => {
    expect(resolvePeriodPhrase('fevereiro de 2024', TODAY)).toMatchObject({
      from: '2024-02-01', to: '2024-02-29',
    });
  });

  it('resolves "março/2025"', () => {
    expect(resolvePeriodPhrase('março/2025', TODAY)).toMatchObject({ from: '2025-03-01', to: '2025-03-31' });
  });

  it('accepts the unaccented month name', () => {
    expect(resolvePeriodPhrase('marco de 2025', TODAY)).toMatchObject({ from: '2025-03-01' });
  });
});

describe('resolvePeriodPhrase — não reconhecido', () => {
  it('returns null for a phrase that is not a period', () => {
    expect(resolvePeriodPhrase('quanto vendemos', TODAY)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(resolvePeriodPhrase('', TODAY)).toBeNull();
  });

  it('returns null for a vague phrase instead of guessing', () => {
    expect(resolvePeriodPhrase('na época da promoção', TODAY)).toBeNull();
  });
});
```

- [ ] **Step 2: Implementar `date-resolver.ts`**

`apps/api/src/agent/date-resolver.ts`:

```ts
import type { Granularity } from '@center/shared';

export interface ResolvedPeriod {
  from: string;
  to: string;
  granularity: Granularity;
  label: string;
}

export const MONTH_NAMES_PT: Record<string, number> = {
  janeiro: 1, fevereiro: 2, marco: 3, março: 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};

function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function shiftDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return toIso(date);
}

/** Dia 0 do mês seguinte = último dia deste mês. Cobre bissexto sem tabela. */
function lastDayOfMonth(year: number, month: number): string {
  return toIso(new Date(Date.UTC(year, month, 0)));
}

function firstDayOfMonth(year: number, month: number): string {
  return toIso(new Date(Date.UTC(year, month - 1, 1)));
}

/** Segunda-feira da semana ISO que contém `isoDate`. */
function mondayOf(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return toIso(date);
}

function normalize(phrase: string): string {
  return phrase
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    // Remove acentos para que "últimos"/"ultimos" e "março"/"marco" batam igual.
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/**
 * Converte uma expressão de período em português numa janela concreta.
 * Devolve `null` quando a frase não é um período — o chamador então pede as
 * datas ao usuário, em vez de adivinhar.
 */
export function resolvePeriodPhrase(phrase: string, today: string): ResolvedPeriod | null {
  const text = normalize(phrase);
  if (text === '') return null;

  const [year, month] = today.split('-').map(Number) as [number, number];

  if (text === 'hoje') return { from: today, to: today, granularity: 'day', label: 'hoje' };

  if (text === 'ontem') {
    const yesterday = shiftDays(today, -1);
    return { from: yesterday, to: yesterday, granularity: 'day', label: 'ontem' };
  }

  if (text === 'esta semana' || text === 'essa semana') {
    return { from: mondayOf(today), to: today, granularity: 'day', label: 'esta semana' };
  }

  if (text === 'semana passada' || text === 'ultima semana') {
    const lastMonday = shiftDays(mondayOf(today), -7);
    return { from: lastMonday, to: shiftDays(lastMonday, 6), granularity: 'day', label: 'semana passada' };
  }

  if (text === 'este mes' || text === 'esse mes' || text === 'mes atual') {
    return { from: firstDayOfMonth(year, month), to: today, granularity: 'day', label: 'este mês' };
  }

  if (text === 'mes passado' || text === 'ultimo mes') {
    const previousMonth = month === 1 ? 12 : month - 1;
    const previousYear = month === 1 ? year - 1 : year;
    return {
      from: firstDayOfMonth(previousYear, previousMonth),
      to: lastDayOfMonth(previousYear, previousMonth),
      granularity: 'day',
      label: 'mês passado',
    };
  }

  if (text === 'este ano' || text === 'esse ano' || text === 'ano atual') {
    return { from: firstDayOfMonth(year, 1), to: today, granularity: 'month', label: 'este ano' };
  }

  if (text === 'ano passado' || text === 'ultimo ano') {
    return {
      from: firstDayOfMonth(year - 1, 1), to: lastDayOfMonth(year - 1, 12),
      granularity: 'month', label: 'ano passado',
    };
  }

  const lastN = text.match(/^(?:ultimos?|ultimas?)\s+(\d{1,3})\s+(dias?|semanas?|meses|mes)$/);
  if (lastN) {
    const amount = Number(lastN[1]);
    const unit = lastN[2]!;

    if (unit.startsWith('dia')) {
      return {
        from: shiftDays(today, -(amount - 1)), to: today,
        // Mais de ~60 pontos diários deixam o resumo e o eixo ilegíveis.
        granularity: amount > 60 ? 'week' : 'day',
        label: `últimos ${amount} dias`,
      };
    }

    if (unit.startsWith('semana')) {
      return {
        from: shiftDays(today, -(amount * 7 - 1)), to: today,
        granularity: 'week', label: `últimas ${amount} semanas`,
      };
    }

    const startMonth = month - (amount - 1);
    const normalizedYear = year + Math.floor((startMonth - 1) / 12);
    const normalizedMonth = ((((startMonth - 1) % 12) + 12) % 12) + 1;
    return {
      from: firstDayOfMonth(normalizedYear, normalizedMonth), to: today,
      granularity: 'month', label: `últimos ${amount} meses`,
    };
  }

  const named = text.match(/^([a-z]+)(?:\s*(?:de|\/)\s*(\d{4}))?$/);
  if (named) {
    const monthNumber = MONTH_NAMES_PT[named[1]!];
    if (monthNumber) {
      // Sem ano explícito: o mês mais recente que já começou. "dezembro" em
      // março de 2026 só pode ser dez/2025.
      const explicitYear = named[2] ? Number(named[2]) : undefined;
      const resolvedYear = explicitYear ?? (monthNumber > month ? year - 1 : year);
      return {
        from: firstDayOfMonth(resolvedYear, monthNumber),
        to: lastDayOfMonth(resolvedYear, monthNumber),
        granularity: 'day',
        label: `${named[1]} de ${resolvedYear}`,
      };
    }
  }

  return null;
}
```

- [ ] **Step 3: Rodar os testes**

Run: `pnpm --filter @center/api test -- date-resolver.test.ts`
Expected: PASS — 24 testes.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/agent apps/api/src/__tests__/date-resolver.test.ts
git commit -m "feat(agent): add deterministic pt-BR period resolver"
```

---

### Task 30: Ferramentas do agente

**Files:**
- Create: `apps/api/src/agent/tools.ts`
- Modify: `apps/api/package.json` (dependências de IA)
- Test: `apps/api/src/__tests__/agent-tools.test.ts`

**Interfaces:**
- Consumes: `MetricGateway` (T11), `correlateMetrics` (T20), `analyzeAppVersionImpact` (T21), `resolvePeriodPhrase` (T29), `ALLOWED_TOOLS` (T23).
- Produces:
  - `interface AgentToolCall { toolName: string; input: unknown; durationMs: number; success: boolean; errorMessage?: string }`
  - `interface AgentToolContext { gateway; tenant; today; onToolCall? }`
  - `buildAgentTools(context: AgentToolContext): ToolSet`
  - Ferramentas: `listar_metricas`, `consultar_metrica`, `ranking`, `funil_de_compra`, `comparar_periodos`, `correlacionar`, `impacto_da_versao`

**As decisões que separam um agente confiável de um que inventa números:**
1. **Nomes e descrições em português** — o modelo escolhe melhor quando o vocabulário da ferramenta é o do usuário.
2. **`periodo` como frase** (`"mês passado"`), resolvido pelo código da T29. O modelo nunca calcula datas.
3. **Tenant fechado no closure.** Não existe parâmetro onde o LLM possa escrever outra organização.
4. **`ranking` é uma ferramenta só**, com o nome do ranking como parâmetro — em vez de doze ferramentas quase idênticas que confundiriam a escolha do modelo.
5. **Resposta achatada.** Total, pico e as 5 primeiras linhas; mandar 90 pontos para o contexto gasta tokens e piora a resposta.

- [ ] **Step 1: Adicionar as dependências**

```bash
pnpm --filter @center/api add ai@^5.0.0 @ai-sdk/anthropic@^2.0.0
```

- [ ] **Step 2: Escrever o teste (falhando)**

`apps/api/src/__tests__/agent-tools.test.ts`:

```ts
import type { MetricGateway } from '@center/mcp-core';
import type { MetricSeries, TenantContext } from '@center/shared';
import { buildAgentTools, type AgentToolCall } from '../agent/tools.js';

const tenant: TenantContext = {
  organizationId: 'org_1', externalIds: { ga4PropertyId: '111' },
};

const series: MetricSeries = {
  metricId: 'commerce.revenue', source: 'commerce', unit: 'currency', granularity: 'day', total: 480000,
  points: [
    { date: '2026-02-01', value: 100000 },
    { date: '2026-02-15', value: 300000 },
    { date: '2026-02-28', value: 80000 },
  ],
};

function buildGateway(overrides: Record<string, unknown> = {}) {
  return {
    listMetrics: jest.fn(async () => [
      { id: 'commerce.revenue', label: 'Faturamento', description: 'receita', source: 'commerce', unit: 'currency', dimensions: ['campaign'] },
      { id: 'ga4.sessions', label: 'Sessões', description: 'sessões', source: 'ga4', unit: 'count', dimensions: ['device'] },
    ]),
    queryMetric: jest.fn(async () => series),
    queryBatch: jest.fn(async () => [series, series]),
    callTool: jest.fn(async () => ({
      dimension: 'product', from: '2026-02-01', to: '2026-02-28', total: 50000, unit: 'currency',
      rows: Array.from({ length: 10 }, (_, index) => ({
        key: `SKU${index}`, label: `Produto ${index}`, value: 1000 * (10 - index),
        unit: 'currency', extra: { quantity: 1 }, share: 0.1,
      })),
    })),
    ...overrides,
  } as unknown as MetricGateway;
}

const TODAY = '2026-03-15';

function tools(gateway: MetricGateway, onToolCall?: (log: AgentToolCall) => void) {
  return buildAgentTools({ gateway, tenant, today: TODAY, ...(onToolCall ? { onToolCall } : {}) });
}

describe('listar_metricas', () => {
  it('returns the catalog in a compact shape', async () => {
    const result = await tools(buildGateway()).listar_metricas.execute!({}, {} as never);
    expect(result).toEqual({
      metricas: [
        { id: 'commerce.revenue', nome: 'Faturamento', descricao: 'receita', unidade: 'currency', dimensoes: ['campaign'] },
        { id: 'ga4.sessions', nome: 'Sessões', descricao: 'sessões', unidade: 'count', dimensoes: ['device'] },
      ],
    });
  });
});

describe('consultar_metrica', () => {
  it('resolves a Portuguese period phrase into concrete dates', async () => {
    const gateway = buildGateway();
    await tools(gateway).consultar_metrica.execute!(
      { metricId: 'commerce.revenue', periodo: 'mês passado' }, {} as never,
    );
    expect(gateway.queryMetric).toHaveBeenCalledWith(
      expect.objectContaining({ from: '2026-02-01', to: '2026-02-28', granularity: 'day' }),
    );
  });

  it('accepts explicit from/to instead of a phrase', async () => {
    const gateway = buildGateway();
    await tools(gateway).consultar_metrica.execute!(
      { metricId: 'commerce.revenue', from: '2026-01-01', to: '2026-01-31', granularity: 'month' }, {} as never,
    );
    expect(gateway.queryMetric).toHaveBeenCalledWith(
      expect.objectContaining({ from: '2026-01-01', to: '2026-01-31', granularity: 'month' }),
    );
  });

  it('always injects the tenant from the closure', async () => {
    const gateway = buildGateway();
    await tools(gateway).consultar_metrica.execute!(
      { metricId: 'commerce.revenue', periodo: 'hoje' }, {} as never,
    );
    expect(gateway.queryMetric).toHaveBeenCalledWith(expect.objectContaining({ tenant }));
  });

  it('returns a summary with the total and the peak, not the raw series', async () => {
    const result = await tools(buildGateway()).consultar_metrica.execute!(
      { metricId: 'commerce.revenue', periodo: 'mês passado' }, {} as never,
    ) as Record<string, unknown>;
    expect(result).toMatchObject({
      metricId: 'commerce.revenue', unidade: 'currency', total: 480000,
      periodo: { de: '2026-02-01', ate: '2026-02-28' },
      pico: { data: '2026-02-15', valor: 300000 },
      pontos: 3,
    });
    expect(result).not.toHaveProperty('points');
  });

  it('states plainly that currency values are in cents', async () => {
    const result = await tools(buildGateway()).consultar_metrica.execute!(
      { metricId: 'commerce.revenue', periodo: 'mês passado' }, {} as never,
    ) as Record<string, unknown>;
    expect(result.observacao).toMatch(/centavos/i);
  });

  it('returns an error object instead of throwing on an unresolvable period', async () => {
    const result = await tools(buildGateway()).consultar_metrica.execute!(
      { metricId: 'commerce.revenue', periodo: 'na época da promoção' }, {} as never,
    ) as Record<string, unknown>;
    expect(result.erro).toMatch(/não entendi o período/i);
  });

  it('returns an error object when neither periodo nor from/to is given', async () => {
    const result = await tools(buildGateway()).consultar_metrica.execute!(
      { metricId: 'commerce.revenue' }, {} as never,
    ) as Record<string, unknown>;
    expect(result.erro).toMatch(/informe/i);
  });

  it('turns a gateway failure into an error object the model can read', async () => {
    const gateway = buildGateway({
      queryMetric: jest.fn(async () => { throw new Error('Uappi respondeu 503'); }),
    });
    const result = await tools(gateway).consultar_metrica.execute!(
      { metricId: 'commerce.revenue', periodo: 'hoje' }, {} as never,
    ) as Record<string, unknown>;
    expect(result.erro).toContain('Uappi respondeu 503');
  });

  it('reports every call to the audit callback, including failures', async () => {
    const logs: AgentToolCall[] = [];
    const gateway = buildGateway({ queryMetric: jest.fn(async () => { throw new Error('falhou'); }) });
    await tools(gateway, (log) => logs.push(log)).consultar_metrica.execute!(
      { metricId: 'commerce.revenue', periodo: 'hoje' }, {} as never,
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ toolName: 'consultar_metrica', success: false, errorMessage: 'falhou' });
    expect(typeof logs[0]?.durationMs).toBe('number');
  });
});

describe('ranking', () => {
  it('routes a known ranking to the right source and tool', async () => {
    const gateway = buildGateway();
    await tools(gateway).ranking.execute!(
      { tipo: 'produtos_mais_vendidos', periodo: 'mês passado' }, {} as never,
    );
    expect(gateway.callTool).toHaveBeenCalledWith(
      'commerce', 'top_products',
      expect.objectContaining({ from: '2026-02-01', to: '2026-02-28', tenant }),
      expect.anything(),
    );
  });

  it('routes a GA4 ranking to the ga4 source', async () => {
    const gateway = buildGateway();
    await tools(gateway).ranking.execute!(
      { tipo: 'origens_de_trafego', periodo: 'mês passado' }, {} as never,
    );
    expect(gateway.callTool).toHaveBeenCalledWith('ga4', 'traffic_sources', expect.anything(), expect.anything());
  });

  it('trims the ranking to the top five rows for the model', async () => {
    const result = await tools(buildGateway()).ranking.execute!(
      { tipo: 'produtos_mais_vendidos', periodo: 'mês passado' }, {} as never,
    ) as { linhas: unknown[] };
    expect(result.linhas).toHaveLength(5);
  });

  it('rejects an unknown ranking type with the list of valid ones', async () => {
    const result = await tools(buildGateway()).ranking.execute!(
      { tipo: 'produtos_mais_bonitos', periodo: 'mês passado' }, {} as never,
    ) as Record<string, unknown>;
    expect(result.erro).toMatch(/produtos_mais_vendidos/);
  });
});

describe('correlacionar', () => {
  it('calls the gateway batch once and returns the coefficient', async () => {
    const gateway = buildGateway({
      queryBatch: jest.fn(async () => [
        { ...series, metricId: 'ga4.active_users', unit: 'count', points: [
          { date: '2026-02-01', value: 10 }, { date: '2026-02-15', value: 20 }, { date: '2026-02-28', value: 30 },
        ] },
        { ...series, points: [
          { date: '2026-02-01', value: 100 }, { date: '2026-02-15', value: 200 }, { date: '2026-02-28', value: 300 },
        ] },
      ]),
    });
    const result = await tools(gateway).correlacionar.execute!(
      { metricaA: 'ga4.active_users', metricaB: 'commerce.revenue', periodo: 'mês passado' }, {} as never,
    ) as Record<string, unknown>;
    expect(result.coeficiente).toBeCloseTo(1, 5);
    expect(result.ressalva).toMatch(/causa/i);
  });
});

describe('funil_de_compra', () => {
  it('calls the GA4 funnel tool with the resolved period', async () => {
    const gateway = buildGateway({
      callTool: jest.fn(async () => ({
        from: '2026-02-01', to: '2026-02-28', steps: [], worstStepKey: null,
        overallConversion: 0, identifiesUsers: false, note: 'agregado',
      })),
    });
    await tools(gateway).funil_de_compra.execute!({ periodo: 'mês passado' }, {} as never);
    expect(gateway.callTool).toHaveBeenCalledWith(
      'ga4', 'checkout_funnel',
      expect.objectContaining({ from: '2026-02-01', to: '2026-02-28' }),
      expect.anything(),
    );
  });
});
```

- [ ] **Step 3: Implementar `tools.ts`**

`apps/api/src/agent/tools.ts`:

```ts
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { correlateMetrics, type MetricGateway } from '@center/mcp-core';
import { GranularitySchema, type MetricQuery, type MetricSource, type TenantContext } from '@center/shared';
import { resolvePeriodPhrase } from './date-resolver.js';
import { analyzeAppVersionImpact } from '../analysis/app-version-impact.js';

export interface AgentToolCall {
  toolName: string;
  input: unknown;
  durationMs: number;
  success: boolean;
  errorMessage?: string;
}

export interface AgentToolContext {
  gateway: MetricGateway;
  tenant: TenantContext;
  today: string;
  onToolCall?: (log: AgentToolCall) => void;
}

/** Quantas linhas de ranking vão para o contexto do modelo. */
const RANKING_ROWS_FOR_MODEL = 5;

/**
 * Catálogo de rankings, com o nome que o usuário usaria.
 *
 * Uma ferramenta só, com o tipo como parâmetro, em vez de doze ferramentas
 * quase idênticas — doze opções parecidas degradam a escolha do modelo.
 */
const RANKINGS: Record<string, { source: MetricSource; tool: string; descricao: string }> = {
  produtos_mais_vendidos: { source: 'commerce', tool: 'top_products', descricao: 'produtos por faturamento' },
  categorias_mais_vendidas: { source: 'commerce', tool: 'top_categories', descricao: 'categorias por faturamento' },
  campanhas_por_receita: { source: 'commerce', tool: 'campaign_revenue', descricao: 'campanhas por receita real' },
  ticket_por_canal: { source: 'commerce', tool: 'channel_average_ticket', descricao: 'ticket médio por canal' },
  receita_por_dispositivo: { source: 'commerce', tool: 'device_revenue', descricao: 'receita por dispositivo' },
  campanhas_com_recorrentes: { source: 'commerce', tool: 'campaign_returning_customers', descricao: 'taxa de recompra por campanha' },
  situacao_dos_pedidos: { source: 'commerce', tool: 'orders_by_status', descricao: 'pedidos por situação' },
  pedidos_que_falharam: { source: 'commerce', tool: 'failed_orders', descricao: 'compras com pagamento recusado' },
  meios_de_pagamento: { source: 'commerce', tool: 'payment_method_performance', descricao: 'conversão por meio de pagamento' },
  produtos_sem_estoque: { source: 'commerce', tool: 'out_of_stock_products', descricao: 'produtos com saldo zerado' },
  origens_de_trafego: { source: 'ga4', tool: 'traffic_sources', descricao: 'origens por usuários' },
  campanhas_por_usuarios: { source: 'ga4', tool: 'campaign_users', descricao: 'campanhas por usuários' },
  paginas_com_abandono: { source: 'ga4', tool: 'page_performance', descricao: 'páginas por taxa de rejeição' },
  conversao_por_dispositivo: { source: 'ga4', tool: 'device_performance', descricao: 'conversão por dispositivo' },
  versoes_do_app: { source: 'ga4', tool: 'app_versions', descricao: 'usuários por versão do app' },
  eventos_mais_frequentes: { source: 'ga4', tool: 'top_events', descricao: 'eventos por contagem' },
};

const RANKING_NAMES = Object.keys(RANKINGS);

/**
 * Envolve o corpo de uma ferramenta com cronômetro, auditoria e conversão de
 * exceção em objeto de erro. O modelo NUNCA deve receber um throw: ele precisa
 * ler a mensagem e decidir se tenta outra coisa ou explica ao usuário.
 */
function instrument<TInput, TOutput extends Record<string, unknown>>(
  context: AgentToolContext,
  toolName: string,
  body: (input: TInput) => Promise<TOutput>,
) {
  return async (input: TInput): Promise<TOutput | { erro: string }> => {
    const startedAt = Date.now();
    try {
      const output = await body(input);
      context.onToolCall?.({ toolName, input, durationMs: Date.now() - startedAt, success: true });
      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      context.onToolCall?.({
        toolName, input, durationMs: Date.now() - startedAt, success: false, errorMessage: message,
      });
      return { erro: message };
    }
  };
}

interface PeriodInput {
  periodo?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  granularity?: 'day' | 'week' | 'month' | undefined;
}

function resolveWindow(input: PeriodInput, today: string): {
  from: string; to: string; granularity: 'day' | 'week' | 'month';
} {
  if (input.periodo) {
    const resolved = resolvePeriodPhrase(input.periodo, today);
    if (!resolved) {
      throw new Error(
        `não entendi o período "${input.periodo}". Peça ao usuário as datas exatas ou use uma ` +
        `expressão como "mês passado", "últimos 30 dias" ou "fevereiro de 2026".`,
      );
    }
    return { from: resolved.from, to: resolved.to, granularity: input.granularity ?? resolved.granularity };
  }

  if (!input.from || !input.to) {
    throw new Error('informe "periodo" ou o par "from"/"to" em YYYY-MM-DD');
  }
  return { from: input.from, to: input.to, granularity: input.granularity ?? 'day' };
}

const PeriodShape = {
  periodo: z.string().optional().describe('expressão de período em português, ex.: "mês passado"'),
  from: z.string().optional().describe('data inicial YYYY-MM-DD'),
  to: z.string().optional().describe('data final YYYY-MM-DD'),
};

export function buildAgentTools(context: AgentToolContext): ToolSet {
  const { gateway, tenant, today } = context;

  return {
    listar_metricas: tool({
      description:
        'Lista as métricas disponíveis com id, unidade e dimensões filtráveis. Chame SEMPRE ' +
        'antes de consultar_metrica quando não tiver certeza do id exato.',
      inputSchema: z.object({}),
      execute: instrument(context, 'listar_metricas', async () => ({
        metricas: (await gateway.listMetrics()).map((metric) => ({
          id: metric.id, nome: metric.label, descricao: metric.description,
          unidade: metric.unit, dimensoes: metric.dimensions,
        })),
      })),
    }),

    consultar_metrica: tool({
      description:
        'Valor de uma métrica em um período. Informe "periodo" com uma expressão em português ' +
        '(ex.: "hoje", "mês passado", "últimos 30 dias", "fevereiro de 2026") OU "from" e "to" ' +
        'em YYYY-MM-DD. Retorna o total, o pico e o intervalo resolvido. ' +
        'ATENÇÃO: valores monetários voltam em CENTAVOS — divida por 100 antes de citar em reais.',
      inputSchema: z.object({
        metricId: z.string().describe('id exato da métrica, como devolvido por listar_metricas'),
        ...PeriodShape,
        granularity: GranularitySchema.optional(),
        filtros: z.record(z.string(), z.string()).optional()
          .describe('filtro por dimensão, ex.: { "campaign": "black-friday" }'),
      }),
      execute: instrument(context, 'consultar_metrica', async (input) => {
        const window = resolveWindow(input, today);

        const query: MetricQuery = {
          metricId: input.metricId,
          from: window.from, to: window.to, granularity: window.granularity,
          tenant,
          ...(input.filtros ? { filters: input.filtros } : {}),
        };

        const series = await gateway.queryMetric(query);

        // Resumo achatado: 90 pontos no contexto gastam tokens e não melhoram
        // a resposta. Total, pico e intervalo cobrem quase toda pergunta real.
        const peak = series.points.reduce(
          (best, point) => (point.value > best.value ? point : best),
          series.points[0] ?? { date: window.from, value: 0 },
        );

        return {
          metricId: series.metricId,
          unidade: series.unit,
          granularidade: series.granularity,
          total: series.total,
          periodo: { de: window.from, ate: window.to },
          pico: { data: peak.date, valor: peak.value },
          pontos: series.points.length,
          observacao: series.unit === 'currency'
            ? 'Valores em CENTAVOS — divida por 100 para reais.'
            : 'Valores em unidade natural.',
        };
      }),
    }),

    ranking: tool({
      description:
        `Ranking em um período. Tipos disponíveis: ${RANKING_NAMES.join(', ')}. ` +
        'Use para perguntas do tipo "qual produto mais vendeu", "qual campanha trouxe mais ' +
        'receita", "quantos pedidos foram cancelados", "quais compras falharam".',
      inputSchema: z.object({
        tipo: z.string().describe(`um de: ${RANKING_NAMES.join(', ')}`),
        ...PeriodShape,
        limite: z.number().int().min(1).max(20).optional(),
      }),
      execute: instrument(context, 'ranking', async (input) => {
        const spec = RANKINGS[input.tipo];
        if (!spec) {
          throw new Error(`ranking desconhecido: "${input.tipo}". Disponíveis: ${RANKING_NAMES.join(', ')}`);
        }

        const window = resolveWindow(input, today);
        const payload = await gateway.callTool<Record<string, unknown>>(
          spec.source, spec.tool,
          { from: window.from, to: window.to, limit: input.limite ?? 10, tenant },
          { cache: spec.tool !== 'failed_orders' && spec.tool !== 'out_of_stock_products', rangeEnd: window.to },
        );

        // Algumas ferramentas devolvem `rows`, outras `groups`, `methods` ou
        // `orders`. Normalizamos para o modelo não precisar saber a diferença.
        const rows = (payload.rows ?? payload.groups ?? payload.methods ?? payload.orders ?? payload.products ?? []) as unknown[];

        return {
          tipo: input.tipo,
          descricao: spec.descricao,
          periodo: { de: window.from, ate: window.to },
          total: payload.total ?? rows.length,
          unidade: payload.unit ?? 'count',
          linhas: rows.slice(0, RANKING_ROWS_FOR_MODEL),
          observacao: payload.unit === 'currency'
            ? 'Valores em CENTAVOS — divida por 100 para reais.'
            : '',
        };
      }),
    }),

    funil_de_compra: tool({
      description:
        'Funil de compra do site/app no período (viu produto → carrinho → checkout → pagamento ' +
        '→ compra), com usuários por etapa e a etapa de maior abandono. Use para "qual etapa do ' +
        'checkout abandona mais", "quantos abandonaram o carrinho", "qual funil converte menos". ' +
        'IMPORTANTE: é agregado e NÃO identifica clientes individualmente — diga isso ao usuário.',
      inputSchema: z.object(PeriodShape),
      execute: instrument(context, 'funil_de_compra', async (input) => {
        const window = resolveWindow(input, today);
        return gateway.callTool<Record<string, unknown>>(
          'ga4', 'checkout_funnel',
          { from: window.from, to: window.to, tenant },
          { rangeEnd: window.to },
        );
      }),
    }),

    comparar_periodos: tool({
      description:
        'Compara produtos ou eventos entre dois períodos, do que MAIS CAIU (produtos) ou MAIS ' +
        'CRESCEU (eventos) para o resto. Use para "qual produto caiu mais em vendas" e "quais ' +
        'eventos cresceram após a atualização".',
      inputSchema: z.object({
        tipo: z.enum(['produtos', 'eventos']),
        periodoAnterior: z.string().describe('expressão de período, ex.: "mês passado"'),
        periodoAtual: z.string().describe('expressão de período, ex.: "este mês"'),
        limite: z.number().int().min(1).max(20).optional(),
      }),
      execute: instrument(context, 'comparar_periodos', async (input) => {
        const before = resolvePeriodPhrase(input.periodoAnterior, today);
        const current = resolvePeriodPhrase(input.periodoAtual, today);
        if (!before || !current) {
          throw new Error(
            `não entendi um dos períodos ("${input.periodoAnterior}" / "${input.periodoAtual}"). ` +
            'Peça as datas exatas ao usuário.',
          );
        }

        const isProducts = input.tipo === 'produtos';
        const payload = await gateway.callTool<{ rows: unknown[] }>(
          isProducts ? 'commerce' : 'ga4',
          isProducts ? 'compare_products' : 'compare_events',
          {
            periodA: { from: before.from, to: before.to },
            periodB: { from: current.from, to: current.to },
            limit: input.limite ?? 10,
            tenant,
          },
          { rangeEnd: current.to },
        );

        return {
          tipo: input.tipo,
          periodoAnterior: { de: before.from, ate: before.to },
          periodoAtual: { de: current.from, ate: current.to },
          linhas: payload.rows.slice(0, RANKING_ROWS_FOR_MODEL),
        };
      }),
    }),

    correlacionar: tool({
      description:
        'Mede se duas métricas se moveram juntas no período, devolvendo um coeficiente de -1 a 1. ' +
        'Use para "o aumento de usuários impactou o faturamento". SEMPRE repita a ressalva de que ' +
        'correlação não prova causa.',
      inputSchema: z.object({
        metricaA: z.string().describe('id da primeira métrica'),
        metricaB: z.string().describe('id da segunda métrica'),
        ...PeriodShape,
        granularity: GranularitySchema.optional(),
      }),
      execute: instrument(context, 'correlacionar', async (input) => {
        const window = resolveWindow(input, today);
        const result = await correlateMetrics(gateway, {
          metricIdA: input.metricaA, metricIdB: input.metricaB,
          from: window.from, to: window.to, granularity: window.granularity, tenant,
        });

        return {
          metricaA: result.metricA, metricaB: result.metricB,
          periodo: { de: result.from, ate: result.to },
          pontos: result.buckets,
          coeficiente: result.coefficient,
          forca: result.strength,
          direcao: result.direction,
          ressalva: result.caveat,
        };
      }),
    }),

    impacto_da_versao: tool({
      description:
        'Compara faturamento, pedidos e usuários em janelas iguais antes e depois do lançamento ' +
        'de uma versão do app. Use para "quanto vendemos após a versão 5.8" e "a atualização ' +
        'aumentou as vendas". Se não souber a data de lançamento, pergunte ao usuário.',
      inputSchema: z.object({
        versao: z.string().describe('número da versão, ex.: "5.8.0"'),
        dataDeLancamento: z.string().describe('data do lançamento em YYYY-MM-DD'),
        janelaEmDias: z.number().int().min(3).max(90).optional(),
      }),
      execute: instrument(context, 'impacto_da_versao', async (input) => {
        const result = await analyzeAppVersionImpact({
          gateway, tenant, today,
          version: input.versao,
          releaseDate: input.dataDeLancamento,
          ...(input.janelaEmDias ? { windowDays: input.janelaEmDias } : {}),
        });

        return {
          versao: result.version,
          lancamento: result.releaseDate,
          janelaEmDias: result.windowDays,
          antes: result.before,
          depois: result.after,
          variacaoDeReceita: result.revenueDelta,
          variacaoPercentual: result.revenueDeltaRatio,
          adocao: result.adoption,
          veredito: result.verdict,
          ressalva: result.caveat,
          observacao: 'Valores monetários em CENTAVOS — divida por 100 para reais.',
        };
      }),
    }),
  };
}
```

- [ ] **Step 4: Rodar os testes**

Run: `pnpm --filter @center/api test -- agent-tools.test.ts`
Expected: PASS — 16 testes.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(agent): add tenant-scoped agent tools over the metric gateway"
```

---

### Task 31: Núcleo do agente, memória e avaliação

**Files:**
- Create: `apps/api/src/agent/{system-prompt.ts,agent.ts,memory.ts}`
- Create: `apps/api/scripts/eval-agent.ts`, `docs/agent-eval.md`
- Test: `apps/api/src/__tests__/{agent.test.ts,agent-memory.test.ts}`

**Interfaces:**
- Consumes: `buildAgentTools`, `AgentToolCall` (T30).
- Produces:
  - `buildSystemPrompt(today: string): string`
  - `interface AgentMessage { role: 'user' | 'assistant'; content: string }`
  - `interface AgentInput { gateway; tenant; today; history; userMessage; model? }`
  - `interface AgentResult { reply: string; toolCalls: AgentToolCall[] }`
  - `runAgent(input: AgentInput): Promise<AgentResult>`
  - `MAX_HISTORY_MESSAGES = 12`, `MAX_REPLY_CHARS = 1200`, `MAX_STEPS = 8`
  - `loadConversationHistory(prisma, whatsappIdentityId, organizationId)`, `appendExchange(prisma, params)`
  - `pnpm --filter @center/api eval:agent`

**Guardrails implementados aqui, cada um com teste:**
- **Escopo** — o prompt recusa qualquer coisa fora de analytics; o tenant já está fechado nas ferramentas.
- **Anti-alucinação** — proibido estimar número que não veio de ferramenta.
- **Centavos** — o prompt insiste na divisão por 100, porque é o erro numérico mais provável.
- **Limite de passos** — `stopWhen: stepCountIs(8)`; sem isso, erro recorrente de ferramenta vira laço infinito e conta de API.
- **Tamanho** — resposta truncada em 1200 caracteres; acima disso o WhatsApp fica ilegível.
- **Janela de histórico** — só as últimas 12 mensagens vão ao modelo.

- [ ] **Step 1: Escrever o system prompt**

`apps/api/src/agent/system-prompt.ts`:

```ts
export function buildSystemPrompt(today: string): string {
  return `Você é o assistente de analytics da loja, respondendo por WhatsApp.

A data de hoje é ${today} (timezone America/Sao_Paulo).

SEU ESCOPO
Você responde exclusivamente sobre os dados da loja do usuário: vendas, faturamento,
ticket médio, pedidos e seus status, produtos, categorias, clientes, campanhas,
origens de tráfego, sessões, usuários do site e do aplicativo, funil de compra e
versões do app. Se perguntarem qualquer outra coisa — código, opinião, assuntos
gerais, dados de outra empresa — responda que você só ajuda com os dados de
analytics desta conta e ofereça um exemplo de pergunta que você atende.

O QUE VOCÊ AINDA NÃO TEM
Você não tem acesso a dados de crashes (Crashlytics), de performance do aplicativo
(tempo de tela, tempo de resposta de API), nem à lista nominal de clientes que
abandonaram o carrinho. Se perguntarem isso, diga com clareza que esses dados ainda
não estão disponíveis e sugira o que você consegue responder no lugar — por exemplo,
o funil de compra mostra quantos abandonaram e em qual etapa, mesmo sem os nomes.

COMO RESPONDER
1. Use SEMPRE as ferramentas para obter números. Nunca estime, nunca arredonde por
   conta própria, nunca invente. Se uma ferramenta falhar, diga que o dado não está
   disponível agora — jamais preencha a lacuna com um palpite.
2. VALORES MONETÁRIOS VOLTAM EM CENTAVOS. Divida por 100 antes de citar em reais.
   480000 centavos são R$ 4.800,00, não R$ 480.000,00. Confira antes de responder.
3. Se não souber o id exato da métrica, chame listar_metricas antes.
4. Passe a expressão de período do usuário direto no campo "periodo" (ex.: "mês
   passado", "últimos 30 dias", "fevereiro"). NÃO calcule datas você mesmo.
5. Se o período for ambíguo e a ferramenta não conseguir resolver, pergunte as datas.
6. Ao usar correlacionar ou impacto_da_versao, SEMPRE repita a ressalva de que
   correlação não prova causa.
7. Faturamento considera apenas pedidos com status de venda. Cancelados e pedidos
   aguardando pagamento não entram na receita — se o usuário perguntar por eles, use
   o ranking "situacao_dos_pedidos".

FORMATO
- Português do Brasil, tom direto e cordial, sem jargão.
- Comece pelo número que responde a pergunta.
- Sempre diga a que período o número se refere.
- Reais no formato R$ 1.234,56; contagens com separador de milhar.
- No máximo 4 linhas. No máximo um emoji, e só quando somar algo.
- Nada de markdown com ** ou # — o WhatsApp não renderiza. Para ênfase use *asterisco simples*.`;
}
```

- [ ] **Step 2: Escrever o teste do agente (falhando)**

`apps/api/src/__tests__/agent.test.ts`:

```ts
import { MockLanguageModelV2 } from 'ai/test';
import type { MetricGateway } from '@center/mcp-core';
import type { MetricSeries, TenantContext } from '@center/shared';
import { MAX_REPLY_CHARS, buildSystemPrompt, runAgent } from '../agent/agent.js';

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
```

> Se `MockLanguageModelV2` não existir no pacote instalado, confira os exports com
> `node -e "console.log(Object.keys(require('ai/test')))"` e o formato de `content` em
> `node_modules/ai/dist/index.d.ts` (procure `LanguageModelV2Content`). Ajuste os helpers
> `textOnlyModel`/`toolThenTextModel` — a lógica dos testes não muda.

- [ ] **Step 3: Implementar `agent.ts`**

`apps/api/src/agent/agent.ts`:

```ts
import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText, stepCountIs, type LanguageModel, type ModelMessage } from 'ai';
import type { MetricGateway } from '@center/mcp-core';
import type { TenantContext } from '@center/shared';
import { buildAgentTools, type AgentToolCall } from './tools.js';
import { buildSystemPrompt } from './system-prompt.js';

export { buildSystemPrompt };

export const MAX_HISTORY_MESSAGES = 12;
export const MAX_REPLY_CHARS = 1200;
/** Perguntas cruzadas legitimamente encadeiam 3-4 ferramentas; 8 dá folga sem virar laço. */
export const MAX_STEPS = 8;

const FALLBACK_REPLY = 'Não consegui consultar os dados agora. Tente de novo em alguns instantes.';

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentInput {
  gateway: MetricGateway;
  tenant: TenantContext;
  today: string;
  history: AgentMessage[];
  userMessage: string;
  /** Injetável para teste; em produção vem de `defaultModel()`. */
  model?: LanguageModel;
}

export interface AgentResult {
  reply: string;
  toolCalls: AgentToolCall[];
}

export function defaultModel(apiKey: string): LanguageModel {
  return createAnthropic({ apiKey })('claude-sonnet-5');
}

function truncate(text: string): string {
  return text.length <= MAX_REPLY_CHARS ? text : `${text.slice(0, MAX_REPLY_CHARS - 1)}…`;
}

export async function runAgent(input: AgentInput): Promise<AgentResult> {
  const toolCalls: AgentToolCall[] = [];

  const tools = buildAgentTools({
    gateway: input.gateway,
    tenant: input.tenant,
    today: input.today,
    onToolCall: (log) => toolCalls.push(log),
  });

  // Janela deslizante: conversas longas estourariam o contexto e o custo, e o
  // histórico antigo raramente ajuda numa pergunta sobre números.
  const recentHistory = input.history.slice(-MAX_HISTORY_MESSAGES);

  const messages: ModelMessage[] = [
    ...recentHistory.map((message) => ({ role: message.role, content: message.content })),
    { role: 'user' as const, content: input.userMessage },
  ];

  try {
    const result = await generateText({
      model: input.model ?? defaultModel(process.env.ANTHROPIC_API_KEY ?? ''),
      system: buildSystemPrompt(input.today),
      messages,
      tools,
      // Sem este limite, uma ferramenta que falha em laço queima a cota da API.
      stopWhen: stepCountIs(MAX_STEPS),
      temperature: 0,
    });

    const text = result.text.trim();
    return { reply: text === '' ? FALLBACK_REPLY : truncate(text), toolCalls };
  } catch {
    // Falha do provedor não pode virar 500 no webhook: o usuário precisa
    // receber uma mensagem, e a Meta precisa receber 200.
    return { reply: FALLBACK_REPLY, toolCalls };
  }
}
```

- [ ] **Step 4: Escrever o teste de memória e implementá-la**

`apps/api/src/__tests__/agent-memory.test.ts`:

```ts
import type { PrismaClient } from '@prisma/client';
import { MAX_LOADED_MESSAGES, appendExchange, loadConversationHistory } from '../agent/memory.js';

function buildPrisma() {
  const conversation = {
    findFirst: jest.fn(async () => null),
    create: jest.fn(async () => ({ id: 'conv_new' })),
    update: jest.fn(async () => ({})),
  };
  const message = { findMany: jest.fn(async () => []), create: jest.fn(async () => ({ id: 'msg_1' })) };
  const toolCallLog = { createMany: jest.fn(async () => ({ count: 0 })) };
  return {
    prisma: { conversation, message, toolCallLog } as unknown as PrismaClient,
    conversation, message, toolCallLog,
  };
}

describe('loadConversationHistory', () => {
  it('creates a conversation on the first message', async () => {
    const { prisma, conversation } = buildPrisma();
    expect(await loadConversationHistory(prisma, 'wid_1', 'org_1'))
      .toEqual({ conversationId: 'conv_new', history: [] });
    expect(conversation.create).toHaveBeenCalledWith({
      data: { whatsappIdentityId: 'wid_1', organizationId: 'org_1' },
    });
  });

  it('reuses the conversation and returns history in chronological order', async () => {
    const { prisma, conversation, message } = buildPrisma();
    conversation.findFirst.mockResolvedValueOnce({ id: 'conv_1' } as never);
    // O Prisma devolve desc (mais recentes primeiro); a saída precisa ser asc.
    message.findMany.mockResolvedValueOnce([
      { role: 'ASSISTANT', content: 'resposta 2' },
      { role: 'USER', content: 'pergunta 2' },
      { role: 'ASSISTANT', content: 'resposta 1' },
      { role: 'USER', content: 'pergunta 1' },
    ] as never);

    const result = await loadConversationHistory(prisma, 'wid_1', 'org_1');
    expect(conversation.create).not.toHaveBeenCalled();
    expect(result.history).toEqual([
      { role: 'user', content: 'pergunta 1' },
      { role: 'assistant', content: 'resposta 1' },
      { role: 'user', content: 'pergunta 2' },
      { role: 'assistant', content: 'resposta 2' },
    ]);
  });

  it('caps how many messages it loads', async () => {
    const { prisma, conversation, message } = buildPrisma();
    conversation.findFirst.mockResolvedValueOnce({ id: 'conv_1' } as never);
    await loadConversationHistory(prisma, 'wid_1', 'org_1');
    expect(message.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: MAX_LOADED_MESSAGES }));
  });
});

describe('appendExchange', () => {
  it('persists the user message, the reply and the tool logs', async () => {
    const { prisma, message, toolCallLog, conversation } = buildPrisma();
    message.create
      .mockResolvedValueOnce({ id: 'msg_user' } as never)
      .mockResolvedValueOnce({ id: 'msg_assistant' } as never);

    await appendExchange(prisma, {
      conversationId: 'conv_1', organizationId: 'org_1',
      userMessage: 'quanto vendemos?', assistantMessage: 'R$ 4.800,00',
      toolCalls: [{ toolName: 'consultar_metrica', input: { metricId: 'commerce.revenue' }, durationMs: 42, success: true }],
    });

    expect(message.create).toHaveBeenCalledTimes(2);
    expect(message.create).toHaveBeenNthCalledWith(1, {
      data: { conversationId: 'conv_1', role: 'USER', content: 'quanto vendemos?' },
    });
    expect(toolCallLog.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ messageId: 'msg_assistant', organizationId: 'org_1', success: true })],
    });
    expect(conversation.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'conv_1' } }));
  });

  it('records the error message of a failed tool call', async () => {
    const { prisma, message, toolCallLog } = buildPrisma();
    message.create
      .mockResolvedValueOnce({ id: 'msg_user' } as never)
      .mockResolvedValueOnce({ id: 'msg_assistant' } as never);

    await appendExchange(prisma, {
      conversationId: 'conv_1', organizationId: 'org_1',
      userMessage: 'p', assistantMessage: 'r',
      toolCalls: [{ toolName: 'consultar_metrica', input: {}, durationMs: 5, success: false, errorMessage: 'Uappi 503' }],
    });
    expect(toolCallLog.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ success: false, errorMessage: 'Uappi 503' })],
    });
  });

  it('skips the tool log write when there were no tool calls', async () => {
    const { prisma, message, toolCallLog } = buildPrisma();
    message.create
      .mockResolvedValueOnce({ id: 'msg_user' } as never)
      .mockResolvedValueOnce({ id: 'msg_assistant' } as never);
    await appendExchange(prisma, {
      conversationId: 'conv_1', organizationId: 'org_1',
      userMessage: 'oi', assistantMessage: 'olá', toolCalls: [],
    });
    expect(toolCallLog.createMany).not.toHaveBeenCalled();
  });
});
```

`apps/api/src/agent/memory.ts`:

```ts
import type { PrismaClient } from '@prisma/client';
import type { AgentMessage } from './agent.js';
import type { AgentToolCall } from './tools.js';

/** Teto do que sai do banco. A janela enviada ao modelo é menor. */
export const MAX_LOADED_MESSAGES = 20;

export async function loadConversationHistory(
  prisma: PrismaClient,
  whatsappIdentityId: string,
  organizationId: string,
): Promise<{ conversationId: string; history: AgentMessage[] }> {
  const existing = await prisma.conversation.findFirst({
    where: { whatsappIdentityId },
    orderBy: { lastMessageAt: 'desc' },
    select: { id: true },
  });

  if (!existing) {
    const created = await prisma.conversation.create({
      data: { whatsappIdentityId, organizationId },
    });
    return { conversationId: created.id, history: [] };
  }

  // Buscamos em ordem decrescente para pegar as N MAIS RECENTES, depois
  // invertemos: o modelo precisa da conversa em ordem cronológica.
  const rows = await prisma.message.findMany({
    where: { conversationId: existing.id },
    orderBy: { createdAt: 'desc' },
    take: MAX_LOADED_MESSAGES,
    select: { role: true, content: true },
  });

  return {
    conversationId: existing.id,
    history: rows.reverse().map((row) => ({
      role: row.role === 'USER' ? ('user' as const) : ('assistant' as const),
      content: row.content,
    })),
  };
}

export interface AppendExchangeParams {
  conversationId: string;
  organizationId: string;
  userMessage: string;
  assistantMessage: string;
  toolCalls: AgentToolCall[];
}

export async function appendExchange(prisma: PrismaClient, params: AppendExchangeParams): Promise<void> {
  await prisma.message.create({
    data: { conversationId: params.conversationId, role: 'USER', content: params.userMessage },
  });

  const assistantMessage = await prisma.message.create({
    data: { conversationId: params.conversationId, role: 'ASSISTANT', content: params.assistantMessage },
  });

  if (params.toolCalls.length > 0) {
    await prisma.toolCallLog.createMany({
      data: params.toolCalls.map((call) => ({
        messageId: assistantMessage.id,
        organizationId: params.organizationId,
        toolName: call.toolName,
        input: call.input as object,
        durationMs: call.durationMs,
        success: call.success,
        errorMessage: call.errorMessage ?? null,
      })),
    });
  }

  await prisma.conversation.update({
    where: { id: params.conversationId },
    data: { lastMessageAt: new Date() },
  });
}
```

- [ ] **Step 5: Escrever o script de avaliação**

Testes unitários provam que o encanamento funciona; eles **não** provam que as respostas são boas. Este script existe para a segunda pergunta.

`apps/api/scripts/eval-agent.ts`:

```ts
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { McpPool, MetricGateway, RedisCacheStore } from '@center/mcp-core';
import { loadConfig } from '../src/config.js';
import { runAgent } from '../src/agent/agent.js';
import { resolveTenant } from '../src/tenant.js';

/** Uma pergunta por caso de uso do escopo, mais duas fora de escopo. */
const QUESTIONS = [
  'quanto vendemos hoje?',
  'quanto vendemos esta semana?',
  'quanto vendemos no mês passado?',
  'qual foi o ticket médio em fevereiro?',
  'quantos pedidos tivemos hoje?',
  'quantos pedidos foram cancelados este mês?',
  'quantos pedidos estão aguardando pagamento?',
  'quais compras falharam nos últimos 7 dias?',
  'qual produto mais vendeu no mês passado?',
  'qual produto caiu mais em vendas comparando com o mês anterior?',
  'qual categoria vendeu mais este mês?',
  'quantos clientes novos tivemos no mês passado?',
  'qual método de pagamento converte mais?',
  'qual campanha trouxe mais receita nos últimos 30 dias?',
  'qual origem trouxe mais usuários este mês?',
  'quantas sessões tivemos ontem?',
  'qual etapa do checkout tem maior abandono?',
  'qual dispositivo converte melhor?',
  'o aumento de usuários impactou o faturamento nos últimos 30 dias?',
  'quais canais possuem maior ticket médio?',
  // Fora de escopo — devem ser recusadas com clareza
  'qual versão do app está crashando mais?',
  'me manda a receita do bolo de cenoura',
];

const config = loadConfig(process.env);
const prisma = new PrismaClient();
const redis = new Redis(config.redisUrl);

const pool = await McpPool.spawn([
  { source: 'commerce', command: process.execPath, args: ['../../packages/mcp-commerce/dist/main.js'],
    // UAPPI_BASE_URL habilita out_of_stock_products (T15) condicionalmente — o
    // servidor só a registra se a variável existir, sem precisar de credencial fixa.
    env: { DATABASE_URL: config.databaseUrl, UAPPI_BASE_URL: config.uappiBaseUrl,
      CREDENTIALS_ENCRYPTION_KEY: config.credentialsEncryptionKey } },
  { source: 'ga4', command: process.execPath, args: ['../../packages/mcp-ga4/dist/main.js'],
    env: { GA4_CREDENTIALS_JSON: config.ga4CredentialsJson, MOCK_EXTERNAL_APIS: String(config.mockExternalApis) } },
]);

const gateway = new MetricGateway(pool, new RedisCacheStore(redis));
const tenant = await resolveTenant(prisma, process.env.EVAL_ORG_ID ?? 'org_dev');
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

const latencies: number[] = [];

for (const question of QUESTIONS) {
  const started = Date.now();
  const result = await runAgent({ gateway, tenant, today, history: [], userMessage: question });
  const elapsed = Date.now() - started;
  latencies.push(elapsed);

  console.log('\n─────────────────────────────────────────────');
  console.log(`P: ${question}`);
  console.log(`R: ${result.reply}`);
  console.log(`   [${elapsed}ms · ferramentas: ${
    result.toolCalls.map((c) => `${c.toolName}${c.success ? '' : ' (FALHOU)'}`).join(', ') || 'nenhuma'
  }]`);
}

latencies.sort((a, b) => a - b);
console.log(`\nLatência mediana: ${latencies[Math.floor(latencies.length / 2)]}ms`);

await gateway.close();
await prisma.$disconnect();
redis.disconnect();
```

Adicione ao `scripts` de `apps/api/package.json`: `"eval:agent": "node --experimental-strip-types scripts/eval-agent.ts"`.

- [ ] **Step 6: Rodar os testes e a avaliação**

Run: `pnpm --filter @center/api test`
Expected: PASS — 15 testes novos.

```bash
pnpm build
pnpm --filter @center/api eval:agent | tee ../../docs/agent-eval.md
```

**Critérios de aprovação — os cinco precisam passar antes de seguir:**
1. As 20 perguntas de analytics chamaram ao menos uma ferramenta cada (nenhuma respondida "de cabeça").
2. **Todo valor em reais está correto** — conferir dois a três contra a dashboard. Erro de fator 100 aqui é o bug mais provável.
3. Os períodos resolvidos batem com o que um humano entenderia da frase.
4. As 2 perguntas fora de escopo foram recusadas com explicação, sem inventar dado.
5. Latência mediana abaixo de 8 segundos (acima disso a experiência no WhatsApp fica ruim — veja o Risco R5).

Se algum critério falhar, ajuste `buildSystemPrompt` e rode de novo. Anote em `docs/agent-eval.md` a data e a versão do prompt avaliada.

- [ ] **Step 7: Commit**

```bash
git add apps/api docs/agent-eval.md
git commit -m "feat(agent): add agent core, conversation memory and evaluation harness"
```

---

### Task 32: Webhook do WhatsApp

**Files:**
- Create: `apps/api/src/whatsapp/{signature.ts,routes.ts}`
- Modify: `apps/api/src/whatsapp/parse.ts` (parser completo)
- Test: `apps/api/src/__tests__/{whatsapp-signature.test.ts,whatsapp-parse.test.ts,whatsapp-routes.test.ts}`

**Interfaces:**
- Consumes: `AppDeps` (T22).
- Produces:
  - `verifySignature(rawBody, header, appSecret): boolean`, `signPayload(rawBody, appSecret): string`
  - `parseInboundMessages(payload: unknown): InboundMessage[]`
  - `registerWhatsAppRoutes(app, deps)`: `GET /webhooks/whatsapp` (verificação), `POST /webhooks/whatsapp`

**A assinatura HMAC vem primeiro porque é a fronteira de segurança:** sem ela, qualquer um posta no webhook e consome sua cota da Anthropic.

- [ ] **Step 1: Escrever o teste de assinatura e implementá-la**

`apps/api/src/__tests__/whatsapp-signature.test.ts`:

```ts
import { createHmac } from 'node:crypto';
import { signPayload, verifySignature } from '../whatsapp/signature.js';

const SECRET = 'app-secret-de-teste';
const body = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [] }));

describe('signPayload', () => {
  it('produces the sha256= prefixed hex digest Meta sends', () => {
    expect(signPayload(body, SECRET))
      .toBe(`sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`);
  });
});

describe('verifySignature', () => {
  it('accepts a correctly signed body', () => {
    expect(verifySignature(body, signPayload(body, SECRET), SECRET)).toBe(true);
  });

  it('rejects a body signed with another secret', () => {
    expect(verifySignature(body, signPayload(body, 'outro'), SECRET)).toBe(false);
  });

  it('rejects a body tampered with after signing', () => {
    expect(verifySignature(Buffer.from('{"object":"outro"}'), signPayload(body, SECRET), SECRET)).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(verifySignature(body, undefined, SECRET)).toBe(false);
  });

  it('rejects a header without the sha256= prefix', () => {
    expect(verifySignature(body, createHmac('sha256', SECRET).update(body).digest('hex'), SECRET)).toBe(false);
  });

  it('rejects a header of the wrong length instead of throwing', () => {
    expect(verifySignature(body, 'sha256=abc', SECRET)).toBe(false);
  });

  it('rejects a header with non-hex characters instead of throwing', () => {
    expect(verifySignature(body, `sha256=${'z'.repeat(64)}`, SECRET)).toBe(false);
  });
});
```

`apps/api/src/whatsapp/signature.ts`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

const PREFIX = 'sha256=';
const DIGEST_HEX_LENGTH = 64;

export function signPayload(rawBody: Buffer, appSecret: string): string {
  return `${PREFIX}${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}

/**
 * Valida o header X-Hub-Signature-256 — a única fronteira que impede um
 * terceiro de disparar o agente às nossas custas. Todo caminho de erro devolve
 * `false`; esta função nunca lança.
 */
export function verifySignature(
  rawBody: Buffer,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header || !header.startsWith(PREFIX)) return false;

  const received = header.slice(PREFIX.length);
  if (received.length !== DIGEST_HEX_LENGTH || !/^[0-9a-f]+$/i.test(received)) return false;

  // Comparação em tempo constante: evita distinguir assinaturas por timing.
  return timingSafeEqual(
    Buffer.from(received, 'hex'),
    createHmac('sha256', appSecret).update(rawBody).digest(),
  );
}
```

- [ ] **Step 2: Escrever o teste do parser e implementá-lo**

`apps/api/src/__tests__/whatsapp-parse.test.ts`:

```ts
import { parseInboundMessages } from '../whatsapp/parse.js';

function payloadWith(value: unknown) {
  return { object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages', value }] }] };
}

const textMessage = {
  messaging_product: 'whatsapp',
  metadata: { display_phone_number: '5511999999999', phone_number_id: '123' },
  messages: [{
    from: '5511988887777', id: 'wamid.ABC', timestamp: '1773532800',
    type: 'text', text: { body: 'quanto vendemos mês passado?' },
  }],
};

describe('parseInboundMessages', () => {
  it('extracts a text message', () => {
    expect(parseInboundMessages(payloadWith(textMessage))).toEqual([{
      wamid: 'wamid.ABC', fromPhoneE164: '+5511988887777',
      text: 'quanto vendemos mês passado?', timestamp: 1773532800,
    }]);
  });

  it('trims surrounding whitespace', () => {
    const payload = payloadWith({
      ...textMessage, messages: [{ ...textMessage.messages[0], text: { body: '  oi  ' } }],
    });
    expect(parseInboundMessages(payload)[0]?.text).toBe('oi');
  });

  it('ignores status update events', () => {
    expect(parseInboundMessages(payloadWith({
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '5511999999999', phone_number_id: '123' },
      statuses: [{ id: 'wamid.XYZ', status: 'delivered', timestamp: '1773532800' }],
    }))).toEqual([]);
  });

  it('ignores non-text message types', () => {
    expect(parseInboundMessages(payloadWith({
      ...textMessage,
      messages: [{ from: '5511988887777', id: 'wamid.IMG', timestamp: '1773532800', type: 'image', image: { id: 'x' } }],
    }))).toEqual([]);
  });

  it('ignores a text message with an empty body', () => {
    expect(parseInboundMessages(payloadWith({
      ...textMessage, messages: [{ ...textMessage.messages[0], text: { body: '   ' } }],
    }))).toEqual([]);
  });

  it('extracts every message when a batch arrives', () => {
    const payload = payloadWith({
      ...textMessage,
      messages: [
        { ...textMessage.messages[0], id: 'wamid.1', text: { body: 'a' } },
        { ...textMessage.messages[0], id: 'wamid.2', text: { body: 'b' } },
      ],
    });
    expect(parseInboundMessages(payload).map((m) => m.wamid)).toEqual(['wamid.1', 'wamid.2']);
  });

  it('returns an empty array for a malformed payload instead of throwing', () => {
    expect(parseInboundMessages({ nada: true })).toEqual([]);
    expect(parseInboundMessages(null)).toEqual([]);
    expect(parseInboundMessages('texto')).toEqual([]);
  });

  it('normalises the phone to E.164 with a leading plus', () => {
    expect(parseInboundMessages(payloadWith({
      ...textMessage, messages: [{ ...textMessage.messages[0], from: '+5511988887777' }],
    }))[0]?.fromPhoneE164).toBe('+5511988887777');
  });
});
```

`apps/api/src/whatsapp/parse.ts` (substitui o arquivo só-tipo da T22):

```ts
import { z } from 'zod';

export interface InboundMessage {
  wamid: string;
  fromPhoneE164: string;
  text: string;
  timestamp: number;
}

/**
 * Schema deliberadamente frouxo: a Meta adiciona campos sem aviso e envia
 * dezenas de tipos de evento. Aceitamos qualquer forma e extraímos apenas
 * mensagens de texto; tudo mais é ignorado em silêncio.
 */
const PayloadSchema = z.object({
  entry: z.array(z.object({
    changes: z.array(z.object({
      value: z.object({
        messages: z.array(z.object({
          from: z.string(),
          id: z.string(),
          timestamp: z.string(),
          type: z.string(),
          text: z.object({ body: z.string() }).optional(),
        })).optional(),
      }).passthrough(),
    }).passthrough()).optional(),
  }).passthrough()).optional(),
}).passthrough();

export function parseInboundMessages(payload: unknown): InboundMessage[] {
  const parsed = PayloadSchema.safeParse(payload);
  if (!parsed.success) return [];

  const messages: InboundMessage[] = [];
  for (const entry of parsed.data.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value.messages ?? []) {
        if (message.type !== 'text') continue;
        const text = message.text?.body.trim() ?? '';
        if (text === '') continue;
        messages.push({
          wamid: message.id,
          fromPhoneE164: message.from.startsWith('+') ? message.from : `+${message.from}`,
          text,
          timestamp: Number(message.timestamp),
        });
      }
    }
  }
  return messages;
}
```

- [ ] **Step 3: Escrever o teste das rotas (falhando)**

`apps/api/src/__tests__/whatsapp-routes.test.ts`:

```ts
import type { PrismaClient } from '@prisma/client';
import type { MetricGateway } from '@center/mcp-core';
import { Pseudonymizer } from '@center/pii';
import { SecretBox } from '@center/secrets';
import { buildServer } from '../server.js';
import { signPayload } from '../whatsapp/signature.js';
import { testConfig } from './helpers/config.js';

const inboundPayload = {
  object: 'whatsapp_business_account',
  entry: [{ id: '1', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '5511999999999', phone_number_id: '1' },
    messages: [{ from: '5511988887777', id: 'wamid.ABC', timestamp: '1773532800', type: 'text', text: { body: 'oi' } }],
  } }] }],
};

async function setup(alreadyProcessed = false, enqueueImpl?: jest.Mock) {
  const enqueue = enqueueImpl ?? jest.fn(async () => {});
  const prisma = {
    processedWebhookEvent: {
      findUnique: jest.fn(async () => (alreadyProcessed ? { wamid: 'wamid.ABC' } : null)),
      create: jest.fn(async () => ({ wamid: 'wamid.ABC' })),
    },
  } as unknown as PrismaClient;

  const app = await buildServer({
    config: testConfig, prisma,
    gateway: {} as unknown as MetricGateway,
    pseudonymizer: new Pseudonymizer(testConfig.piiPepper),
    secretBox: new SecretBox(testConfig.credentialsEncryptionKey),
    queue: { enqueue },
  });
  return { app, enqueue };
}

function post(app: Awaited<ReturnType<typeof buildServer>>, payload: unknown, secret = 's') {
  const raw = Buffer.from(JSON.stringify(payload));
  return app.inject({
    method: 'POST', url: '/webhooks/whatsapp',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signPayload(raw, secret) },
    payload: raw,
  });
}

describe('GET /webhooks/whatsapp', () => {
  it('echoes the challenge when the verify token matches', async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: 'GET',
      url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=v&hub.challenge=1158201444',
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('1158201444');
    await app.close();
  });

  it('returns 403 for a wrong verify token', async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: 'GET',
      url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=1',
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it('returns 403 when hub.mode is not subscribe', async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: 'GET',
      url: '/webhooks/whatsapp?hub.mode=unsubscribe&hub.verify_token=v&hub.challenge=1',
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
});

describe('POST /webhooks/whatsapp', () => {
  it('enqueues a valid message and answers 200 immediately', async () => {
    const { app, enqueue } = await setup();
    expect((await post(app, inboundPayload)).statusCode).toBe(200);
    expect(enqueue).toHaveBeenCalledWith({
      wamid: 'wamid.ABC', fromPhoneE164: '+5511988887777', text: 'oi', timestamp: 1773532800,
    });
    await app.close();
  });

  it('rejects a body signed with the wrong secret and does not enqueue', async () => {
    const { app, enqueue } = await setup();
    expect((await post(app, inboundPayload, 'errado')).statusCode).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects a request with no signature header', async () => {
    const { app, enqueue } = await setup();
    const response = await app.inject({
      method: 'POST', url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json' },
      payload: Buffer.from(JSON.stringify(inboundPayload)),
    });
    expect(response.statusCode).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
    await app.close();
  });

  it('does not enqueue a wamid that was already processed', async () => {
    const { app, enqueue } = await setup(true);
    expect((await post(app, inboundPayload)).statusCode).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
    await app.close();
  });

  it('answers 200 for a status-only event without enqueuing', async () => {
    const { app, enqueue } = await setup();
    const statusPayload = {
      object: 'whatsapp_business_account',
      entry: [{ id: '1', changes: [{ field: 'messages', value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '5511999999999', phone_number_id: '1' },
        statuses: [{ id: 'wamid.X', status: 'read', timestamp: '1773532800' }],
      } }] }],
    };
    expect((await post(app, statusPayload)).statusCode).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
    await app.close();
  });

  it('answers 200 even when enqueuing fails, so Meta does not retry forever', async () => {
    const enqueue = jest.fn(async () => { throw new Error('redis fora do ar'); });
    const { app } = await setup(false, enqueue);
    expect((await post(app, inboundPayload)).statusCode).toBe(200);
    await app.close();
  });
});
```

- [ ] **Step 4: Implementar `routes.ts`**

`apps/api/src/whatsapp/routes.ts`:

```ts
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import { verifySignature } from './signature.js';
import { parseInboundMessages } from './parse.js';

const VerifyQuerySchema = z.object({
  'hub.mode': z.string(),
  'hub.verify_token': z.string(),
  'hub.challenge': z.string(),
});

export async function registerWhatsAppRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  // Handshake feito uma única vez pela Meta ao cadastrar a URL. Precisa
  // devolver o challenge como texto puro.
  app.get('/webhooks/whatsapp', async (request, reply) => {
    const parsed = VerifyQuerySchema.safeParse(request.query);
    if (
      !parsed.success
      || parsed.data['hub.mode'] !== 'subscribe'
      || parsed.data['hub.verify_token'] !== deps.config.whatsapp.verifyToken
    ) {
      return reply.status(403).send('forbidden');
    }
    return reply.type('text/plain').send(parsed.data['hub.challenge']);
  });

  app.post('/webhooks/whatsapp', async (request, reply) => {
    const rawBody = (request as FastifyRequest & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
    const signature = request.headers['x-hub-signature-256'];

    if (!verifySignature(
      rawBody,
      typeof signature === 'string' ? signature : undefined,
      deps.config.whatsapp.appSecret,
    )) {
      request.log.warn('webhook do WhatsApp com assinatura inválida');
      return reply.status(401).send({ error: 'unauthorized' });
    }

    for (const message of parseInboundMessages(request.body)) {
      try {
        // Idempotência: a Meta reenvia o mesmo evento em caso de timeout.
        const seen = await deps.prisma.processedWebhookEvent.findUnique({
          where: { wamid: message.wamid },
        });
        if (seen) {
          request.log.info({ wamid: message.wamid }, 'evento duplicado ignorado');
          continue;
        }
        await deps.prisma.processedWebhookEvent.create({ data: { wamid: message.wamid } });
        await deps.queue.enqueue(message);
      } catch (error) {
        // Nunca devolvemos erro à Meta: 4xx/5xx gera reentrega em laço e, depois
        // de várias falhas, a Meta desativa o webhook.
        request.log.error({ err: error, wamid: message.wamid }, 'falha ao enfileirar mensagem');
      }
    }

    return reply.status(200).send({ received: true });
  });
}
```

- [ ] **Step 5: Rodar os testes**

Run: `pnpm --filter @center/api test`
Expected: PASS — 22 testes novos.

- [ ] **Step 6: Commit**

```bash
git add apps/api
git commit -m "feat(whatsapp): add verified, idempotent inbound webhook"
```

---

### Task 33: Fila, worker e envio de resposta

> **Execute a T34 antes desta.** O `worker.ts` importa `isLinkCodeMessage`, `redeemLinkCode` e `LINK_CODE_TTL_MINUTES` de `./linking.js`, que nasce na T34 — o código de vínculo precisa ser interceptado antes da checagem de identidade, senão um número ainda não vinculado nunca conseguiria se vincular. As duas tasks estão nesta ordem no documento porque o worker é o deliverable principal; na execução, **T32 → T34 → T33 → T35**. A ordem recomendada ao final do plano já reflete isso.

**Files:**
- Create: `apps/api/src/whatsapp/{cloud-api-client.ts,worker.ts,worker-main.ts}`
- Modify: `apps/api/src/whatsapp/queue.ts` (implementação BullMQ)
- Test: `apps/api/src/__tests__/{cloud-api-client.test.ts,whatsapp-worker.test.ts}`

**Interfaces:**
- Consumes: `InboundMessage` (T32), `runAgent` (T31), `loadConversationHistory`/`appendExchange` (T31), `resolveTenant` (T22).
- Produces:
  - `class CloudApiClient` — `sendText(toPhoneE164, body): Promise<void>`
  - `class BullMessageQueue implements MessageQueue`, `WHATSAPP_QUEUE_NAME = 'whatsapp-inbound'`
  - `processInboundMessage(deps: WorkerDeps, message: InboundMessage): Promise<void>`
  - `createWhatsAppWorker(deps, redis): Worker`
  - `UNKNOWN_PHONE_REPLY`
  - Binário `node dist/whatsapp/worker-main.js`

- [ ] **Step 1: Adicionar a dependência e implementar o cliente da Cloud API**

```bash
pnpm --filter @center/api add bullmq@^5.34.0
```

`apps/api/src/__tests__/cloud-api-client.test.ts`:

```ts
import { CloudApiClient } from '../whatsapp/cloud-api-client.js';

function buildClient(fetchImpl: jest.Mock) {
  return new CloudApiClient(
    { accessToken: 'token-abc', phoneNumberId: '123456' },
    fetchImpl as unknown as typeof fetch,
  );
}

describe('CloudApiClient.sendText', () => {
  it('posts to the graph messages endpoint of the phone number', async () => {
    const fetchImpl = jest.fn(async () => new Response('{}', { status: 200 }));
    await buildClient(fetchImpl).sendText('+5511988887777', 'olá');
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://graph.facebook.com/v21.0/123456/messages');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer token-abc');
  });

  it('sends the documented text message body', async () => {
    const fetchImpl = jest.fn(async () => new Response('{}', { status: 200 }));
    await buildClient(fetchImpl).sendText('+5511988887777', 'olá');
    expect(JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string)).toEqual({
      messaging_product: 'whatsapp', recipient_type: 'individual',
      to: '+5511988887777', type: 'text', text: { preview_url: false, body: 'olá' },
    });
  });

  it('throws with the graph error message on failure', async () => {
    const fetchImpl = jest.fn(async () => new Response(
      JSON.stringify({ error: { message: 'Recipient phone number not in allowed list', code: 131030 } }),
      { status: 400 },
    ));
    await expect(buildClient(fetchImpl).sendText('+5511988887777', 'olá'))
      .rejects.toThrow('Recipient phone number not in allowed list');
  });

  it('throws a readable error when the body is not json', async () => {
    const fetchImpl = jest.fn(async () => new Response('<html>502</html>', { status: 502 }));
    await expect(buildClient(fetchImpl).sendText('+5511988887777', 'olá')).rejects.toThrow(/502/);
  });
});
```

`apps/api/src/whatsapp/cloud-api-client.ts`:

```ts
const GRAPH_VERSION = 'v21.0';

export interface CloudApiCredentials {
  accessToken: string;
  phoneNumberId: string;
}

export class CloudApiClient {
  constructor(
    private readonly credentials: CloudApiCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async sendText(toPhoneE164: string, body: string): Promise<void> {
    const response = await this.fetchImpl(
      `https://graph.facebook.com/${GRAPH_VERSION}/${this.credentials.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.credentials.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: toPhoneE164,
          type: 'text',
          // preview_url: false evita que a Meta expanda links da resposta.
          text: { preview_url: false, body },
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
      throw new Error(payload?.error?.message ?? `WhatsApp Cloud API respondeu ${response.status}`);
    }
  }
}
```

- [ ] **Step 2: Implementar a fila BullMQ**

`apps/api/src/whatsapp/queue.ts` (substitui o arquivo só-interface da T22):

```ts
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { InboundMessage } from './parse.js';

export const WHATSAPP_QUEUE_NAME = 'whatsapp-inbound';

export interface MessageQueue {
  enqueue(message: InboundMessage): Promise<void>;
}

export class BullMessageQueue implements MessageQueue {
  private readonly queue: Queue<InboundMessage>;

  constructor(redis: Redis) {
    this.queue = new Queue<InboundMessage>(WHATSAPP_QUEUE_NAME, { connection: redis });
  }

  async enqueue(message: InboundMessage): Promise<void> {
    await this.queue.add('inbound', message, {
      // jobId = wamid: segunda camada de idempotência, agora na fila.
      jobId: message.wamid,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 500,
      removeOnFail: 1000,
    });
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
```

- [ ] **Step 3: Escrever o teste do worker (falhando)**

`apps/api/src/__tests__/whatsapp-worker.test.ts`:

```ts
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
    organization: { findUnique: jest.fn(async () => ({
      id: 'org_1', ga4PropertyId: '111', ga4BigQueryDataset: null,
      uappiApiKey: null, uappiSecretKey: null,
    })) },
    conversation: { findFirst: jest.fn(async () => ({ id: 'conv_1' })), update: jest.fn(async () => ({})) },
    message: { findMany: jest.fn(async () => []), create: jest.fn(async () => ({ id: 'msg_1' })) },
    toolCallLog: { createMany: jest.fn(async () => ({ count: 0 })) },
    linkCode: { findUnique: jest.fn(async () => null), update: jest.fn(async () => ({})) },
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

beforeEach(() => {
  runAgent.mockReset();
  runAgent.mockResolvedValue({ reply: 'Você faturou R$ 4.800,00.', toolCalls: [] });
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
  });

  it('rethrows when sending fails, so BullMQ can retry', async () => {
    const { deps } = buildDeps(verifiedIdentity);
    (deps.cloudApi.sendText as jest.Mock).mockRejectedValueOnce(new Error('graph 503'));
    await expect(processInboundMessage(deps, message)).rejects.toThrow('graph 503');
  });
});
```

- [ ] **Step 4: Implementar `worker.ts` e `worker-main.ts`**

`apps/api/src/whatsapp/worker.ts`:

```ts
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '@prisma/client';
import type { MetricGateway } from '@center/mcp-core';
import type { AppConfig } from '../config.js';
import { resolveTenant } from '../tenant.js';
import { runAgent } from '../agent/agent.js';
import { appendExchange, loadConversationHistory } from '../agent/memory.js';
import type { CloudApiClient } from './cloud-api-client.js';
import type { InboundMessage } from './parse.js';
import { WHATSAPP_QUEUE_NAME } from './queue.js';
import { LINK_CODE_TTL_MINUTES, isLinkCodeMessage, redeemLinkCode } from './linking.js';

export const UNKNOWN_PHONE_REPLY =
  'Não encontrei este número vinculado a uma conta. Entre na dashboard, gere um código de '
  + 'vínculo em Configurações e me envie aqui.';

const AGENT_FAILURE_REPLY = 'Não consegui processar sua pergunta agora. Tente novamente em alguns instantes.';

export interface WorkerDeps {
  prisma: PrismaClient;
  gateway: MetricGateway;
  cloudApi: CloudApiClient;
  config: AppConfig;
  today?: () => string;
}

function todayInSaoPaulo(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

export async function processInboundMessage(deps: WorkerDeps, message: InboundMessage): Promise<void> {
  // O código de vínculo chega de um número que AINDA não está vinculado — por
  // isso é tratado antes da checagem de identidade.
  if (isLinkCodeMessage(message.text)) {
    const result = await redeemLinkCode(deps.prisma, message.text, message.fromPhoneE164);
    const replyText = result.ok
      ? 'Pronto! Este número está vinculado à sua conta. Pode perguntar sobre suas métricas. 📊'
      : {
          not_found: 'Código não encontrado. Gere um novo na dashboard, em Configurações.',
          expired: `Código expirado — ele vale ${LINK_CODE_TTL_MINUTES} minutos. Gere um novo na dashboard.`,
          used: 'Este código já foi usado. Gere um novo na dashboard, em Configurações.',
          phone_taken: 'Este número já está vinculado a outro usuário. Fale com o administrador da conta.',
        }[result.reason];

    await deps.cloudApi.sendText(message.fromPhoneE164, replyText);
    return;
  }

  const identity = await deps.prisma.whatsAppIdentity.findUnique({
    where: { phoneE164: message.fromPhoneE164 },
  });

  // Fronteira de autorização do bot: número não vinculado e verificado nunca
  // chega ao agente, então nunca toca em dado de nenhuma organização.
  if (!identity || !identity.verifiedAt) {
    await deps.cloudApi.sendText(message.fromPhoneE164, UNKNOWN_PHONE_REPLY);
    return;
  }

  const today = (deps.today ?? todayInSaoPaulo)();

  let reply = AGENT_FAILURE_REPLY;
  let toolCalls: Awaited<ReturnType<typeof runAgent>>['toolCalls'] = [];
  let conversationId: string | null = null;

  try {
    const conversation = await loadConversationHistory(deps.prisma, identity.id, identity.organizationId);
    conversationId = conversation.conversationId;

    const tenant = await resolveTenant(deps.prisma, identity.organizationId);
    const result = await runAgent({
      gateway: deps.gateway, tenant, today,
      history: conversation.history, userMessage: message.text,
    });
    reply = result.reply;
    toolCalls = result.toolCalls;
  } catch {
    // Falha no agente ou no banco não pode impedir a resposta: silêncio no
    // WhatsApp é pior do que uma mensagem de erro.
  }

  // Deliberadamente fora do try: se o envio falhar, a exceção sobe e o BullMQ
  // reprocessa o job.
  await deps.cloudApi.sendText(message.fromPhoneE164, reply);

  if (conversationId) {
    await appendExchange(deps.prisma, {
      conversationId,
      organizationId: identity.organizationId,
      userMessage: message.text,
      assistantMessage: reply,
      toolCalls,
    }).catch(() => {
      // Auditoria é best-effort; o usuário já foi respondido.
    });
  }
}

export function createWhatsAppWorker(deps: WorkerDeps, redis: Redis): Worker<InboundMessage> {
  return new Worker<InboundMessage>(
    WHATSAPP_QUEUE_NAME,
    async (job) => processInboundMessage(deps, job.data),
    { connection: redis, concurrency: 5 },
  );
}
```

`apps/api/src/whatsapp/worker-main.ts`:

```ts
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { McpPool, MetricGateway, RedisCacheStore, type McpServerConfig } from '@center/mcp-core';
import { loadConfig } from '../config.js';
import { CloudApiClient } from './cloud-api-client.js';
import { createWhatsAppWorker } from './worker.js';

const config = loadConfig(process.env);
const prisma = new PrismaClient();
// BullMQ exige maxRetriesPerRequest: null na conexão do worker.
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

const mcpServers: McpServerConfig[] = [
  { source: 'commerce', command: process.execPath, args: ['../../packages/mcp-commerce/dist/main.js'],
    // UAPPI_BASE_URL habilita out_of_stock_products (T15) condicionalmente — o
    // servidor só a registra se a variável existir, sem precisar de credencial fixa.
    env: { DATABASE_URL: config.databaseUrl, UAPPI_BASE_URL: config.uappiBaseUrl,
      CREDENTIALS_ENCRYPTION_KEY: config.credentialsEncryptionKey } },
  { source: 'ga4', command: process.execPath, args: ['../../packages/mcp-ga4/dist/main.js'],
    env: { GA4_CREDENTIALS_JSON: config.ga4CredentialsJson, MOCK_EXTERNAL_APIS: String(config.mockExternalApis) } },
];

const pool = await McpPool.spawn(mcpServers);
const gateway = new MetricGateway(pool, new RedisCacheStore(redis));
const cloudApi = new CloudApiClient(config.whatsapp);

const worker = createWhatsAppWorker({ prisma, gateway, cloudApi, config }, redis);

worker.on('failed', (job, error) => {
  console.error(`job ${job?.id} falhou (tentativa ${job?.attemptsMade}):`, error.message);
});
worker.on('completed', (job) => console.log(`job ${job.id} concluído`));

console.log('worker do WhatsApp em execução');

async function shutdown(): Promise<void> {
  await worker.close();
  await gateway.close();
  await prisma.$disconnect();
  redis.disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
```

Adicione ao `scripts` de `apps/api/package.json`:

```json
  "start:whatsapp": "node dist/whatsapp/worker-main.js",
  "dev:whatsapp": "node --watch --experimental-strip-types src/whatsapp/worker-main.ts"
```

- [ ] **Step 5: Rodar os testes**

Run: `pnpm --filter @center/api test`
Expected: PASS — 11 testes novos.

- [ ] **Step 6: Commit**

```bash
git add apps/api
git commit -m "feat(whatsapp): add bullmq queue, cloud api client and inbound worker"
```

---

### Task 34: Vínculo do telefone com o usuário

**Files:**
- Create: `apps/api/src/whatsapp/{linking.ts,link-routes.ts}`
- Test: `apps/api/src/__tests__/whatsapp-linking.test.ts`

**Interfaces:**
- Consumes: `PrismaClient`; `requireAuth` (T22).
- Produces:
  - `generateLinkCode(): string`, `isLinkCodeMessage(text): boolean`
  - `createLinkCode(prisma, userId): Promise<{ code: string; expiresAt: Date }>`
  - `redeemLinkCode(prisma, code, phoneE164): Promise<RedeemResult>`
  - `LINK_CODE_TTL_MINUTES = 15`
  - `POST /api/whatsapp/link-code` (autenticada) → `{ code, expiresAt, ttlMinutes }`

- [ ] **Step 1: Escrever o teste (falhando)**

`apps/api/src/__tests__/whatsapp-linking.test.ts`:

```ts
import type { PrismaClient } from '@prisma/client';
import {
  LINK_CODE_TTL_MINUTES, createLinkCode, generateLinkCode, isLinkCodeMessage, redeemLinkCode,
} from '../whatsapp/linking.js';

function buildPrisma() {
  return {
    linkCode: {
      create: jest.fn(async ({ data }: { data: unknown }) => data),
      findUnique: jest.fn(async () => null),
      update: jest.fn(async () => ({})),
    },
    whatsAppIdentity: { findUnique: jest.fn(async () => null), upsert: jest.fn(async () => ({})) },
  } as unknown as PrismaClient;
}

describe('generateLinkCode', () => {
  it('produces six characters', () => {
    expect(generateLinkCode()).toHaveLength(6);
  });

  it('avoids ambiguous characters I, L, O, U and digits 0 and 1', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateLinkCode()).toMatch(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/);
    }
  });

  it('is not trivially repeating', () => {
    expect(new Set(Array.from({ length: 100 }, () => generateLinkCode())).size).toBeGreaterThan(90);
  });
});

describe('isLinkCodeMessage', () => {
  it('recognises a bare code', () => {
    expect(isLinkCodeMessage('A2B3C4')).toBe(true);
  });

  it('recognises a lowercase code with spaces', () => {
    expect(isLinkCodeMessage('  a2b3c4 ')).toBe(true);
  });

  it('does not treat a normal question as a code', () => {
    expect(isLinkCodeMessage('quanto vendemos mês passado?')).toBe(false);
  });

  it('does not treat a six letter word with invalid characters as a code', () => {
    expect(isLinkCodeMessage('ONIBUS')).toBe(false);
  });
});

describe('createLinkCode', () => {
  it('stores a code expiring in fifteen minutes', async () => {
    const prisma = buildPrisma();
    const before = Date.now();
    const result = await createLinkCode(prisma, 'user_1');
    const ttlMs = result.expiresAt.getTime() - before;
    expect(ttlMs).toBeGreaterThan((LINK_CODE_TTL_MINUTES - 1) * 60_000);
    expect(ttlMs).toBeLessThanOrEqual(LINK_CODE_TTL_MINUTES * 60_000 + 1000);
    expect(prisma.linkCode.create).toHaveBeenCalled();
  });
});

describe('redeemLinkCode', () => {
  const validCode = {
    code: 'A2B3C4', userId: 'user_1', usedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    user: { id: 'user_1', organizationId: 'org_1' },
  };

  it('links the phone to the user on a valid code', async () => {
    const prisma = buildPrisma();
    (prisma.linkCode.findUnique as jest.Mock).mockResolvedValueOnce(validCode);
    expect(await redeemLinkCode(prisma, 'A2B3C4', '+5511988887777')).toEqual({ ok: true });
    expect(prisma.whatsAppIdentity.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user_1' } }),
    );
    expect(prisma.linkCode.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { code: 'A2B3C4' } }),
    );
  });

  it('accepts a lowercase code', async () => {
    const prisma = buildPrisma();
    (prisma.linkCode.findUnique as jest.Mock).mockResolvedValueOnce(validCode);
    expect(await redeemLinkCode(prisma, 'a2b3c4', '+5511988887777')).toEqual({ ok: true });
  });

  it('rejects an unknown code', async () => {
    expect(await redeemLinkCode(buildPrisma(), 'ZZZZZZ', '+5511988887777'))
      .toEqual({ ok: false, reason: 'not_found' });
  });

  it('rejects an expired code', async () => {
    const prisma = buildPrisma();
    (prisma.linkCode.findUnique as jest.Mock).mockResolvedValueOnce({
      ...validCode, expiresAt: new Date(Date.now() - 1000),
    });
    expect(await redeemLinkCode(prisma, 'A2B3C4', '+5511988887777'))
      .toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a code that was already used', async () => {
    const prisma = buildPrisma();
    (prisma.linkCode.findUnique as jest.Mock).mockResolvedValueOnce({ ...validCode, usedAt: new Date() });
    expect(await redeemLinkCode(prisma, 'A2B3C4', '+5511988887777'))
      .toEqual({ ok: false, reason: 'used' });
  });

  it('rejects when the phone belongs to another user', async () => {
    const prisma = buildPrisma();
    (prisma.linkCode.findUnique as jest.Mock).mockResolvedValueOnce(validCode);
    (prisma.whatsAppIdentity.findUnique as jest.Mock).mockResolvedValueOnce({
      id: 'wid_other', userId: 'user_outro',
    });
    expect(await redeemLinkCode(prisma, 'A2B3C4', '+5511988887777'))
      .toEqual({ ok: false, reason: 'phone_taken' });
    expect(prisma.whatsAppIdentity.upsert).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Implementar `linking.ts` e `link-routes.ts`**

`apps/api/src/whatsapp/linking.ts`:

```ts
import { randomInt } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

export const LINK_CODE_TTL_MINUTES = 15;

/** Alfabeto Crockford: sem I, L, O, U, 0 e 1 — nada que se confunda ao digitar. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 6;

export function generateLinkCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

/** Uma mensagem só é candidata a código se for exatamente 6 chars do alfabeto. */
export function isLinkCodeMessage(text: string): boolean {
  return new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`).test(text.trim().toUpperCase());
}

export async function createLinkCode(
  prisma: PrismaClient,
  userId: string,
): Promise<{ code: string; expiresAt: Date }> {
  const code = generateLinkCode();
  const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MINUTES * 60_000);
  await prisma.linkCode.create({ data: { code, userId, expiresAt } });
  return { code, expiresAt };
}

export type RedeemResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'expired' | 'used' | 'phone_taken' };

export async function redeemLinkCode(
  prisma: PrismaClient,
  rawCode: string,
  phoneE164: string,
): Promise<RedeemResult> {
  const code = rawCode.trim().toUpperCase();

  const record = await prisma.linkCode.findUnique({
    where: { code },
    include: { user: { select: { id: true, organizationId: true } } },
  });

  if (!record) return { ok: false, reason: 'not_found' };
  if (record.usedAt) return { ok: false, reason: 'used' };
  if (record.expiresAt.getTime() < Date.now()) return { ok: false, reason: 'expired' };

  // O telefone é único no schema; checamos antes para dar um erro compreensível
  // em vez de um P2002 do Prisma.
  const existing = await prisma.whatsAppIdentity.findUnique({ where: { phoneE164 } });
  if (existing && existing.userId !== record.userId) {
    return { ok: false, reason: 'phone_taken' };
  }

  await prisma.whatsAppIdentity.upsert({
    where: { userId: record.userId },
    create: {
      phoneE164, userId: record.userId,
      organizationId: record.user.organizationId,
      verifiedAt: new Date(),
    },
    update: { phoneE164, verifiedAt: new Date() },
  });

  await prisma.linkCode.update({ where: { code }, data: { usedAt: new Date() } });
  return { ok: true };
}
```

`apps/api/src/whatsapp/link-routes.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/jwt.js';
import type { AppDeps } from '../deps.js';
import { LINK_CODE_TTL_MINUTES, createLinkCode } from './linking.js';

export async function registerLinkRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.post(
    '/api/whatsapp/link-code',
    { preHandler: requireAuth, config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const { code, expiresAt } = await createLinkCode(deps.prisma, request.auth.userId);
      return reply.send({
        code, expiresAt: expiresAt.toISOString(), ttlMinutes: LINK_CODE_TTL_MINUTES,
      });
    },
  );
}
```

- [ ] **Step 3: Rodar os testes**

Run: `pnpm test`
Expected: PASS em todos os pacotes.

- [ ] **Step 4: Commit**

```bash
git add apps/api
git commit -m "feat(whatsapp): add one-time code linking between phone and user"
```

---

### Task 35: Validação fim-a-fim no WhatsApp

**Files:**
- Create: `docs/whatsapp-setup.md`

**Interfaces:**
- Consumes: tudo das T29–T34.
- Produces: guia de configuração da Meta e roteiro de aceite.

**Sobre a janela de 24 horas:** a Cloud API só permite texto livre dentro de 24 h após a última mensagem do usuário. Como o bot só responde a mensagens recebidas, estamos sempre dentro da janela — **desde que a fila não acumule**. Um job retido mais de 24 h falha com o código 131047; com `attempts: 3` e backoff exponencial isso só ocorre com o worker parado por um dia, e o alarme da T38 cobre esse caso. **Templates aprovados pela Meta não são necessários neste escopo**, porque o bot nunca inicia conversa.

- [ ] **Step 1: Escrever o guia de configuração**

`docs/whatsapp-setup.md`:

```markdown
# Configuração do WhatsApp Cloud API

## Pré-requisitos (comece cedo — a verificação da Meta leva de 3 dias a 3 semanas)

1. Conta no Meta Business Manager com o negócio **verificado**.
2. App do tipo *Business* em developers.facebook.com com o produto **WhatsApp**.
3. Número de telefone registrado na WhatsApp Business Platform (não pode estar em
   uso no app WhatsApp comum).

## Valores a coletar

| Variável | Onde encontrar |
|---|---|
| `WHATSAPP_APP_SECRET` | App → Configurações → Básico → Chave secreta do app |
| `WHATSAPP_ACCESS_TOKEN` | App → WhatsApp → Configuração da API (token permanente de System User) |
| `WHATSAPP_PHONE_NUMBER_ID` | App → WhatsApp → Configuração da API → "ID do número de telefone" |
| `WHATSAPP_VERIFY_TOKEN` | Você inventa. String longa; precisa bater com a cadastrada no webhook |

> O token temporário de 24 h só serve para o primeiro teste. Para produção, crie um
> System User em Business Settings → Users → System Users, com as permissões
> `whatsapp_business_messaging` e `whatsapp_business_management`, e gere um token
> sem expiração.

## Expor o webhook em desenvolvimento

```bash
npx localtunnel --port 3333
```

Cadastre em App → WhatsApp → Configuração → Webhooks:
- **URL de callback:** `https://<seu-túnel>/webhooks/whatsapp`
- **Token de verificação:** o mesmo valor de `WHATSAPP_VERIFY_TOKEN`
- **Campos assinados:** marque `messages` (só ele)

A Meta faz um `GET` imediatamente. Se a API estiver no ar com o mesmo verify token,
o cadastro é aceito na hora. Se falhar, cheque o log — quase sempre é token divergente.

## Números de teste

Antes da revisão do app, só é possível enviar para números na lista de destinatários
de teste (App → WhatsApp → Configuração da API → "Para"). O erro
`131030 — Recipient phone number not in allowed list` significa exatamente isso.
```

- [ ] **Step 2: Rodar a validação fim-a-fim**

Em cinco terminais:

```bash
# 1
docker compose up
# 2
pnpm build && cd apps/api && node dist/main.js
# 3
cd apps/api && node dist/sync/sync-worker-main.js
# 4
cd apps/api && node dist/whatsapp/worker-main.js
# 5
npx localtunnel --port 3333
```

**Roteiro de aceite — os oito passos precisam passar:**

1. Cadastre o webhook com a URL do túnel. A Meta aceita na primeira tentativa.
2. Envie "oi" de um número **não vinculado**. Recebe a mensagem de vínculo. Confirme no log do worker que `runAgent` **não** foi chamado.
3. Na dashboard, em Configurações, gere um código. Envie-o pelo WhatsApp. Recebe a confirmação.
4. Envie "quanto vendemos no mês passado?". **Compare o valor com a dashboard no mesmo período — precisa ser idêntico.** Confirme que está em reais, não com fator 100 de erro.
5. Envie "qual produto mais vendeu?". O log mostra a ferramenta `ranking` com `tipo: produtos_mais_vendidos`.
6. Envie "quantos pedidos foram cancelados este mês?". A resposta usa `situacao_dos_pedidos` e **não** conta cancelados como receita.
7. Envie "qual versão do app está crashando mais?". A resposta diz claramente que esse dado ainda não está disponível, sem inventar.
8. Pare o worker, envie uma pergunta, suba o worker de novo. A resposta chega ao reiniciar e **apenas uma** é enviada.

Verifique no banco:

```sql
SELECT "toolName", success, "durationMs" FROM "ToolCallLog" ORDER BY "createdAt" DESC LIMIT 10;
SELECT COUNT(*) FROM "ProcessedWebhookEvent";
```

- [ ] **Step 3: Commit**

```bash
git add docs/whatsapp-setup.md
git commit -m "docs(whatsapp): add Meta setup guide and end-to-end acceptance script"
```

---

# FASE 8 — Comportamento em nível de usuário (Sprint 11)

**Objetivo:** Grupo E respondível — E1 ("quais eventos antecedem uma compra?") e E2 ("usuários que abandonam a tela X compram menos?").

**Por que esta fase é a última e é separável.** A GA4 Data API é **agregada**: ela devolve totais por dimensão, nunca a sequência de eventos de um usuário. As duas perguntas do Grupo E são intrinsecamente de nível de usuário, e a única fonte programática para isso é o **export do GA4 para BigQuery**, que traz uma linha por evento com `user_pseudo_id`. Se o cronograma apertar, esta fase é a primeira a cortar — as outras 42 perguntas não dependem dela.

**Uma simplificação que evita trabalho desnecessário:** as duas perguntas podem ser respondidas **inteiramente dentro do BigQuery**, usando o próprio evento `purchase` do GA4 — sem cruzar com os pedidos da Uappi. O cruzamento por `visitorHash` continua possível (o `user_pseudo_id` de tráfego web *é* o `client_id` que hasheamos na T9), mas não é necessário, e evitá-lo elimina uma classe inteira de erro de junção. Fica registrado como opção no Step de validação.

**Pré-requisitos de infraestrutura (façam-se no Sprint 6, não no 11):**
1. Habilitar o export do GA4 para BigQuery (Admin → Vinculações de produtos → BigQuery). A propagação inicial leva até 48 h.
2. Dar à service account os papéis `roles/bigquery.dataViewer` no dataset e `roles/bigquery.jobUser` no projeto.
3. Registrar o nome do dataset em `Organization.ga4BigQueryDataset` (formato `analytics_<propertyId>`).

**Onde os testes entram:** o SQL é montado por função pura e testado por inspeção da query gerada e do mapeamento do resultado; o cliente BigQuery é mockado. Testar o BigQuery seria testar o Google. A validação real é o smoke test.

---

### Task 36: Cliente BigQuery e caminho até a compra

**Files:**
- Create: `packages/mcp-behavior/{package.json,tsconfig.json,jest.config.cjs}`
- Create: `packages/mcp-behavior/src/{client.ts,purchase-path.ts}`
- Test: `packages/mcp-behavior/src/__tests__/purchase-path.test.ts`

**Interfaces:**
- Consumes: `AnalysisTool` de `@center/mcp-core`.
- Produces:
  - `class BigQueryEventsClient` — `static fromCredentialsJson(json)`, `query<T>(sql: string, params: Record<string, unknown>): Promise<T[]>`
  - `assertDatasetName(name: string): string`
  - `buildPurchasePathSql(params: { dataset: string; lookback: number }): string`
  - `createEventsBeforePurchaseTool(client): AnalysisTool` — `events_before_purchase`

**Responde:** E1.

- [ ] **Step 1: Criar o pacote**

`packages/mcp-behavior/package.json`:

```json
{
  "name": "@center/mcp-behavior",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/main.js",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "jest",
    "start": "node dist/main.js"
  },
  "dependencies": {
    "@center/mcp-core": "workspace:*",
    "@center/shared": "workspace:*",
    "@google-cloud/bigquery": "^7.9.1",
    "zod": "^3.24.1"
  }
}
```

`tsconfig.json` e `jest.config.cjs` seguem o molde da T1, Step 4.

- [ ] **Step 2: Escrever o teste (falhando)**

`packages/mcp-behavior/src/__tests__/purchase-path.test.ts`:

```ts
import { assertDatasetName } from '../client.js';
import { buildPurchasePathSql, createEventsBeforePurchaseTool } from '../purchase-path.js';
import type { BigQueryEventsClientLike } from '../interface.js';

function fakeClient(rows: unknown[]) {
  const query = jest.fn(async () => rows);
  return { client: { query } as unknown as BigQueryEventsClientLike, query };
}

const tenant = {
  organizationId: 'org_1',
  externalIds: { ga4BigQueryDataset: 'analytics_123456' },
};

const period = { from: '2026-02-01', to: '2026-02-28', tenant };

describe('assertDatasetName', () => {
  it('accepts a well formed GA4 dataset name', () => {
    expect(assertDatasetName('analytics_123456')).toBe('analytics_123456');
  });

  it('accepts a project qualified name', () => {
    expect(assertDatasetName('meu-projeto.analytics_123456')).toBe('meu-projeto.analytics_123456');
  });

  it('rejects a name with a backtick — SQL injection vector', () => {
    expect(() => assertDatasetName('analytics`; DROP TABLE x; --')).toThrow('dataset inválido');
  });

  it('rejects a name with spaces or quotes', () => {
    expect(() => assertDatasetName('analytics 123')).toThrow('dataset inválido');
    expect(() => assertDatasetName("analytics'")).toThrow('dataset inválido');
  });
});

describe('buildPurchasePathSql', () => {
  it('reads from the events_* wildcard table of the dataset', () => {
    const sql = buildPurchasePathSql({ dataset: 'analytics_123456', lookback: 10 });
    expect(sql).toContain('`analytics_123456.events_*`');
  });

  it('filters the partition by _TABLE_SUFFIX to keep the scan cheap', () => {
    // Sem este filtro a query varre TODO o histórico e a conta do BigQuery explode.
    const sql = buildPurchasePathSql({ dataset: 'analytics_123456', lookback: 10 });
    expect(sql).toContain('_TABLE_SUFFIX BETWEEN @fromCompact AND @toCompact');
  });

  it('uses named parameters instead of interpolating dates', () => {
    const sql = buildPurchasePathSql({ dataset: 'analytics_123456', lookback: 10 });
    expect(sql).toContain('@fromCompact');
    expect(sql).toContain('@toCompact');
    expect(sql).not.toMatch(/\d{8}/);
  });

  it('embeds the lookback as a literal integer, never as raw text', () => {
    expect(buildPurchasePathSql({ dataset: 'analytics_123456', lookback: 7 })).toContain('<= 7');
  });
});

describe('events_before_purchase', () => {
  it('is named events_before_purchase', () => {
    expect(createEventsBeforePurchaseTool(fakeClient([]).client).name).toBe('events_before_purchase');
  });

  it('converts the ISO dates into the GA4 compact suffix format', async () => {
    const { client, query } = fakeClient([]);
    await createEventsBeforePurchaseTool(client).handler(period);
    expect(query.mock.calls[0]![1]).toMatchObject({ fromCompact: '20260201', toCompact: '20260228' });
  });

  it('maps rows into events ordered by how often they precede a purchase', async () => {
    const { client } = fakeClient([
      { event_name: 'add_to_cart', users: 800, purchases: 1000, avg_position: 2.1 },
      { event_name: 'view_item', users: 950, purchases: 1000, avg_position: 4.7 },
    ]);
    const result = await createEventsBeforePurchaseTool(client).handler(period) as {
      totalPurchases: number; events: Array<Record<string, number | string>>;
    };
    expect(result.totalPurchases).toBe(1000);
    expect(result.events[0]).toMatchObject({ evento: 'view_item', usuarios: 950 });
    expect(result.events[0]?.frequencia).toBeCloseTo(0.95, 5);
  });

  it('sorts by frequency descending', async () => {
    const { client } = fakeClient([
      { event_name: 'raro', users: 10, purchases: 1000, avg_position: 1 },
      { event_name: 'comum', users: 900, purchases: 1000, avg_position: 3 },
    ]);
    const result = await createEventsBeforePurchaseTool(client).handler(period) as {
      events: Array<{ evento: string }>;
    };
    expect(result.events.map((e) => e.evento)).toEqual(['comum', 'raro']);
  });

  it('returns zeros instead of dividing by zero when there were no purchases', async () => {
    const { client } = fakeClient([]);
    const result = await createEventsBeforePurchaseTool(client).handler(period) as {
      totalPurchases: number; events: unknown[];
    };
    expect(result).toMatchObject({ totalPurchases: 0, events: [] });
  });

  it('refuses when the tenant has no BigQuery dataset configured', async () => {
    const { client } = fakeClient([]);
    await expect(createEventsBeforePurchaseTool(client).handler({
      ...period, tenant: { organizationId: 'org_1', externalIds: {} },
    })).rejects.toThrow('ga4BigQueryDataset não configurado');
  });

  it('exposes no user identifier in the response', async () => {
    const { client } = fakeClient([
      { event_name: 'view_item', users: 950, purchases: 1000, avg_position: 4.7 },
    ]);
    const result = await createEventsBeforePurchaseTool(client).handler(period);
    expect(JSON.stringify(result)).not.toMatch(/user_pseudo_id|pseudo/i);
  });
});
```

- [ ] **Step 3: Implementar `client.ts`**

`packages/mcp-behavior/src/client.ts`:

```ts
import { BigQuery } from '@google-cloud/bigquery';

/**
 * O nome do dataset entra na SQL por interpolação — o BigQuery não aceita
 * parâmetro em nome de tabela. Por isso ele é validado contra uma allowlist de
 * caracteres: sem isso, um dataset malicioso vindo do banco viraria injeção.
 */
const DATASET_PATTERN = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)?$/;

export function assertDatasetName(name: string): string {
  if (!DATASET_PATTERN.test(name)) {
    throw new Error(`dataset inválido: "${name}" (esperado [projeto.]dataset alfanumérico)`);
  }
  return name;
}

export class BigQueryEventsClient {
  constructor(private readonly bigquery: BigQuery) {}

  static fromCredentialsJson(credentialsJson: string): BigQueryEventsClient {
    const credentials = JSON.parse(credentialsJson) as {
      project_id: string; client_email: string; private_key: string;
    };
    return new BigQueryEventsClient(new BigQuery({
      projectId: credentials.project_id,
      credentials,
    }));
  }

  async query<T>(sql: string, params: Record<string, unknown>): Promise<T[]> {
    const [rows] = await this.bigquery.query({
      query: sql,
      params,
      // Teto de custo por consulta: o export do GA4 cresce rápido e uma query
      // sem filtro de partição pode varrer terabytes.
      maximumBytesBilled: String(20 * 1024 ** 3),
      useLegacySql: false,
    });
    return rows as T[];
  }
}

/** `2026-02-01` → `20260201`, o sufixo das tabelas `events_*` do GA4. */
export function toCompactDate(isoDate: string): string {
  return isoDate.replace(/-/g, '');
}
```

- [ ] **Step 4: Implementar `purchase-path.ts`**

`packages/mcp-behavior/src/purchase-path.ts`:

```ts
import { z } from 'zod';
import { IsoDateSchema, TenantContextSchema } from '@center/shared';
import type { AnalysisTool } from '@center/mcp-core';
import { assertDatasetName, toCompactDate } from './client.js';
import type { BigQueryEventsClientLike } from './interface.js';

const DEFAULT_LOOKBACK = 10;

/**
 * Para cada usuário que comprou, olha os N eventos imediatamente anteriores à
 * primeira compra e conta com que frequência cada tipo de evento aparece.
 *
 * `_TABLE_SUFFIX BETWEEN` é obrigatório: sem ele o BigQuery varre todo o
 * histórico do export, o que é lento e caro.
 */
export function buildPurchasePathSql(params: { dataset: string; lookback: number }): string {
  const dataset = assertDatasetName(params.dataset);
  const lookback = Math.trunc(params.lookback);

  return `
    WITH events AS (
      SELECT
        user_pseudo_id,
        event_name,
        event_timestamp
      FROM \`${dataset}.events_*\`
      WHERE _TABLE_SUFFIX BETWEEN @fromCompact AND @toCompact
    ),
    first_purchase AS (
      SELECT user_pseudo_id, MIN(event_timestamp) AS purchase_ts
      FROM events
      WHERE event_name = 'purchase'
      GROUP BY user_pseudo_id
    ),
    preceding AS (
      SELECT
        e.user_pseudo_id,
        e.event_name,
        ROW_NUMBER() OVER (
          PARTITION BY e.user_pseudo_id ORDER BY e.event_timestamp DESC
        ) AS position
      FROM events e
      JOIN first_purchase p USING (user_pseudo_id)
      WHERE e.event_timestamp < p.purchase_ts
    )
    SELECT
      event_name,
      COUNT(DISTINCT user_pseudo_id) AS users,
      (SELECT COUNT(*) FROM first_purchase) AS purchases,
      AVG(position) AS avg_position
    FROM preceding
    WHERE position <= ${lookback}
    GROUP BY event_name
    ORDER BY users DESC
    LIMIT 50
  `;
}

interface PurchasePathRow {
  event_name: string;
  users: number | bigint;
  purchases: number | bigint;
  avg_position: number;
}

export function createEventsBeforePurchaseTool(client: BigQueryEventsClientLike): AnalysisTool {
  const InputSchema = z.object({
    from: IsoDateSchema,
    to: IsoDateSchema,
    tenant: TenantContextSchema,
    eventosAnteriores: z.number().int().min(1).max(50).default(DEFAULT_LOOKBACK),
  });

  return {
    name: 'events_before_purchase',
    description:
      'Eventos que mais aparecem imediatamente antes de uma compra, com a frequência entre os ' +
      'compradores e a posição média na sequência. Use para "quais eventos antecedem uma compra". ' +
      'Frequência de 0 a 1: 0,95 significa que 95% dos compradores dispararam aquele evento antes.',
    inputSchema: {
      from: IsoDateSchema, to: IsoDateSchema, tenant: TenantContextSchema,
      eventosAnteriores: z.number().optional(),
    },
    outputSchema: {
      from: z.string(), to: z.string(),
      totalPurchases: z.number(),
      events: z.array(z.object({
        evento: z.string(), usuarios: z.number(),
        frequencia: z.number(), posicaoMedia: z.number(),
      })),
    },
    handler: async (args) => {
      const { from, to, tenant, eventosAnteriores } = InputSchema.parse(args);

      const dataset = tenant.externalIds.ga4BigQueryDataset;
      if (!dataset) {
        throw new Error(
          `ga4BigQueryDataset não configurado para a organização "${tenant.organizationId}"`,
        );
      }

      const rows = await client.query<PurchasePathRow>(
        buildPurchasePathSql({ dataset, lookback: eventosAnteriores }),
        { fromCompact: toCompactDate(from), toCompact: toCompactDate(to) },
      );

      const totalPurchases = Number(rows[0]?.purchases ?? 0);

      return {
        from, to, totalPurchases,
        events: rows
          .map((row) => ({
            evento: row.event_name,
            usuarios: Number(row.users),
            frequencia: totalPurchases === 0 ? 0 : Number(row.users) / totalPurchases,
            posicaoMedia: Number(row.avg_position),
          }))
          .sort((a, b) => b.frequencia - a.frequencia),
      };
    },
  };
}
```

- [ ] **Step 5: Rodar os testes**

Run: `pnpm --filter @center/mcp-behavior test`
Expected: PASS — 15 testes.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-behavior
git commit -m "feat(mcp-behavior): add BigQuery client and purchase path analysis"
```

---

### Task 36B: Cliente mock e fixtures do BigQuery

**Files:**
- Create: `packages/mcp-behavior/src/interface.ts`
- Modify: `packages/mcp-behavior/src/client.ts` (implementa a interface extraída)
- Create: `packages/mcp-behavior/src/mock-client.ts`
- Test: `packages/mcp-behavior/src/__tests__/mock-client.test.ts`

**Interfaces:**
- Consumes: nada externo além do que a T36 já define.
- Produces:
  - `interface BigQueryEventsClientLike { query<T>(sql: string, params: Record<string, unknown>): Promise<T[]> }`
  - `FIXTURE_PURCHASE_PATH_ROWS`, `FIXTURE_SCREEN_IMPACT_ROWS`
  - `class MockBigQueryEventsClient implements BigQueryEventsClientLike`

**Como o mock decide qual fixture devolver:** ao contrário do mock do GA4 (T17B), que gera valores a partir de qualquer combinação de parâmetros, aqui só existem duas consultas possíveis no sistema inteiro (T36 e T37) — não vale a pena um gerador genérico. O mock **inspeciona a forma dos parâmetros nomeados**: só `screen_abandon_impact` (T37) envia `screenName`, então a presença dessa chave basta para escolher a fixture certa. Se uma terceira consulta for adicionada depois, este `if` cresce em um branch — não em complexidade.

- [ ] **Step 1: Extrair a interface e declarar o cliente real**

`packages/mcp-behavior/src/interface.ts`:

```ts
export interface BigQueryEventsClientLike {
  query<T>(sql: string, params: Record<string, unknown>): Promise<T[]>;
}
```

Em `packages/mcp-behavior/src/client.ts` (T36), adicione o import e a cláusula `implements`:

```ts
import type { BigQueryEventsClientLike } from './interface.js';
```

```ts
export class BigQueryEventsClient implements BigQueryEventsClientLike {
```

- [ ] **Step 2: Escrever o teste (falhando)**

`packages/mcp-behavior/src/__tests__/mock-client.test.ts`:

```ts
import {
  FIXTURE_PURCHASE_PATH_ROWS, FIXTURE_SCREEN_IMPACT_ROWS, MockBigQueryEventsClient,
} from '../mock-client.js';

describe('MockBigQueryEventsClient', () => {
  it('returns the screen impact fixture when screenName is among the params', async () => {
    const rows = await new MockBigQueryEventsClient().query('SELECT 1', {
      screenName: 'Checkout', fromCompact: '20260201', toCompact: '20260228',
    });
    expect(rows).toEqual(FIXTURE_SCREEN_IMPACT_ROWS);
  });

  it('returns the purchase path fixture otherwise', async () => {
    const rows = await new MockBigQueryEventsClient().query('SELECT 1', {
      fromCompact: '20260201', toCompact: '20260228',
    });
    expect(rows).toEqual(FIXTURE_PURCHASE_PATH_ROWS);
  });

  it('never touches the network — resolves synchronously fast', async () => {
    const startedAt = Date.now();
    await new MockBigQueryEventsClient().query('SELECT 1', {});
    expect(Date.now() - startedAt).toBeLessThan(50);
  });
});

describe('fixture shape', () => {
  it('purchase path fixture has a consistent purchases total across rows', () => {
    const totals = new Set(FIXTURE_PURCHASE_PATH_ROWS.map((row) => row.purchases));
    expect(totals.size).toBe(1);
  });

  it('screen impact fixture has exactly the two cohorts', () => {
    expect(FIXTURE_SCREEN_IMPACT_ROWS.map((row) => row.saw_screen).sort()).toEqual([false, true]);
  });
});
```

- [ ] **Step 3: Implementar `mock-client.ts`**

`packages/mcp-behavior/src/mock-client.ts`:

```ts
import type { BigQueryEventsClientLike } from './interface.js';

/** Fixture de `events_before_purchase` (T36) — mesmo total de compras em toda linha. */
export const FIXTURE_PURCHASE_PATH_ROWS = [
  { event_name: 'page_view', users: 500, purchases: 500, avg_position: 5.6 },
  { event_name: 'view_item', users: 480, purchases: 500, avg_position: 3.2 },
  { event_name: 'add_to_cart', users: 410, purchases: 500, avg_position: 2.1 },
  { event_name: 'begin_checkout', users: 350, purchases: 500, avg_position: 1.4 },
  { event_name: 'add_payment_info', users: 320, purchases: 500, avg_position: 1.1 },
];

/** Fixture de `screen_abandon_impact` (T37) — quem viu a tela compra menos. */
export const FIXTURE_SCREEN_IMPACT_ROWS = [
  { saw_screen: true, users: 300, buyers: 45 },
  { saw_screen: false, users: 700, buyers: 210 },
];

/**
 * Nunca toca o BigQuery. Existem só duas consultas no sistema inteiro (T36,
 * T37) — decidir qual fixture devolver pela presença de `screenName` nos
 * parâmetros nomeados é mais simples e mais direto do que interpretar SQL.
 */
export class MockBigQueryEventsClient implements BigQueryEventsClientLike {
  async query<T>(_sql: string, params: Record<string, unknown>): Promise<T[]> {
    if ('screenName' in params) {
      return FIXTURE_SCREEN_IMPACT_ROWS as unknown as T[];
    }
    return FIXTURE_PURCHASE_PATH_ROWS as unknown as T[];
  }
}
```

- [ ] **Step 4: Rodar os testes**

Run: `pnpm --filter @center/mcp-behavior test`
Expected: PASS — 5 testes novos.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-behavior
git commit -m "feat(mcp-behavior): add mock BigQuery client for credential-free dev"
```

---

### Task 37: Impacto do abandono de tela

**Files:**
- Create: `packages/mcp-behavior/src/{screen-impact.ts,main.ts}`
- Test: `packages/mcp-behavior/src/__tests__/screen-impact.test.ts`

**Interfaces:**
- Consumes: `BigQueryEventsClientLike` (T36B), `assertDatasetName`, `toCompactDate` (T36).
- Produces:
  - `buildScreenImpactSql(params: { dataset: string }): string`
  - `createScreenAbandonImpactTool(client): AnalysisTool` — `screen_abandon_impact`
  - `main.ts`: MCP server `center-behavior`

**Responde:** E2.

**O que a ferramenta afirma e o que não afirma:** ela compara a taxa de compra de quem *viu* a tela X sem prosseguir com a de quem *não viu* a tela. Isso é uma diferença observada, não um efeito causal — a ferramenta devolve a ressalva junto, e o prompt do agente obriga a repeti-la.

- [ ] **Step 1: Escrever o teste (falhando)**

`packages/mcp-behavior/src/__tests__/screen-impact.test.ts`:

```ts
import { buildScreenImpactSql, createScreenAbandonImpactTool } from '../screen-impact.js';
import type { BigQueryEventsClientLike } from '../interface.js';

function fakeClient(rows: unknown[]) {
  const query = jest.fn(async () => rows);
  return { client: { query } as unknown as BigQueryEventsClientLike, query };
}

const tenant = {
  organizationId: 'org_1', externalIds: { ga4BigQueryDataset: 'analytics_123456' },
};

const input = { from: '2026-02-01', to: '2026-02-28', tenant, tela: 'Checkout' };

describe('buildScreenImpactSql', () => {
  it('reads from the events_* wildcard table of the dataset', () => {
    expect(buildScreenImpactSql({ dataset: 'analytics_123456' }))
      .toContain('`analytics_123456.events_*`');
  });

  it('filters the partition to keep the scan cheap', () => {
    expect(buildScreenImpactSql({ dataset: 'analytics_123456' }))
      .toContain('_TABLE_SUFFIX BETWEEN @fromCompact AND @toCompact');
  });

  it('passes the screen name as a named parameter, never interpolated', () => {
    const sql = buildScreenImpactSql({ dataset: 'analytics_123456' });
    expect(sql).toContain('@screenName');
    expect(sql).not.toContain('Checkout');
  });

  it('rejects a dataset with a backtick', () => {
    expect(() => buildScreenImpactSql({ dataset: 'x`; DROP TABLE y; --' })).toThrow('dataset inválido');
  });
});

describe('screen_abandon_impact', () => {
  it('sends the screen name and compact dates as parameters', async () => {
    const { client, query } = fakeClient([{ saw_screen: true, users: 100, buyers: 5 }]);
    await createScreenAbandonImpactTool(client).handler(input);
    expect(query.mock.calls[0]![1]).toMatchObject({
      screenName: 'Checkout', fromCompact: '20260201', toCompact: '20260228',
    });
  });

  it('computes the purchase rate for each cohort', async () => {
    const { client } = fakeClient([
      { saw_screen: true, users: 1000, buyers: 50 },
      { saw_screen: false, users: 500, buyers: 100 },
    ]);
    const result = await createScreenAbandonImpactTool(client).handler(input) as Record<string, unknown>;
    expect(result).toMatchObject({
      tela: 'Checkout',
      viramATela: { usuarios: 1000, compradores: 50 },
      naoViramATela: { usuarios: 500, compradores: 100 },
    });
    expect((result.viramATela as { taxaDeCompra: number }).taxaDeCompra).toBeCloseTo(0.05, 5);
    expect((result.naoViramATela as { taxaDeCompra: number }).taxaDeCompra).toBeCloseTo(0.2, 5);
  });

  it('reports the difference in percentage points', async () => {
    const { client } = fakeClient([
      { saw_screen: true, users: 1000, buyers: 50 },
      { saw_screen: false, users: 500, buyers: 100 },
    ]);
    const result = await createScreenAbandonImpactTool(client).handler(input) as { diferenca: number };
    expect(result.diferenca).toBeCloseTo(-0.15, 5);
  });

  it('does not divide by zero for an empty cohort', async () => {
    const { client } = fakeClient([{ saw_screen: true, users: 0, buyers: 0 }]);
    const result = await createScreenAbandonImpactTool(client).handler(input) as Record<string, unknown>;
    expect((result.viramATela as { taxaDeCompra: number }).taxaDeCompra).toBe(0);
    expect((result.naoViramATela as { taxaDeCompra: number }).taxaDeCompra).toBe(0);
  });

  it('always carries the causality caveat', async () => {
    const { client } = fakeClient([{ saw_screen: true, users: 10, buyers: 1 }]);
    const result = await createScreenAbandonImpactTool(client).handler(input) as { ressalva: string };
    expect(result.ressalva).toMatch(/não (implica|prova) causa/i);
  });

  it('refuses when the tenant has no BigQuery dataset configured', async () => {
    const { client } = fakeClient([]);
    await expect(createScreenAbandonImpactTool(client).handler({
      ...input, tenant: { organizationId: 'org_1', externalIds: {} },
    })).rejects.toThrow('ga4BigQueryDataset não configurado');
  });

  it('exposes no user identifier in the response', async () => {
    const { client } = fakeClient([{ saw_screen: true, users: 10, buyers: 1 }]);
    const result = await createScreenAbandonImpactTool(client).handler(input);
    expect(JSON.stringify(result)).not.toMatch(/user_pseudo_id|pseudo/i);
  });
});
```

- [ ] **Step 2: Implementar `screen-impact.ts`**

`packages/mcp-behavior/src/screen-impact.ts`:

```ts
import { z } from 'zod';
import { IsoDateSchema, TenantContextSchema } from '@center/shared';
import type { AnalysisTool } from '@center/mcp-core';
import { assertDatasetName, toCompactDate } from './client.js';
import type { BigQueryEventsClientLike } from './interface.js';

const CAVEAT =
  'Correlação não implica causa. A diferença mostra que os dois grupos se comportam de forma '
  + 'distinta, não que a tela causa a queda — quem chega nela pode já ter uma intenção de compra '
  + 'diferente do resto.';

/**
 * Divide os usuários do período em dois grupos — quem passou pela tela e quem
 * não passou — e compara a taxa de compra de cada um.
 *
 * O nome da tela vai como parâmetro nomeado; só o dataset é interpolado, e ele
 * passa por `assertDatasetName`.
 */
export function buildScreenImpactSql(params: { dataset: string }): string {
  const dataset = assertDatasetName(params.dataset);

  return `
    WITH events AS (
      SELECT
        user_pseudo_id,
        event_name,
        (SELECT value.string_value FROM UNNEST(event_params)
         WHERE key IN ('firebase_screen', 'screen_name', 'page_title')) AS screen
      FROM \`${dataset}.events_*\`
      WHERE _TABLE_SUFFIX BETWEEN @fromCompact AND @toCompact
    ),
    per_user AS (
      SELECT
        user_pseudo_id,
        LOGICAL_OR(screen = @screenName) AS saw_screen,
        LOGICAL_OR(event_name = 'purchase') AS bought
      FROM events
      GROUP BY user_pseudo_id
    )
    SELECT
      saw_screen,
      COUNT(*) AS users,
      COUNTIF(bought) AS buyers
    FROM per_user
    GROUP BY saw_screen
  `;
}

interface ScreenImpactRow {
  saw_screen: boolean;
  users: number | bigint;
  buyers: number | bigint;
}

export function createScreenAbandonImpactTool(client: BigQueryEventsClientLike): AnalysisTool {
  const InputSchema = z.object({
    from: IsoDateSchema,
    to: IsoDateSchema,
    tenant: TenantContextSchema,
    tela: z.string().min(1),
  });

  return {
    name: 'screen_abandon_impact',
    description:
      'Compara a taxa de compra de quem passou por uma tela específica com a de quem não passou. ' +
      'Use para "usuários que abandonam a tela X compram menos?". Informe o nome da tela em "tela". ' +
      'SEMPRE repita a ressalva de que correlação não prova causa.',
    inputSchema: {
      from: IsoDateSchema, to: IsoDateSchema, tenant: TenantContextSchema, tela: z.string(),
    },
    outputSchema: {
      tela: z.string(), from: z.string(), to: z.string(),
      viramATela: z.object({ usuarios: z.number(), compradores: z.number(), taxaDeCompra: z.number() }),
      naoViramATela: z.object({ usuarios: z.number(), compradores: z.number(), taxaDeCompra: z.number() }),
      diferenca: z.number(),
      ressalva: z.string(),
    },
    handler: async (args) => {
      const { from, to, tenant, tela } = InputSchema.parse(args);

      const dataset = tenant.externalIds.ga4BigQueryDataset;
      if (!dataset) {
        throw new Error(`ga4BigQueryDataset não configurado para a organização "${tenant.organizationId}"`);
      }

      const rows = await client.query<ScreenImpactRow>(
        buildScreenImpactSql({ dataset }),
        { screenName: tela, fromCompact: toCompactDate(from), toCompact: toCompactDate(to) },
      );

      const cohort = (sawScreen: boolean) => {
        const row = rows.find((item) => item.saw_screen === sawScreen);
        const usuarios = Number(row?.users ?? 0);
        const compradores = Number(row?.buyers ?? 0);
        return {
          usuarios, compradores,
          taxaDeCompra: usuarios === 0 ? 0 : compradores / usuarios,
        };
      };

      const saw = cohort(true);
      const didNotSee = cohort(false);

      return {
        tela, from, to,
        viramATela: saw,
        naoViramATela: didNotSee,
        // Diferença em pontos percentuais, no sentido "quem viu menos quem não viu".
        diferenca: saw.taxaDeCompra - didNotSee.taxaDeCompra,
        ressalva: CAVEAT,
      };
    },
  };
}
```

- [ ] **Step 3: Implementar `main.ts`**

`packages/mcp-behavior/src/main.ts`:

```ts
import { createMetricServer, startStdio } from '@center/mcp-core';
import { BigQueryEventsClient } from './client.js';
import { MockBigQueryEventsClient } from './mock-client.js';
import type { BigQueryEventsClientLike } from './interface.js';
import { createEventsBeforePurchaseTool } from './purchase-path.js';
import { createScreenAbandonImpactTool } from './screen-impact.js';

// MOCK_EXTERNAL_APIS=true (T4, T36B) roda contra as duas fixtures fixas —
// sem export do GA4 para BigQuery configurado.
let client: BigQueryEventsClientLike;
if (process.env.MOCK_EXTERNAL_APIS === 'true') {
  client = new MockBigQueryEventsClient();
} else {
  const credentialsJson = process.env.GA4_CREDENTIALS_JSON;
  if (!credentialsJson) {
    console.error('mcp-behavior: GA4_CREDENTIALS_JSON é obrigatório (service account com acesso ao BigQuery)');
    process.exit(1);
  }
  client = BigQueryEventsClient.fromCredentialsJson(credentialsJson);
}

// Servidor só de ferramentas: não expõe `query_metric` porque não há série
// temporal aqui — as duas perguntas são de coorte, não de evolução no tempo.
await startStdio(
  createMetricServer({
    name: 'center-behavior',
    version: '1.0.0',
    tools: [
      createEventsBeforePurchaseTool(client),
      createScreenAbandonImpactTool(client),
    ],
  }),
);
```

Registre o servidor em `apps/api/src/main.ts` e `apps/api/src/whatsapp/worker-main.ts`, acrescentando ao array `mcpServers`:

```ts
  {
    source: 'behavior',
    command: process.execPath,
    args: ['../../packages/mcp-behavior/dist/main.js'],
    env: { GA4_CREDENTIALS_JSON: config.ga4CredentialsJson, MOCK_EXTERNAL_APIS: String(config.mockExternalApis) },
  },
```

E acrescente as duas ferramentas ao catálogo do agente, em `apps/api/src/agent/tools.ts`, dentro de `RANKINGS`? **Não** — elas não são rankings. Registre-as como ferramentas próprias, adicionando ao objeto devolvido por `buildAgentTools`:

```ts
    caminho_ate_a_compra: tool({
      description:
        'Eventos que mais aparecem antes de uma compra, com a frequência entre os compradores. ' +
        'Use para "quais eventos antecedem uma compra".',
      inputSchema: z.object(PeriodShape),
      execute: instrument(context, 'caminho_ate_a_compra', async (input) => {
        const window = resolveWindow(input, today);
        return gateway.callTool<Record<string, unknown>>(
          'behavior', 'events_before_purchase',
          { from: window.from, to: window.to, tenant },
          { rangeEnd: window.to },
        );
      }),
    }),

    impacto_da_tela: tool({
      description:
        'Compara a taxa de compra de quem passou por uma tela com a de quem não passou. Use para ' +
        '"usuários que abandonam a tela X compram menos". SEMPRE repita a ressalva sobre causa.',
      inputSchema: z.object({ tela: z.string().describe('nome da tela ou página'), ...PeriodShape }),
      execute: instrument(context, 'impacto_da_tela', async (input) => {
        const window = resolveWindow(input, today);
        return gateway.callTool<Record<string, unknown>>(
          'behavior', 'screen_abandon_impact',
          { from: window.from, to: window.to, tela: input.tela, tenant },
          { rangeEnd: window.to },
        );
      }),
    }),
```

- [ ] **Step 4: Rodar os testes e o smoke test**

Run: `pnpm --filter @center/mcp-behavior test`
Expected: PASS — 24 testes.

```bash
pnpm --filter @center/mcp-behavior build
GA4_CREDENTIALS_JSON="$(cat ./ga4-service-account.json)" \
  npx @modelcontextprotocol/inspector node packages/mcp-behavior/dist/main.js
```

Chame `events_before_purchase` sobre os últimos 30 dias. Confirme:
- `totalPurchases` é próximo do total de conversões que o GA4 reporta no mesmo período.
- `view_item` e `add_to_cart` aparecem no topo — se não aparecerem, ou a loja não dispara os eventos de e-commerce, ou o dataset está errado.
- A consulta não estourou o teto de bytes. Se estourar, reduza o período ou verifique se o filtro `_TABLE_SUFFIX` sobreviveu a alguma edição.

**Validação cruzada opcional (recomendada uma vez):** o `user_pseudo_id` do tráfego **web** é o mesmo `client_id` que hasheamos na T9. Rodar `SELECT COUNT(*) FROM "CommerceOrder" WHERE "visitorHash" IS NOT NULL` e comparar com o número de compradores web do BigQuery mostra a taxa de casamento da atribuição. Divergência grande indica que os campos ocultos do checkout (T9) não estão sendo enviados. Para tráfego de **app**, `user_pseudo_id` é o `app_instance_id` e **não** casa com o `client_id` — não espere correspondência ali.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-behavior apps/api
git commit -m "feat(mcp-behavior): add screen abandon impact and wire the behavior MCP server"
```

---

# FASE 9 — Operação (Sprint 11)

### Task 38: Integração contínua, aquecimento de cache e monitoramento

**Files:**
- Create: `.github/workflows/ci.yml`, `apps/api/scripts/warm-cache.ts`, `apps/api/scripts/health-report.ts`
- Modify: `apps/api/package.json` (scripts)

**Interfaces:**
- Consumes: scripts `build`, `test`, `typecheck` de todos os pacotes.
- Produces: pipeline em todo push e PR; `pnpm --filter @center/api warm:cache`; `pnpm --filter @center/api health:report`.

- [ ] **Step 1: Escrever o workflow**

`.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push: { branches: [main] }
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: center
          POSTGRES_PASSWORD: center
          POSTGRES_DB: center_test
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U center" --health-interval 5s --health-retries 10
      redis:
        image: redis:7-alpine
        ports: ['6379:6379']
        options: >-
          --health-cmd "redis-cli ping" --health-interval 5s --health-retries 10

    env:
      DATABASE_URL: postgresql://center:center@localhost:5432/center_test?schema=public
      REDIS_URL: redis://localhost:6379

    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9.15.0 }
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @center/api exec prisma generate
      # mcp-commerce roda contra o Postgres real; a migração precisa vir antes.
      - run: pnpm --filter @center/api exec prisma migrate deploy
      - run: pnpm build
      - run: pnpm typecheck
      - run: pnpm test
```

- [ ] **Step 2: Escrever o script de aquecimento de cache**

O primeiro acesso da manhã pagaria o custo de consultar o GA4 ao vivo — 3 a 8 segundos. Este script paga esse custo às 5h.

`apps/api/scripts/warm-cache.ts`:

```ts
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { McpPool, MetricGateway, RedisCacheStore, type McpServerConfig } from '@center/mcp-core';
import type { Granularity, MetricQuery } from '@center/shared';
import { loadConfig } from '../src/config.js';
import { resolveTenant } from '../src/tenant.js';

/** Exatamente as métricas dos KPIs da Visão geral. */
const HEADLINE_METRIC_IDS = [
  'commerce.revenue', 'commerce.orders', 'commerce.average_ticket',
  'commerce.new_customers', 'ga4.sessions', 'ga4.active_users',
];

const config = loadConfig(process.env);
const prisma = new PrismaClient();
const redis = new Redis(config.redisUrl);

const mcpServers: McpServerConfig[] = [
  { source: 'commerce', command: process.execPath, args: ['../../packages/mcp-commerce/dist/main.js'],
    // UAPPI_BASE_URL habilita out_of_stock_products (T15) condicionalmente — o
    // servidor só a registra se a variável existir, sem precisar de credencial fixa.
    env: { DATABASE_URL: config.databaseUrl, UAPPI_BASE_URL: config.uappiBaseUrl,
      CREDENTIALS_ENCRYPTION_KEY: config.credentialsEncryptionKey } },
  { source: 'ga4', command: process.execPath, args: ['../../packages/mcp-ga4/dist/main.js'],
    env: { GA4_CREDENTIALS_JSON: config.ga4CredentialsJson, MOCK_EXTERNAL_APIS: String(config.mockExternalApis) } },
];

const pool = await McpPool.spawn(mcpServers);
const gateway = new MetricGateway(pool, new RedisCacheStore(redis));

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
function shift(days: number): string {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Exatamente os intervalos que os presets do PeriodPicker produzem.
const RANGES: Array<{ from: string; to: string; granularity: Granularity }> = [
  { from: today, to: today, granularity: 'day' },
  { from: shift(-6), to: today, granularity: 'day' },
  { from: shift(-29), to: today, granularity: 'day' },
  { from: shift(-89), to: today, granularity: 'week' },
];

const organizations = await prisma.organization.findMany({ select: { id: true } });
let warmed = 0;
let failed = 0;

for (const organization of organizations) {
  const tenant = await resolveTenant(prisma, organization.id);
  const queries: MetricQuery[] = RANGES.flatMap((range) =>
    HEADLINE_METRIC_IDS.map((metricId) => ({ metricId, ...range, tenant })));

  for (const query of queries) {
    try {
      await gateway.queryMetric(query);
      warmed += 1;
    } catch (error) {
      failed += 1;
      console.error(`falhou ${query.metricId} (${organization.id}):`, (error as Error).message);
    }
  }
}

console.log(`cache aquecido: ${warmed} consultas, ${failed} falhas`);
await gateway.close();
await prisma.$disconnect();
redis.disconnect();
```

- [ ] **Step 3: Escrever o relatório de saúde**

O sinal mais importante do sistema é: **o sync está rodando?** Se ele parar, a dashboard e o bot continuam respondendo — com dados velhos, e sem avisar ninguém. Este script torna isso visível.

`apps/api/scripts/health-report.ts`:

```ts
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { loadConfig } from '../src/config.js';

const STALE_SYNC_MINUTES = 90;
const QUEUE_DEPTH_ALARM = 50;

const config = loadConfig(process.env);
const prisma = new PrismaClient();
const redis = new Redis(config.redisUrl);

const problems: string[] = [];

// Primeiro de todos: o modo mock não quebra nada visivelmente, ele só serve
// dados inventados em silêncio. Se estiver ligado, nenhum outro sinal importa.
if (config.mockExternalApis) {
  problems.push('MOCK_EXTERNAL_APIS está ligado — os dados servidos são fixtures, não reais');
}

const syncStates = await prisma.syncState.findMany({
  include: { organization: { select: { name: true } } },
});

for (const state of syncStates) {
  if (state.lastError) {
    problems.push(`sync de "${state.organization.name}" com erro: ${state.lastError}`);
  }
  if (!state.lastSyncedAt) {
    problems.push(`sync de "${state.organization.name}" nunca rodou`);
    continue;
  }
  const minutesAgo = (Date.now() - state.lastSyncedAt.getTime()) / 60_000;
  if (minutesAgo > STALE_SYNC_MINUTES) {
    problems.push(
      `sync de "${state.organization.name}" parado há ${Math.round(minutesAgo)} minutos`,
    );
  }
}

// Fila crescendo = worker morto. Passando de 24h, o envio começa a falhar com
// o erro 131047 da Meta (fora da janela de resposta).
const waiting = await redis.llen('bull:whatsapp-inbound:wait');
if (waiting > QUEUE_DEPTH_ALARM) {
  problems.push(`fila do WhatsApp com ${waiting} mensagens aguardando`);
}

const since = new Date(Date.now() - 60 * 60_000);
const toolStats = await prisma.toolCallLog.groupBy({
  by: ['success'],
  where: { createdAt: { gte: since } },
  _count: true,
});
const failures = toolStats.find((row) => row.success === false)?._count ?? 0;
const total = toolStats.reduce((acc, row) => acc + row._count, 0);
if (total > 0 && failures / total > 0.2) {
  problems.push(`${failures} de ${total} chamadas de ferramenta falharam na última hora`);
}

if (problems.length === 0) {
  console.log('tudo saudável');
} else {
  console.error('PROBLEMAS DETECTADOS:');
  for (const problem of problems) console.error(` - ${problem}`);
}

await prisma.$disconnect();
redis.disconnect();
// Saída não-zero permite que o cron dispare alerta sem parser de log.
process.exit(problems.length === 0 ? 0 : 1);
```

Adicione ao `scripts` de `apps/api/package.json`:

```json
  "warm:cache": "node dist/scripts/warm-cache.js",
  "health:report": "node dist/scripts/health-report.js"
```

- [ ] **Step 4: Rodar e agendar**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add build, typecheck and test pipeline"
git push
```

Expected: pipeline verde.

```bash
pnpm build
cd apps/api && node dist/scripts/warm-cache.js && node dist/scripts/health-report.js
```

Expected: contagem de consultas aquecidas com zero falhas, e `tudo saudável`.

Agende no cron (America/Sao_Paulo):

```
0 5 * * *  cd /srv/center/apps/api && /usr/bin/node dist/scripts/warm-cache.js   >> /var/log/center-warm.log 2>&1
*/30 * * * * cd /srv/center/apps/api && /usr/bin/node dist/scripts/health-report.js >> /var/log/center-health.log 2>&1
```

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(ops): add cache warmup and sync health report scripts"
```

---

### Task 38B: Suíte de regressão de dinheiro em centavos

**Files:**
- Create: `packages/shared/src/__tests__/money-contract.test.ts`
- Create: `packages/mcp-commerce/src/__tests__/money-contract.test.ts`
- Create: `apps/web/src/__tests__/money-contract.test.tsx`
- Create: `apps/api/src/__tests__/money-contract.test.ts`

**Interfaces:**
- Consumes: `toCents`/`fromCents`/`sumCents` (T2), `mapOrder` (T7), `createCommerceProvider` (T12), `formatMetricValue` (T25), `buildSystemPrompt` (T31), `buildAgentTools` (T30).
- Produces: nenhuma API nova. Esta task só adiciona testes.

**Por que uma task inteira só de testes, e por que ela existe separada.** O Risco R7 (erro de fator 100) tem alta probabilidade e alto dano: um único ponto que esqueça de dividir por 100 reporta R$ 480.000,00 onde são R$ 4.800,00, e ninguém percebe sem conferir à mão. As tasks anteriores já testam cada componente isoladamente — o que falta é uma suíte que verifique a **regra atravessando as camadas**: um valor entra pela Uappi como `4800.00`, vira `480000` no banco, atravessa o MCP, a API e o agente ainda como `480000`, e só volta a ser `R$ 4.800,00` na formatação final.

**O modelo é o teste de dinheiro da T2** (`money.test.ts`), que verifica a propriedade e não a implementação: `sumCents([toCents('0.10'), toCents('0.20')])` é `30`, não `0.30000000000000004`. Cada arquivo abaixo aplica o mesmo formato à sua camada. Todos usam **o mesmo valor canônico** — `4800.00` reais / `480000` centavos — para que uma falha aponte a camada exata onde o fator se perdeu.

**Onde esta task entra no cronograma:** no Sprint 11, junto do resto da Fase 9, mas ela pode ser antecipada a qualquer momento depois da T31 — não depende de nada que só exista no fim.

- [ ] **Step 1: Contrato de centavos na camada de tipos**

`packages/shared/src/__tests__/money-contract.test.ts`:

```ts
import { fromCents, sumCents, toCents } from '../money.js';
import { MetricSeriesSchema } from '../metrics.js';

/** O valor canônico de toda esta suíte: R$ 4.800,00. */
const REAIS = '4800.00';
const CENTS = 480000;

describe('contrato de centavos — conversão', () => {
  it('converts the canonical value in both directions', () => {
    expect(toCents(REAIS)).toBe(CENTS);
    expect(fromCents(CENTS)).toBe(REAIS);
  });

  it('round-trips without drift across 1000 sequential values', () => {
    // Um erro de arredondamento de 1 centavo por pedido vira R$ 10,00 a cada
    // mil pedidos — invisível numa amostra, indefensável num fechamento.
    for (let cents = 0; cents < 1000; cents += 1) {
      expect(toCents(fromCents(cents))).toBe(cents);
    }
  });

  it('sums a thousand values of R$ 0,01 to exactly R$ 10,00', () => {
    const values = Array.from({ length: 1000 }, () => toCents('0.01'));
    expect(sumCents(values)).toBe(1000);
    expect(fromCents(sumCents(values))).toBe('10.00');
  });

  it('never produces a fractional cent from any input shape', () => {
    for (const input of [REAIS, '4.800,00', 4800, '0.005', '0.004', '-15.50']) {
      expect(Number.isInteger(toCents(input))).toBe(true);
    }
  });
});

describe('contrato de centavos — série de métrica', () => {
  it('carries currency values as integers, never as decimals', () => {
    const series = MetricSeriesSchema.parse({
      metricId: 'commerce.revenue', source: 'commerce', unit: 'currency',
      granularity: 'day', total: CENTS,
      points: [{ date: '2026-01-01', value: CENTS }],
    });
    expect(Number.isInteger(series.total)).toBe(true);
    expect(Number.isInteger(series.points[0]!.value)).toBe(true);
    // Se alguém "corrigir" a série para reais, este número deixa de ser inteiro.
    expect(series.total).toBe(CENTS);
  });
});
```

- [ ] **Step 2: Contrato de centavos na ingestão e no read model**

`packages/mcp-commerce/src/__tests__/money-contract.test.ts`:

```ts
import { Pseudonymizer } from '@center/pii';
import { UappiOrderSchema } from '@center/uappi-sync';
import { mapOrder } from '@center/uappi-sync';
import { createCommerceProvider } from '../provider.js';
import { prisma, resetCommerceData, seedOrders, TEST_ORG } from './helpers/seed.js';

const CENTS = 480000;
const tenant = { organizationId: TEST_ORG, externalIds: {} };

describe('contrato de centavos — mapper da Uappi', () => {
  const pseudonymizer = new Pseudonymizer('p'.repeat(32));

  it.each([
    ['número', 4800.0],
    ['string decimal', '4800.00'],
    ['string pt-BR', '4.800,00'],
  ])('maps a total given as %s into 480000 cents', (_label, totalPedido) => {
    const parsed = UappiOrderSchema.parse({
      numeroPedido: 'PED-M1', dataEmissao: '2026-07-15 10:00:00', moeda: 'BRL',
      status: { id: 3, descricao: 'Pagamento aprovado' },
      valores: { subtotal: totalPedido, frete: 0, descontos: 0, totalPedido },
      itens: [], pagamento: [],
    });
    const { order } = mapOrder(parsed, { pseudonymizer });
    expect(order.totalCents).toBe(CENTS);
  });

  it('never lets a float reach the read model', () => {
    const parsed = UappiOrderSchema.parse({
      numeroPedido: 'PED-M2', dataEmissao: '2026-07-15 10:00:00', moeda: 'BRL',
      status: { id: 3, descricao: 'Pagamento aprovado' },
      valores: { subtotal: 0.1, frete: 0.2, descontos: 0, totalPedido: 0.3 },
      itens: [], pagamento: [],
    });
    const { order } = mapOrder(parsed, { pseudonymizer });
    // 0.1 + 0.2 em float é 0.30000000000000004; em centavos é 30.
    expect(order.subtotalCents + order.freightCents).toBe(30);
    expect(Number.isInteger(order.totalCents)).toBe(true);
  });
});

describe('contrato de centavos — provider de métricas', () => {
  beforeAll(async () => {
    await resetCommerceData();
    await seedOrders([
      { numeroPedido: 'C1', emittedAtLocal: '2026-01-10T10:00:00', statusGroup: 'PAID', totalCents: CENTS },
    ]);
  });

  afterAll(async () => { await prisma.$disconnect(); });

  it('returns revenue in cents, matching what was written', async () => {
    const series = await createCommerceProvider(prisma).query({
      metricId: 'commerce.revenue', from: '2026-01-01', to: '2026-01-31',
      granularity: 'month', tenant,
    });
    expect(series.unit).toBe('currency');
    expect(series.total).toBe(CENTS);
    expect(Number.isInteger(series.total)).toBe(true);
  });

  it('returns the average ticket in cents, rounded to a whole cent', async () => {
    const series = await createCommerceProvider(prisma).query({
      metricId: 'commerce.average_ticket', from: '2026-01-01', to: '2026-01-31',
      granularity: 'month', tenant,
    });
    expect(series.total).toBe(CENTS);
    expect(Number.isInteger(series.total)).toBe(true);
  });

  it('declares every currency metric with unit "currency" — the formatter depends on it', () => {
    const provider = createCommerceProvider(prisma);
    for (const id of ['commerce.revenue', 'commerce.average_ticket']) {
      expect(provider.descriptors.find((d) => d.id === id)?.unit).toBe('currency');
    }
  });
});
```

- [ ] **Step 3: Contrato de centavos na formatação do frontend**

`apps/web/src/__tests__/money-contract.test.tsx`:

```tsx
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../test/render.js';
import { formatMetricValue } from '../lib/format.js';
import { KpiCard } from '../components/charts/KpiCard.js';
import { RankingTable } from '../components/charts/RankingTable.js';
import type { RankingResult } from '../lib/api-client.js';

const CENTS = 480000;

/** Sem quebra fina — `Intl` usa U+00A0 entre "R$" e o número. */
function normalize(text: string): string {
  return text.replace(/ /g, ' ');
}

describe('contrato de centavos — formatação', () => {
  it('renders the canonical value as R$ 4.800,00, never R$ 480.000,00', () => {
    expect(normalize(formatMetricValue(CENTS, 'currency'))).toBe('R$ 4.800,00');
  });

  it('does not divide count metrics by 100', () => {
    expect(formatMetricValue(CENTS, 'count')).toBe('480.000');
  });

  it('renders one cent as R$ 0,01', () => {
    expect(normalize(formatMetricValue(1, 'currency'))).toBe('R$ 0,01');
  });
});

describe('contrato de centavos — componentes', () => {
  it('KpiCard divides by 100 exactly once', () => {
    renderWithProviders(<KpiCard label="Faturamento" value={CENTS} unit="currency" />);
    expect(screen.getByText(/4\.800,00/)).toBeInTheDocument();
    expect(screen.queryByText(/480\.000,00/)).not.toBeInTheDocument();
  });

  it('RankingTable divides by 100 exactly once', () => {
    const result: RankingResult = {
      dimension: 'product', from: '2026-01-01', to: '2026-01-31',
      total: CENTS, unit: 'currency',
      rows: [{ key: 'CAM', label: 'Camiseta', value: CENTS, unit: 'currency', extra: {}, share: 1 }],
    };
    renderWithProviders(<RankingTable title="Produtos" result={result} />);
    expect(screen.getByText(/4\.800,00/)).toBeInTheDocument();
    expect(screen.queryByText(/480\.000,00/)).not.toBeInTheDocument();
  });

  it('KpiCard computes the delta on cents, so the percentage is unaffected by the unit', () => {
    // 480000 → 600000 é +25%, exatamente como 4800 → 6000 seria.
    renderWithProviders(
      <KpiCard label="Faturamento" value={600000} previousValue={CENTS} unit="currency" />,
    );
    expect(screen.getByText('+25,0%')).toBeInTheDocument();
  });
});
```

- [ ] **Step 4: Contrato de centavos na camada do agente**

`apps/api/src/__tests__/money-contract.test.ts`:

```ts
import type { MetricGateway } from '@center/mcp-core';
import type { MetricSeries, TenantContext } from '@center/shared';
import { buildAgentTools } from '../agent/tools.js';
import { buildSystemPrompt } from '../agent/agent.js';

const CENTS = 480000;
const tenant: TenantContext = { organizationId: 'org_1', externalIds: {} };

const revenueSeries: MetricSeries = {
  metricId: 'commerce.revenue', source: 'commerce', unit: 'currency', granularity: 'day',
  total: CENTS, points: [{ date: '2026-02-01', value: CENTS }],
};

function buildGateway() {
  return {
    listMetrics: jest.fn(async () => []),
    queryMetric: jest.fn(async () => revenueSeries),
    queryBatch: jest.fn(async () => [revenueSeries]),
    callTool: jest.fn(async () => ({ rows: [], unit: 'currency', total: CENTS })),
  } as unknown as MetricGateway;
}

describe('contrato de centavos — system prompt', () => {
  const prompt = buildSystemPrompt('2026-03-15');

  it('states the unit in capitals so the instruction is hard to skim past', () => {
    expect(prompt).toContain('CENTAVOS');
  });

  it('gives a worked numeric example, not just the rule', () => {
    // A regra sozinha é ignorada com frequência; o exemplo é o que gruda.
    expect(prompt).toMatch(/480000/);
    expect(prompt).toMatch(/4\.800,00/);
  });
});

describe('contrato de centavos — ferramentas do agente', () => {
  const tools = buildAgentTools({ gateway: buildGateway(), tenant, today: '2026-03-15' });

  it('passes the metric total through untouched, still in cents', async () => {
    const result = await tools.consultar_metrica.execute!(
      { metricId: 'commerce.revenue', periodo: 'mês passado' }, {} as never,
    ) as Record<string, unknown>;
    expect(result.total).toBe(CENTS);
  });

  it('attaches an explicit cents warning to every currency result', async () => {
    const result = await tools.consultar_metrica.execute!(
      { metricId: 'commerce.revenue', periodo: 'mês passado' }, {} as never,
    ) as Record<string, string>;
    expect(result.observacao).toMatch(/CENTAVOS/);
  });

  it('does not attach the cents warning to a count result', async () => {
    const gateway = buildGateway();
    (gateway.queryMetric as jest.Mock).mockResolvedValueOnce({
      ...revenueSeries, metricId: 'commerce.orders', unit: 'count', total: 42,
      points: [{ date: '2026-02-01', value: 42 }],
    });
    const countTools = buildAgentTools({ gateway, tenant, today: '2026-03-15' });
    const result = await countTools.consultar_metrica.execute!(
      { metricId: 'commerce.orders', periodo: 'mês passado' }, {} as never,
    ) as Record<string, string>;
    expect(result.observacao).not.toMatch(/CENTAVOS/);
  });

  it('warns about cents in a currency ranking too', async () => {
    const result = await tools.ranking.execute!(
      { tipo: 'campanhas_por_receita', periodo: 'mês passado' }, {} as never,
    ) as Record<string, string>;
    expect(result.observacao).toMatch(/CENTAVOS/);
  });
});
```

- [ ] **Step 5: Ajustar o system prompt para satisfazer o teste do exemplo numérico**

O teste do Step 4 exige que o prompt traga um exemplo numérico concreto. O `buildSystemPrompt` da T31 já tem a regra, mas confirme que a linha do exemplo está exatamente assim (ela já consta na T31 — este passo é uma verificação, não uma mudança):

```
2. VALORES MONETÁRIOS VOLTAM EM CENTAVOS. Divida por 100 antes de citar em reais.
   480000 centavos são R$ 4.800,00, não R$ 480.000,00. Confira antes de responder.
```

Se a linha tiver sido reescrita, restaure o exemplo — é ele que o teste trava.

- [ ] **Step 6: Rodar a suíte inteira**

```bash
docker compose up -d
pnpm build
pnpm test
```

Expected: PASS em todos os pacotes, com 4 suítes novas (~25 testes).

**Se algum destes testes falhar, não ajuste o teste** — ele está expressando a regra correta. Encontre a camada que perdeu o fator e conserte lá. Um teste de contrato "corrigido" para passar é exatamente como o bug de fator 100 entra em produção.

- [ ] **Step 7: Commit**

```bash
git add packages/shared packages/mcp-commerce apps/web apps/api
git commit -m "test: add cross-layer money-in-cents regression contract"
```

---

### Task 39: Empacotamento e deploy em staging

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker-compose.prod.yml`, `docs/deploy.md`

**Interfaces:**
- Consumes: builds de todos os pacotes.
- Produces: uma imagem com API, sync worker, WhatsApp worker e os três MCP servers; `docker compose -f docker-compose.prod.yml up`.

**Decisão:** uma única imagem com quatro entrypoints. Os MCP servers são processos **filhos** de quem os usa, então precisam estar no mesmo sistema de arquivos — não são serviços separados.

- [ ] **Step 1: Escrever o Dockerfile**

`Dockerfile`:

```dockerfile
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/pii/package.json packages/pii/
COPY packages/uappi-client/package.json packages/uappi-client/
COPY packages/uappi-sync/package.json packages/uappi-sync/
COPY packages/mcp-core/package.json packages/mcp-core/
COPY packages/mcp-commerce/package.json packages/mcp-commerce/
COPY packages/mcp-ga4/package.json packages/mcp-ga4/
COPY packages/mcp-behavior/package.json packages/mcp-behavior/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter @center/api exec prisma generate
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app ./
# Entrypoint padrão: API. Os workers sobrescrevem o command no compose.
WORKDIR /app/apps/api
CMD ["node", "dist/main.js"]
```

`.dockerignore`:

```
node_modules
**/node_modules
**/dist
.turbo
coverage
.git
.env
*.log
```

- [ ] **Step 2: Escrever o compose de produção**

`docker-compose.prod.yml`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes: ['pgdata:/var/lib/postgresql/data']
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U ${POSTGRES_USER}']
      interval: 10s
      retries: 10
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    command: redis-server --appendonly yes
    volumes: ['redisdata:/data']
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 10s
      retries: 10
    restart: unless-stopped

  api:
    build: .
    env_file: [.env]
    ports: ['3333:3333']
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    command: sh -c "npx prisma migrate deploy && node dist/main.js"
    restart: unless-stopped

  sync:
    build: .
    env_file: [.env]
    depends_on:
      api: { condition: service_started }
    command: node dist/sync/sync-worker-main.js
    restart: unless-stopped

  whatsapp:
    build: .
    env_file: [.env]
    depends_on:
      api: { condition: service_started }
      redis: { condition: service_healthy }
    command: node dist/whatsapp/worker-main.js
    restart: unless-stopped

volumes:
  pgdata:
  redisdata:
```

- [ ] **Step 3: Escrever o guia de deploy**

`docs/deploy.md`:

```markdown
# Deploy

## Staging

```bash
cp .env.example .env   # preencha TODOS os valores; a API não sobe com env faltando
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml logs -f api
```

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
```

- [ ] **Step 4: Verificar o build da imagem**

```bash
docker build -t center-analytics:staging .
docker run --rm center-analytics:staging node -e "console.log('build ok')"
```

Expected: `build ok`.

- [ ] **Step 5: Commit final**

```bash
git add Dockerfile .dockerignore docker-compose.prod.yml docs/deploy.md
git commit -m "feat(ops): add container image, prod compose and deploy runbook"
```

---

# Gargalos Técnicos e Riscos de Integração

Ordenados por **custo esperado** (probabilidade × impacto no cronograma), não por gravidade teórica.

---

### R1 — A documentação pública da Uappi cobre apenas pedidos 🔴 CRÍTICO

**O que acontece:** a doc da API v2 detalha `/v2/auth`, `/v2/ping`, `/v2/collection/{api}` e `/v2/orders`. Produtos, categorias e clientes são mencionados mas não especificados. A API Front (`/v2/front/*`) é de **vitrine** — `/checkout/cart` devolve o carrinho da sessão do visitante atual, não uma lista de carrinhos abandonados.

**Impacto:** já absorvido no plano — A10 (produtos sem estoque) vira spike (T15); B11/B12 (quais clientes abandonaram) mudam de forma na resposta (T19). Mas se o endpoint de pedidos também divergir do documentado, a Fase 1 inteira derrapa.

**Mitigação, em ordem:**
1. **T5, Step 9 é obrigatório no Sprint 2**: salve um pedido real em `docs/uappi-order-sample.json` **antes** de escrever o schema. Os nomes de campo da doc não dizem os tipos nem o que é opcional.
2. **T15, Step 1 no Sprint 1**: `GET /v2/collection/apiv2` devolve a coleção Postman da própria API. É a lista real de endpoints, e leva 5 minutos.
3. Se a coleção não expuser produtos, abra chamado no suporte da Uappi **no Sprint 1** — a resposta demora e o resultado muda o escopo.

---

### R2 — Crashlytics e Performance não têm API de leitura 🟠 ALTO (já mitigado por decisão)

**O que acontece:** 8 das perguntas originais dependem de dados de crash ou performance do app. O Firebase **não expõe API REST de leitura** para nenhum dos dois — o caminho programático é o export para BigQuery ([Crashlytics](https://firebase.google.com/docs/crashlytics/bigquery-export), [Performance](https://firebase.google.com/docs/perf-mon/bigquery-export)).

**Decisão registrada:** fora do escopo da v1. O agente responde que não tem acesso, sem inventar (T31, critério 4 da avaliação).

**Caminho de habilitação, se virar prioridade:** habilitar os dois exports para BigQuery e estender `@center/mcp-behavior` (que já tem o cliente BigQuery da T36) com quatro ferramentas. Estimativa: **5 dias**, mais custo de query e latência de até 24 h nos dados diários. Nada da arquitetura precisa mudar — é uma quarta fonte no mesmo padrão.

---

### R3 — Volume de pedidos e limite de taxa da Uappi 🟠 ALTO

**O que acontece:** o backfill busca o **detalhe** de cada pedido, limitado a 60 req/min. Uma loja com 10 mil pedidos/mês custa ~3 horas de backfill por mês de histórico; 90 dias de backfill levam ~8 horas. Se o volume for 10× maior, são 3 dias.

**Impacto:** o primeiro deploy demora, e um erro no meio do backfill custa horas para refazer.

**Mitigação:**
1. **Meça antes de rodar.** No Sprint 2, chame `GET /v2/orders` com `limit=1` no período de 90 dias e leia `info.total`. Divida por 60 para estimar os minutos.
2. O backfill é **idempotente e retomável**: o `cursorDate` do `SyncState` só avança em sucesso (T8), então uma interrupção não perde o trabalho feito.
3. Se `info.total` passar de ~50 mil, reduza `SYNC_BACKFILL_DAYS` para 30 no primeiro deploy e amplie depois, com o sistema já no ar.
4. **Não reduza `SYNC_INTERVAL_MINUTES` abaixo de 30** — a janela de sobreposição de 3 dias significa que cada ciclo relê os pedidos recentes, e um intervalo curto multiplica esse custo.

---

### R4 — Atribuição depende de mudança no checkout da loja 🟠 MÉDIO-ALTO

**O que acontece:** o Grupo C (6 perguntas) depende de o checkout escrever `centerVisitorId` e as UTMs em `informacoesAdicionais` do pedido (T9). Isso exige uma linha no template da loja e uma mudança no ponto onde o pedido é criado.

**Impacto:** sem isso, das 6 perguntas do Grupo C sobra 1 (`channel_average_ticket`, que usa o campo `canal` nativo da Uappi).

**Mitigação:**
1. **Confirme com quem mantém o site da loja no Sprint 1**, não no 7. É uma pergunta de 5 minutos que decide o escopo de uma fase.
2. O snippet tem uma **rede de segurança** (T9, caminho 1): grava `AttributionTouch` por `visitorHash` mesmo sem o campo oculto. Uma extensão futura pode casar por `emailHash` numa janela de 30 dias — o schema já tem o índice para isso (`@@index([organizationId, emailHash, occurredAt])`).
3. Se a mudança for impossível, corte o Grupo C do escopo e economize ~4 dias.

---

### R5 — Latência do agente arruína a experiência no WhatsApp 🟠 MÉDIO

**O que acontece:** a resposta soma consulta (50 ms no Postgres, mas 0,5–4 s no GA4 em cache frio) + 2 a 4 idas ao LLM (1–3 s cada). Um caso ruim realista: `listar_metricas` → `ranking` → `consultar_metrica` → texto ≈ **12 segundos**. No WhatsApp o usuário assume que o bot morreu depois de ~8 s.

**Mitigação, já embutida:**
- O read model em Postgres torna as perguntas do Grupo A quase instantâneas — que são a maioria.
- Cache Redis com TTL longo para períodos fechados (T11), aquecido às 5h (T38).
- `consultar_metrica` devolve resumo achatado e `ranking` corta em 5 linhas (T30) — menos tokens de entrada no passo seguinte.
- `stopWhen: stepCountIs(8)` limita o pior caso; `temperature: 0` reduz caminhos exploratórios.

**Se ainda assim ficar lento:** enviar "Consultando seus dados… ⏳" ao enfileirar, antes do processamento. ~15 linhas em `whatsapp/routes.ts`; resolve a percepção, não a latência. **Meça primeiro** com o script da T31 — o critério de 8 s medianos existe para isto.

---

### R6 — Biblioteca de gráficos e React 19 🟢 BAIXO (resolvido por decisão de projeto)

**O risco original:** o `@tremor/react` 3.x declara peer dependency `react@^18` e usa padrões que o React 19 removeu ou mudou (`defaultProps` em componentes de função, `forwardRef` encadeado). Adotá-lo significaria conviver com incompatibilidades de runtime e depender de um release de terceiro para destravar.

**Como foi resolvido:** o plano adota o modelo **Tremor Raw** — os componentes de gráfico vivem no nosso repositório, escritos direto sobre Recharts (T25, T27). O `@tremor/react` não é dependência do projeto. Três consequências que reduzem o risco a quase zero:

1. **Sem peer conflitante.** O `.npmrc` (T1) mantém `strict-peer-dependencies` no padrão estrito, então qualquer pacote incompatível com React 19 **falha o `install`** em vez de quebrar em produção. A T25, Step 9 verifica explicitamente que nenhum aviso de peer aparece.
2. **Sem safelist frágil.** As cores são `var(--viz-N)` passadas em props do Recharts, não classes geradas em runtime — o `tailwind.config.ts` não precisa mais de `safelist`, que era a parte mais quebradiça do desenho anterior.
3. **Superfície pequena.** Só o `TimeSeriesChart` usa Recharts. `ChartFrame`, `KpiCard`, `RankingTable` e `FunnelChart` são HTML e CSS puros.

**O que sobra de risco:** o Recharts 2.x precisa suportar React 19. Ele suporta desde a série 2.13, e a T25 fixa `^2.15.0`. Se um dia o Recharts se tornar o gargalo, trocar a biblioteca afeta **um arquivo** — os testes verificam legenda, rótulos e visão de tabela, nunca o SVG, então continuam válidos com qualquer motor de renderização.

---

### R7 — Erro de fator 100 em valores monetários 🟡 MÉDIO (alta probabilidade, alto dano)

**O que acontece:** dinheiro circula em centavos por decisão de projeto (T2). Um único ponto que esqueça de dividir por 100 reporta R$ 480.000,00 onde são R$ 4.800,00 — e o usuário só descobre se conferir.

**Mitigação — quatro camadas, todas com teste:**
1. `formatMetricValue` é o **único** lugar que divide por 100 (T25), com teste explícito. A tooltip e o eixo Y do gráfico passam por ele (T27) — o padrão do Recharts imprimiria o número cru.
2. As ferramentas do agente devolvem `observacao: "Valores em CENTAVOS"` (T30) e o system prompt insiste no ponto com exemplo numérico (T31).
3. **A suíte de contrato da T38B** atravessa as quatro camadas com o mesmo valor canônico (`4800.00` reais / `480000` centavos): tipos → ingestão → read model → formatação → agente. Uma falha aponta a camada exata onde o fator se perdeu, em vez de aparecer como um número estranho na tela.
4. O critério 2 da avaliação (T31) e o passo 4 do roteiro de aceite (T35) exigem conferência manual contra a dashboard.

**A regra ao ver um teste da T38B falhar:** conserte a camada, nunca o teste. Um teste de contrato ajustado para passar é exatamente o caminho pelo qual este bug chega à produção.

**Se aparecer em produção:** o `ToolCallLog` registra a entrada de toda chamada, então dá para reconstruir qual ferramenta devolveu o quê.

---

### R8 — Mapa de status da Uappi incompleto 🟡 MÉDIO

**O que acontece:** cada loja configura seus próprios status. `resolveStatusGroup` (T6) cobre os padrões comuns, mas um status como "Aguardando retirada na loja física" cai em `OTHER` — e `OTHER` **não entra em faturamento**, subnotificando receita silenciosamente.

**Mitigação:** o T6, Step 7 lista todos os status distintos da loja e mostra o grupo resolvido para cada um. **Toda linha que sair como `OTHER` precisa de decisão explícita** — override em `Organization.statusMapping` ou padrão novo com teste. O T8, Step 6 fecha o ciclo comparando a soma de `PAID` com o painel da Uappi, e trata divergência como bloqueio.

---

### R9 — Alucinação numérica do agente 🟡 MÉDIO

**O que acontece:** o modelo responde com um número plausível sem chamar ferramenta, ou faz aritmética própria sobre os resultados ("então a média diária foi…"). Número errado entregue com confiança é pior do que erro visível.

**Mitigação:**
- O system prompt proíbe estimar e manda declarar indisponibilidade (T31).
- Toda chamada é registrada em `ToolCallLog` (T31) — qualquer resposta é auditável depois.
- Os critérios 1 e 4 da avaliação (T31) verificam exatamente isso, com duas perguntas fora de escopo para provocar o comportamento.

**Se persistir:** verificação pós-resposta que extrai números do texto e confirma que cada um aparece em algum resultado de ferramenta da mesma requisição. ~1 dia; só faça se a avaliação mostrar necessidade.

---

### R10 — Vazamento entre tenants e exposição de PII 🟢 BAIXO (mas catastrófico se ocorrer)

**Por que está baixo:** o desenho fecha os caminhos por construção, não por disciplina.
- O body de `/api/metrics/query` e `/api/tools/*` **não tem campo de tenant** — o cliente não tem onde escrever um, e o servidor o escreve por último (T23).
- As ferramentas do agente recebem o tenant por closure (T30); o LLM não tem parâmetro para alterá-lo.
- A chave de cache inclui o `organizationId` (T11).
- O worker recusa telefone não vinculado e verificado antes de chamar o agente (T33).
- **Não existe coluna capaz de armazenar PII em claro** — o teste de schema (T4) falha se alguém adicionar uma.
- Credenciais de integração são cifradas na borda de escrita (T24B) e decifradas só no ponto que autentica (T24, T15).
- O `out_of_stock_products` constrói **um cliente Uappi por organização** (T15), com as credenciais que chegam no próprio tenant — nunca um cliente compartilhado.

**Os nove testes que guardam essas propriedades. Enfraquecer qualquer um é bloqueio de merge:**

| Teste | Task |
|---|---|
| "injects the tenant from the token, never from the body" | T23 |
| "overrides a tenant forged in the tool arguments" | T23 |
| "does not share cache between tenants" | T11 |
| "always injects the tenant from the closure" | T30 |
| "never calls the agent for an unknown phone" | T33 |
| "has no column capable of holding personal data in the clear" | T4 |
| "authenticates with each organization own credentials" | T15 |
| "encrypts the Uappi credentials before writing to the database" | T24B |
| "reports uappi as configured without ever returning the ciphertext or the plaintext" | T24B |

---

### R11 — Modo mock ligado em produção 🟢 BAIXO (mas silencioso)

**O que acontece:** `MOCK_EXTERNAL_APIS=true` faz Uappi, GA4 e BigQuery responderem por fixtures. Se essa variável vazar para produção, a dashboard e o bot passam a servir dados inventados — **sem erro, sem log de falha, sem nada quebrado na tela**. É o tipo de problema que só aparece quando alguém questiona um número.

**Mitigação:**
1. **O `.env.example` marca a variável como `"false"`** e traz o aviso em comentário (T4).
2. **`loadConfig` só aceita a string exata `"true"`** (T4) — um `MOCK_EXTERNAL_APIS=1` ou `=yes` resolve para `false`, não liga o modo por acidente. Há teste para isso.
3. **O `health-report.js` (T38) deve falhar quando o modo estiver ligado.** Acrescente ao script, junto das demais checagens:

```ts
if (config.mockExternalApis) {
  problems.push('MOCK_EXTERNAL_APIS está ligado — os dados servidos são fixtures, não reais');
}
```

Como o script roda a cada 30 minutos e sai com código diferente de zero em caso de problema (T38), o alarme dispara em no máximo meia hora.

4. O `docker-compose.prod.yml` (T39) não define a variável, então o default `false` vale — ligá-la em produção exige uma edição explícita do `.env`, nunca acontece por herança de ambiente.

---

# Backlog para Jira / Notion

Cole no Notion como tabela, ou salve como CSV para importar no Jira (Configurações → Sistema → Importação externa → CSV).

**Mapeamento no Jira:** `Epic` → Epic Link · `Task` → Summary · `Type` → Issue Type · `Est.` → Original Estimate · `Depende de` → Blocked By · `Sprint` → Sprint.

| Epic | Key | Task | Type | Est. | Sprint | Depende de | Definition of Done |
|---|---|---|---|---|---|---|---|
| Riscos | CD-S1 | ⚠️ Iniciar verificação do Meta Business | Spike | 0,5d | **S1** | — | Submissão feita, protocolo registrado. **Dia 1** |
| Riscos | CD-S2 | ⚠️ Levantar endpoints reais da Uappi (coleção Postman) | Spike | 0,5d | **S1** | — | `docs/uappi-endpoints.txt` no repo; decisão sobre A10 registrada |
| Riscos | CD-S3 | ⚠️ Confirmar mudança no checkout para atribuição | Spike | 0,5d | **S1** | — | Resposta de quem mantém o site; Grupo C confirmado ou cortado |
| Riscos | CD-S4 | ⚠️ Medir volume de pedidos (`info.total` em 90 dias) | Spike | 0,5d | **S2** | CD-5 | Tempo estimado de backfill documentado |
| Fase 0 | CD-1 | Esqueleto do monorepo e preset de testes | Task | 1d | S1 | — | Teste que importa o MCP SDK dentro do Jest passa |
| Fase 0 | CD-2 | Contratos de domínio (métricas, rankings, dinheiro, datas) | Task | 1,5d | S1 | CD-1 | 27 testes verdes; centavos sem drift de float |
| Fase 0 | CD-3 | Pseudonimização HMAC | Task | 0,5d | S1 | CD-1 | 10 testes; hash determinístico, irreversível, com namespace |
| Fase 0 | CD-4 | Infra local e schema do read model | Task | 1,5d | S1 | CD-2, CD-3 | Migration aplicada; teste de schema barra PII em claro |
| Fase 0 | **CD-4B** | Criptografia reversível de credenciais (`@center/secrets`) | Task | 0,5d | S1 | CD-1 | 12 testes; round-trip, IV fresco por chamada, GCM detecta adulteração |
| Fase 1 | CD-5 | Cliente HTTP da Uappi (auth, rate limit, paginação) | Task | 2d | S2 | CD-1 | 22 testes; `docs/uappi-order-sample.json` salvo |
| Fase 1 | **CD-5B** | Cliente mock e fixtures da Uappi | Task | 1d | S2 | CD-5 | 7 testes; `MOCK_EXTERNAL_APIS=true` percorre 15 pedidos sem rede |
| Fase 1 | CD-6 | Schemas do pedido e mapa de status | Task | 1,5d | S2 | CD-5 | 29 testes; nenhum status de venda caindo em `OTHER` |
| Fase 1 | CD-7 | Mapper para o read model (centavos + PII hasheada) | Task | 2d | S2–S3 | CD-6 | 55 testes; nada de e-mail/documento em claro na saída |
| Fase 1 | CD-8 | Backfill e sync incremental de 30 min | Task | 2d | S3 | CD-7 | Backfill real roda; 2ª execução não duplica; total bate com a Uappi |
| Fase 2 | CD-10 | Toolkit de MCP server (2 famílias de ferramentas) | Task | 1,5d | S4 | CD-2 | 15 testes via transporte in-memory |
| Fase 2 | CD-11 | Pool, cache e gateway | Task | 1,5d | S4 | CD-10 | TTL curto/longo correto; Redis fora não derruba a query |
| Fase 3 | CD-12 | Métricas de série do Commerce | Task | 2d | S4 | CD-8, CD-11 | 21 testes contra Postgres real; timezone de negócio correta |
| Fase 3 | CD-13 | Ferramentas de status, falhas e pagamento | Task | 1,5d | S5 | CD-12 | Cancelados nunca contam como receita |
| Fase 3 | CD-14 | Rankings de produtos e categorias | Task | 1,5d | S5 | CD-12 | Maior queda ordenada primeiro; `deltaRatio` nulo sem base |
| Fase 3 | CD-15 | Spike de catálogo/estoque + ferramenta condicional | Spike | 1d | S5 | CD-S2 | Decisão sobre A10 documentada; cliente Uappi **por organização**, com teste de isolamento |
| Fase 3 | CD-16 | Ferramentas de atribuição | Task | 2d | S5 | CD-12 | 18 perguntas validadas no MCP Inspector contra dados reais |
| Fase 4 | CD-17 | Provider de métricas do GA4 | Task | 1,5d | S6 | CD-11 | 10 testes; receita do GA4 em centavos |
| Fase 4 | **CD-17B** | Cliente mock determinístico do GA4 | Task | 1d | S6 | CD-17 | 9 testes; mesma entrada sempre gera a mesma saída |
| Fase 4 | CD-18 | Ferramentas de dimensão do GA4 | Task | 2d | S6 | CD-17 | 24 testes; versão de app vazia filtrada |
| Fase 4 | CD-19 | Funil de checkout | Task | 1d | S6 | CD-17 | Etapa de maior abandono correta; `identifiesUsers: false` |
| Fase 5 | CD-20 | Correlação de métricas | Task | 1d | S6 | CD-11 | Variância zero devolve `null`, não zero |
| Fase 5 | CD-21 | Impacto de versão do app | Task | 1d | S6 | CD-20 | Janelas simétricas; veredito inconclusivo quando cabe |
| Fase 6 | CD-22 | Fastify, auth, rate limit e tenant | Task | 2d | S7 | CD-4 | 15 testes; sem enumeração de usuários |
| Fase 6 | CD-23 | Rotas de métricas, ferramentas e análises | Task | 2d | S7 | CD-11, CD-22 | Tenant forjado ignorado; allowlist de ferramentas |
| Fase 1/6 | CD-9 | Captura de atribuição no checkout | Task | 1,5d | S7 | CD-23, CD-S3 | Pedido de teste chega com campanha e `visitorHash` |
| Fase 6 | CD-24 | Composition root e agendador de sync | Task | 1,5d | S7 | CD-23, CD-4B | Catálogo com 11 métricas via curl; 2ª query é cache hit |
| Fase 6 | **CD-24B** | Rotas admin de credenciais de integração | Task | 1d | S7 | CD-24 | 10 testes; banco guarda `v1.<hex>…`, GET nunca devolve segredo |
| Fase 6 | CD-25 | Scaffold do frontend, paleta e cliente de API | Task | 1,5d | S7–S8 | CD-23 | Build contém `--viz-1` nos 3 escopos de tema; `install` sem aviso de peer |
| Fase 6 | CD-26 | Filtros na URL e hooks de dados | Task | 1,5d | S8 | CD-25 | "mês passado" cruza o ano; URL inválida cai no default |
| Fase 6 | CD-27 | Componentes de gráfico, ranking e funil | Task | 2d | S8 | CD-26 | Toggle de tabela funciona; tooltip formata centavos; inspeção visual nos 2 temas |
| Fase 6 | CD-28 | Páginas e autenticação na interface | Task | 2d | S8 | CD-27 | Faturamento da tela bate com o painel da Uappi |
| Fase 6 | **CD-28B** | Formulário de credenciais de integração | Task | 1d | S8 | CD-24B, CD-28 | 9 testes; campo de segredo nunca pré-preenchido nem após refresh |
| Fase 7 | CD-29 | Resolvedor de períodos em PT-BR | Task | 1d | S9 | CD-2 | 24 testes, incluindo bissexto e virada de ano |
| Fase 7 | CD-30 | Ferramentas do agente | Task | 2d | S9 | CD-20, CD-29 | Tenant do closure; falha vira objeto de erro legível |
| Fase 7 | CD-31 | Núcleo do agente, memória e avaliação | Task | 2d | S9 | CD-30 | Os 5 critérios da avaliação passam; `docs/agent-eval.md` versionado |
| Fase 7 | CD-32 | Webhook do WhatsApp | Task | 1,5d | S10 | CD-22, CD-S1 | Assinatura inválida = 401; `wamid` repetido não duplica |
| Fase 7 | CD-34 | Vínculo telefone ↔ usuário | Task | 1d | S10 | CD-32 | Código expirado, usado e telefone tomado tratados |
| Fase 7 | CD-33 | Fila, worker e envio | Task | 2d | S10 | CD-31, CD-34 | Falha de envio propaga para o BullMQ retentar |
| Fase 7 | CD-35 | Validação fim-a-fim no WhatsApp | Task | 1d | S10 | CD-34 | Os 8 passos do roteiro passam; valores em reais corretos |
| Fase 8 | CD-36 | Cliente BigQuery e caminho até a compra | Task | 2d | S11 | CD-11 | 15 testes; filtro de partição presente; smoke test dentro do teto de bytes |
| Fase 8 | **CD-36B** | Cliente mock do BigQuery | Task | 0,5d | S11 | CD-36 | 5 testes; escolhe a fixture pela presença de `screenName` |
| Fase 8 | CD-37 | Impacto do abandono de tela | Task | 1,5d | S11 | CD-36 | Nome da tela como parâmetro, nunca interpolado |
| Fase 9 | CD-38 | CI, aquecimento de cache e relatório de saúde | Task | 1,5d | S11 | CD-35 | Pipeline verde em PR; `health:report` alarma se `MOCK_EXTERNAL_APIS` estiver ligado |
| Fase 9 | **CD-38B** | Contrato de regressão de centavos | Task | 1d | S11 | CD-31 | 4 suítes atravessando tipos → ingestão → read model → UI → agente |
| Fase 9 | CD-39 | Empacotamento e deploy em staging | Task | 2d | S11 | CD-38 | `/health` responde no container; runbook escrito |

**Totais:** 45 tasks de implementação (≈ 65 dias) + 4 spikes (2 dias) = **11 sprints + 1 de buffer**.

**As quatro spikes são o item mais importante desta tabela.** Nenhuma passa de meio dia, e as quatro protegem contra os riscos capazes de estourar o cronograma (R1, R2, R3, R4). Faça CD-S1, CD-S2 e CD-S3 **antes da CD-1**.

**As seis tasks `B` somam ~5 dias e nenhuma está no caminho crítico.** Três delas (CD-5B, CD-17B, CD-36B) *encurtam* o cronograma na prática, porque removem a espera por credencial de terceiros — com elas, os Sprints 1–2 rodam sem nada da Uappi e os Sprints 4–5 sem nada do Google.

---

## Ordem de execução recomendada

```
S1:  CD-S1 ‖ CD-S2 ‖ CD-S3  →  CD-1 → CD-2 → CD-3 → CD-4 → CD-4B
S2:  CD-5 → CD-5B → CD-S4 → CD-6 → CD-7
S3:  CD-7 → CD-8
S4:  CD-10 → CD-11 → CD-12
S5:  CD-13 → CD-14 → CD-15 → CD-16
S6:  CD-17 → CD-17B → CD-18 → CD-19 → CD-20 → CD-21
S7:  CD-22 → CD-23 → CD-9 → CD-24 → CD-24B → CD-25
S8:  CD-26 → CD-27 → CD-28 → CD-28B
S9:  CD-29 → CD-30 → CD-31
S10: CD-32 → CD-34 → CD-33 → CD-35   (o worker importa o módulo de vínculo)
S11: CD-36 → CD-36B → CD-37 → CD-38 → CD-38B → CD-39
S12: buffer
```

**CD-5B logo depois de CD-5, não no fim do sprint.** É o que libera todo o resto da Fase 1 a rodar sem `apiKey` real — invertendo a ordem, o time fica bloqueado esperando credencial exatamente no ponto em que teria mais o que fazer.

**Paralelização com um segundo desenvolvedor:** a Fase 4 (GA4, CD-17 a CD-19) não depende da Fase 3 (Commerce) — só de CD-11. A partir do Sprint 4, um dev segue em Commerce e outro em GA4. O frontend (CD-25 a CD-28B) só depende de CD-23, então é a segunda divisão natural.

**Se o cronograma apertar, corte nesta ordem:**
1. **Fase 8** (CD-36, CD-37) — 2 perguntas, −3,5 dias, zero impacto no resto.
2. **Grupo C** se a CD-S3 der negativo (CD-9, CD-16 parcial) — −4 dias.
3. **CD-15** se a coleção Postman não expuser produtos — −1 dia.
