# Center Dashboard + Agente IA WhatsApp — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir um monorepo que expõe métricas de Firebase, GA4 e Backend Proprietário através de MCP servers, consumidas simultaneamente por uma dashboard React e por um agente de IA no WhatsApp.

**Architecture:** Três MCP servers (um por fonte de dados) implementam um contrato uniforme de duas ferramentas — `list_metrics` e `query_metric` — sobre um tipo canônico `MetricSeries`. Um `McpPool` no processo da API Fastify mantém conexões stdio com os três servers; um `MetricGateway` envolve o pool com cache Redis. Dashboard e agente de IA consomem **o mesmo** `MetricGateway`, então não existe lógica de agregação duplicada. O agente usa Vercel AI SDK com tool calling, e as ferramentas do LLM são adaptadores finos sobre o gateway.

**Tech Stack:** pnpm workspaces + Turborepo · TypeScript 5.7 (ESM/NodeNext) · Node 22 · Fastify 5 · Prisma 6 + PostgreSQL 16 · Redis 7 + BullMQ · `@modelcontextprotocol/sdk` · Vercel AI SDK 5 (`ai` + `@ai-sdk/anthropic`) · React 19 + Vite 6 + Tailwind 3 + Tremor 3 + TanStack Query 5 · Jest 29 + `@swc/jest` + React Testing Library + MSW 2 · WhatsApp Cloud API (Meta oficial)

## Global Constraints

- **Node.js 22 LTS.** Todo `package.json` declara `"engines": { "node": ">=22" }`.
- **Todos os pacotes são ESM.** `"type": "module"` + `"module": "NodeNext"` no tsconfig. Imports relativos **sempre** com extensão `.js` (ex.: `import { x } from './y.js'`).
- **Jest roda em modo CJS** via `@swc/jest` (transpila ESM→CJS só para o teste), com `moduleNameMapper` removendo o sufixo `.js`. Isso evita `--experimental-vm-modules`.
- **Modelo de LLM:** `claude-sonnet-5` via `@ai-sdk/anthropic`. Não usar outro modelo sem alterar este documento.
- **Multi-tenant obrigatório.** Nenhuma query de métrica pode ser executada sem um `TenantContext`. Não existe rota, ferramenta de LLM ou função de gateway que aceite query sem tenant.
- **Nenhum segredo em código.** Credenciais só via variáveis de ambiente, validadas por Zod no boot (`loadConfig()`), que falha o processo se faltar algo.
- **Datas em `YYYY-MM-DD`, timezone fixa `America/Sao_Paulo`.** Nunca usar `new Date()` dentro de lógica de negócio — a data "hoje" é sempre injetada como parâmetro, para que os testes sejam determinísticos.
- **Cobertura mínima de 80%** em `packages/shared`, `packages/mcp-core` e `apps/api/src/agent` (enforced no `jest.config`).
- **Paleta de gráficos fixa e validada** (ver Task 16). Slots categóricos nesta ordem, nunca reciclados: `#2a78d6` / `#eb6834` / `#1baf7a` / `#eda100` (light) e `#3987e5` / `#d95926` / `#199e70` / `#c98500` (dark).
- **Todo gráfico tem toggle de tabela.** Três cores light ficam abaixo de 3:1 de contraste — a "regra de relevo" exige rótulos diretos visíveis ou visão de tabela. Não é opcional.
- **Convenção de commit:** Conventional Commits (`feat:`, `fix:`, `test:`, `chore:`, `refactor:`).

---

## Mapa de Arquivos

```
centerDashboard/
├─ package.json                 # workspace root, scripts turbo
├─ pnpm-workspace.yaml
├─ turbo.json
├─ tsconfig.base.json           # compilerOptions compartilhadas
├─ jest.preset.cjs              # preset Jest compartilhado (swc, CJS)
├─ docker-compose.yml           # postgres:16 + redis:7
├─ .env.example
├─ packages/
│  ├─ shared/                   # @center/shared — contratos puros, zero I/O
│  │  └─ src/{metrics.ts,tenant.ts,date.ts,index.ts}
│  ├─ mcp-core/                 # @center/mcp-core — toolkit server + pool client + cache
│  │  └─ src/{provider.ts,server.ts,pool.ts,cache.ts,gateway.ts,index.ts}
│  ├─ mcp-backend/              # @center/mcp-backend — server MCP do backend proprietário
│  │  └─ src/{client.ts,provider.ts,promotions.ts,main.ts}
│  ├─ mcp-ga4/                  # @center/mcp-ga4 — server MCP do Google Analytics 4
│  │  └─ src/{client.ts,provider.ts,main.ts}
│  └─ mcp-firebase/             # @center/mcp-firebase — server MCP do Firebase (Firestore)
│     └─ src/{client.ts,provider.ts,main.ts}
└─ apps/
   ├─ api/                      # @center/api — Fastify
   │  ├─ prisma/schema.prisma
   │  └─ src/
   │     ├─ config.ts           # loadConfig() com Zod
   │     ├─ server.ts           # buildServer(deps)
   │     ├─ main.ts             # composition root
   │     ├─ auth/{jwt.ts,routes.ts,guard.ts}
   │     ├─ tenant.ts           # resolveTenant(prisma, orgId)
   │     ├─ routes/{metrics.ts,promotions.ts}
   │     ├─ agent/{system-prompt.ts,date-resolver.ts,tools.ts,agent.ts,memory.ts}
   │     └─ whatsapp/{signature.ts,parse.ts,cloud-api-client.ts,linking.ts,routes.ts,queue.ts,worker.ts}
   └─ web/                      # @center/web — React 19 + Vite
      └─ src/
         ├─ main.tsx, App.tsx, index.css
         ├─ lib/{api-client.ts,query-keys.ts,format.ts,viz-colors.ts}
         ├─ hooks/{use-auth.ts,use-filters.ts,use-metric-catalog.ts,use-metric-series.ts,use-promotions.ts}
         ├─ components/layout/AppShell.tsx
         ├─ components/filters/{PeriodPicker.tsx,SourceFilter.tsx}
         ├─ components/charts/{ChartFrame.tsx,KpiCard.tsx,TimeSeriesChart.tsx,SourceBreakdown.tsx}
         ├─ pages/{LoginPage.tsx,OverviewPage.tsx,PromotionsPage.tsx}
         └─ test/{setup.ts,msw-server.ts,render.tsx}
```

**Regra de dependência (unidirecional, nunca invertida):**
`shared` ← `mcp-core` ← `mcp-*` (servers) e `shared` ← `mcp-core` ← `api` ← `web` (via HTTP, tipos copiados de `shared`).

---

## Roadmap — Sprints (1 sprint = 1 semana, 1 dev sênior full-cycle)

| Fase | Nome | Tasks | Sprints | Entregável testável |
|---|---|---|---|---|
| 0 | Fundação do Monorepo | 1–3 | S1 | `pnpm test` verde, DB migrado |
| 1 | MCP Core & Servers | 4–9 | S2–S4 | 3 MCP servers respondendo `query_metric` |
| 2 | API Core | 10–12 | S4–S5 | `POST /api/metrics/query` autenticado com cache |
| 3 | Dashboard Web | 13–18 | S5–S7 | Dashboard navegável com dados reais |
| 4 | Agente de IA | 19–22 | S8 | `runAgent()` responde perguntas em PT-BR |
| 5 | Integração WhatsApp | 23–26 | S9 | Bot responde no WhatsApp fim-a-fim |
| 6 | Hardening & Deploy | 27–28 | S10 | CI verde, deploy em staging |

**Total: 10 sprints de desenvolvimento + 1 sprint de buffer = 11 semanas.**

Premissas da estimativa (se alguma cair, a estimativa muda):
1. Credenciais de GA4, Firebase e do Backend Proprietário estão disponíveis **antes do Sprint 2**.
2. A conta Meta Business já está verificada e o número de telefone provisionado **antes do Sprint 9**. Verificação da Meta leva de 3 dias a 3 semanas e é assíncrona — **inicie no Sprint 1**.
3. O Backend Proprietário já expõe endpoints de gasto e promoções, ou aceita que sejam criados nesta janela.
4. Não há requisito de design system próprio para a dashboard (usa Tremor + Tailwind puros).

### Caminho crítico

```
Task 2 (contratos) → Task 4 (toolkit server) → Task 6 (mcp-backend) → Task 11 (rota query)
                                                                    → Task 19 (agente)
```
Tasks 7 e 8 (GA4, Firebase) são paralelizáveis entre si. Tasks 13–18 (frontend) só dependem da Task 11.

---

# FASE 0 — Fundação do Monorepo (Sprint 1)

**Objetivo da fase:** provar que o toolchain funciona antes de escrever qualquer regra de negócio. O risco real aqui não é "montar workspaces", é **Jest + ESM + TypeScript**, que quebra de formas obscuras. A Task 1 existe para queimar esse risco no primeiro dia.

**Onde os testes entram:** a Task 1 termina com um teste que importa o `@modelcontextprotocol/sdk` (dependência ESM-first) dentro do Jest. Se esse teste passa, o resto do projeto é seguro.

---

### Task 1: Esqueleto do monorepo e preset de testes

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `jest.preset.cjs`, `.gitignore`, `.npmrc`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/jest.config.cjs`
- Create: `packages/shared/src/index.ts`
- Test: `packages/shared/src/__tests__/toolchain.test.ts`

**Interfaces:**
- Consumes: nada (primeira task).
- Produces: preset Jest em `jest.preset.cjs` (usado por todos os pacotes); `tsconfig.base.json` estendido por todos os pacotes; scripts `pnpm build`, `pnpm test`, `pnpm lint` na raiz.

- [ ] **Step 1: Inicializar o workspace**

```bash
git init
corepack enable
corepack prepare pnpm@9.15.0 --activate
```

`package.json` (raiz):

```json
{
  "name": "center-dashboard",
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

`.npmrc` — Tremor 3 ainda declara peer `react@^18`; sem isto o install falha no React 19:

```
strict-peer-dependencies=false
auto-install-peers=true
```

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
    "exactOptionalPropertyTypes": false,
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
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "test": {
      "dependsOn": ["^build"],
      "outputs": ["coverage/**"]
    },
    "typecheck": {
      "dependsOn": ["^build"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    }
  }
}
```

- [ ] **Step 3: Preset Jest compartilhado**

`jest.preset.cjs` — este arquivo é a peça crítica. O `moduleNameMapper` remove o sufixo `.js` dos imports relativos (obrigatórios em ESM/NodeNext) para que o resolver CJS do Jest os encontre.

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
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transformIgnorePatterns: ['/node_modules/(?!(@modelcontextprotocol)/)'],
  testMatch: ['**/__tests__/**/*.test.ts?(x)'],
  clearMocks: true,
};
```

- [ ] **Step 4: Criar o pacote `@center/shared` vazio**

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
  "dependencies": {
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0"
  }
}
```

`packages/shared/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist"
  },
  "include": ["src/**/*"],
  "exclude": ["src/**/__tests__/**"]
}
```

`packages/shared/jest.config.cjs`:

```js
module.exports = {
  ...require('../../jest.preset.cjs'),
  coverageThreshold: {
    global: { branches: 80, functions: 80, lines: 80, statements: 80 },
  },
};
```

`packages/shared/src/index.ts`:

```ts
export const PACKAGE_NAME = '@center/shared';
```

- [ ] **Step 5: Escrever o teste que valida o toolchain**

Este teste tem um único propósito: provar que Jest consegue carregar uma dependência ESM-first e um módulo interno com import sufixado em `.js`.

`packages/shared/src/__tests__/toolchain.test.ts`:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PACKAGE_NAME } from '../index.js';

describe('toolchain', () => {
  it('resolves relative ESM imports written with a .js suffix', () => {
    expect(PACKAGE_NAME).toBe('@center/shared');
  });

  it('loads the ESM-first MCP SDK inside Jest', () => {
    const server = new McpServer({ name: 'toolchain-probe', version: '0.0.0' });
    expect(server).toBeInstanceOf(McpServer);
  });
});
```

- [ ] **Step 6: Instalar e rodar**

```bash
pnpm install
pnpm --filter @center/shared test
```

Expected: 2 testes PASS.

Se o segundo teste falhar com `Cannot use import statement outside a module` apontando para `@modelcontextprotocol/sdk`, o pacote não está sendo transpilado — confirme que `transformIgnorePatterns` no `jest.preset.cjs` está exatamente como no Step 3. **Não avance para a Task 2 com esse teste vermelho**; toda a Fase 1 depende dele.

- [ ] **Step 7: Commit**

```bash
git add .
git commit -m "chore: bootstrap pnpm monorepo with turbo and jest/swc preset"
```

---

### Task 2: Contratos de domínio em `@center/shared`

**Files:**
- Create: `packages/shared/src/tenant.ts`, `packages/shared/src/metrics.ts`, `packages/shared/src/date.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/__tests__/date.test.ts`, `packages/shared/src/__tests__/metrics.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `TenantContextSchema`/`TenantContext`, `MetricSourceSchema`/`MetricSource`, `MetricUnitSchema`/`MetricUnit`, `GranularitySchema`/`Granularity`, `MetricDescriptorSchema`/`MetricDescriptor`, `MetricQuerySchema`/`MetricQuery`, `MetricPointSchema`/`MetricPoint`, `MetricSeriesSchema`/`MetricSeries`, `bucketStart(isoDate, granularity)`, `eachBucket(from, to, granularity)`, `sumPoints(points)`. **Todo o resto do sistema fala nestes tipos.**

- [ ] **Step 1: Escrever os testes de data (falhando)**

`packages/shared/src/__tests__/date.test.ts`:

```ts
import { bucketStart, eachBucket, sumPoints } from '../date.js';

describe('bucketStart', () => {
  it('returns the same date for day granularity', () => {
    expect(bucketStart('2026-03-17', 'day')).toBe('2026-03-17');
  });

  it('snaps to the Monday of the week', () => {
    expect(bucketStart('2026-03-17', 'week')).toBe('2026-03-16'); // terça -> segunda
    expect(bucketStart('2026-03-16', 'week')).toBe('2026-03-16'); // segunda -> ela mesma
    expect(bucketStart('2026-03-22', 'week')).toBe('2026-03-16'); // domingo -> segunda anterior
  });

  it('snaps to the first day of the month', () => {
    expect(bucketStart('2026-03-17', 'month')).toBe('2026-03-01');
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

describe('sumPoints', () => {
  it('sums the values', () => {
    expect(sumPoints([{ date: '2026-03-01', value: 2 }, { date: '2026-03-02', value: 3.5 }])).toBe(5.5);
  });

  it('returns 0 for an empty series', () => {
    expect(sumPoints([])).toBe(0);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `pnpm --filter @center/shared test -- date.test.ts`
Expected: FAIL — `Cannot find module '../date.js'`.

- [ ] **Step 3: Implementar `tenant.ts`**

`packages/shared/src/tenant.ts`:

```ts
import { z } from 'zod';

/**
 * Contexto obrigatório em toda query de métrica. `externalIds` carrega os
 * identificadores da organização em cada fonte externa — cada MCP server lê
 * apenas a chave que lhe interessa, e nenhum server guarda estado de tenant.
 *
 * Chaves conhecidas: `ga4PropertyId`, `firebaseProjectId`, `backendAccountId`.
 */
export const TenantContextSchema = z.object({
  organizationId: z.string().min(1),
  externalIds: z.record(z.string(), z.string()),
});

export type TenantContext = z.infer<typeof TenantContextSchema>;
```

- [ ] **Step 4: Implementar `date.ts`**

Toda aritmética de data usa `Date.UTC` para evitar deslocamento por timezone do host. A timezone de negócio (`America/Sao_Paulo`) é aplicada só na borda, quando resolvemos "hoje" (Task 20).

`packages/shared/src/date.ts`:

```ts
import type { Granularity, MetricPoint } from './metrics.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function toUtc(isoDate: string): Date {
  if (!ISO_DATE.test(isoDate)) {
    throw new Error(`data inválida: "${isoDate}" (esperado YYYY-MM-DD)`);
  }
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`data inválida: "${isoDate}"`);
  }
  return date;
}

function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Normaliza uma data para o início do seu bucket (dia / segunda-feira / dia 1º). */
export function bucketStart(isoDate: string, granularity: Granularity): string {
  const date = toUtc(isoDate);
  if (granularity === 'day') return toIso(date);
  if (granularity === 'month') {
    return toIso(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)));
  }
  // week: ISO week começa na segunda. getUTCDay() 0=domingo.
  const dayOfWeek = date.getUTCDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return toIso(date);
}

/** Lista todos os buckets entre `from` e `to`, inclusive em ambas as pontas. */
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

export function sumPoints(points: readonly MetricPoint[]): number {
  return points.reduce((acc, point) => acc + point.value, 0);
}
```

- [ ] **Step 5: Implementar `metrics.ts`**

`packages/shared/src/metrics.ts`:

```ts
import { z } from 'zod';
import { TenantContextSchema } from './tenant.js';

export const MetricSourceSchema = z.enum(['firebase', 'ga4', 'backend']);
export type MetricSource = z.infer<typeof MetricSourceSchema>;

export const MetricUnitSchema = z.enum(['count', 'currency', 'ratio', 'duration']);
export type MetricUnit = z.infer<typeof MetricUnitSchema>;

export const GranularitySchema = z.enum(['day', 'week', 'month']);
export type Granularity = z.infer<typeof GranularitySchema>;

const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'esperado YYYY-MM-DD');

/** Descreve uma métrica disponível. `id` é sempre `<source>.<nome>`. */
export const MetricDescriptorSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string(),
  source: MetricSourceSchema,
  unit: MetricUnitSchema,
  /** Dimensões pelas quais esta métrica aceita filtro ou agrupamento. */
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
  value: z.number(),
  /** Valor da dimensão de `groupBy`, quando a query agrupa. */
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

/** Formato usado pelo MCP server ao devolver a lista de métricas. */
export const MetricCatalogSchema = z.object({ metrics: z.array(MetricDescriptorSchema) });
export type MetricCatalog = z.infer<typeof MetricCatalogSchema>;
```

- [ ] **Step 6: Reexportar tudo em `index.ts`**

`packages/shared/src/index.ts`:

```ts
export * from './tenant.js';
export * from './metrics.js';
export * from './date.js';

export const PACKAGE_NAME = '@center/shared';
```

- [ ] **Step 7: Escrever o teste dos schemas**

`packages/shared/src/__tests__/metrics.test.ts`:

```ts
import { MetricQuerySchema, MetricSeriesSchema } from '../metrics.js';

const validQuery = {
  metricId: 'ga4.sessions',
  from: '2026-01-01',
  to: '2026-01-31',
  granularity: 'day',
  tenant: { organizationId: 'org_1', externalIds: { ga4PropertyId: '123456' } },
};

describe('MetricQuerySchema', () => {
  it('accepts a well formed query', () => {
    expect(MetricQuerySchema.parse(validQuery).metricId).toBe('ga4.sessions');
  });

  it('rejects a non ISO date', () => {
    const result = MetricQuerySchema.safeParse({ ...validQuery, from: '01/01/2026' });
    expect(result.success).toBe(false);
  });

  it('rejects a query without a tenant', () => {
    const { tenant: _omitted, ...withoutTenant } = validQuery;
    expect(MetricQuerySchema.safeParse(withoutTenant).success).toBe(false);
  });

  it('rejects an unknown granularity', () => {
    expect(MetricQuerySchema.safeParse({ ...validQuery, granularity: 'hour' }).success).toBe(false);
  });
});

describe('MetricSeriesSchema', () => {
  it('accepts a grouped series', () => {
    const series = MetricSeriesSchema.parse({
      metricId: 'backend.spend',
      source: 'backend',
      unit: 'currency',
      granularity: 'month',
      total: 300,
      points: [{ date: '2026-01-01', value: 300, group: 'meta_ads' }],
    });
    expect(series.points[0]?.group).toBe('meta_ads');
  });
});
```

- [ ] **Step 8: Rodar todos os testes**

Run: `pnpm --filter @center/shared test`
Expected: PASS — 3 suites, 13 testes.

- [ ] **Step 9: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add metric, tenant and date contracts"
```

---

### Task 3: Infraestrutura local e schema Prisma

**Files:**
- Create: `docker-compose.yml`, `.env.example`
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/jest.config.cjs`
- Create: `apps/api/prisma/schema.prisma`
- Create: `apps/api/src/config.ts`
- Test: `apps/api/src/__tests__/config.test.ts`, `apps/api/src/__tests__/prisma-schema.test.ts`

**Interfaces:**
- Consumes: `@center/shared` (dependência de workspace).
- Produces: `loadConfig(env: NodeJS.ProcessEnv): AppConfig`; client Prisma gerado com os models `Organization`, `User`, `WhatsAppIdentity`, `LinkCode`, `Conversation`, `Message`, `ToolCallLog`, `ProcessedWebhookEvent`.

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
docker compose up -d
docker compose ps
```

Expected: ambos os serviços `healthy`.

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
    "dev": "node --watch --experimental-strip-types src/main.ts",
    "db:migrate": "prisma migrate dev",
    "db:generate": "prisma generate"
  },
  "dependencies": {
    "@center/shared": "workspace:*",
    "@prisma/client": "^6.1.0",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "prisma": "^6.1.0"
  }
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
  coverageThreshold: {
    global: { branches: 80, functions: 80, lines: 80, statements: 80 },
  },
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

/// Tenant. `externalIds` alimenta o TenantContext de @center/shared.
model Organization {
  id                String   @id @default(cuid())
  name              String
  ga4PropertyId     String?
  firebaseProjectId String?
  backendAccountId  String?
  createdAt         DateTime @default(now())

  users              User[]
  whatsappIdentities WhatsAppIdentity[]
  conversations      Conversation[]
  toolCallLogs       ToolCallLog[]
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

/// Vínculo telefone -> usuário. Um telefone atende um único usuário.
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

/// Código de uso único emitido na dashboard e enviado pelo usuário no WhatsApp.
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

/// Auditoria: toda chamada de ferramenta do LLM é registrada.
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

/// Idempotência do webhook: a Meta reenvia eventos. O wamid é a chave natural.
model ProcessedWebhookEvent {
  wamid       String   @id
  processedAt DateTime @default(now())
}
```

- [ ] **Step 4: Rodar a migration**

`.env.example` (copie para `.env` antes de rodar):

```
DATABASE_URL="postgresql://center:center@localhost:5432/center?schema=public"
REDIS_URL="redis://localhost:6379"
JWT_SECRET="troque-isto-por-32-caracteres-no-minimo"
ANTHROPIC_API_KEY=""
GA4_CREDENTIALS_JSON=""
FIREBASE_CREDENTIALS_JSON=""
BACKEND_API_URL="http://localhost:4000"
BACKEND_API_TOKEN=""
WHATSAPP_APP_SECRET=""
WHATSAPP_VERIFY_TOKEN="troque-isto"
WHATSAPP_ACCESS_TOKEN=""
WHATSAPP_PHONE_NUMBER_ID=""
```

```bash
cp .env.example .env
cd apps/api && pnpm prisma migrate dev --name init && pnpm prisma generate
```

Expected: `migrations/<timestamp>_init/migration.sql` criado e client gerado.

- [ ] **Step 5: Escrever o teste de configuração (falhando)**

`apps/api/src/__tests__/config.test.ts`:

```ts
import { loadConfig } from '../config.js';

const validEnv = {
  DATABASE_URL: 'postgresql://center:center@localhost:5432/center',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'x'.repeat(32),
  ANTHROPIC_API_KEY: 'sk-ant-test',
  BACKEND_API_URL: 'http://localhost:4000',
  BACKEND_API_TOKEN: 'token',
  WHATSAPP_APP_SECRET: 'secret',
  WHATSAPP_VERIFY_TOKEN: 'verify',
  WHATSAPP_ACCESS_TOKEN: 'access',
  WHATSAPP_PHONE_NUMBER_ID: '123',
};

describe('loadConfig', () => {
  it('parses a complete environment', () => {
    const config = loadConfig(validEnv);
    expect(config.port).toBe(3333);
    expect(config.jwtSecret).toHaveLength(32);
  });

  it('honours an explicit PORT', () => {
    expect(loadConfig({ ...validEnv, PORT: '8080' }).port).toBe(8080);
  });

  it('throws listing the missing variable', () => {
    const { JWT_SECRET: _omitted, ...incomplete } = validEnv;
    expect(() => loadConfig(incomplete)).toThrow(/JWT_SECRET/);
  });

  it('rejects a JWT secret shorter than 32 characters', () => {
    expect(() => loadConfig({ ...validEnv, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });
});
```

- [ ] **Step 6: Rodar e confirmar que falha**

Run: `pnpm --filter @center/api test -- config.test.ts`
Expected: FAIL — `Cannot find module '../config.js'`.

- [ ] **Step 7: Implementar `config.ts`**

`apps/api/src/config.ts`:

```ts
import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3333),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET precisa de ao menos 32 caracteres'),
  ANTHROPIC_API_KEY: z.string().min(1),
  GA4_CREDENTIALS_JSON: z.string().default(''),
  FIREBASE_CREDENTIALS_JSON: z.string().default(''),
  BACKEND_API_URL: z.string().url(),
  BACKEND_API_TOKEN: z.string().min(1),
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
  anthropicApiKey: string;
  ga4CredentialsJson: string;
  firebaseCredentialsJson: string;
  backendApiUrl: string;
  backendApiToken: string;
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
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    ga4CredentialsJson: e.GA4_CREDENTIALS_JSON,
    firebaseCredentialsJson: e.FIREBASE_CREDENTIALS_JSON,
    backendApiUrl: e.BACKEND_API_URL,
    backendApiToken: e.BACKEND_API_TOKEN,
    whatsapp: {
      appSecret: e.WHATSAPP_APP_SECRET,
      verifyToken: e.WHATSAPP_VERIFY_TOKEN,
      accessToken: e.WHATSAPP_ACCESS_TOKEN,
      phoneNumberId: e.WHATSAPP_PHONE_NUMBER_ID,
    },
  };
}
```

- [ ] **Step 8: Escrever o teste do schema Prisma**

Este teste protege contra a regressão mais cara do projeto: alguém remover o índice único que garante a idempotência do webhook, ou o vínculo 1-1 telefone→usuário.

`apps/api/src/__tests__/prisma-schema.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const schema = readFileSync(join(__dirname, '../../prisma/schema.prisma'), 'utf8');

describe('prisma schema invariants', () => {
  it('keeps the webhook idempotency key as a primary key', () => {
    expect(schema).toMatch(/model ProcessedWebhookEvent \{[\s\S]*?wamid\s+String\s+@id/);
  });

  it('keeps phone and user unique on WhatsAppIdentity', () => {
    const model = schema.match(/model WhatsAppIdentity \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(model).toMatch(/phoneE164\s+String\s+@unique/);
    expect(model).toMatch(/userId\s+String\s+@unique/);
  });

  it('scopes every tenant-owned model to an organization', () => {
    for (const model of ['WhatsAppIdentity', 'Conversation', 'ToolCallLog', 'User']) {
      const body = schema.match(new RegExp(`model ${model} \\{[\\s\\S]*?\\n\\}`))?.[0] ?? '';
      expect(body).toMatch(/organizationId\s+String/);
    }
  });
});
```

- [ ] **Step 9: Rodar todos os testes**

Run: `pnpm --filter @center/api test`
Expected: PASS — 2 suites, 7 testes.

- [ ] **Step 10: Commit**

```bash
git add docker-compose.yml .env.example apps/api
git commit -m "feat(api): add docker infra, prisma schema and validated config loader"
```

---

# FASE 1 — MCP Core & Servers (Sprints 2–4)

**Objetivo da fase:** três processos MCP independentes que respondem `list_metrics` e `query_metric` sobre o mesmo contrato. Depois desta fase, trocar GA4 por outra fonte é escrever um `MetricProvider` novo — nada mais no sistema muda.

**Onde os testes entram — e por que nesta ordem:**
1. **Task 4** testa o toolkit com um provider fake, via transporte *in-memory*. Isso testa o protocolo MCP inteiro (serialização, validação, formato de erro) sem subir processo nem tocar rede. É o teste mais valioso do projeto.
2. **Tasks 6–8** testam cada *provider* isoladamente com o SDK externo mockado. O que se testa é a **tradução**: query canônica → chamada da API externa, e resposta da API externa → `MetricSeries`. Não se testa a API do Google.
3. **Task 9** testa acerto/erro de cache e a chave de cache, com um store em memória.

Nenhum teste desta fase faz chamada de rede real. A validação contra as APIs reais é manual, com os scripts de smoke de cada task.

---

### Task 4: Toolkit de MCP server em `@center/mcp-core`

**Files:**
- Create: `packages/mcp-core/package.json`, `packages/mcp-core/tsconfig.json`, `packages/mcp-core/jest.config.cjs`
- Create: `packages/mcp-core/src/provider.ts`, `packages/mcp-core/src/server.ts`, `packages/mcp-core/src/index.ts`
- Test: `packages/mcp-core/src/__tests__/server.test.ts`

**Interfaces:**
- Consumes: `MetricDescriptor`, `MetricQuery`, `MetricQuerySchema`, `MetricSeries`, `MetricSeriesSchema`, `MetricCatalogSchema` de `@center/shared`.
- Produces:
  - `interface MetricProvider { readonly descriptors: readonly MetricDescriptor[]; query(q: MetricQuery): Promise<MetricSeries>; }`
  - `interface ExtraTool { name: string; description: string; inputSchema: ZodRawShape; outputSchema: ZodRawShape; handler: (args: any) => Promise<Record<string, unknown>>; }`
  - `createMetricServer(options: CreateMetricServerOptions): McpServer` onde `CreateMetricServerOptions = { name: string; version: string; provider: MetricProvider; extraTools?: ExtraTool[] }`
  - `startStdio(server: McpServer): Promise<void>`
  - `MetricNotFoundError` (classe)

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

`packages/mcp-core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "./src", "outDir": "./dist" },
  "include": ["src/**/*"],
  "exclude": ["src/**/__tests__/**"]
}
```

`packages/mcp-core/jest.config.cjs`:

```js
module.exports = {
  ...require('../../jest.preset.cjs'),
  coverageThreshold: {
    global: { branches: 80, functions: 80, lines: 80, statements: 80 },
  },
};
```

- [ ] **Step 2: Escrever o teste do server (falhando)**

O transporte in-memory nos dá o protocolo MCP completo dentro do processo de teste. Um provider fake torna as asserções determinísticas.

`packages/mcp-core/src/__tests__/server.test.ts`:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import type { MetricDescriptor, MetricQuery, MetricSeries } from '@center/shared';
import { createMetricServer, MetricNotFoundError, type MetricProvider } from '../server.js';

const descriptors: MetricDescriptor[] = [
  {
    id: 'fake.clicks',
    label: 'Cliques',
    description: 'Cliques registrados na fonte fake',
    source: 'backend',
    unit: 'count',
    dimensions: ['promotionId'],
  },
];

function buildProvider(overrides: Partial<MetricProvider> = {}): MetricProvider {
  return {
    descriptors,
    async query(q: MetricQuery): Promise<MetricSeries> {
      if (q.metricId !== 'fake.clicks') throw new MetricNotFoundError(q.metricId);
      return {
        metricId: q.metricId,
        source: 'backend',
        unit: 'count',
        granularity: q.granularity,
        total: 30,
        points: [
          { date: '2026-01-01', value: 10 },
          { date: '2026-01-02', value: 20 },
        ],
      };
    },
    ...overrides,
  };
}

async function connect(provider: MetricProvider, extraTools = undefined as never) {
  const server = createMetricServer({
    name: 'fake-server',
    version: '1.0.0',
    provider,
    ...(extraTools ? { extraTools } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const validQuery = {
  metricId: 'fake.clicks',
  from: '2026-01-01',
  to: '2026-01-02',
  granularity: 'day' as const,
  tenant: { organizationId: 'org_1', externalIds: {} },
};

describe('createMetricServer', () => {
  it('exposes list_metrics and query_metric', async () => {
    const { client, close } = await connect(buildProvider());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['list_metrics', 'query_metric']);
    await close();
  });

  it('returns the catalog through list_metrics', async () => {
    const { client, close } = await connect(buildProvider());
    const result = await client.callTool({ name: 'list_metrics', arguments: {} });
    expect(result.structuredContent).toEqual({ metrics: descriptors });
    await close();
  });

  it('returns a metric series through query_metric', async () => {
    const { client, close } = await connect(buildProvider());
    const result = await client.callTool({ name: 'query_metric', arguments: validQuery });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ metricId: 'fake.clicks', total: 30 });
    await close();
  });

  it('reports an unknown metric as a tool error, not a crash', async () => {
    const { client, close } = await connect(buildProvider());
    const result = await client.callTool({
      name: 'query_metric',
      arguments: { ...validQuery, metricId: 'fake.unknown' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('fake.unknown');
    await close();
  });

  it('surfaces a provider failure as a tool error', async () => {
    const provider = buildProvider({
      query: async () => { throw new Error('upstream 503'); },
    });
    const { client, close } = await connect(provider);
    const result = await client.callTool({ name: 'query_metric', arguments: validQuery });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('upstream 503');
    await close();
  });

  it('rejects a query missing the tenant before reaching the provider', async () => {
    const query = jest.fn();
    const { client, close } = await connect(buildProvider({ query }));
    const { tenant: _omitted, ...withoutTenant } = validQuery;
    const result = await client.callTool({ name: 'query_metric', arguments: withoutTenant });
    expect(result.isError).toBe(true);
    expect(query).not.toHaveBeenCalled();
    await close();
  });

  it('registers extra tools alongside the metric tools', async () => {
    const server = createMetricServer({
      name: 'fake-server',
      version: '1.0.0',
      provider: buildProvider(),
      extraTools: [
        {
          name: 'list_promotions',
          description: 'Lista promoções',
          inputSchema: { activeOn: z.string() },
          outputSchema: { promotions: z.array(z.object({ id: z.string(), name: z.string() })) },
          handler: async () => ({ promotions: [{ id: 'p1', name: 'Black Friday' }] }),
        },
      ],
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('list_promotions');
    const result = await client.callTool({
      name: 'list_promotions',
      arguments: { activeOn: '2026-01-01' },
    });
    expect(result.structuredContent).toEqual({ promotions: [{ id: 'p1', name: 'Black Friday' }] });

    await client.close();
    await server.close();
  });
});
```

- [ ] **Step 3: Rodar e confirmar que falha**

Run: `pnpm --filter @center/mcp-core test`
Expected: FAIL — `Cannot find module '../server.js'`.

- [ ] **Step 4: Implementar `provider.ts`**

`packages/mcp-core/src/provider.ts`:

```ts
import type { MetricDescriptor, MetricQuery, MetricSeries } from '@center/shared';

/**
 * A única coisa que um MCP server de métricas precisa implementar.
 * Todo o protocolo fica no toolkit; o provider é lógica de tradução pura.
 */
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

- [ ] **Step 5: Implementar `server.ts`**

`packages/mcp-core/src/server.ts`:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ZodRawShape } from 'zod';
import { MetricCatalogSchema, MetricQuerySchema, MetricSeriesSchema } from '@center/shared';
import { MetricNotFoundError, type MetricProvider } from './provider.js';

export { MetricNotFoundError };
export type { MetricProvider };

export interface ExtraTool {
  name: string;
  description: string;
  inputSchema: ZodRawShape;
  outputSchema: ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

export interface CreateMetricServerOptions {
  name: string;
  version: string;
  provider: MetricProvider;
  extraTools?: ExtraTool[];
}

/** Converte um payload estruturado no envelope de resultado do MCP. */
function ok(structured: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

/**
 * Erros viram resultado-de-ferramenta, não exceção de transporte. O LLM precisa
 * conseguir ler a mensagem e tentar outra coisa; um crash de transporte derrubaria
 * a conversa inteira.
 */
function fail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  };
}

export function createMetricServer(options: CreateMetricServerOptions): McpServer {
  const { name, version, provider, extraTools = [] } = options;
  const server = new McpServer({ name, version });

  server.registerTool(
    'list_metrics',
    {
      title: 'Listar métricas',
      description:
        'Lista todas as métricas disponíveis nesta fonte, com unidade e dimensões filtráveis. ' +
        'Chame isto antes de query_metric quando não souber o metricId exato.',
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
        'Consulta uma série temporal de uma métrica em um intervalo de datas. ' +
        'Datas em YYYY-MM-DD. Retorna os pontos por bucket e o total do período.',
      inputSchema: MetricQuerySchema.shape,
      outputSchema: MetricSeriesSchema.shape,
    },
    async (args) => {
      try {
        // Revalidamos aqui: o SDK valida a forma, mas queremos as regras de
        // negócio (regex de data, tenant obrigatório) aplicadas de um lugar só.
        const query = MetricQuerySchema.parse(args);
        const known = provider.descriptors.some((d) => d.id === query.metricId);
        if (!known) throw new MetricNotFoundError(query.metricId);
        const series = await provider.query(query);
        return ok(MetricSeriesSchema.parse(series));
      } catch (error) {
        return fail(error);
      }
    },
  );

  for (const tool of extraTools) {
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
          return ok(await tool.handler(args));
        } catch (error) {
          return fail(error);
        }
      },
    );
  }

  return server;
}

/** Ponto de entrada de todo `main.ts` de MCP server. */
export async function startStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

- [ ] **Step 6: Reexportar**

`packages/mcp-core/src/index.ts`:

```ts
export * from './provider.js';
export * from './server.js';
```

- [ ] **Step 7: Rodar os testes**

Run: `pnpm --filter @center/mcp-core test`
Expected: PASS — 7 testes.

- [ ] **Step 8: Commit**

```bash
git add packages/mcp-core
git commit -m "feat(mcp-core): add metric server toolkit with uniform tool contract"
```

---

### Task 5: Pool de clientes MCP

**Files:**
- Create: `packages/mcp-core/src/pool.ts`
- Modify: `packages/mcp-core/src/index.ts`
- Test: `packages/mcp-core/src/__tests__/pool.test.ts`

**Interfaces:**
- Consumes: `createMetricServer` (Task 4); `MetricSource`, `MetricDescriptor`, `MetricQuery`, `MetricSeries` de `@center/shared`.
- Produces:
  - `interface McpServerConfig { source: MetricSource; command: string; args: string[]; env?: Record<string, string>; }`
  - `interface McpConnection { source: MetricSource; client: Client; }`
  - `class McpPool` com `static fromConnections(connections: McpConnection[]): McpPool`, `static async spawn(configs: McpServerConfig[]): Promise<McpPool>`, `listMetrics(): Promise<MetricDescriptor[]>`, `queryMetric(query: MetricQuery): Promise<MetricSeries>`, `callTool<T>(source: MetricSource, name: string, args: Record<string, unknown>): Promise<T>`, `close(): Promise<void>`
  - `class McpToolError extends Error`

**Decisão de design:** `queryMetric` roteia pelo prefixo do `metricId` (`ga4.sessions` → source `ga4`). Isso mantém o roteamento sem estado e testável, e é por isso que o `id` do descriptor é obrigatoriamente `<source>.<nome>`.

- [ ] **Step 1: Escrever o teste (falhando)**

`packages/mcp-core/src/__tests__/pool.test.ts`:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { MetricDescriptor, MetricQuery, MetricSeries, MetricSource } from '@center/shared';
import { createMetricServer, type MetricProvider } from '../server.js';
import { McpPool, McpToolError } from '../pool.js';

function descriptor(source: MetricSource, name: string): MetricDescriptor {
  return {
    id: `${source}.${name}`,
    label: name,
    description: `${name} de ${source}`,
    source,
    unit: 'count',
    dimensions: [],
  };
}

function providerFor(source: MetricSource, name: string, total: number): MetricProvider {
  return {
    descriptors: [descriptor(source, name)],
    async query(q: MetricQuery): Promise<MetricSeries> {
      return {
        metricId: q.metricId,
        source,
        unit: 'count',
        granularity: q.granularity,
        total,
        points: [{ date: q.from, value: total }],
      };
    },
  };
}

async function linkedClient(provider: MetricProvider): Promise<Client> {
  const server = createMetricServer({ name: 'srv', version: '1.0.0', provider });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'pool-test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const query: MetricQuery = {
  metricId: 'ga4.sessions',
  from: '2026-01-01',
  to: '2026-01-01',
  granularity: 'day',
  tenant: { organizationId: 'org_1', externalIds: {} },
};

describe('McpPool', () => {
  let pool: McpPool;

  beforeEach(async () => {
    pool = McpPool.fromConnections([
      { source: 'ga4', client: await linkedClient(providerFor('ga4', 'sessions', 100)) },
      { source: 'backend', client: await linkedClient(providerFor('backend', 'spend', 250)) },
    ]);
  });

  afterEach(async () => { await pool.close(); });

  it('merges the catalogs of every connected server', async () => {
    const metrics = await pool.listMetrics();
    expect(metrics.map((m) => m.id).sort()).toEqual(['backend.spend', 'ga4.sessions']);
  });

  it('routes a query to the server named by the metric id prefix', async () => {
    expect((await pool.queryMetric(query)).total).toBe(100);
    expect((await pool.queryMetric({ ...query, metricId: 'backend.spend' })).total).toBe(250);
  });

  it('throws when the metric id has no known source prefix', async () => {
    await expect(pool.queryMetric({ ...query, metricId: 'firebase.dau' }))
      .rejects.toThrow('nenhum servidor MCP conectado para a fonte "firebase"');
  });

  it('throws when the metric id has no dot separator', async () => {
    await expect(pool.queryMetric({ ...query, metricId: 'sessions' }))
      .rejects.toThrow('metricId inválido');
  });

  it('converts an MCP tool error into McpToolError', async () => {
    await expect(pool.queryMetric({ ...query, metricId: 'ga4.unknown' }))
      .rejects.toBeInstanceOf(McpToolError);
  });

  it('keeps serving the other sources when one server is missing', async () => {
    const single = McpPool.fromConnections([
      { source: 'ga4', client: await linkedClient(providerFor('ga4', 'sessions', 100)) },
    ]);
    expect((await single.listMetrics()).map((m) => m.id)).toEqual(['ga4.sessions']);
    await single.close();
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `pnpm --filter @center/mcp-core test -- pool.test.ts`
Expected: FAIL — `Cannot find module '../pool.js'`.

- [ ] **Step 3: Implementar `pool.ts`**

`packages/mcp-core/src/pool.ts`:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  MetricDescriptorSchema,
  MetricSeriesSchema,
  MetricSourceSchema,
  type MetricDescriptor,
  type MetricQuery,
  type MetricSeries,
  type MetricSource,
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

/** Erro devolvido por uma ferramenta MCP (isError: true), já desembrulhado. */
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

export class McpPool {
  private constructor(private readonly connections: Map<MetricSource, Client>) {}

  /** Usado nos testes e em qualquer cenário com transporte não-stdio. */
  static fromConnections(connections: McpConnection[]): McpPool {
    return new McpPool(new Map(connections.map((c) => [c.source, c.client])));
  }

  /** Sobe cada MCP server como processo filho e conecta via stdio. */
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
    if (!client) {
      throw new Error(`nenhum servidor MCP conectado para a fonte "${source}"`);
    }
    return client;
  }

  async callTool<T>(source: MetricSource, name: string, args: Record<string, unknown>): Promise<T> {
    const result = (await this.clientFor(source).callTool({
      name,
      arguments: args,
    })) as RawToolResult;

    if (result.isError) {
      const text = result.content?.map((part) => part.text ?? '').join(' ').trim();
      throw new McpToolError(source, name, text || 'erro desconhecido');
    }
    if (result.structuredContent === undefined) {
      throw new McpToolError(source, name, 'resposta sem structuredContent');
    }
    return result.structuredContent as T;
  }

  /** Catálogo unificado. Um server offline não derruba os demais. */
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
    const source = sourceOf(query.metricId);
    const payload = await this.callTool<unknown>(source, 'query_metric', query as unknown as Record<string, unknown>);
    return MetricSeriesSchema.parse(payload);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.connections.values()].map((client) => client.close()));
    this.connections.clear();
  }
}

/** `ga4.sessions` → `ga4`. Roteamento sem estado, derivado do próprio id. */
export function sourceOf(metricId: string): MetricSource {
  const prefix = metricId.split('.')[0];
  const parsed = MetricSourceSchema.safeParse(prefix);
  if (!parsed.success || !metricId.includes('.')) {
    throw new Error(`metricId inválido: "${metricId}" (esperado "<source>.<nome>")`);
  }
  return parsed.data;
}
```

- [ ] **Step 4: Reexportar**

`packages/mcp-core/src/index.ts`:

```ts
export * from './provider.js';
export * from './server.js';
export * from './pool.js';
```

- [ ] **Step 5: Rodar os testes**

Run: `pnpm --filter @center/mcp-core test`
Expected: PASS — 13 testes (7 de server + 6 de pool).

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-core
git commit -m "feat(mcp-core): add MCP client pool with prefix-based routing"
```

---

### Task 6: MCP server do Backend Proprietário

**Files:**
- Create: `packages/mcp-backend/package.json`, `packages/mcp-backend/tsconfig.json`, `packages/mcp-backend/jest.config.cjs`
- Create: `packages/mcp-backend/src/client.ts`, `packages/mcp-backend/src/provider.ts`, `packages/mcp-backend/src/promotions.ts`, `packages/mcp-backend/src/main.ts`
- Test: `packages/mcp-backend/src/__tests__/provider.test.ts`, `packages/mcp-backend/src/__tests__/promotions.test.ts`

**Interfaces:**
- Consumes: `createMetricServer`, `startStdio`, `MetricProvider`, `MetricNotFoundError` de `@center/mcp-core`; tipos de `@center/shared`.
- Produces:
  - `class BackendApiClient` com `fetchSpend(params)`, `fetchPromotionClicks(params)`, `fetchPromotions(params)`
  - `createBackendProvider(client: BackendApiClient): MetricProvider`
  - `createPromotionsTool(client: BackendApiClient): ExtraTool`
  - Métricas: `backend.spend` (currency, dims `channel`, `campaignId`), `backend.promotion_clicks` (count, dims `promotionId`), `backend.orders` (count, dims `channel`)

**Por que este server é o primeiro:** é a única fonte cujo contrato nós controlamos. Fazê-lo primeiro destrava a Task 11 e a Task 19 sem depender de credenciais do Google.

- [ ] **Step 1: Criar o pacote**

`packages/mcp-backend/package.json`:

```json
{
  "name": "@center/mcp-backend",
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
    "zod": "^3.24.1"
  }
}
```

`packages/mcp-backend/tsconfig.json` e `jest.config.cjs`: idênticos aos de `mcp-core` (Task 4, Step 1), trocando apenas os caminhos relativos — `"extends": "../../tsconfig.base.json"` e `require('../../jest.preset.cjs')`.

- [ ] **Step 2: Escrever o teste do provider (falhando)**

`packages/mcp-backend/src/__tests__/provider.test.ts`:

```ts
import type { MetricQuery } from '@center/shared';
import { createBackendProvider } from '../provider.js';
import type { BackendApiClient, SpendRow } from '../client.js';

function fakeClient(rows: SpendRow[]): BackendApiClient {
  return {
    fetchSpend: jest.fn(async () => rows),
    fetchPromotionClicks: jest.fn(async () => rows),
    fetchOrders: jest.fn(async () => rows),
    fetchPromotions: jest.fn(async () => []),
  } as unknown as BackendApiClient;
}

const baseQuery: MetricQuery = {
  metricId: 'backend.spend',
  from: '2026-01-01',
  to: '2026-01-03',
  granularity: 'day',
  tenant: { organizationId: 'org_1', externalIds: { backendAccountId: 'acc_9' } },
};

describe('backend provider', () => {
  it('publishes the three backend metrics', () => {
    const provider = createBackendProvider(fakeClient([]));
    expect(provider.descriptors.map((d) => d.id).sort()).toEqual([
      'backend.orders', 'backend.promotion_clicks', 'backend.spend',
    ]);
  });

  it('maps rows into a series and computes the total', async () => {
    const provider = createBackendProvider(fakeClient([
      { date: '2026-01-01', value: 100.5, group: null },
      { date: '2026-01-02', value: 200.25, group: null },
    ]));
    const series = await provider.query(baseQuery);
    expect(series).toEqual({
      metricId: 'backend.spend',
      source: 'backend',
      unit: 'currency',
      granularity: 'day',
      total: 300.75,
      points: [
        { date: '2026-01-01', value: 100.5 },
        { date: '2026-01-02', value: 200.25 },
      ],
    });
  });

  it('fills missing buckets with zero so charts have no gaps', async () => {
    const provider = createBackendProvider(fakeClient([{ date: '2026-01-02', value: 5, group: null }]));
    const series = await provider.query(baseQuery);
    expect(series.points).toEqual([
      { date: '2026-01-01', value: 0 },
      { date: '2026-01-02', value: 5 },
      { date: '2026-01-03', value: 0 },
    ]);
  });

  it('collapses daily rows into month buckets', async () => {
    const provider = createBackendProvider(fakeClient([
      { date: '2026-01-05', value: 10, group: null },
      { date: '2026-01-20', value: 15, group: null },
    ]));
    const series = await provider.query({ ...baseQuery, to: '2026-01-31', granularity: 'month' });
    expect(series.points).toEqual([{ date: '2026-01-01', value: 25 }]);
    expect(series.total).toBe(25);
  });

  it('keeps grouped rows separate when groupBy is set', async () => {
    const provider = createBackendProvider(fakeClient([
      { date: '2026-01-01', value: 60, group: 'meta_ads' },
      { date: '2026-01-01', value: 40, group: 'google_ads' },
    ]));
    const series = await provider.query({ ...baseQuery, to: '2026-01-01', groupBy: 'channel' });
    expect(series.points).toEqual([
      { date: '2026-01-01', value: 40, group: 'google_ads' },
      { date: '2026-01-01', value: 60, group: 'meta_ads' },
    ]);
    expect(series.total).toBe(100);
  });

  it('passes the tenant account id and filters down to the client', async () => {
    const client = fakeClient([]);
    const provider = createBackendProvider(client);
    await provider.query({ ...baseQuery, filters: { channel: 'meta_ads' } });
    expect(client.fetchSpend).toHaveBeenCalledWith({
      accountId: 'acc_9',
      from: '2026-01-01',
      to: '2026-01-03',
      filters: { channel: 'meta_ads' },
      groupBy: undefined,
    });
  });

  it('refuses to query when the tenant has no backend account id', async () => {
    const provider = createBackendProvider(fakeClient([]));
    await expect(
      provider.query({ ...baseQuery, tenant: { organizationId: 'org_1', externalIds: {} } }),
    ).rejects.toThrow('backendAccountId não configurado');
  });
});
```

- [ ] **Step 3: Rodar e confirmar que falha**

Run: `pnpm --filter @center/mcp-backend test`
Expected: FAIL — `Cannot find module '../provider.js'`.

- [ ] **Step 4: Implementar `client.ts`**

`packages/mcp-backend/src/client.ts`:

```ts
import { z } from 'zod';

/** Linha crua vinda do backend proprietário: uma data, um valor, um grupo opcional. */
export const SpendRowSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  value: z.number(),
  group: z.string().nullable(),
});
export type SpendRow = z.infer<typeof SpendRowSchema>;

export const PromotionSchema = z.object({
  id: z.string(),
  name: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  status: z.enum(['scheduled', 'running', 'finished']),
});
export type Promotion = z.infer<typeof PromotionSchema>;

export interface RowsParams {
  accountId: string;
  from: string;
  to: string;
  filters?: Record<string, string>;
  groupBy?: string | undefined;
}

export class BackendApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async get<T>(path: string, params: Record<string, string>, schema: z.ZodType<T>): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    const response = await this.fetchImpl(url, {
      headers: { authorization: `Bearer ${this.token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`backend respondeu ${response.status} em ${path}`);
    }
    return schema.parse(await response.json());
  }

  private rowParams(params: RowsParams): Record<string, string> {
    const query: Record<string, string> = {
      accountId: params.accountId,
      from: params.from,
      to: params.to,
    };
    if (params.groupBy) query.groupBy = params.groupBy;
    for (const [key, value] of Object.entries(params.filters ?? {})) query[`filter.${key}`] = value;
    return query;
  }

  fetchSpend(params: RowsParams): Promise<SpendRow[]> {
    return this.get('/analytics/spend', this.rowParams(params), z.array(SpendRowSchema));
  }

  fetchPromotionClicks(params: RowsParams): Promise<SpendRow[]> {
    return this.get('/analytics/promotion-clicks', this.rowParams(params), z.array(SpendRowSchema));
  }

  fetchOrders(params: RowsParams): Promise<SpendRow[]> {
    return this.get('/analytics/orders', this.rowParams(params), z.array(SpendRowSchema));
  }

  fetchPromotions(params: { accountId: string; activeOn?: string }): Promise<Promotion[]> {
    const query: Record<string, string> = { accountId: params.accountId };
    if (params.activeOn) query.activeOn = params.activeOn;
    return this.get('/promotions', query, z.array(PromotionSchema));
  }
}
```

- [ ] **Step 5: Implementar `provider.ts`**

A função `toSeries` é a peça reusada por todos os três MCP servers — bucketing, preenchimento de zeros e ordenação em um lugar só.

`packages/mcp-backend/src/provider.ts`:

```ts
import {
  bucketStart,
  eachBucket,
  type Granularity,
  type MetricDescriptor,
  type MetricQuery,
  type MetricSeries,
  type MetricUnit,
} from '@center/shared';
import { MetricNotFoundError, type MetricProvider } from '@center/mcp-core';
import type { BackendApiClient, RowsParams, SpendRow } from './client.js';

const DESCRIPTORS: MetricDescriptor[] = [
  {
    id: 'backend.spend',
    label: 'Investimento em mídia',
    description: 'Valor gasto em mídia paga, em BRL, por dia. Dimensões: channel, campaignId.',
    source: 'backend',
    unit: 'currency',
    dimensions: ['channel', 'campaignId'],
  },
  {
    id: 'backend.promotion_clicks',
    label: 'Cliques em promoções',
    description: 'Cliques registrados em promoções. Filtre por promotionId para uma promoção específica.',
    source: 'backend',
    unit: 'count',
    dimensions: ['promotionId'],
  },
  {
    id: 'backend.orders',
    label: 'Pedidos',
    description: 'Pedidos concluídos. Dimensão: channel.',
    source: 'backend',
    unit: 'count',
    dimensions: ['channel'],
  },
];

const UNIT_BY_METRIC: Record<string, MetricUnit> = {
  'backend.spend': 'currency',
  'backend.promotion_clicks': 'count',
  'backend.orders': 'count',
};

/**
 * Converte linhas diárias cruas na série canônica: agrupa por bucket, preenche
 * buckets vazios com zero (senão o gráfico ganha buracos) e ordena de forma
 * determinística por (data, grupo).
 */
export function toSeries(
  rows: readonly SpendRow[],
  query: MetricQuery,
  unit: MetricUnit,
  source: MetricSeries['source'],
): MetricSeries {
  const granularity: Granularity = query.granularity;
  const totals = new Map<string, number>();

  for (const row of rows) {
    const bucket = bucketStart(row.date, granularity);
    const key = `${bucket} ${row.group ?? ''}`;
    totals.set(key, (totals.get(key) ?? 0) + row.value);
  }

  const groups = query.groupBy
    ? [...new Set(rows.map((row) => row.group ?? ''))].sort()
    : [''];

  const points = eachBucket(query.from, query.to, granularity).flatMap((bucket) =>
    groups.map((group) => {
      const value = totals.get(`${bucket} ${group}`) ?? 0;
      return group ? { date: bucket, value, group } : { date: bucket, value };
    }),
  );

  return {
    metricId: query.metricId,
    source,
    unit,
    granularity,
    total: points.reduce((acc, point) => acc + point.value, 0),
    points,
  };
}

export function createBackendProvider(client: BackendApiClient): MetricProvider {
  return {
    descriptors: DESCRIPTORS,

    async query(query: MetricQuery): Promise<MetricSeries> {
      const accountId = query.tenant.externalIds.backendAccountId;
      if (!accountId) {
        throw new Error(
          `backendAccountId não configurado para a organização "${query.tenant.organizationId}"`,
        );
      }

      const params: RowsParams = {
        accountId,
        from: query.from,
        to: query.to,
        filters: query.filters ?? {},
        groupBy: query.groupBy,
      };

      let rows: SpendRow[];
      switch (query.metricId) {
        case 'backend.spend': rows = await client.fetchSpend(params); break;
        case 'backend.promotion_clicks': rows = await client.fetchPromotionClicks(params); break;
        case 'backend.orders': rows = await client.fetchOrders(params); break;
        default: throw new MetricNotFoundError(query.metricId);
      }

      return toSeries(rows, query, UNIT_BY_METRIC[query.metricId] ?? 'count', 'backend');
    },
  };
}
```

> **Nota para os implementadores das Tasks 7 e 8:** `toSeries` é reusada pelos servers de GA4 e Firebase. Ao chegar na Task 7, mova-a de `packages/mcp-backend/src/provider.ts` para `packages/mcp-core/src/series.ts`, reexporte em `packages/mcp-core/src/index.ts` e importe nos três servers. O teste "fills missing buckets with zero" acompanha a função.

- [ ] **Step 6: Escrever o teste da ferramenta de promoções (falhando)**

`packages/mcp-backend/src/__tests__/promotions.test.ts`:

```ts
import type { BackendApiClient, Promotion } from '../client.js';
import { createPromotionsTool } from '../promotions.js';

const promotions: Promotion[] = [
  { id: 'p1', name: 'Black Friday', startsAt: '2026-11-20', endsAt: '2026-11-30', status: 'finished' },
];

function fakeClient(): BackendApiClient {
  return { fetchPromotions: jest.fn(async () => promotions) } as unknown as BackendApiClient;
}

describe('list_promotions tool', () => {
  it('is named list_promotions', () => {
    expect(createPromotionsTool(fakeClient()).name).toBe('list_promotions');
  });

  it('returns the promotions for the tenant account', async () => {
    const client = fakeClient();
    const result = await createPromotionsTool(client).handler({
      tenant: { organizationId: 'org_1', externalIds: { backendAccountId: 'acc_9' } },
      activeOn: '2026-11-25',
    });
    expect(result).toEqual({ promotions });
    expect(client.fetchPromotions).toHaveBeenCalledWith({ accountId: 'acc_9', activeOn: '2026-11-25' });
  });

  it('refuses when the tenant has no backend account id', async () => {
    await expect(
      createPromotionsTool(fakeClient()).handler({
        tenant: { organizationId: 'org_1', externalIds: {} },
      }),
    ).rejects.toThrow('backendAccountId não configurado');
  });
});
```

- [ ] **Step 7: Implementar `promotions.ts`**

Esta ferramenta existe para **resolução de entidade**: o usuário do WhatsApp diz "promoção Black Friday", e o LLM precisa converter isso num `promotionId` antes de chamar `query_metric`.

`packages/mcp-backend/src/promotions.ts`:

```ts
import { z } from 'zod';
import { TenantContextSchema } from '@center/shared';
import type { ExtraTool } from '@center/mcp-core';
import { PromotionSchema, type BackendApiClient } from './client.js';

const InputSchema = z.object({
  tenant: TenantContextSchema,
  activeOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export function createPromotionsTool(client: BackendApiClient): ExtraTool {
  return {
    name: 'list_promotions',
    description:
      'Lista as promoções da conta com id, nome, período e status. Use isto para converter o ' +
      'nome de uma promoção citada pelo usuário no promotionId exigido pelo filtro de query_metric.',
    inputSchema: { tenant: TenantContextSchema, activeOn: z.string().optional() },
    outputSchema: { promotions: z.array(PromotionSchema) },
    handler: async (args) => {
      const { tenant, activeOn } = InputSchema.parse(args);
      const accountId = tenant.externalIds.backendAccountId;
      if (!accountId) {
        throw new Error(`backendAccountId não configurado para a organização "${tenant.organizationId}"`);
      }
      const promotions = await client.fetchPromotions(
        activeOn ? { accountId, activeOn } : { accountId },
      );
      return { promotions };
    },
  };
}
```

- [ ] **Step 8: Implementar `main.ts`**

`packages/mcp-backend/src/main.ts`:

```ts
import { createMetricServer, startStdio } from '@center/mcp-core';
import { BackendApiClient } from './client.js';
import { createBackendProvider } from './provider.js';
import { createPromotionsTool } from './promotions.js';

const baseUrl = process.env.BACKEND_API_URL;
const token = process.env.BACKEND_API_TOKEN;
if (!baseUrl || !token) {
  // stderr, nunca stdout: stdout é o canal do protocolo MCP.
  console.error('mcp-backend: BACKEND_API_URL e BACKEND_API_TOKEN são obrigatórios');
  process.exit(1);
}

const client = new BackendApiClient(baseUrl, token);

await startStdio(
  createMetricServer({
    name: 'center-backend',
    version: '1.0.0',
    provider: createBackendProvider(client),
    extraTools: [createPromotionsTool(client)],
  }),
);
```

- [ ] **Step 9: Rodar os testes**

Run: `pnpm --filter @center/mcp-backend test`
Expected: PASS — 10 testes.

- [ ] **Step 10: Smoke test manual contra o backend real**

```bash
pnpm --filter @center/mcp-backend build
BACKEND_API_URL=http://localhost:4000 BACKEND_API_TOKEN=<token> \
  npx @modelcontextprotocol/inspector node packages/mcp-backend/dist/main.js
```

Abra o Inspector no navegador, chame `list_metrics` (deve retornar 3 métricas) e `query_metric` com `{"metricId":"backend.spend","from":"2026-01-01","to":"2026-01-31","granularity":"day","tenant":{"organizationId":"org_1","externalIds":{"backendAccountId":"<id real>"}}}`.

- [ ] **Step 11: Commit**

```bash
git add packages/mcp-backend
git commit -m "feat(mcp-backend): add spend, clicks, orders metrics and promotions tool"
```

---

### Task 7: MCP server do Google Analytics 4

**Files:**
- Create: `packages/mcp-ga4/package.json`, `packages/mcp-ga4/tsconfig.json`, `packages/mcp-ga4/jest.config.cjs`
- Create: `packages/mcp-ga4/src/client.ts`, `packages/mcp-ga4/src/provider.ts`, `packages/mcp-ga4/src/main.ts`
- Create: `packages/mcp-core/src/series.ts` (movido da Task 6)
- Modify: `packages/mcp-core/src/index.ts`, `packages/mcp-backend/src/provider.ts` (passa a importar `toSeries` de `@center/mcp-core`)
- Test: `packages/mcp-ga4/src/__tests__/provider.test.ts`, `packages/mcp-core/src/__tests__/series.test.ts`

**Interfaces:**
- Consumes: `toSeries`, `MetricNotFoundError`, `MetricProvider`, `createMetricServer`, `startStdio` de `@center/mcp-core`.
- Produces:
  - `class Ga4Client` com `runReport(params: Ga4ReportParams): Promise<SeriesRow[]>`
  - `createGa4Provider(client: Ga4Client): MetricProvider`
  - `interface SeriesRow { date: string; value: number; group: string | null }` (exportado de `@center/mcp-core`, substitui `SpendRow` como tipo canônico de linha crua)
  - Métricas: `ga4.sessions`, `ga4.active_users`, `ga4.conversions`, `ga4.event_count` (todas `count`, dims `campaignName`, `sourceMedium`, `eventName`, `country`)

- [ ] **Step 1: Mover `toSeries` para `@center/mcp-core`**

Crie `packages/mcp-core/src/series.ts` com **exatamente** o conteúdo da função `toSeries` e o tipo de linha, agora com nome canônico:

```ts
import {
  bucketStart,
  eachBucket,
  type Granularity,
  type MetricQuery,
  type MetricSeries,
  type MetricSource,
  type MetricUnit,
} from '@center/shared';

/** Linha crua de qualquer fonte: uma data diária, um valor, um grupo opcional. */
export interface SeriesRow {
  date: string;
  value: number;
  group: string | null;
}

/**
 * Converte linhas diárias cruas na série canônica: agrupa por bucket, preenche
 * buckets vazios com zero (senão o gráfico ganha buracos) e ordena de forma
 * determinística por (data, grupo).
 */
export function toSeries(
  rows: readonly SeriesRow[],
  query: MetricQuery,
  unit: MetricUnit,
  source: MetricSource,
): MetricSeries {
  const granularity: Granularity = query.granularity;
  const totals = new Map<string, number>();

  for (const row of rows) {
    const bucket = bucketStart(row.date, granularity);
    const key = `${bucket} ${row.group ?? ''}`;
    totals.set(key, (totals.get(key) ?? 0) + row.value);
  }

  const groups = query.groupBy ? [...new Set(rows.map((row) => row.group ?? ''))].sort() : [''];

  const points = eachBucket(query.from, query.to, granularity).flatMap((bucket) =>
    groups.map((group) => {
      const value = totals.get(`${bucket} ${group}`) ?? 0;
      return group ? { date: bucket, value, group } : { date: bucket, value };
    }),
  );

  return {
    metricId: query.metricId,
    source,
    unit,
    granularity,
    total: points.reduce((acc, point) => acc + point.value, 0),
    points,
  };
}
```

Adicione `export * from './series.js';` em `packages/mcp-core/src/index.ts`. Em `packages/mcp-backend/src/provider.ts`, remova a definição local de `toSeries` e troque o import por `import { MetricNotFoundError, toSeries, type MetricProvider } from '@center/mcp-core';`. Em `packages/mcp-backend/src/client.ts`, mantenha `SpendRow` como alias: `export type SpendRow = SeriesRow;` importando `SeriesRow` de `@center/mcp-core`.

- [ ] **Step 2: Mover os testes de bucketing junto**

Crie `packages/mcp-core/src/__tests__/series.test.ts` movendo os casos "fills missing buckets with zero", "collapses daily rows into month buckets" e "keeps grouped rows separate when groupBy is set" do arquivo `packages/mcp-backend/src/__tests__/provider.test.ts`, reescritos para chamar `toSeries` diretamente:

```ts
import type { MetricQuery } from '@center/shared';
import { toSeries, type SeriesRow } from '../series.js';

const query: MetricQuery = {
  metricId: 'ga4.sessions',
  from: '2026-01-01',
  to: '2026-01-03',
  granularity: 'day',
  tenant: { organizationId: 'org_1', externalIds: {} },
};

describe('toSeries', () => {
  it('fills missing buckets with zero so charts have no gaps', () => {
    const rows: SeriesRow[] = [{ date: '2026-01-02', value: 5, group: null }];
    expect(toSeries(rows, query, 'count', 'ga4').points).toEqual([
      { date: '2026-01-01', value: 0 },
      { date: '2026-01-02', value: 5 },
      { date: '2026-01-03', value: 0 },
    ]);
  });

  it('collapses daily rows into month buckets', () => {
    const rows: SeriesRow[] = [
      { date: '2026-01-05', value: 10, group: null },
      { date: '2026-01-20', value: 15, group: null },
    ];
    const series = toSeries(rows, { ...query, to: '2026-01-31', granularity: 'month' }, 'count', 'ga4');
    expect(series.points).toEqual([{ date: '2026-01-01', value: 25 }]);
    expect(series.total).toBe(25);
  });

  it('keeps grouped rows separate and sorted when groupBy is set', () => {
    const rows: SeriesRow[] = [
      { date: '2026-01-01', value: 60, group: 'meta_ads' },
      { date: '2026-01-01', value: 40, group: 'google_ads' },
    ];
    const series = toSeries(rows, { ...query, to: '2026-01-01', groupBy: 'channel' }, 'count', 'ga4');
    expect(series.points).toEqual([
      { date: '2026-01-01', value: 40, group: 'google_ads' },
      { date: '2026-01-01', value: 60, group: 'meta_ads' },
    ]);
    expect(series.total).toBe(100);
  });

  it('sums two rows that land in the same bucket', () => {
    const rows: SeriesRow[] = [
      { date: '2026-01-01', value: 3, group: null },
      { date: '2026-01-01', value: 4, group: null },
    ];
    expect(toSeries(rows, { ...query, to: '2026-01-01' }, 'count', 'ga4').total).toBe(7);
  });
});
```

Run: `pnpm --filter @center/mcp-core test && pnpm --filter @center/mcp-backend test`
Expected: PASS em ambos.

- [ ] **Step 3: Criar o pacote `@center/mcp-ga4`**

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
    "@google-analytics/data": "^4.12.0"
  }
}
```

`tsconfig.json` e `jest.config.cjs` seguem o mesmo molde da Task 4, Step 1.

- [ ] **Step 4: Escrever o teste do provider (falhando)**

O que se testa aqui é a **tradução**, não o GA4: a query canônica vira os parâmetros certos de `runReport`, e o retorno do GA4 vira `MetricSeries`.

`packages/mcp-ga4/src/__tests__/provider.test.ts`:

```ts
import type { MetricQuery } from '@center/shared';
import type { SeriesRow } from '@center/mcp-core';
import { createGa4Provider } from '../provider.js';
import type { Ga4Client, Ga4ReportParams } from '../client.js';

function fakeClient(rows: SeriesRow[]) {
  const runReport = jest.fn(async (_params: Ga4ReportParams) => rows);
  return { client: { runReport } as unknown as Ga4Client, runReport };
}

const baseQuery: MetricQuery = {
  metricId: 'ga4.sessions',
  from: '2026-02-01',
  to: '2026-02-02',
  granularity: 'day',
  tenant: { organizationId: 'org_1', externalIds: { ga4PropertyId: '987654321' } },
};

describe('ga4 provider', () => {
  it('publishes the four ga4 metrics', () => {
    const { client } = fakeClient([]);
    expect(createGa4Provider(client).descriptors.map((d) => d.id).sort()).toEqual([
      'ga4.active_users', 'ga4.conversions', 'ga4.event_count', 'ga4.sessions',
    ]);
  });

  it('translates the canonical query into GA4 report params', async () => {
    const { client, runReport } = fakeClient([]);
    await createGa4Provider(client).query(baseQuery);
    expect(runReport).toHaveBeenCalledWith({
      propertyId: '987654321',
      ga4MetricName: 'sessions',
      from: '2026-02-01',
      to: '2026-02-02',
      dimensionFilters: {},
      groupByDimension: undefined,
    });
  });

  it('maps each metric id to its GA4 metric name', async () => {
    const { client, runReport } = fakeClient([]);
    const provider = createGa4Provider(client);
    await provider.query({ ...baseQuery, metricId: 'ga4.active_users' });
    await provider.query({ ...baseQuery, metricId: 'ga4.conversions' });
    await provider.query({ ...baseQuery, metricId: 'ga4.event_count' });
    expect(runReport.mock.calls.map((call) => call[0].ga4MetricName)).toEqual([
      'activeUsers', 'conversions', 'eventCount',
    ]);
  });

  it('forwards filters and groupBy as GA4 dimensions', async () => {
    const { client, runReport } = fakeClient([]);
    await createGa4Provider(client).query({
      ...baseQuery,
      filters: { campaignName: 'black-friday' },
      groupBy: 'sourceMedium',
    });
    expect(runReport.mock.calls[0]?.[0]).toMatchObject({
      dimensionFilters: { campaignName: 'black-friday' },
      groupByDimension: 'sourceMedium',
    });
  });

  it('returns a zero-filled series built from the GA4 rows', async () => {
    const { client } = fakeClient([{ date: '2026-02-02', value: 42, group: null }]);
    const series = await createGa4Provider(client).query(baseQuery);
    expect(series).toEqual({
      metricId: 'ga4.sessions',
      source: 'ga4',
      unit: 'count',
      granularity: 'day',
      total: 42,
      points: [
        { date: '2026-02-01', value: 0 },
        { date: '2026-02-02', value: 42 },
      ],
    });
  });

  it('refuses to query when the tenant has no GA4 property id', async () => {
    const { client } = fakeClient([]);
    await expect(
      createGa4Provider(client).query({ ...baseQuery, tenant: { organizationId: 'org_1', externalIds: {} } }),
    ).rejects.toThrow('ga4PropertyId não configurado');
  });

  it('rejects a filter on a dimension the metric does not declare', async () => {
    const { client } = fakeClient([]);
    await expect(
      createGa4Provider(client).query({ ...baseQuery, filters: { productSku: 'abc' } }),
    ).rejects.toThrow('dimensão não suportada: "productSku"');
  });
});
```

- [ ] **Step 5: Rodar e confirmar que falha**

Run: `pnpm --filter @center/mcp-ga4 test`
Expected: FAIL — `Cannot find module '../provider.js'`.

- [ ] **Step 6: Implementar `client.ts`**

`packages/mcp-ga4/src/client.ts`:

```ts
import { BetaAnalyticsDataClient } from '@google-analytics/data';
import type { SeriesRow } from '@center/mcp-core';

export interface Ga4ReportParams {
  propertyId: string;
  ga4MetricName: string;
  from: string;
  to: string;
  dimensionFilters: Record<string, string>;
  groupByDimension?: string | undefined;
}

/** `20260201` (formato do GA4) → `2026-02-01`. */
function fromGa4Date(compact: string): string {
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

export class Ga4Client {
  constructor(private readonly api: BetaAnalyticsDataClient) {}

  static fromCredentialsJson(credentialsJson: string): Ga4Client {
    const credentials = JSON.parse(credentialsJson) as { client_email: string; private_key: string };
    return new Ga4Client(new BetaAnalyticsDataClient({ credentials }));
  }

  async runReport(params: Ga4ReportParams): Promise<SeriesRow[]> {
    const dimensions = [{ name: 'date' }];
    if (params.groupByDimension) dimensions.push({ name: params.groupByDimension });

    const filterEntries = Object.entries(params.dimensionFilters);
    const [response] = await this.api.runReport({
      property: `properties/${params.propertyId}`,
      dateRanges: [{ startDate: params.from, endDate: params.to }],
      dimensions,
      metrics: [{ name: params.ga4MetricName }],
      limit: 100_000,
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

    return (response.rows ?? []).map((row): SeriesRow => {
      const dimensionValues = row.dimensionValues ?? [];
      return {
        date: fromGa4Date(dimensionValues[0]?.value ?? ''),
        value: Number(row.metricValues?.[0]?.value ?? 0),
        group: params.groupByDimension ? (dimensionValues[1]?.value ?? null) : null,
      };
    });
  }
}
```

- [ ] **Step 7: Implementar `provider.ts`**

`packages/mcp-ga4/src/provider.ts`:

```ts
import type { MetricDescriptor, MetricQuery, MetricSeries } from '@center/shared';
import { MetricNotFoundError, toSeries, type MetricProvider } from '@center/mcp-core';
import type { Ga4Client } from './client.js';

const SHARED_DIMENSIONS = ['campaignName', 'sourceMedium', 'eventName', 'country'];

const DESCRIPTORS: MetricDescriptor[] = [
  {
    id: 'ga4.sessions',
    label: 'Sessões',
    description: 'Sessões no site/web app medidas pelo GA4.',
    source: 'ga4', unit: 'count', dimensions: SHARED_DIMENSIONS,
  },
  {
    id: 'ga4.active_users',
    label: 'Usuários ativos',
    description: 'Usuários ativos distintos no período, medidos pelo GA4.',
    source: 'ga4', unit: 'count', dimensions: SHARED_DIMENSIONS,
  },
  {
    id: 'ga4.conversions',
    label: 'Conversões',
    description: 'Eventos marcados como conversão no GA4.',
    source: 'ga4', unit: 'count', dimensions: SHARED_DIMENSIONS,
  },
  {
    id: 'ga4.event_count',
    label: 'Eventos',
    description: 'Contagem total de eventos. Filtre por eventName para um evento específico.',
    source: 'ga4', unit: 'count', dimensions: SHARED_DIMENSIONS,
  },
];

const GA4_METRIC_NAME: Record<string, string> = {
  'ga4.sessions': 'sessions',
  'ga4.active_users': 'activeUsers',
  'ga4.conversions': 'conversions',
  'ga4.event_count': 'eventCount',
};

export function createGa4Provider(client: Ga4Client): MetricProvider {
  return {
    descriptors: DESCRIPTORS,

    async query(query: MetricQuery): Promise<MetricSeries> {
      const propertyId = query.tenant.externalIds.ga4PropertyId;
      if (!propertyId) {
        throw new Error(`ga4PropertyId não configurado para a organização "${query.tenant.organizationId}"`);
      }

      const ga4MetricName = GA4_METRIC_NAME[query.metricId];
      if (!ga4MetricName) throw new MetricNotFoundError(query.metricId);

      const filters = query.filters ?? {};
      // Validamos as dimensões aqui para que um LLM que inventou um nome receba
      // uma mensagem útil em vez de um 400 opaco do Google.
      for (const dimension of [...Object.keys(filters), ...(query.groupBy ? [query.groupBy] : [])]) {
        if (!SHARED_DIMENSIONS.includes(dimension)) {
          throw new Error(
            `dimensão não suportada: "${dimension}". Disponíveis: ${SHARED_DIMENSIONS.join(', ')}`,
          );
        }
      }

      const rows = await client.runReport({
        propertyId,
        ga4MetricName,
        from: query.from,
        to: query.to,
        dimensionFilters: filters,
        groupByDimension: query.groupBy,
      });

      return toSeries(rows, query, 'count', 'ga4');
    },
  };
}
```

- [ ] **Step 8: Implementar `main.ts`**

`packages/mcp-ga4/src/main.ts`:

```ts
import { createMetricServer, startStdio } from '@center/mcp-core';
import { Ga4Client } from './client.js';
import { createGa4Provider } from './provider.js';

const credentialsJson = process.env.GA4_CREDENTIALS_JSON;
if (!credentialsJson) {
  console.error('mcp-ga4: GA4_CREDENTIALS_JSON é obrigatório (JSON da service account)');
  process.exit(1);
}

await startStdio(
  createMetricServer({
    name: 'center-ga4',
    version: '1.0.0',
    provider: createGa4Provider(Ga4Client.fromCredentialsJson(credentialsJson)),
  }),
);
```

- [ ] **Step 9: Rodar os testes**

Run: `pnpm --filter @center/mcp-ga4 test`
Expected: PASS — 7 testes.

- [ ] **Step 10: Smoke test manual contra o GA4 real**

Pré-requisito: a service account precisa do papel **Viewer** na propriedade GA4 (Admin → Property Access Management) e a **Google Analytics Data API** habilitada no projeto GCP.

```bash
pnpm --filter @center/mcp-ga4 build
GA4_CREDENTIALS_JSON="$(cat ./ga4-service-account.json)" \
  npx @modelcontextprotocol/inspector node packages/mcp-ga4/dist/main.js
```

Chame `query_metric` com `ga4.sessions` sobre os últimos 7 dias e compare o total com a interface do GA4. **Divergências de até ~2% são esperadas** (sampling e data freshness); acima disso, investigue antes de seguir.

- [ ] **Step 11: Commit**

```bash
git add packages/mcp-core packages/mcp-backend packages/mcp-ga4
git commit -m "feat(mcp-ga4): add GA4 metrics server and extract shared toSeries"
```

---

### Task 8: MCP server do Firebase

**Files:**
- Create: `packages/mcp-firebase/package.json`, `packages/mcp-firebase/tsconfig.json`, `packages/mcp-firebase/jest.config.cjs`
- Create: `packages/mcp-firebase/src/client.ts`, `packages/mcp-firebase/src/provider.ts`, `packages/mcp-firebase/src/main.ts`
- Test: `packages/mcp-firebase/src/__tests__/provider.test.ts`

**Interfaces:**
- Consumes: `toSeries`, `SeriesRow`, `MetricNotFoundError`, `MetricProvider`, `createMetricServer`, `startStdio` de `@center/mcp-core`.
- Produces:
  - `class FirestoreMetricsClient` com `fetchDailyRollups(params: RollupParams): Promise<SeriesRow[]>`
  - `createFirebaseProvider(client: FirestoreMetricsClient): MetricProvider`
  - Métricas: `firebase.app_opens`, `firebase.active_devices`, `firebase.push_delivered`, `firebase.in_app_events` (todas `count`, dims `platform`, `appVersion`, `eventName`)

> **Decisão de arquitetura registrada:** o Firebase Admin SDK **não** expõe a API de Google Analytics for Firebase. Eventos de analytics do app só saem por (a) GA4 Data API na mesma propriedade — já coberto pela Task 7 — ou (b) export para BigQuery. Este server lê **rollups diários agregados que o app mobile escreve no Firestore**, na coleção `metric_rollups`. Se o time mobile não escrever esses rollups, esta task muda de escopo: veja o Risco R3.

**Documento esperado em `metric_rollups`:**
```
{ projectId: string, metric: string, date: 'YYYY-MM-DD',
  platform: 'ios'|'android', appVersion: string, eventName: string|null, value: number }
```

- [ ] **Step 1: Criar o pacote**

`packages/mcp-firebase/package.json`:

```json
{
  "name": "@center/mcp-firebase",
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
    "firebase-admin": "^13.0.2"
  }
}
```

`tsconfig.json` e `jest.config.cjs` seguem o molde da Task 4, Step 1.

- [ ] **Step 2: Escrever o teste (falhando)**

`packages/mcp-firebase/src/__tests__/provider.test.ts`:

```ts
import type { MetricQuery } from '@center/shared';
import type { SeriesRow } from '@center/mcp-core';
import { createFirebaseProvider } from '../provider.js';
import type { FirestoreMetricsClient, RollupParams } from '../client.js';

function fakeClient(rows: SeriesRow[]) {
  const fetchDailyRollups = jest.fn(async (_params: RollupParams) => rows);
  return { client: { fetchDailyRollups } as unknown as FirestoreMetricsClient, fetchDailyRollups };
}

const baseQuery: MetricQuery = {
  metricId: 'firebase.app_opens',
  from: '2026-04-01',
  to: '2026-04-02',
  granularity: 'day',
  tenant: { organizationId: 'org_1', externalIds: { firebaseProjectId: 'meu-app-prod' } },
};

describe('firebase provider', () => {
  it('publishes the four firebase metrics', () => {
    const { client } = fakeClient([]);
    expect(createFirebaseProvider(client).descriptors.map((d) => d.id).sort()).toEqual([
      'firebase.active_devices', 'firebase.app_opens', 'firebase.in_app_events', 'firebase.push_delivered',
    ]);
  });

  it('translates the canonical query into rollup params', async () => {
    const { client, fetchDailyRollups } = fakeClient([]);
    await createFirebaseProvider(client).query({ ...baseQuery, filters: { platform: 'ios' } });
    expect(fetchDailyRollups).toHaveBeenCalledWith({
      projectId: 'meu-app-prod',
      metric: 'app_opens',
      from: '2026-04-01',
      to: '2026-04-02',
      filters: { platform: 'ios' },
      groupBy: undefined,
    });
  });

  it('strips the firebase prefix from every metric id', async () => {
    const { client, fetchDailyRollups } = fakeClient([]);
    const provider = createFirebaseProvider(client);
    await provider.query({ ...baseQuery, metricId: 'firebase.active_devices' });
    await provider.query({ ...baseQuery, metricId: 'firebase.push_delivered' });
    expect(fetchDailyRollups.mock.calls.map((call) => call[0].metric)).toEqual([
      'active_devices', 'push_delivered',
    ]);
  });

  it('returns a zero-filled series', async () => {
    const { client } = fakeClient([{ date: '2026-04-01', value: 1200, group: null }]);
    const series = await createFirebaseProvider(client).query(baseQuery);
    expect(series).toEqual({
      metricId: 'firebase.app_opens',
      source: 'firebase',
      unit: 'count',
      granularity: 'day',
      total: 1200,
      points: [
        { date: '2026-04-01', value: 1200 },
        { date: '2026-04-02', value: 0 },
      ],
    });
  });

  it('refuses to query when the tenant has no firebase project id', async () => {
    const { client } = fakeClient([]);
    await expect(
      createFirebaseProvider(client).query({ ...baseQuery, tenant: { organizationId: 'org_1', externalIds: {} } }),
    ).rejects.toThrow('firebaseProjectId não configurado');
  });

  it('rejects an unknown metric id', async () => {
    const { client } = fakeClient([]);
    await expect(
      createFirebaseProvider(client).query({ ...baseQuery, metricId: 'firebase.revenue' }),
    ).rejects.toThrow('métrica desconhecida');
  });

  it('rejects a filter on an undeclared dimension', async () => {
    const { client } = fakeClient([]);
    await expect(
      createFirebaseProvider(client).query({ ...baseQuery, filters: { osVersion: '17' } }),
    ).rejects.toThrow('dimensão não suportada: "osVersion"');
  });
});
```

- [ ] **Step 3: Rodar e confirmar que falha**

Run: `pnpm --filter @center/mcp-firebase test`
Expected: FAIL — `Cannot find module '../provider.js'`.

- [ ] **Step 4: Implementar `client.ts`**

`packages/mcp-firebase/src/client.ts`:

```ts
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import type { SeriesRow } from '@center/mcp-core';

export interface RollupParams {
  projectId: string;
  metric: string;
  from: string;
  to: string;
  filters: Record<string, string>;
  groupBy?: string | undefined;
}

const COLLECTION = 'metric_rollups';

export class FirestoreMetricsClient {
  constructor(private readonly firestore: Firestore) {}

  static fromCredentialsJson(credentialsJson: string): FirestoreMetricsClient {
    const credentials = JSON.parse(credentialsJson) as {
      project_id: string; client_email: string; private_key: string;
    };
    const app = getApps().length > 0
      ? getApps()[0]!
      : initializeApp({ credential: cert(credentials) });
    return new FirestoreMetricsClient(getFirestore(app));
  }

  async fetchDailyRollups(params: RollupParams): Promise<SeriesRow[]> {
    let query = this.firestore
      .collection(COLLECTION)
      .where('projectId', '==', params.projectId)
      .where('metric', '==', params.metric)
      .where('date', '>=', params.from)
      .where('date', '<=', params.to);

    for (const [field, value] of Object.entries(params.filters)) {
      query = query.where(field, '==', value);
    }

    const snapshot = await query.get();
    return snapshot.docs.map((doc): SeriesRow => {
      const data = doc.data() as Record<string, unknown>;
      return {
        date: String(data.date ?? ''),
        value: Number(data.value ?? 0),
        group: params.groupBy ? String(data[params.groupBy] ?? '') : null,
      };
    });
  }
}
```

> **Índice composto obrigatório.** A query acima exige um índice em `metric_rollups` com os campos `projectId (asc), metric (asc), date (asc)`. Crie-o em `firestore.indexes.json` e faça deploy com `firebase deploy --only firestore:indexes` **antes** do smoke test — sem ele, a query falha com `FAILED_PRECONDITION` e um link para criar o índice. Cada dimensão adicional usada como filtro exige seu próprio índice composto; por isso a lista de dimensões é fechada.

- [ ] **Step 5: Implementar `provider.ts`**

`packages/mcp-firebase/src/provider.ts`:

```ts
import type { MetricDescriptor, MetricQuery, MetricSeries } from '@center/shared';
import { MetricNotFoundError, toSeries, type MetricProvider } from '@center/mcp-core';
import type { FirestoreMetricsClient } from './client.js';

const DIMENSIONS = ['platform', 'appVersion', 'eventName'];

const DESCRIPTORS: MetricDescriptor[] = [
  {
    id: 'firebase.app_opens',
    label: 'Aberturas do app',
    description: 'Aberturas do aplicativo mobile por dia. Dimensões: platform (ios|android), appVersion.',
    source: 'firebase', unit: 'count', dimensions: DIMENSIONS,
  },
  {
    id: 'firebase.active_devices',
    label: 'Dispositivos ativos',
    description: 'Dispositivos distintos que usaram o app no dia.',
    source: 'firebase', unit: 'count', dimensions: DIMENSIONS,
  },
  {
    id: 'firebase.push_delivered',
    label: 'Push entregues',
    description: 'Notificações push entregues via FCM.',
    source: 'firebase', unit: 'count', dimensions: DIMENSIONS,
  },
  {
    id: 'firebase.in_app_events',
    label: 'Eventos in-app',
    description: 'Eventos customizados registrados pelo app. Filtre por eventName.',
    source: 'firebase', unit: 'count', dimensions: DIMENSIONS,
  },
];

const KNOWN_IDS = new Set(DESCRIPTORS.map((d) => d.id));

export function createFirebaseProvider(client: FirestoreMetricsClient): MetricProvider {
  return {
    descriptors: DESCRIPTORS,

    async query(query: MetricQuery): Promise<MetricSeries> {
      const projectId = query.tenant.externalIds.firebaseProjectId;
      if (!projectId) {
        throw new Error(
          `firebaseProjectId não configurado para a organização "${query.tenant.organizationId}"`,
        );
      }
      if (!KNOWN_IDS.has(query.metricId)) throw new MetricNotFoundError(query.metricId);

      const filters = query.filters ?? {};
      for (const dimension of [...Object.keys(filters), ...(query.groupBy ? [query.groupBy] : [])]) {
        if (!DIMENSIONS.includes(dimension)) {
          throw new Error(`dimensão não suportada: "${dimension}". Disponíveis: ${DIMENSIONS.join(', ')}`);
        }
      }

      const rows = await client.fetchDailyRollups({
        projectId,
        metric: query.metricId.replace('firebase.', ''),
        from: query.from,
        to: query.to,
        filters,
        groupBy: query.groupBy,
      });

      return toSeries(rows, query, 'count', 'firebase');
    },
  };
}
```

- [ ] **Step 6: Implementar `main.ts`**

`packages/mcp-firebase/src/main.ts`:

```ts
import { createMetricServer, startStdio } from '@center/mcp-core';
import { FirestoreMetricsClient } from './client.js';
import { createFirebaseProvider } from './provider.js';

const credentialsJson = process.env.FIREBASE_CREDENTIALS_JSON;
if (!credentialsJson) {
  console.error('mcp-firebase: FIREBASE_CREDENTIALS_JSON é obrigatório (JSON da service account)');
  process.exit(1);
}

await startStdio(
  createMetricServer({
    name: 'center-firebase',
    version: '1.0.0',
    provider: createFirebaseProvider(FirestoreMetricsClient.fromCredentialsJson(credentialsJson)),
  }),
);
```

- [ ] **Step 7: Rodar os testes**

Run: `pnpm --filter @center/mcp-firebase test`
Expected: PASS — 7 testes.

- [ ] **Step 8: Smoke test manual contra o Firestore real**

```bash
pnpm --filter @center/mcp-firebase build
FIREBASE_CREDENTIALS_JSON="$(cat ./firebase-service-account.json)" \
  npx @modelcontextprotocol/inspector node packages/mcp-firebase/dist/main.js
```

Antes: semeie ao menos um documento em `metric_rollups` pelo console do Firebase, com `projectId`, `metric: "app_opens"`, `date`, `platform` e `value`. Depois chame `query_metric` e confirme que o valor volta no bucket certo.

- [ ] **Step 9: Commit**

```bash
git add packages/mcp-firebase
git commit -m "feat(mcp-firebase): add mobile rollup metrics server backed by firestore"
```

---

### Task 9: `MetricGateway` com cache Redis

**Files:**
- Create: `packages/mcp-core/src/cache.ts`, `packages/mcp-core/src/gateway.ts`
- Modify: `packages/mcp-core/src/index.ts`
- Test: `packages/mcp-core/src/__tests__/gateway.test.ts`

**Interfaces:**
- Consumes: `McpPool` (Task 5); `MetricQuery`, `MetricSeries`, `MetricDescriptor`, `Granularity` de `@center/shared`.
- Produces:
  - `interface CacheStore { get(key: string): Promise<string | null>; set(key: string, value: string, ttlSeconds: number): Promise<void>; }`
  - `class MemoryCacheStore implements CacheStore`
  - `class RedisCacheStore implements CacheStore` (construtor recebe `Redis` de `ioredis`)
  - `cacheKeyFor(query: MetricQuery): string`, `SHORT_TTL_SECONDS = 300`, `LONG_TTL_SECONDS = 86_400`
  - `class MetricGateway` com `constructor(pool: McpPool, cache: CacheStore, options?: { ttlFor?: (g: Granularity) => number; now?: () => Date })`, `listMetrics(): Promise<MetricDescriptor[]>`, `queryMetric(query: MetricQuery): Promise<MetricSeries>`, `queryBatch(queries: MetricQuery[]): Promise<MetricSeries[]>`, `close(): Promise<void>`

**Regra de TTL (o ponto que mais gera bug):** um período que **inclui hoje** ainda está mudando, então recebe TTL curto (5 min). Um período **totalmente no passado** é imutável e recebe TTL longo (24 h). Sem isso, ou a dashboard mostra dados velhos, ou o cache nunca serve para nada.

- [ ] **Step 1: Escrever o teste (falhando)**

`packages/mcp-core/src/__tests__/gateway.test.ts`:

```ts
import type { MetricQuery, MetricSeries } from '@center/shared';
import { MemoryCacheStore, cacheKeyFor } from '../cache.js';
import { MetricGateway } from '../gateway.js';
import type { McpPool } from '../pool.js';

const query: MetricQuery = {
  metricId: 'ga4.sessions',
  from: '2026-01-01',
  to: '2026-01-31',
  granularity: 'day',
  tenant: { organizationId: 'org_1', externalIds: { ga4PropertyId: '1' } },
};

const series: MetricSeries = {
  metricId: 'ga4.sessions', source: 'ga4', unit: 'count', granularity: 'day',
  total: 10, points: [{ date: '2026-01-01', value: 10 }],
};

function fakePool() {
  const queryMetric = jest.fn(async () => series);
  const listMetrics = jest.fn(async () => []);
  const close = jest.fn(async () => {});
  return { pool: { queryMetric, listMetrics, close } as unknown as McpPool, queryMetric, listMetrics };
}

// "hoje" fixo em 2026-03-15 — o range da query acima está inteiramente no passado.
const now = () => new Date('2026-03-15T12:00:00Z');

describe('cacheKeyFor', () => {
  it('is stable across key ordering in filters', () => {
    const a = { ...query, filters: { country: 'BR', campaignName: 'x' } };
    const b = { ...query, filters: { campaignName: 'x', country: 'BR' } };
    expect(cacheKeyFor(a)).toBe(cacheKeyFor(b));
  });

  it('separates tenants', () => {
    const other = { ...query, tenant: { organizationId: 'org_2', externalIds: { ga4PropertyId: '1' } } };
    expect(cacheKeyFor(query)).not.toBe(cacheKeyFor(other));
  });

  it('separates date ranges', () => {
    expect(cacheKeyFor(query)).not.toBe(cacheKeyFor({ ...query, to: '2026-02-28' }));
  });

  it('is namespaced so a FLUSHDB target is obvious', () => {
    expect(cacheKeyFor(query)).toMatch(/^metric:v1:org_1:/);
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
    expect(await gateway.queryMetric(query)).toEqual(series);
    expect(queryMetric).toHaveBeenCalledTimes(1);
  });

  it('does not share cache between tenants', async () => {
    const { pool, queryMetric } = fakePool();
    const gateway = new MetricGateway(pool, new MemoryCacheStore(), { now });
    await gateway.queryMetric(query);
    await gateway.queryMetric({
      ...query,
      tenant: { organizationId: 'org_2', externalIds: { ga4PropertyId: '9' } },
    });
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

  it('falls through to the pool when the cached payload is corrupt', async () => {
    const { pool, queryMetric } = fakePool();
    const cache = new MemoryCacheStore();
    await cache.set(cacheKeyFor(query), '{not json', 60);
    const gateway = new MetricGateway(pool, cache, { now });
    expect(await gateway.queryMetric(query)).toEqual(series);
    expect(queryMetric).toHaveBeenCalledTimes(1);
  });

  it('still answers when the cache backend is down', async () => {
    const { pool, queryMetric } = fakePool();
    const brokenCache = {
      get: jest.fn(async () => { throw new Error('ECONNREFUSED'); }),
      set: jest.fn(async () => { throw new Error('ECONNREFUSED'); }),
    };
    const gateway = new MetricGateway(pool, brokenCache, { now });
    expect(await gateway.queryMetric(query)).toEqual(series);
    expect(queryMetric).toHaveBeenCalledTimes(1);
  });

  it('resolves a batch preserving input order', async () => {
    const { pool } = fakePool();
    const gateway = new MetricGateway(pool, new MemoryCacheStore(), { now });
    const results = await gateway.queryBatch([query, { ...query, metricId: 'ga4.conversions' }]);
    expect(results).toHaveLength(2);
    expect(results[0]?.metricId).toBe('ga4.sessions');
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `pnpm --filter @center/mcp-core test -- gateway.test.ts`
Expected: FAIL — `Cannot find module '../cache.js'`.

- [ ] **Step 3: Implementar `cache.ts`**

`packages/mcp-core/src/cache.ts`:

```ts
import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { MetricQuery } from '@center/shared';

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

/**
 * `metric:v1:<orgId>:<hash>`. O `v1` permite invalidar tudo de uma vez com um
 * bump de versão; o orgId no claro torna óbvio o alvo de um SCAN por tenant.
 */
export function cacheKeyFor(query: MetricQuery): string {
  const { tenant, ...rest } = query;
  const payload = JSON.stringify(canonicalize({ ...rest, externalIds: tenant.externalIds }));
  const hash = createHash('sha256').update(payload).digest('hex').slice(0, 32);
  return `metric:v1:${tenant.organizationId}:${hash}`;
}

/** Período que alcança hoje ainda está sendo escrito pelas fontes. */
export const SHORT_TTL_SECONDS = 300;
/** Período fechado no passado é imutável. */
export const LONG_TTL_SECONDS = 86_400;
```

- [ ] **Step 4: Implementar `gateway.ts`**

`packages/mcp-core/src/gateway.ts`:

```ts
import {
  MetricSeriesSchema,
  type Granularity,
  type MetricDescriptor,
  type MetricQuery,
  type MetricSeries,
} from '@center/shared';
import { LONG_TTL_SECONDS, SHORT_TTL_SECONDS, cacheKeyFor, type CacheStore } from './cache.js';
import type { McpPool } from './pool.js';

export interface MetricGatewayOptions {
  ttlFor?: (granularity: Granularity) => number;
  now?: () => Date;
}

/**
 * A única porta de entrada para métricas em todo o sistema. Dashboard e agente
 * de IA passam por aqui — é o que garante que não exista lógica de agregação
 * duplicada entre os dois consumidores.
 */
export class MetricGateway {
  private readonly now: () => Date;
  private readonly ttlFor: ((granularity: Granularity) => number) | undefined;

  constructor(
    private readonly pool: McpPool,
    private readonly cache: CacheStore,
    options: MetricGatewayOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.ttlFor = options.ttlFor;
  }

  listMetrics(): Promise<MetricDescriptor[]> {
    return this.pool.listMetrics();
  }

  async queryMetric(query: MetricQuery): Promise<MetricSeries> {
    const key = cacheKeyFor(query);

    // O cache nunca pode derrubar uma requisição: falha de Redis vira miss.
    try {
      const cached = await this.cache.get(key);
      if (cached !== null) {
        return MetricSeriesSchema.parse(JSON.parse(cached));
      }
    } catch {
      // miss silencioso — segue para a origem
    }

    const series = await this.pool.queryMetric(query);

    try {
      await this.cache.set(key, JSON.stringify(series), this.ttlSecondsFor(query));
    } catch {
      // gravação de cache é best-effort
    }

    return series;
  }

  /** Uma dashboard carrega vários KPIs de uma vez; isto evita N round-trips em série. */
  queryBatch(queries: MetricQuery[]): Promise<MetricSeries[]> {
    return Promise.all(queries.map((query) => this.queryMetric(query)));
  }

  close(): Promise<void> {
    return this.pool.close();
  }

  /**
   * Um intervalo que alcança hoje ainda está sendo escrito pelas fontes, então
   * expira rápido. Um intervalo fechado no passado é imutável.
   */
  private ttlSecondsFor(query: MetricQuery): number {
    if (this.ttlFor) return this.ttlFor(query.granularity);
    const today = this.now().toISOString().slice(0, 10);
    return query.to >= today ? SHORT_TTL_SECONDS : LONG_TTL_SECONDS;
  }
}
```

- [ ] **Step 5: Reexportar**

`packages/mcp-core/src/index.ts`:

```ts
export * from './provider.js';
export * from './server.js';
export * from './pool.js';
export * from './series.js';
export * from './cache.js';
export * from './gateway.js';
```

- [ ] **Step 6: Rodar todos os testes do pacote**

Run: `pnpm --filter @center/mcp-core test`
Expected: PASS — 30 testes (7 server + 6 pool + 4 series + 13 gateway/cache).

- [ ] **Step 7: Commit**

```bash
git add packages/mcp-core
git commit -m "feat(mcp-core): add metric gateway with tenant-scoped redis cache"
```

---

# FASE 2 — API Core (Sprints 4–5)

**Objetivo da fase:** expor o `MetricGateway` por HTTP com autenticação e escopo de tenant. Ao fim desta fase o frontend pode ser desenvolvido contra uma API real.

**Onde os testes entram:** todos os testes desta fase usam `fastify.inject()` — sem porta, sem rede, sem `supertest`. As dependências (`prisma`, `gateway`) são injetadas como fakes. O teste mais importante da fase é o de **vazamento entre tenants**: um token da organização A não pode, sob nenhuma rota, ler dados da organização B.

---

### Task 10: Servidor Fastify, autenticação e resolução de tenant

**Files:**
- Create: `apps/api/src/auth/password.ts`, `apps/api/src/auth/jwt.ts`, `apps/api/src/auth/routes.ts`
- Create: `apps/api/src/tenant.ts`, `apps/api/src/server.ts`, `apps/api/src/deps.ts`
- Modify: `apps/api/package.json` (novas dependências)
- Test: `apps/api/src/__tests__/password.test.ts`, `apps/api/src/__tests__/auth-routes.test.ts`, `apps/api/src/__tests__/tenant.test.ts`

**Interfaces:**
- Consumes: `loadConfig`/`AppConfig` (Task 3); `MetricGateway` (Task 9); `TenantContext` de `@center/shared`.
- Produces:
  - `hashPassword(plain: string): Promise<string>`, `verifyPassword(plain: string, stored: string): Promise<boolean>`
  - `interface AuthPayload { userId: string; organizationId: string; role: 'ADMIN' | 'VIEWER' }`
  - `requireAuth(request, reply): Promise<void>` (preHandler do Fastify)
  - `resolveTenant(prisma: PrismaClient, organizationId: string): Promise<TenantContext>`
  - `interface AppDeps { config: AppConfig; prisma: PrismaClient; gateway: MetricGateway }`
  - `buildServer(deps: AppDeps): Promise<FastifyInstance>`
  - Rotas: `GET /health`, `POST /auth/login`, `GET /auth/me`
  - `request.auth: AuthPayload` disponível em toda rota protegida

- [ ] **Step 1: Adicionar as dependências**

```bash
pnpm --filter @center/api add fastify@^5.2.0 @fastify/jwt@^9.0.2 @fastify/cors@^10.0.1 \
  @fastify/rate-limit@^10.2.1 @center/mcp-core@workspace:* ioredis@^5.4.2
```

- [ ] **Step 2: Escrever o teste de senha (falhando)**

`apps/api/src/__tests__/password.test.ts`:

```ts
import { hashPassword, verifyPassword } from '../auth/password.js';

describe('password hashing', () => {
  it('accepts the correct password', async () => {
    const stored = await hashPassword('senha-correta-123');
    expect(await verifyPassword('senha-correta-123', stored)).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const stored = await hashPassword('senha-correta-123');
    expect(await verifyPassword('senha-errada', stored)).toBe(false);
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

Usa `scrypt` do Node — sem dependência nativa, sem `bcrypt` para compilar em CI.

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

Run: `pnpm --filter @center/api test -- password.test.ts`
Expected: PASS — 4 testes.

- [ ] **Step 4: Escrever o teste de tenant (falhando)**

`apps/api/src/__tests__/tenant.test.ts`:

```ts
import type { PrismaClient } from '@prisma/client';
import { resolveTenant } from '../tenant.js';

function fakePrisma(organization: unknown): PrismaClient {
  return {
    organization: { findUnique: jest.fn(async () => organization) },
  } as unknown as PrismaClient;
}

describe('resolveTenant', () => {
  it('builds externalIds from the organization row', async () => {
    const prisma = fakePrisma({
      id: 'org_1', ga4PropertyId: '111', firebaseProjectId: 'app-prod', backendAccountId: 'acc_9',
    });
    expect(await resolveTenant(prisma, 'org_1')).toEqual({
      organizationId: 'org_1',
      externalIds: { ga4PropertyId: '111', firebaseProjectId: 'app-prod', backendAccountId: 'acc_9' },
    });
  });

  it('omits unconfigured external ids instead of sending empty strings', async () => {
    const prisma = fakePrisma({
      id: 'org_1', ga4PropertyId: '111', firebaseProjectId: null, backendAccountId: null,
    });
    expect(await resolveTenant(prisma, 'org_1')).toEqual({
      organizationId: 'org_1',
      externalIds: { ga4PropertyId: '111' },
    });
  });

  it('throws when the organization does not exist', async () => {
    await expect(resolveTenant(fakePrisma(null), 'org_missing'))
      .rejects.toThrow('organização não encontrada: org_missing');
  });
});
```

- [ ] **Step 5: Implementar `tenant.ts`**

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
    select: { id: true, ga4PropertyId: true, firebaseProjectId: true, backendAccountId: true },
  });
  if (!organization) {
    throw new Error(`organização não encontrada: ${organizationId}`);
  }

  const externalIds: Record<string, string> = {};
  if (organization.ga4PropertyId) externalIds.ga4PropertyId = organization.ga4PropertyId;
  if (organization.firebaseProjectId) externalIds.firebaseProjectId = organization.firebaseProjectId;
  if (organization.backendAccountId) externalIds.backendAccountId = organization.backendAccountId;

  return { organizationId: organization.id, externalIds };
}
```

- [ ] **Step 6: Implementar `jwt.ts` e `deps.ts`**

`apps/api/src/deps.ts`:

```ts
import type { PrismaClient } from '@prisma/client';
import type { MetricGateway } from '@center/mcp-core';
import type { AppConfig } from './config.js';

export interface AppDeps {
  config: AppConfig;
  prisma: PrismaClient;
  gateway: MetricGateway;
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

- [ ] **Step 7: Escrever o teste das rotas de auth (falhando)**

`apps/api/src/__tests__/auth-routes.test.ts`:

```ts
import type { PrismaClient } from '@prisma/client';
import type { MetricGateway } from '@center/mcp-core';
import { buildServer } from '../server.js';
import { hashPassword } from '../auth/password.js';
import type { AppConfig } from '../config.js';

const config = {
  port: 0,
  databaseUrl: 'postgresql://x',
  redisUrl: 'redis://x',
  jwtSecret: 'x'.repeat(32),
  anthropicApiKey: 'sk-ant-test',
  ga4CredentialsJson: '',
  firebaseCredentialsJson: '',
  backendApiUrl: 'http://localhost:4000',
  backendApiToken: 't',
  whatsapp: { appSecret: 's', verifyToken: 'v', accessToken: 'a', phoneNumberId: '1' },
} satisfies AppConfig;

async function buildTestServer(userRow: unknown) {
  const prisma = {
    user: { findUnique: jest.fn(async () => userRow) },
    organization: {
      findUnique: jest.fn(async () => ({
        id: 'org_1', ga4PropertyId: '111', firebaseProjectId: null, backendAccountId: null,
      })),
    },
  } as unknown as PrismaClient;

  const gateway = {
    listMetrics: jest.fn(async () => []),
    queryMetric: jest.fn(),
    queryBatch: jest.fn(),
  } as unknown as MetricGateway;

  return { app: await buildServer({ config, prisma, gateway }), prisma };
}

const validUser = {
  id: 'user_1',
  email: 'ana@example.com',
  name: 'Ana',
  role: 'ADMIN' as const,
  organizationId: 'org_1',
  passwordHash: '',
};

describe('GET /health', () => {
  it('answers without authentication', async () => {
    const { app } = await buildTestServer(null);
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    await app.close();
  });
});

describe('POST /auth/login', () => {
  it('returns a token for valid credentials', async () => {
    const user = { ...validUser, passwordHash: await hashPassword('segredo123') };
    const { app } = await buildTestServer(user);
    const response = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: 'ana@example.com', password: 'segredo123' },
    });
    expect(response.statusCode).toBe(200);
    expect(typeof response.json().token).toBe('string');
    await app.close();
  });

  it('rejects a wrong password with 401 and no user detail', async () => {
    const user = { ...validUser, passwordHash: await hashPassword('segredo123') };
    const { app } = await buildTestServer(user);
    const response = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: 'ana@example.com', password: 'errada' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().message).toBe('credenciais inválidas');
    await app.close();
  });

  it('gives the same 401 for an unknown email (no user enumeration)', async () => {
    const { app } = await buildTestServer(null);
    const response = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: 'ninguem@example.com', password: 'qualquer' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().message).toBe('credenciais inválidas');
    await app.close();
  });

  it('rejects a malformed body with 400', async () => {
    const { app } = await buildTestServer(null);
    const response = await app.inject({
      method: 'POST', url: '/auth/login', payload: { email: 'nao-e-email' },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

describe('GET /auth/me', () => {
  it('returns 401 without a token', async () => {
    const { app } = await buildTestServer(validUser);
    expect((await app.inject({ method: 'GET', url: '/auth/me' })).statusCode).toBe(401);
    await app.close();
  });

  it('returns 401 for a token signed with another secret', async () => {
    const { app } = await buildTestServer(validUser);
    const forged =
      'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ1c2VyXzEiLCJvcmdhbml6YXRpb25JZCI6Im9yZ18xIn0.invalid';
    const response = await app.inject({
      method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${forged}` },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('returns the authenticated identity for a valid token', async () => {
    const user = { ...validUser, passwordHash: await hashPassword('segredo123') };
    const { app } = await buildTestServer(user);
    const login = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: 'ana@example.com', password: 'segredo123' },
    });
    const { token } = login.json();
    const response = await app.inject({
      method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${token}` },
    });
    expect(response.json()).toEqual({
      userId: 'user_1', organizationId: 'org_1', role: 'ADMIN',
    });
    await app.close();
  });
});
```

- [ ] **Step 8: Implementar `auth/routes.ts`**

`apps/api/src/auth/routes.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import { verifyPassword } from './password.js';
import { requireAuth, type AuthPayload } from './jwt.js';

const LoginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function registerAuthRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.post('/auth/login', async (request, reply) => {
    const parsed = LoginBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'bad_request', message: 'email e password são obrigatórios' });
    }

    const user = await deps.prisma.user.findUnique({ where: { email: parsed.data.email } });
    // Mesma resposta para email inexistente e senha errada: sem enumeração de usuários.
    const valid = user ? await verifyPassword(parsed.data.password, user.passwordHash) : false;
    if (!user || !valid) {
      return reply.status(401).send({ error: 'unauthorized', message: 'credenciais inválidas' });
    }

    const payload: AuthPayload = {
      userId: user.id,
      organizationId: user.organizationId,
      role: user.role,
    };
    return reply.send({
      token: app.jwt.sign(payload, { expiresIn: '12h' }),
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  });

  app.get('/auth/me', { preHandler: requireAuth }, async (request) => request.auth);
}
```

- [ ] **Step 9: Implementar `server.ts`**

`apps/api/src/server.ts`:

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import type { AppDeps } from './deps.js';
import { registerAuthRoutes } from './auth/routes.js';

export async function buildServer(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    // O corpo cru é necessário para validar a assinatura do webhook do WhatsApp
    // (Task 23). Guardamos aqui, no único ponto onde o buffer ainda existe.
    disableRequestLogging: false,
  });

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

  app.get('/health', async () => ({ status: 'ok' }));

  await registerAuthRoutes(app, deps);

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

- [ ] **Step 10: Rodar os testes**

Run: `pnpm --filter @center/api test`
Expected: PASS — 5 suites, 18 testes.

- [ ] **Step 11: Commit**

```bash
git add apps/api
git commit -m "feat(api): add fastify server, scrypt auth and tenant resolution"
```

---

### Task 11: Rotas de métricas

**Files:**
- Create: `apps/api/src/routes/metrics.ts`, `apps/api/src/routes/promotions.ts`
- Modify: `apps/api/src/server.ts` (registrar as rotas)
- Test: `apps/api/src/__tests__/metrics-routes.test.ts`

**Interfaces:**
- Consumes: `requireAuth`, `AuthPayload` (Task 10); `resolveTenant` (Task 10); `MetricGateway` (Task 9).
- Produces:
  - `GET /api/metrics/catalog` → `{ metrics: MetricDescriptor[] }`
  - `POST /api/metrics/query` body `{ metricId, from, to, granularity, filters?, groupBy? }` → `MetricSeries`
  - `POST /api/metrics/batch` body `{ queries: [...] }` (máx. 12) → `{ series: MetricSeries[] }`
  - `GET /api/promotions?activeOn=YYYY-MM-DD` → `{ promotions: Promotion[] }`
  - `registerMetricRoutes(app, deps)`, `registerPromotionRoutes(app, deps)`

**Invariante de segurança desta task:** o body da requisição **não contém tenant**. O tenant vem exclusivamente do JWT, via `resolveTenant`. Um cliente não tem como pedir dados de outra organização, porque não existe campo onde escrevê-lo.

- [ ] **Step 1: Escrever o teste (falhando)**

`apps/api/src/__tests__/metrics-routes.test.ts`:

```ts
import type { PrismaClient } from '@prisma/client';
import type { MetricGateway } from '@center/mcp-core';
import type { MetricSeries } from '@center/shared';
import { buildServer } from '../server.js';
import { hashPassword } from '../auth/password.js';
import type { AppConfig } from '../config.js';

const config = {
  port: 0, databaseUrl: 'postgresql://x', redisUrl: 'redis://x',
  jwtSecret: 'x'.repeat(32), anthropicApiKey: 'sk-ant-test',
  ga4CredentialsJson: '', firebaseCredentialsJson: '',
  backendApiUrl: 'http://localhost:4000', backendApiToken: 't',
  whatsapp: { appSecret: 's', verifyToken: 'v', accessToken: 'a', phoneNumberId: '1' },
} satisfies AppConfig;

const series: MetricSeries = {
  metricId: 'ga4.sessions', source: 'ga4', unit: 'count', granularity: 'day',
  total: 55, points: [{ date: '2026-01-01', value: 55 }],
};

async function setup(organizationId = 'org_1') {
  const gateway = {
    listMetrics: jest.fn(async () => [{
      id: 'ga4.sessions', label: 'Sessões', description: 'd',
      source: 'ga4' as const, unit: 'count' as const, dimensions: ['country'],
    }]),
    queryMetric: jest.fn(async () => series),
    queryBatch: jest.fn(async () => [series, series]),
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
        firebaseProjectId: null, backendAccountId: null,
      })),
    },
  } as unknown as PrismaClient;

  const app = await buildServer({ config, prisma, gateway });
  const login = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { email: 'ana@example.com', password: 'segredo123' },
  });
  return { app, gateway, token: login.json().token as string };
}

const validQuery = {
  metricId: 'ga4.sessions', from: '2026-01-01', to: '2026-01-31', granularity: 'day',
};

describe('GET /api/metrics/catalog', () => {
  it('requires a token', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'GET', url: '/api/metrics/catalog' })).statusCode).toBe(401);
    await app.close();
  });

  it('returns the merged catalog', async () => {
    const { app, token } = await setup();
    const response = await app.inject({
      method: 'GET', url: '/api/metrics/catalog', headers: { authorization: `Bearer ${token}` },
    });
    expect(response.json().metrics).toHaveLength(1);
    await app.close();
  });
});

describe('POST /api/metrics/query', () => {
  it('requires a token', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'POST', url: '/api/metrics/query', payload: validQuery });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('returns the series', async () => {
    const { app, token } = await setup();
    const response = await app.inject({
      method: 'POST', url: '/api/metrics/query',
      headers: { authorization: `Bearer ${token}` }, payload: validQuery,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().total).toBe(55);
    await app.close();
  });

  it('injects the tenant from the token, never from the body', async () => {
    const { app, gateway, token } = await setup('org_1');
    await app.inject({
      method: 'POST', url: '/api/metrics/query',
      headers: { authorization: `Bearer ${token}` },
      // Cliente malicioso tentando forjar outro tenant no corpo:
      payload: { ...validQuery, tenant: { organizationId: 'org_ATTACKER', externalIds: { ga4PropertyId: 'roubado' } } },
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
      method: 'POST', url: '/api/metrics/query',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...validQuery, from: '01/01/2026' },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('rejects an inverted date range with 400', async () => {
    const { app, token } = await setup();
    const response = await app.inject({
      method: 'POST', url: '/api/metrics/query',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...validQuery, from: '2026-02-01', to: '2026-01-01' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/anterior/);
    await app.close();
  });

  it('rejects a range longer than 400 days with 400', async () => {
    const { app, token } = await setup();
    const response = await app.inject({
      method: 'POST', url: '/api/metrics/query',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...validQuery, from: '2024-01-01', to: '2026-01-01' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/400 dias/);
    await app.close();
  });

  it('turns an upstream failure into 502, not 500', async () => {
    const { app, gateway, token } = await setup();
    (gateway.queryMetric as jest.Mock).mockRejectedValueOnce(new Error('GA4 indisponível'));
    const response = await app.inject({
      method: 'POST', url: '/api/metrics/query',
      headers: { authorization: `Bearer ${token}` }, payload: validQuery,
    });
    expect(response.statusCode).toBe(502);
    await app.close();
  });
});

describe('POST /api/metrics/batch', () => {
  it('resolves several queries at once', async () => {
    const { app, token } = await setup();
    const response = await app.inject({
      method: 'POST', url: '/api/metrics/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: { queries: [validQuery, { ...validQuery, metricId: 'ga4.conversions' }] },
    });
    expect(response.json().series).toHaveLength(2);
    await app.close();
  });

  it('rejects more than 12 queries with 400', async () => {
    const { app, token } = await setup();
    const response = await app.inject({
      method: 'POST', url: '/api/metrics/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: { queries: Array.from({ length: 13 }, () => validQuery) },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `pnpm --filter @center/api test -- metrics-routes.test.ts`
Expected: FAIL — 401 em todas as rotas `/api/metrics/*` (ainda não existem).

- [ ] **Step 3: Implementar `routes/metrics.ts`**

`apps/api/src/routes/metrics.ts`:

```ts
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { GranularitySchema, type MetricQuery } from '@center/shared';
import { requireAuth } from '../auth/jwt.js';
import { resolveTenant } from '../tenant.js';
import type { AppDeps } from '../deps.js';

const MAX_RANGE_DAYS = 400;
const MAX_BATCH_SIZE = 12;

/** Igual ao MetricQuerySchema de @center/shared, MENOS o tenant — que vem do JWT. */
const QueryBodySchema = z.object({
  metricId: z.string().min(1),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'from precisa ser YYYY-MM-DD'),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'to precisa ser YYYY-MM-DD'),
  granularity: GranularitySchema,
  filters: z.record(z.string(), z.string()).optional(),
  groupBy: z.string().optional(),
});
type QueryBody = z.infer<typeof QueryBodySchema>;

const BatchBodySchema = z.object({
  queries: z.array(QueryBodySchema).min(1).max(MAX_BATCH_SIZE),
});

class BadRequestError extends Error {}

function assertRange(body: QueryBody): void {
  if (body.from > body.to) {
    throw new BadRequestError(`"from" (${body.from}) é anterior a "to" (${body.to})`);
  }
  const spanDays =
    (Date.parse(`${body.to}T00:00:00Z`) - Date.parse(`${body.from}T00:00:00Z`)) / 86_400_000;
  if (spanDays > MAX_RANGE_DAYS) {
    throw new BadRequestError(`intervalo excede o máximo de ${MAX_RANGE_DAYS} dias`);
  }
}

function badRequest(reply: FastifyReply, message: string) {
  return reply.status(400).send({ error: 'bad_request', message });
}

/** Falha de fonte externa é 502 (problema deles), não 500 (problema nosso). */
function upstreamError(reply: FastifyReply, error: unknown) {
  const message = error instanceof Error ? error.message : 'fonte de dados indisponível';
  return reply.status(502).send({ error: 'upstream_error', message });
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
      const queries: MetricQuery[] = parsed.data.queries.map((item) => ({ ...item, tenant }));
      return reply.send({ series: await deps.gateway.queryBatch(queries) });
    } catch (error) {
      if (error instanceof BadRequestError) return badRequest(reply, error.message);
      return upstreamError(reply, error);
    }
  });
}
```

- [ ] **Step 4: Implementar `routes/promotions.ts`**

`apps/api/src/routes/promotions.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/jwt.js';
import { resolveTenant } from '../tenant.js';
import type { AppDeps } from '../deps.js';

const QuerystringSchema = z.object({
  activeOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

interface Promotion {
  id: string; name: string; startsAt: string; endsAt: string;
  status: 'scheduled' | 'running' | 'finished';
}

export async function registerPromotionRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get('/api/promotions', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = QuerystringSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'bad_request', message: 'activeOn precisa ser YYYY-MM-DD' });
    }

    try {
      const tenant = await resolveTenant(deps.prisma, request.auth.organizationId);
      // A ferramenta list_promotions vive no MCP server do backend proprietário.
      const payload = await deps.gateway.callTool<{ promotions: Promotion[] }>(
        'backend',
        'list_promotions',
        parsed.data.activeOn ? { tenant, activeOn: parsed.data.activeOn } : { tenant },
      );
      return reply.send(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'fonte indisponível';
      return reply.status(502).send({ error: 'upstream_error', message });
    }
  });
}
```

Isso exige que o `MetricGateway` exponha `callTool`. Adicione a `packages/mcp-core/src/gateway.ts`, dentro da classe `MetricGateway`:

```ts
  /** Passagem direta para ferramentas não-métricas (ex.: list_promotions). Sem cache. */
  callTool<T>(source: MetricSource, name: string, args: Record<string, unknown>): Promise<T> {
    return this.pool.callTool<T>(source, name, args);
  }
```

e acrescente `MetricSource` ao import de `@center/shared` no topo do mesmo arquivo.

- [ ] **Step 5: Registrar as rotas no servidor**

Em `apps/api/src/server.ts`, adicione os imports e a chamada logo após `registerAuthRoutes`:

```ts
import { registerMetricRoutes } from './routes/metrics.js';
import { registerPromotionRoutes } from './routes/promotions.js';
```

```ts
  await registerAuthRoutes(app, deps);
  await registerMetricRoutes(app, deps);
  await registerPromotionRoutes(app, deps);
```

- [ ] **Step 6: Rodar os testes**

Run: `pnpm --filter @center/api test`
Expected: PASS — 6 suites, 29 testes.

- [ ] **Step 7: Commit**

```bash
git add apps/api packages/mcp-core
git commit -m "feat(api): add metric catalog, query, batch and promotions routes"
```

---

### Task 12: Composition root, rate limiting e seed

**Files:**
- Create: `apps/api/src/main.ts`, `apps/api/prisma/seed.ts`
- Modify: `apps/api/src/server.ts` (rate limit), `apps/api/package.json` (script de seed)
- Test: `apps/api/src/__tests__/rate-limit.test.ts`

**Interfaces:**
- Consumes: `loadConfig` (Task 3), `buildServer` (Task 10), `McpPool.spawn`, `MetricGateway`, `RedisCacheStore` (Tasks 5 e 9).
- Produces: binário executável `node dist/main.js`; script `pnpm --filter @center/api db:seed` que cria a organização de desenvolvimento e um usuário admin.

- [ ] **Step 1: Escrever o teste de rate limit (falhando)**

`apps/api/src/__tests__/rate-limit.test.ts`:

```ts
import type { PrismaClient } from '@prisma/client';
import type { MetricGateway } from '@center/mcp-core';
import { buildServer } from '../server.js';
import type { AppConfig } from '../config.js';

const config = {
  port: 0, databaseUrl: 'postgresql://x', redisUrl: 'redis://x',
  jwtSecret: 'x'.repeat(32), anthropicApiKey: 'sk-ant-test',
  ga4CredentialsJson: '', firebaseCredentialsJson: '',
  backendApiUrl: 'http://localhost:4000', backendApiToken: 't',
  whatsapp: { appSecret: 's', verifyToken: 'v', accessToken: 'a', phoneNumberId: '1' },
} satisfies AppConfig;

async function build() {
  return buildServer({
    config,
    prisma: { user: { findUnique: jest.fn(async () => null) } } as unknown as PrismaClient,
    gateway: {} as unknown as MetricGateway,
  });
}

describe('rate limiting', () => {
  it('allows the first 10 login attempts and blocks the 11th with 429', async () => {
    const app = await build();
    const attempt = () => app.inject({
      method: 'POST', url: '/auth/login',
      headers: { 'x-forwarded-for': '203.0.113.7' },
      payload: { email: 'ana@example.com', password: 'errada' },
    });

    for (let i = 0; i < 10; i += 1) {
      expect((await attempt()).statusCode).toBe(401);
    }
    const blocked = await attempt();
    expect(blocked.statusCode).toBe(429);
    await app.close();
  });

  it('does not rate limit /health', async () => {
    const app = await build();
    for (let i = 0; i < 30; i += 1) {
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    }
    await app.close();
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `pnpm --filter @center/api test -- rate-limit.test.ts`
Expected: FAIL — a 11ª tentativa devolve 401 em vez de 429.

- [ ] **Step 3: Adicionar rate limiting ao `server.ts`**

Em `apps/api/src/server.ts`, adicione o import e registre o plugin **antes** de `registerAuthRoutes`:

```ts
import rateLimit from '@fastify/rate-limit';
```

```ts
  // Global, generoso: protege contra loop acidental de cliente.
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    allowList: (request) => request.url === '/health',
  });
```

E em `apps/api/src/auth/routes.ts`, restrinja especificamente o login (força bruta é o risco real):

```ts
  app.post(
    '/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
```

(o corpo do handler permanece exatamente como na Task 10, Step 8).

- [ ] **Step 4: Rodar os testes**

Run: `pnpm --filter @center/api test -- rate-limit.test.ts`
Expected: PASS — 2 testes.

- [ ] **Step 5: Implementar o composition root**

`apps/api/src/main.ts`:

```ts
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { McpPool, MetricGateway, RedisCacheStore, type McpServerConfig } from '@center/mcp-core';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';

const config = loadConfig(process.env);
const prisma = new PrismaClient();
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });

// Cada MCP server roda como processo filho, conectado por stdio. Ficam neste
// array para que adicionar uma quarta fonte seja uma linha só.
const mcpServers: McpServerConfig[] = [
  {
    source: 'backend',
    command: process.execPath,
    args: ['../../packages/mcp-backend/dist/main.js'],
    env: { BACKEND_API_URL: config.backendApiUrl, BACKEND_API_TOKEN: config.backendApiToken },
  },
  {
    source: 'ga4',
    command: process.execPath,
    args: ['../../packages/mcp-ga4/dist/main.js'],
    env: { GA4_CREDENTIALS_JSON: config.ga4CredentialsJson },
  },
  {
    source: 'firebase',
    command: process.execPath,
    args: ['../../packages/mcp-firebase/dist/main.js'],
    env: { FIREBASE_CREDENTIALS_JSON: config.firebaseCredentialsJson },
  },
];

const pool = await McpPool.spawn(mcpServers);
const gateway = new MetricGateway(pool, new RedisCacheStore(redis));
const app = await buildServer({ config, prisma, gateway });

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'encerrando');
  await app.close();
  await gateway.close();
  await prisma.$disconnect();
  redis.disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.port, host: '0.0.0.0' });
```

- [ ] **Step 6: Escrever o seed**

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
    name: 'Organização de Desenvolvimento',
    ga4PropertyId: process.env.SEED_GA4_PROPERTY_ID ?? null,
    firebaseProjectId: process.env.SEED_FIREBASE_PROJECT_ID ?? null,
    backendAccountId: process.env.SEED_BACKEND_ACCOUNT_ID ?? null,
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

e ao bloco `scripts`: `"db:seed": "prisma db seed"`.

- [ ] **Step 7: Validar a API de ponta a ponta manualmente**

```bash
pnpm build
pnpm --filter @center/api db:seed
cd apps/api && node dist/main.js
```

Em outro terminal:

```bash
TOKEN=$(curl -s -X POST localhost:3333/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@center.local","password":"center-dev-123"}' | jq -r .token)

curl -s localhost:3333/api/metrics/catalog -H "authorization: Bearer $TOKEN" | jq '.metrics | length'

curl -s -X POST localhost:3333/api/metrics/query \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"metricId":"backend.spend","from":"2026-01-01","to":"2026-01-31","granularity":"day"}' | jq .total
```

Expected: o catálogo lista 11 métricas (3 backend + 4 GA4 + 4 Firebase) e a query devolve um total numérico. Rode a mesma query duas vezes e confirme no log que a segunda não gerou chamada ao MCP server (cache hit).

- [ ] **Step 8: Commit**

```bash
git add apps/api
git commit -m "feat(api): add composition root, rate limiting and dev seed"
```

---

# FASE 3 — Dashboard Web (Sprints 5–7)

**Objetivo da fase:** dashboard navegável, com filtros no URL, gráficos acessíveis e estados de carregamento/erro tratados.

**Onde os testes entram — e o que NÃO testar:**
- **Testa-se comportamento**: o filtro de período muda a query enviada; o erro da API vira mensagem visível; o toggle de tabela expõe os números.
- **Não se testa** SVG do Recharts, nem contagem de pixels. Testes de gráfico verificam a **legenda, os rótulos diretos e a tabela** — que é justamente o que um usuário com deficiência de visão de cores lê.
- MSW intercepta as chamadas HTTP, então nenhum teste faz `jest.mock` do módulo do cliente de API. Isso mantém os testes acoplados ao contrato HTTP e não à implementação.

**Regra de cor desta fase (não negociável — vem da validação executada):** os slots categóricos são `#2a78d6`, `#eb6834`, `#1baf7a`, `#eda100` em light e `#3987e5`, `#d95926`, `#199e70`, `#c98500` em dark, **nesta ordem, atribuídos por fonte de dados e nunca reciclados** — se um filtro esconde uma série, as demais mantêm suas cores. Três dos slots light ficam abaixo de 3:1 de contraste com a superfície, então **todo gráfico embarca visão de tabela** (`ChartFrame`) e séries com ≤ 4 categorias recebem rótulo direto. Nunca usar dois eixos Y.

---

### Task 13: Scaffold do frontend com Vite, Tailwind e Tremor

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/tailwind.config.ts`, `apps/web/postcss.config.js`, `apps/web/index.html`, `apps/web/jest.config.cjs`
- Create: `apps/web/src/index.css`, `apps/web/src/main.tsx`, `apps/web/src/App.tsx`
- Create: `apps/web/src/lib/viz-colors.ts`, `apps/web/src/test/setup.ts`, `apps/web/src/test/render.tsx`
- Test: `apps/web/src/__tests__/app.test.tsx`

**Interfaces:**
- Consumes: nada do backend ainda.
- Produces:
  - `SERIES_SLOT_BY_SOURCE: Record<MetricSource, 1 | 2 | 3>`, `TREMOR_COLOR_BY_SOURCE: Record<MetricSource, string>`, `TREMOR_SLOTS: readonly string[]`, `SOURCE_LABEL: Record<MetricSource, string>`
  - `renderWithProviders(ui: ReactElement, options?: { route?: string }): RenderResult` (helper de teste, envolve em `QueryClientProvider` + `MemoryRouter`)
  - `App` (componente raiz com rotas)

- [ ] **Step 1: Criar o pacote**

```bash
mkdir -p apps/web/src
```

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
    "preview": "vite preview",
    "test": "jest"
  },
  "dependencies": {
    "@tanstack/react-query": "^5.62.7",
    "@tremor/react": "^3.18.7",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router-dom": "^7.1.1"
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

- [ ] **Step 2: Configurar Vite, TypeScript e PostCSS**

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
    "resolveJsonModule": true,
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
    <title>Center Dashboard</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 3: Configurar Tailwind com as cores de visualização**

As cores de série viram **variáveis CSS**, não hex fixo no Tailwind. É o que permite que o mesmo `className` troque de valor entre light e dark sem duplicar componente.

`apps/web/tailwind.config.ts`:

```ts
import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}', './node_modules/@tremor/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        viz: {
          1: 'var(--viz-1)',
          2: 'var(--viz-2)',
          3: 'var(--viz-3)',
          4: 'var(--viz-4)',
        },
      },
    },
  },
  safelist: [
    // Tremor gera estas classes em runtime a partir do prop `colors`;
    // sem safelist o Tailwind as remove no build de produção.
    { pattern: /^(bg|fill|stroke|text|border)-viz-[1-4]$/ },
  ],
} satisfies Config;
```

`apps/web/src/index.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

/*
 * Paleta categórica validada (adjacent pairlist, light e dark).
 * A ORDEM DOS SLOTS É O MECANISMO DE SEGURANÇA PARA DALTONISMO — não reordene
 * nem substitua um hex sem revalidar a paleta inteira.
 */
:root {
  color-scheme: light;
  --viz-1: #2a78d6;
  --viz-2: #eb6834;
  --viz-3: #1baf7a;
  --viz-4: #eda100;
  --surface-1: #fcfcfb;
  --page-plane: #f9f9f7;
  --text-primary: #0b0b0b;
  --text-secondary: #52514e;
  --text-muted: #898781;
  --gridline: #e1e0d9;
  --hairline: rgba(11, 11, 11, 0.1);
}

@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme='light'])) {
    color-scheme: dark;
    --viz-1: #3987e5;
    --viz-2: #d95926;
    --viz-3: #199e70;
    --viz-4: #c98500;
    --surface-1: #1a1a19;
    --page-plane: #0d0d0d;
    --text-primary: #ffffff;
    --text-secondary: #c3c2b7;
    --text-muted: #898781;
    --gridline: #2c2c2a;
    --hairline: rgba(255, 255, 255, 0.1);
  }
}

:root[data-theme='dark'] {
  color-scheme: dark;
  --viz-1: #3987e5;
  --viz-2: #d95926;
  --viz-3: #199e70;
  --viz-4: #c98500;
  --surface-1: #1a1a19;
  --page-plane: #0d0d0d;
  --text-primary: #ffffff;
  --text-secondary: #c3c2b7;
  --text-muted: #898781;
  --gridline: #2c2c2a;
  --hairline: rgba(255, 255, 255, 0.1);
}

body {
  background-color: var(--page-plane);
  color: var(--text-primary);
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
}
```

- [ ] **Step 4: Implementar `viz-colors.ts`**

`apps/web/src/lib/viz-colors.ts`:

```ts
export type MetricSource = 'firebase' | 'ga4' | 'backend';

/**
 * A cor segue a ENTIDADE (a fonte de dados), nunca a posição na lista. Se um
 * filtro esconde o Firebase, GA4 e Backend mantêm exatamente as mesmas cores.
 */
export const SERIES_SLOT_BY_SOURCE: Record<MetricSource, 1 | 2 | 3> = {
  ga4: 1,
  backend: 2,
  firebase: 3,
};

/** Nome de cor que o Tremor resolve para `stroke-viz-N` / `fill-viz-N`. */
export const TREMOR_COLOR_BY_SOURCE: Record<MetricSource, string> = {
  ga4: 'viz-1',
  backend: 'viz-2',
  firebase: 'viz-3',
};

/** Slots por posição, para séries que não são "por fonte" (ex.: promoções). */
export const TREMOR_SLOTS = ['viz-1', 'viz-2', 'viz-3', 'viz-4'] as const;

export const SOURCE_LABEL: Record<MetricSource, string> = {
  ga4: 'Google Analytics',
  backend: 'Backend',
  firebase: 'App Mobile',
};
```

- [ ] **Step 5: Configurar Jest para o frontend**

`apps/web/jest.config.cjs`:

```js
module.exports = {
  ...require('../../jest.preset.cjs'),
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/src/test/setup.ts'],
  moduleNameMapper: {
    ...require('../../jest.preset.cjs').moduleNameMapper,
    '\\.css$': '<rootDir>/src/test/style-stub.cjs',
  },
};
```

`apps/web/src/test/style-stub.cjs`:

```js
module.exports = {};
```

`apps/web/src/test/setup.ts`:

```ts
import '@testing-library/jest-dom';
import { TextDecoder, TextEncoder } from 'node:util';

// MSW 2 e o Recharts precisam destas APIs, que o jsdom não fornece.
Object.assign(globalThis, { TextEncoder, TextDecoder });

globalThis.ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver;

// O Recharts mede o container; em jsdom todas as medidas são 0 e o gráfico
// não renderiza. Forçamos um tamanho para que os elementos existam no DOM.
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 800 });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 400 });
```

- [ ] **Step 6: Escrever o teste do App (falhando)**

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
    // Sem retry nos testes: um erro precisa aparecer imediatamente,
    // não depois de três tentativas silenciosas.
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[options.route ?? '/']}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}
```

`apps/web/src/__tests__/app.test.tsx`:

```tsx
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../test/render.js';
import { App } from '../App.js';
import { SERIES_SLOT_BY_SOURCE, TREMOR_COLOR_BY_SOURCE } from '../lib/viz-colors.js';

describe('App', () => {
  it('renders the application shell', () => {
    renderWithProviders(<App />, { route: '/' });
    expect(screen.getByRole('banner')).toHaveTextContent('Center Dashboard');
  });
});

describe('viz color assignment', () => {
  it('assigns a distinct slot to each source', () => {
    const slots = Object.values(SERIES_SLOT_BY_SOURCE);
    expect(new Set(slots).size).toBe(slots.length);
  });

  it('keeps the tremor color name in sync with the slot number', () => {
    for (const [source, slot] of Object.entries(SERIES_SLOT_BY_SOURCE)) {
      expect(TREMOR_COLOR_BY_SOURCE[source as keyof typeof TREMOR_COLOR_BY_SOURCE])
        .toBe(`viz-${slot}`);
    }
  });
});
```

- [ ] **Step 7: Implementar `App.tsx` e `main.tsx`**

`apps/web/src/App.tsx`:

```tsx
import { Route, Routes } from 'react-router-dom';

export function App() {
  return (
    <div className="min-h-screen">
      <header role="banner" className="border-b px-6 py-4" style={{ borderColor: 'var(--hairline)' }}>
        <h1 className="text-lg font-semibold">Center Dashboard</h1>
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
    queries: {
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
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

- [ ] **Step 8: Instalar e rodar**

```bash
pnpm install
pnpm --filter @center/web test
```

Expected: PASS — 3 testes.

> Se o `pnpm install` reclamar do peer `react@^18` do Tremor, confirme que o `.npmrc` da raiz (Task 1) contém `strict-peer-dependencies=false`. Se o Tremor quebrar em runtime com React 19, veja o Risco R5 — o plano B é migrar os quatro componentes de gráfico para Tremor Raw (copy-paste sobre Recharts), o que não altera nenhuma outra task.

- [ ] **Step 9: Verificar o build de produção**

```bash
pnpm --filter @center/web build
```

Expected: build sem erro; confirme que `dist/assets/*.css` contém `--viz-1` e as classes `stroke-viz-1` (prova de que o safelist funcionou).

- [ ] **Step 10: Commit**

```bash
git add apps/web
git commit -m "feat(web): scaffold vite + react 19 + tailwind with validated viz palette"
```

---

### Task 14: Cliente de API tipado e hooks do TanStack Query

**Files:**
- Create: `apps/web/src/lib/api-client.ts`, `apps/web/src/lib/query-keys.ts`, `apps/web/src/lib/format.ts`
- Create: `apps/web/src/hooks/use-metric-catalog.ts`, `apps/web/src/hooks/use-metric-series.ts`, `apps/web/src/hooks/use-promotions.ts`
- Create: `apps/web/src/test/msw-server.ts`
- Test: `apps/web/src/__tests__/api-client.test.ts`, `apps/web/src/__tests__/use-metric-series.test.tsx`

**Interfaces:**
- Consumes: contrato HTTP das Tasks 10–11.
- Produces:
  - Tipos locais `MetricDescriptor`, `MetricSeries`, `MetricPoint`, `Promotion`, `MetricQueryInput` (espelham `@center/shared` **sem** o campo `tenant`)
  - `class ApiError extends Error { status: number }`
  - `apiClient: { login, getCatalog, queryMetric, queryBatch, getPromotions }`
  - `setAuthToken(token: string | null): void`, `getAuthToken(): string | null`
  - `queryKeys: { catalog: () => [...], series: (q) => [...], batch: (qs) => [...], promotions: (activeOn?) => [...] }`
  - `useMetricCatalog()`, `useMetricSeries(query, options?)`, `useMetricBatch(queries)`, `usePromotions(activeOn?)`
  - `formatMetricValue(value: number, unit: MetricUnit): string`, `formatBucketLabel(date: string, granularity: Granularity): string`

- [ ] **Step 1: Escrever o teste do cliente (falhando)**

`apps/web/src/test/msw-server.ts`:

```ts
import { setupServer } from 'msw/node';

export const mswServer = setupServer();
```

Adicione ao final de `apps/web/src/test/setup.ts`:

```ts
import { mswServer } from './msw-server.js';

beforeAll(() => mswServer.listen({ onUnhandledRequest: 'error' }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());
```

`apps/web/src/__tests__/api-client.test.ts`:

```ts
import { http, HttpResponse } from 'msw';
import { mswServer } from '../test/msw-server.js';
import { ApiError, apiClient, setAuthToken } from '../lib/api-client.js';
import { formatBucketLabel, formatMetricValue } from '../lib/format.js';

const series = {
  metricId: 'ga4.sessions', source: 'ga4', unit: 'count', granularity: 'day',
  total: 55, points: [{ date: '2026-01-01', value: 55 }],
};

const query = {
  metricId: 'ga4.sessions', from: '2026-01-01', to: '2026-01-31', granularity: 'day' as const,
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

  it('throws ApiError carrying the status on 4xx', async () => {
    mswServer.use(http.post('/api/metrics/query', () =>
      HttpResponse.json({ error: 'bad_request', message: 'intervalo excede o máximo de 400 dias' }, { status: 400 })));

    await expect(apiClient.queryMetric(query)).rejects.toMatchObject({
      name: 'ApiError', status: 400, message: 'intervalo excede o máximo de 400 dias',
    });
  });

  it('throws ApiError with a readable message on 502', async () => {
    mswServer.use(http.post('/api/metrics/query', () =>
      HttpResponse.json({ error: 'upstream_error', message: 'GA4 indisponível' }, { status: 502 })));
    await expect(apiClient.queryMetric(query)).rejects.toBeInstanceOf(ApiError);
  });

  it('clears the token on 401 so the app can send the user back to login', async () => {
    mswServer.use(http.post('/api/metrics/query', () =>
      HttpResponse.json({ error: 'unauthorized', message: 'token inválido' }, { status: 401 })));
    setAuthToken('token-expirado');
    await expect(apiClient.queryMetric(query)).rejects.toMatchObject({ status: 401 });
    expect(localStorage.getItem('center.token')).toBeNull();
  });
});

describe('apiClient.queryBatch', () => {
  it('unwraps the series array', async () => {
    mswServer.use(http.post('/api/metrics/batch', () => HttpResponse.json({ series: [series, series] })));
    expect(await apiClient.queryBatch([query, query])).toHaveLength(2);
  });
});

describe('formatMetricValue', () => {
  it('formats currency as BRL', () => {
    expect(formatMetricValue(1234.5, 'currency').replace(/ /g, ' ')).toBe('R$ 1.234,50');
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

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `pnpm --filter @center/web test -- api-client.test.ts`
Expected: FAIL — `Cannot find module '../lib/api-client.js'`.

- [ ] **Step 3: Implementar `api-client.ts`**

`apps/web/src/lib/api-client.ts`:

```ts
export type MetricSource = 'firebase' | 'ga4' | 'backend';
export type MetricUnit = 'count' | 'currency' | 'ratio' | 'duration';
export type Granularity = 'day' | 'week' | 'month';

export interface MetricDescriptor {
  id: string;
  label: string;
  description: string;
  source: MetricSource;
  unit: MetricUnit;
  dimensions: string[];
}

export interface MetricPoint {
  date: string;
  value: number;
  group?: string;
}

export interface MetricSeries {
  metricId: string;
  source: MetricSource;
  unit: MetricUnit;
  granularity: Granularity;
  total: number;
  points: MetricPoint[];
}

/** O cliente NUNCA envia tenant — ele vem do JWT no servidor. */
export interface MetricQueryInput {
  metricId: string;
  from: string;
  to: string;
  granularity: Granularity;
  filters?: Record<string, string>;
  groupBy?: string;
}

export interface Promotion {
  id: string;
  name: string;
  startsAt: string;
  endsAt: string;
  status: 'scheduled' | 'running' | 'finished';
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
    // Token expirado: limpamos aqui para que o guard de rota redirecione
    // sem cada tela precisar tratar 401 individualmente.
    if (response.status === 401) setAuthToken(null);
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(response.status, body.message ?? `requisição falhou (${response.status})`);
  }

  return (await response.json()) as T;
}

export const apiClient = {
  async login(email: string, password: string): Promise<{ token: string; user: { id: string; name: string; email: string; role: string } }> {
    return request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  },

  async getCatalog(): Promise<MetricDescriptor[]> {
    const payload = await request<{ metrics: MetricDescriptor[] }>('/api/metrics/catalog');
    return payload.metrics;
  },

  queryMetric(query: MetricQueryInput): Promise<MetricSeries> {
    return request('/api/metrics/query', { method: 'POST', body: JSON.stringify(query) });
  },

  async queryBatch(queries: MetricQueryInput[]): Promise<MetricSeries[]> {
    const payload = await request<{ series: MetricSeries[] }>('/api/metrics/batch', {
      method: 'POST',
      body: JSON.stringify({ queries }),
    });
    return payload.series;
  },

  async getPromotions(activeOn?: string): Promise<Promotion[]> {
    const search = activeOn ? `?activeOn=${activeOn}` : '';
    const payload = await request<{ promotions: Promotion[] }>(`/api/promotions${search}`);
    return payload.promotions;
  },
};
```

- [ ] **Step 4: Implementar `format.ts`**

`apps/web/src/lib/format.ts`:

```ts
import type { Granularity, MetricUnit } from './api-client.js';

const LOCALE = 'pt-BR';

const currency = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'BRL' });
const count = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const ratio = new Intl.NumberFormat(LOCALE, { style: 'percent', maximumFractionDigits: 1 });

export function formatMetricValue(value: number, unit: MetricUnit): string {
  switch (unit) {
    case 'currency': return currency.format(value);
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
  if (granularity === 'month') {
    return `${MONTH_ABBR[Number(month) - 1]}/${year.slice(2)}`;
  }
  const short = `${day}/${month}`;
  return granularity === 'week' ? `sem. ${short}` : short;
}
```

- [ ] **Step 5: Implementar `query-keys.ts` e os hooks**

`apps/web/src/lib/query-keys.ts`:

```ts
import type { MetricQueryInput } from './api-client.js';

/**
 * Chaves hierárquicas: invalidar `['metrics']` invalida tudo de métricas.
 * O objeto de query entra inteiro na chave — o TanStack Query serializa de
 * forma estável, então a ordem das propriedades não gera cache duplicado.
 */
export const queryKeys = {
  catalog: () => ['metrics', 'catalog'] as const,
  series: (query: MetricQueryInput) => ['metrics', 'series', query] as const,
  batch: (queries: MetricQueryInput[]) => ['metrics', 'batch', queries] as const,
  promotions: (activeOn?: string) => ['promotions', activeOn ?? 'all'] as const,
};
```

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
import { useQueries, useQuery } from '@tanstack/react-query';
import { apiClient, type MetricQueryInput } from '../lib/api-client.js';
import { queryKeys } from '../lib/query-keys.js';

export function useMetricSeries(query: MetricQueryInput, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.series(query),
    queryFn: () => apiClient.queryMetric(query),
    enabled: options.enabled ?? true,
  });
}

/**
 * Uma única chamada HTTP para os N KPIs da tela. Cada série continua com sua
 * própria chave de cache, então navegar entre páginas reaproveita o que já veio.
 */
export function useMetricBatch(queries: MetricQueryInput[], options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.batch(queries),
    queryFn: () => apiClient.queryBatch(queries),
    enabled: (options.enabled ?? true) && queries.length > 0,
  });
}

export { useQueries };
```

`apps/web/src/hooks/use-promotions.ts`:

```ts
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../lib/api-client.js';
import { queryKeys } from '../lib/query-keys.js';

export function usePromotions(activeOn?: string) {
  return useQuery({
    queryKey: queryKeys.promotions(activeOn),
    queryFn: () => apiClient.getPromotions(activeOn),
  });
}
```

- [ ] **Step 6: Escrever o teste do hook (falhando)**

`apps/web/src/__tests__/use-metric-series.test.tsx`:

```tsx
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { mswServer } from '../test/msw-server.js';
import { useMetricSeries } from '../hooks/use-metric-series.js';
import type { MetricQueryInput } from '../lib/api-client.js';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const query: MetricQueryInput = {
  metricId: 'ga4.sessions', from: '2026-01-01', to: '2026-01-31', granularity: 'day',
};

const series = {
  metricId: 'ga4.sessions', source: 'ga4', unit: 'count', granularity: 'day',
  total: 55, points: [{ date: '2026-01-01', value: 55 }],
};

describe('useMetricSeries', () => {
  it('returns the series once loaded', async () => {
    mswServer.use(http.post('/api/metrics/query', () => HttpResponse.json(series)));
    const { result } = renderHook(() => useMetricSeries(query), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.total).toBe(55);
  });

  it('surfaces the API error message', async () => {
    mswServer.use(http.post('/api/metrics/query', () =>
      HttpResponse.json({ message: 'GA4 indisponível' }, { status: 502 })));
    const { result } = renderHook(() => useMetricSeries(query), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ message: 'GA4 indisponível' });
  });

  it('does not fetch while disabled', async () => {
    const handler = jest.fn(() => HttpResponse.json(series));
    mswServer.use(http.post('/api/metrics/query', handler));
    const { result } = renderHook(() => useMetricSeries(query, { enabled: false }), { wrapper });
    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(handler).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 7: Rodar os testes**

Run: `pnpm --filter @center/web test`
Expected: PASS — 3 suites, 18 testes.

- [ ] **Step 8: Commit**

```bash
git add apps/web
git commit -m "feat(web): add typed api client, formatters and query hooks"
```

---

### Task 15: Filtros globais sincronizados com a URL

**Files:**
- Create: `apps/web/src/hooks/use-filters.ts`, `apps/web/src/components/filters/PeriodPicker.tsx`, `apps/web/src/components/filters/SourceFilter.tsx`
- Test: `apps/web/src/__tests__/use-filters.test.tsx`, `apps/web/src/__tests__/period-picker.test.tsx`

**Interfaces:**
- Consumes: `MetricSource`, `Granularity` de `lib/api-client.js`; `SOURCE_LABEL` de `lib/viz-colors.js`.
- Produces:
  - `interface DashboardFilters { from: string; to: string; granularity: Granularity; sources: MetricSource[] }`
  - `useFilters(today?: string): { filters: DashboardFilters; setFilters(patch: Partial<DashboardFilters>): void; applyPreset(preset: PeriodPreset): void }`
  - `type PeriodPreset = 'last7' | 'last30' | 'last90' | 'monthToDate' | 'lastMonth'`
  - `resolvePreset(preset: PeriodPreset, today: string): { from: string; to: string; granularity: Granularity }`
  - `<PeriodPicker />`, `<SourceFilter />`

**Por que na URL e não em contexto React:** o usuário precisa conseguir mandar o link da tela filtrada para um colega. Estado de filtro em memória perde isso e obriga a reimplementar deep-link depois.

- [ ] **Step 1: Escrever o teste (falhando)**

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
  it('last7 covers today and the six previous days', () => {
    expect(resolvePreset('last7', TODAY)).toEqual({
      from: '2026-03-09', to: '2026-03-15', granularity: 'day',
    });
  });

  it('last30 stays on day granularity', () => {
    expect(resolvePreset('last30', TODAY)).toEqual({
      from: '2026-02-14', to: '2026-03-15', granularity: 'day',
    });
  });

  it('last90 switches to week granularity so the axis stays readable', () => {
    expect(resolvePreset('last90', TODAY)).toEqual({
      from: '2025-12-16', to: '2026-03-15', granularity: 'week',
    });
  });

  it('monthToDate starts on the first of the month', () => {
    expect(resolvePreset('monthToDate', TODAY)).toEqual({
      from: '2026-03-01', to: '2026-03-15', granularity: 'day',
    });
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
});

describe('useFilters', () => {
  it('defaults to the last 30 days when the URL has no params', () => {
    const { result } = renderHook(() => useFilters(TODAY), { wrapper: wrapperFor('/') });
    expect(result.current.filters).toEqual({
      from: '2026-02-14', to: '2026-03-15', granularity: 'day',
      sources: ['ga4', 'backend', 'firebase'],
    });
  });

  it('reads the filters from the URL', () => {
    const { result } = renderHook(() => useFilters(TODAY), {
      wrapper: wrapperFor('/?from=2026-01-01&to=2026-01-31&granularity=month&sources=ga4,backend'),
    });
    expect(result.current.filters).toEqual({
      from: '2026-01-01', to: '2026-01-31', granularity: 'month', sources: ['ga4', 'backend'],
    });
  });

  it('falls back to the default when the URL carries an invalid granularity', () => {
    const { result } = renderHook(() => useFilters(TODAY), {
      wrapper: wrapperFor('/?granularity=hour'),
    });
    expect(result.current.filters.granularity).toBe('day');
  });

  it('ignores an unknown source in the URL', () => {
    const { result } = renderHook(() => useFilters(TODAY), {
      wrapper: wrapperFor('/?sources=ga4,mixpanel'),
    });
    expect(result.current.filters.sources).toEqual(['ga4']);
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

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `pnpm --filter @center/web test -- use-filters.test.tsx`
Expected: FAIL — `Cannot find module '../hooks/use-filters.js'`.

- [ ] **Step 3: Implementar `use-filters.ts`**

`apps/web/src/hooks/use-filters.ts`:

```ts
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Granularity, MetricSource } from '../lib/api-client.js';

export type PeriodPreset = 'last7' | 'last30' | 'last90' | 'monthToDate' | 'lastMonth';

export interface DashboardFilters {
  from: string;
  to: string;
  granularity: Granularity;
  sources: MetricSource[];
}

const ALL_SOURCES: MetricSource[] = ['ga4', 'backend', 'firebase'];
const GRANULARITIES: Granularity[] = ['day', 'week', 'month'];

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
    case 'last7':
      return { from: shiftDays(today, -6), to: today, granularity: 'day' };
    case 'last30':
      return { from: shiftDays(today, -29), to: today, granularity: 'day' };
    case 'last90':
      // 90 pontos diários deixam o eixo ilegível; a semana é a leitura certa aqui.
      return { from: shiftDays(today, -89), to: today, granularity: 'week' };
    case 'monthToDate':
      return { from: toIso(new Date(Date.UTC(year, month - 1, 1))), to: today, granularity: 'day' };
    case 'lastMonth': {
      const first = new Date(Date.UTC(year, month - 2, 1));
      // Dia 0 do mês seguinte = último dia do mês anterior. Cobre ano bissexto.
      const last = new Date(Date.UTC(year, month - 1, 0));
      return { from: toIso(first), to: toIso(last), granularity: 'day' };
    }
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function useFilters(today: string = new Date().toISOString().slice(0, 10)) {
  const [searchParams, setSearchParams] = useSearchParams();

  const filters = useMemo<DashboardFilters>(() => {
    const fallback = resolvePreset('last30', today);

    const from = searchParams.get('from');
    const to = searchParams.get('to');
    const granularity = searchParams.get('granularity') as Granularity | null;
    const sourcesParam = searchParams.get('sources');

    const parsedSources = sourcesParam
      ? (sourcesParam.split(',').filter((s): s is MetricSource =>
          ALL_SOURCES.includes(s as MetricSource)))
      : ALL_SOURCES;

    return {
      // Valor inválido na URL nunca quebra a tela — cai no default.
      from: from && ISO_DATE.test(from) ? from : fallback.from,
      to: to && ISO_DATE.test(to) ? to : fallback.to,
      granularity: granularity && GRANULARITIES.includes(granularity) ? granularity : fallback.granularity,
      sources: parsedSources.length > 0 ? parsedSources : ALL_SOURCES,
    };
  }, [searchParams, today]);

  const setFilters = useCallback(
    (patch: Partial<DashboardFilters>) => {
      const next = { ...filters, ...patch };
      setSearchParams(
        {
          from: next.from,
          to: next.to,
          granularity: next.granularity,
          sources: next.sources.join(','),
        },
        { replace: true },
      );
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

- [ ] **Step 4: Escrever o teste do PeriodPicker (falhando)**

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
    for (const label of ['7 dias', '30 dias', '90 dias', 'Mês atual', 'Mês passado']) {
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
  it('renders one checkbox per source, all checked by default', () => {
    renderWithProviders(<SourceFilter today="2026-03-15" />, { route: '/' });
    for (const label of ['Google Analytics', 'Backend', 'App Mobile']) {
      expect(screen.getByRole('checkbox', { name: label })).toBeChecked();
    }
  });

  it('unchecking a source removes it from the filters', async () => {
    renderWithProviders(<SourceFilter today="2026-03-15" />, { route: '/' });
    await userEvent.click(screen.getByRole('checkbox', { name: 'App Mobile' }));
    expect(screen.getByRole('checkbox', { name: 'App Mobile' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Google Analytics' })).toBeChecked();
  });

  it('refuses to uncheck the last remaining source', async () => {
    renderWithProviders(<SourceFilter today="2026-03-15" />, { route: '/?sources=ga4' });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Google Analytics' }));
    expect(screen.getByRole('checkbox', { name: 'Google Analytics' })).toBeChecked();
  });
});
```

- [ ] **Step 5: Implementar os componentes de filtro**

`apps/web/src/components/filters/PeriodPicker.tsx`:

```tsx
import { resolvePreset, useFilters, type PeriodPreset } from '../../hooks/use-filters.js';

const PRESETS: Array<{ id: PeriodPreset; label: string }> = [
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
      {/* O intervalo resolvido sempre visível: "30 dias" sozinho é ambíguo. */}
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
import { SOURCE_LABEL } from '../../lib/viz-colors.js';
import type { MetricSource } from '../../lib/api-client.js';

const SOURCES: MetricSource[] = ['ga4', 'backend', 'firebase'];

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
          {/* Swatch ao lado do rótulo: a identidade nunca depende só da cor. */}
          <span
            aria-hidden="true"
            className={`h-2.5 w-2.5 rounded-sm bg-viz-${source === 'ga4' ? 1 : source === 'backend' ? 2 : 3}`}
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
Expected: PASS — 5 suites, 31 testes.

- [ ] **Step 7: Commit**

```bash
git add apps/web
git commit -m "feat(web): add url-synced dashboard filters with period presets"
```

---

### Task 16: Componentes de gráfico

**Files:**
- Create: `apps/web/src/components/charts/ChartFrame.tsx`, `apps/web/src/components/charts/KpiCard.tsx`, `apps/web/src/components/charts/TimeSeriesChart.tsx`, `apps/web/src/components/charts/SourceBreakdown.tsx`
- Test: `apps/web/src/__tests__/chart-frame.test.tsx`, `apps/web/src/__tests__/kpi-card.test.tsx`, `apps/web/src/__tests__/time-series-chart.test.tsx`

**Interfaces:**
- Consumes: `MetricSeries`, `MetricUnit`, `Granularity` de `lib/api-client.js`; `formatMetricValue`, `formatBucketLabel` de `lib/format.js`; `TREMOR_COLOR_BY_SOURCE`, `TREMOR_SLOTS`, `SOURCE_LABEL` de `lib/viz-colors.js`.
- Produces:
  - `<ChartFrame title, description?, tableRows, tableColumns, isLoading, error, children />`
  - `<KpiCard label, value, unit, previousValue?, isLoading?, error? />`
  - `<TimeSeriesChart title, seriesList, granularity, unit, isLoading, error />` onde `seriesList: MetricSeries[]`
  - `<SourceBreakdown title, seriesList, unit, isLoading, error />`

**As regras de visualização aplicadas aqui (todas verificáveis por teste):**
1. **Tabela sempre disponível.** Três cores do modo claro ficam abaixo de 3:1 de contraste — a regra de relevo obriga rótulos visíveis ou visão de tabela. O `ChartFrame` embute o toggle.
2. **Legenda presente com ≥ 2 séries; nenhuma com 1 série** (o título já nomeia a única série).
3. **Nunca dois eixos Y.** Se duas métricas têm escalas diferentes, são dois `TimeSeriesChart`.
4. **Traço de 2px, grade recessiva, sem ponto rotulado em todo bucket.**
5. **Cor por entidade.** `TREMOR_COLOR_BY_SOURCE` mapeia fonte → slot fixo.

- [ ] **Step 1: Escrever o teste do ChartFrame (falhando)**

`apps/web/src/__tests__/chart-frame.test.tsx`:

```tsx
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/render.js';
import { ChartFrame } from '../components/charts/ChartFrame.js';

const tableColumns = ['Data', 'Sessões'];
const tableRows = [['01/01', '55'], ['02/01', '61']];

describe('ChartFrame', () => {
  it('renders the chart by default and hides the table', () => {
    renderWithProviders(
      <ChartFrame title="Sessões" tableColumns={tableColumns} tableRows={tableRows}>
        <div data-testid="chart" />
      </ChartFrame>,
    );
    expect(screen.getByTestId('chart')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('swaps to the accessible table view on toggle', async () => {
    renderWithProviders(
      <ChartFrame title="Sessões" tableColumns={tableColumns} tableRows={tableRows}>
        <div data-testid="chart" />
      </ChartFrame>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Ver como tabela' }));
    const table = screen.getByRole('table');
    expect(table).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Sessões' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '55' })).toBeInTheDocument();
    expect(screen.queryByTestId('chart')).not.toBeInTheDocument();
  });

  it('goes back to the chart on a second toggle', async () => {
    renderWithProviders(
      <ChartFrame title="Sessões" tableColumns={tableColumns} tableRows={tableRows}>
        <div data-testid="chart" />
      </ChartFrame>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Ver como tabela' }));
    await userEvent.click(screen.getByRole('button', { name: 'Ver como gráfico' }));
    expect(screen.getByTestId('chart')).toBeInTheDocument();
  });

  it('shows a loading state instead of the chart', () => {
    renderWithProviders(
      <ChartFrame title="Sessões" tableColumns={tableColumns} tableRows={[]} isLoading>
        <div data-testid="chart" />
      </ChartFrame>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Carregando');
    expect(screen.queryByTestId('chart')).not.toBeInTheDocument();
  });

  it('shows the error message and hides the table toggle', () => {
    renderWithProviders(
      <ChartFrame
        title="Sessões" tableColumns={tableColumns} tableRows={[]}
        error={new Error('GA4 indisponível')}
      >
        <div data-testid="chart" />
      </ChartFrame>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('GA4 indisponível');
    expect(screen.queryByRole('button', { name: 'Ver como tabela' })).not.toBeInTheDocument();
  });

  it('shows an empty state when there is no data', () => {
    renderWithProviders(
      <ChartFrame title="Sessões" tableColumns={tableColumns} tableRows={[]}>
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
 * 3:1 de contraste com a superfície, então a visão de tabela não é um extra —
 * é o mecanismo de relevo que torna o gráfico legível para quem não distingue
 * as cores. Por isso ela vive aqui, e não em cada gráfico.
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
          Carregando
        </div>
      ) : error ? (
        <div role="alert" className="rounded-md p-4 text-sm" style={{ color: 'var(--text-secondary)' }}>
          <strong className="block font-medium" style={{ color: '#d03b3b' }}>Não foi possível carregar</strong>
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
                    key={column}
                    scope="col"
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

- [ ] **Step 3: Escrever o teste do KpiCard (falhando)**

`apps/web/src/__tests__/kpi-card.test.tsx`:

```tsx
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../test/render.js';
import { KpiCard } from '../components/charts/KpiCard.js';

describe('KpiCard', () => {
  it('shows the formatted value for its unit', () => {
    renderWithProviders(<KpiCard label="Investimento" value={12345.6} unit="currency" />);
    expect(screen.getByText(/12\.345,60/)).toBeInTheDocument();
  });

  it('shows a positive delta with a direction word, not only a color', () => {
    renderWithProviders(<KpiCard label="Sessões" value={120} previousValue={100} unit="count" />);
    expect(screen.getByText('+20,0%')).toBeInTheDocument();
    expect(screen.getByText(/aumento/i)).toBeInTheDocument();
  });

  it('shows a negative delta', () => {
    renderWithProviders(<KpiCard label="Sessões" value={80} previousValue={100} unit="count" />);
    expect(screen.getByText('-20,0%')).toBeInTheDocument();
    expect(screen.getByText(/queda/i)).toBeInTheDocument();
  });

  it('omits the delta when there is no previous value', () => {
    renderWithProviders(<KpiCard label="Sessões" value={120} unit="count" />);
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it('omits the delta when the previous value is zero (division by zero)', () => {
    renderWithProviders(<KpiCard label="Sessões" value={120} previousValue={0} unit="count" />);
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it('shows the error message instead of a stale value', () => {
    renderWithProviders(
      <KpiCard label="Sessões" value={0} unit="count" error={new Error('fonte fora do ar')} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('fonte fora do ar');
  });
});
```

- [ ] **Step 4: Implementar `KpiCard.tsx`**

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
 * / "queda") além da cor — a cor sozinha não é canal acessível.
 */
export function KpiCard({ label, value, unit, previousValue, isLoading = false, error = null }: KpiCardProps) {
  const hasDelta = previousValue !== undefined && previousValue !== 0;
  const deltaRatio = hasDelta ? ((value - previousValue) / Math.abs(previousValue)) * 100 : 0;
  const rising = deltaRatio >= 0;

  return (
    <div
      className="rounded-lg border p-4"
      style={{ backgroundColor: 'var(--surface-1)', borderColor: 'var(--hairline)' }}
    >
      <p className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
        {label}
      </p>

      {isLoading ? (
        <div role="status" className="mt-2 h-8 w-24 animate-pulse rounded" style={{ backgroundColor: 'var(--gridline)' }}>
          <span className="sr-only">Carregando {label}</span>
        </div>
      ) : error ? (
        <p role="alert" className="mt-2 text-sm" style={{ color: '#d03b3b' }}>{error.message}</p>
      ) : (
        <>
          <p className="mt-1 text-3xl font-semibold" style={{ color: 'var(--text-primary)' }}>
            {formatMetricValue(value, unit)}
          </p>
          {hasDelta ? (
            <p className="mt-1 flex items-center gap-1.5 text-sm">
              <span aria-hidden="true" style={{ color: rising ? '#006300' : '#d03b3b' }}>
                {rising ? '▲' : '▼'}
              </span>
              <span className="tabular-nums" style={{ color: rising ? '#006300' : '#d03b3b' }}>
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

- [ ] **Step 5: Escrever o teste do TimeSeriesChart (falhando)**

`apps/web/src/__tests__/time-series-chart.test.tsx`:

```tsx
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/render.js';
import { TimeSeriesChart } from '../components/charts/TimeSeriesChart.js';
import type { MetricSeries } from '../lib/api-client.js';

const ga4: MetricSeries = {
  metricId: 'ga4.sessions', source: 'ga4', unit: 'count', granularity: 'day', total: 116,
  points: [{ date: '2026-01-01', value: 55 }, { date: '2026-01-02', value: 61 }],
};

const backend: MetricSeries = {
  metricId: 'backend.orders', source: 'backend', unit: 'count', granularity: 'day', total: 12,
  points: [{ date: '2026-01-01', value: 5 }, { date: '2026-01-02', value: 7 }],
};

describe('TimeSeriesChart', () => {
  it('renders inside a chart frame titled with the given title', () => {
    renderWithProviders(
      <TimeSeriesChart title="Sessões" seriesList={[ga4]} granularity="day" unit="count" />,
    );
    expect(screen.getByRole('region', { name: 'Sessões' })).toBeInTheDocument();
  });

  it('builds a table row per bucket with a column per series', async () => {
    renderWithProviders(
      <TimeSeriesChart title="Volume" seriesList={[ga4, backend]} granularity="day" unit="count" />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Ver como tabela' }));
    expect(screen.getByRole('columnheader', { name: 'Google Analytics' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Backend' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '01/01' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '55' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '5' })).toBeInTheDocument();
  });

  it('aligns buckets across series that do not share every date', async () => {
    const sparse: MetricSeries = { ...backend, points: [{ date: '2026-01-02', value: 7 }] };
    renderWithProviders(
      <TimeSeriesChart title="Volume" seriesList={[ga4, sparse]} granularity="day" unit="count" />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Ver como tabela' }));
    // 01/01 existe só no GA4 — a coluna do backend precisa mostrar zero, não sumir.
    expect(screen.getAllByRole('row')).toHaveLength(3); // cabeçalho + 2 buckets
  });

  it('propagates the error to the frame', () => {
    renderWithProviders(
      <TimeSeriesChart
        title="Sessões" seriesList={[]} granularity="day" unit="count"
        error={new Error('GA4 fora do ar')}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('GA4 fora do ar');
  });

  it('shows the empty state when every series is empty', () => {
    renderWithProviders(
      <TimeSeriesChart title="Sessões" seriesList={[{ ...ga4, points: [] }]} granularity="day" unit="count" />,
    );
    expect(screen.getByText('Sem dados no período selecionado')).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Implementar `TimeSeriesChart.tsx`**

`apps/web/src/components/charts/TimeSeriesChart.tsx`:

```tsx
import { AreaChart } from '@tremor/react';
import type { Granularity, MetricSeries, MetricUnit } from '../../lib/api-client.js';
import { formatBucketLabel, formatMetricValue } from '../../lib/format.js';
import { SOURCE_LABEL, TREMOR_COLOR_BY_SOURCE } from '../../lib/viz-colors.js';
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

interface ChartRow {
  bucket: string;
  [seriesName: string]: string | number;
}

/**
 * Uma única escala Y, sempre. Duas métricas de grandezas diferentes (gasto em
 * R$ e cliques, por exemplo) NUNCA compartilham este componente — são dois
 * gráficos lado a lado.
 */
function buildRows(seriesList: MetricSeries[], granularity: Granularity): ChartRow[] {
  const buckets = [...new Set(seriesList.flatMap((series) => series.points.map((p) => p.date)))].sort();

  return buckets.map((bucket) => {
    const row: ChartRow = { bucket: formatBucketLabel(bucket, granularity) };
    for (const series of seriesList) {
      // Bucket ausente vira 0, não `undefined` — senão a linha ganha um furo.
      row[SOURCE_LABEL[series.source]] =
        series.points.find((point) => point.date === bucket)?.value ?? 0;
    }
    return row;
  });
}

export function TimeSeriesChart({
  title, description, seriesList, granularity, unit, isLoading = false, error = null,
}: TimeSeriesChartProps) {
  const rows = buildRows(seriesList, granularity);
  const categories = seriesList.map((series) => SOURCE_LABEL[series.source]);
  const colors = seriesList.map((series) => TREMOR_COLOR_BY_SOURCE[series.source]);

  const tableColumns = ['Período', ...categories];
  const tableRows = rows.map((row) => [
    String(row.bucket),
    ...categories.map((category) => formatMetricValue(Number(row[category] ?? 0), unit)),
  ]);

  return (
    <ChartFrame
      title={title}
      {...(description ? { description } : {})}
      tableColumns={tableColumns}
      tableRows={tableRows}
      isLoading={isLoading}
      error={error}
    >
      <AreaChart
        className="h-64"
        data={rows}
        index="bucket"
        categories={categories}
        colors={colors}
        valueFormatter={(value: number) => formatMetricValue(value, unit)}
        // Legenda só com 2+ séries: com uma série o título já a nomeia.
        showLegend={categories.length > 1}
        showGridLines
        showAnimation={false}
        curveType="monotone"
        connectNulls
        yAxisWidth={72}
        autoMinValue
      />
    </ChartFrame>
  );
}
```

- [ ] **Step 7: Implementar `SourceBreakdown.tsx`**

`apps/web/src/components/charts/SourceBreakdown.tsx`:

```tsx
import { BarChart } from '@tremor/react';
import type { MetricSeries, MetricUnit } from '../../lib/api-client.js';
import { formatMetricValue } from '../../lib/format.js';
import { SOURCE_LABEL, TREMOR_SLOTS } from '../../lib/viz-colors.js';
import { ChartFrame } from './ChartFrame.js';

interface SourceBreakdownProps {
  title: string;
  description?: string;
  seriesList: MetricSeries[];
  unit: MetricUnit;
  isLoading?: boolean;
  error?: Error | null;
}

/**
 * Comparação de totais entre fontes: barras horizontais, ordenadas por
 * magnitude. Uma categoria por barra, então uma cor só — a identidade vem do
 * rótulo do eixo, não da cor. É por isso que aqui usamos o slot 1 para todas.
 */
export function SourceBreakdown({
  title, description, seriesList, unit, isLoading = false, error = null,
}: SourceBreakdownProps) {
  const rows = seriesList
    .map((series) => ({ fonte: SOURCE_LABEL[series.source], Total: series.total }))
    .sort((a, b) => b.Total - a.Total);

  return (
    <ChartFrame
      title={title}
      {...(description ? { description } : {})}
      tableColumns={['Fonte', 'Total']}
      tableRows={rows.map((row) => [row.fonte, formatMetricValue(row.Total, unit)])}
      isLoading={isLoading}
      error={error}
    >
      <BarChart
        className="h-64"
        data={rows}
        index="fonte"
        categories={['Total']}
        colors={[TREMOR_SLOTS[0]]}
        layout="vertical"
        valueFormatter={(value: number) => formatMetricValue(value, unit)}
        showLegend={false}
        showAnimation={false}
        yAxisWidth={120}
      />
    </ChartFrame>
  );
}
```

- [ ] **Step 8: Rodar os testes**

Run: `pnpm --filter @center/web test`
Expected: PASS — 8 suites, 48 testes.

- [ ] **Step 9: Inspeção visual (o validador não checa layout)**

```bash
pnpm --filter @center/web dev
```

Abra `http://localhost:5173` e confirme, nos dois temas do sistema operacional:
- Rótulos do eixo X não colidem nem são cortados no range de 90 dias.
- A legenda aparece com 2+ séries e some com 1.
- O toggle de tabela troca o conteúdo e mantém a altura do card estável.
- Nenhuma barra de rolagem horizontal no `body` em viewport de 375px.

- [ ] **Step 10: Commit**

```bash
git add apps/web
git commit -m "feat(web): add accessible chart components with mandatory table view"
```

---

### Task 17: Páginas Overview e Promoções

**Files:**
- Create: `apps/web/src/components/layout/AppShell.tsx`, `apps/web/src/pages/OverviewPage.tsx`, `apps/web/src/pages/PromotionsPage.tsx`
- Modify: `apps/web/src/App.tsx` (rotas)
- Test: `apps/web/src/__tests__/overview-page.test.tsx`, `apps/web/src/__tests__/promotions-page.test.tsx`

**Interfaces:**
- Consumes: `useFilters` (Task 15); `useMetricBatch`, `usePromotions` (Task 14); `KpiCard`, `TimeSeriesChart`, `SourceBreakdown` (Task 16); `PeriodPicker`, `SourceFilter` (Task 15).
- Produces: `<AppShell />`, `<OverviewPage today />`, `<PromotionsPage today />`; rotas `/` → Overview, `/promocoes` → Promoções.

- [ ] **Step 1: Escrever o teste da Overview (falhando)**

`apps/web/src/__tests__/overview-page.test.tsx`:

```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../test/msw-server.js';
import { renderWithProviders } from '../test/render.js';
import { OverviewPage } from '../pages/OverviewPage.js';

const seriesFor = (metricId: string, source: string, unit: string, total: number) => ({
  metricId, source, unit, granularity: 'day', total,
  points: [{ date: '2026-03-14', value: total / 2 }, { date: '2026-03-15', value: total / 2 }],
});

function mockBatch(handler?: jest.Mock) {
  mswServer.use(http.post('/api/metrics/batch', async ({ request }) => {
    const body = (await request.json()) as { queries: Array<{ metricId: string }> };
    handler?.(body);
    return HttpResponse.json({
      series: body.queries.map((query) => {
        if (query.metricId === 'backend.spend') return seriesFor(query.metricId, 'backend', 'currency', 4800);
        if (query.metricId === 'firebase.app_opens') return seriesFor(query.metricId, 'firebase', 'count', 3000);
        return seriesFor(query.metricId, 'ga4', 'count', 1200);
      }),
    });
  }));
}

describe('OverviewPage', () => {
  it('renders one KPI card per headline metric', async () => {
    mockBatch();
    renderWithProviders(<OverviewPage today="2026-03-15" />, { route: '/' });
    await waitFor(() => expect(screen.getByText('Sessões')).toBeInTheDocument());
    expect(screen.getByText('Investimento')).toBeInTheDocument();
    expect(screen.getByText('Aberturas do app')).toBeInTheDocument();
    expect(screen.getByText('Pedidos')).toBeInTheDocument();
  });

  it('sends the filter period in every query', async () => {
    const handler = jest.fn();
    mockBatch(handler);
    renderWithProviders(<OverviewPage today="2026-03-15" />, {
      route: '/?from=2026-01-01&to=2026-01-31&granularity=day&sources=ga4,backend,firebase',
    });
    await waitFor(() => expect(handler).toHaveBeenCalled());
    const body = handler.mock.calls[0][0];
    expect(body.queries.every((q: { from: string }) => q.from === '2026-01-01')).toBe(true);
  });

  it('drops queries for a deselected source', async () => {
    const handler = jest.fn();
    mockBatch(handler);
    renderWithProviders(<OverviewPage today="2026-03-15" />, { route: '/?sources=ga4' });
    await waitFor(() => expect(handler).toHaveBeenCalled());
    const metricIds = handler.mock.calls[0][0].queries.map((q: { metricId: string }) => q.metricId);
    expect(metricIds.every((id: string) => id.startsWith('ga4.'))).toBe(true);
  });

  it('refetches when the user picks another period', async () => {
    const handler = jest.fn();
    mockBatch(handler);
    renderWithProviders(<OverviewPage today="2026-03-15" />, { route: '/' });
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole('button', { name: '7 dias' }));
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    expect(handler.mock.calls[1][0].queries[0].from).toBe('2026-03-09');
  });

  it('shows the error on every card when the batch fails', async () => {
    mswServer.use(http.post('/api/metrics/batch', () =>
      HttpResponse.json({ message: 'fontes indisponíveis' }, { status: 502 })));
    renderWithProviders(<OverviewPage today="2026-03-15" />, { route: '/' });
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect(screen.getAllByRole('alert')[0]).toHaveTextContent('fontes indisponíveis');
  });
});
```

- [ ] **Step 2: Implementar `AppShell.tsx`**

`apps/web/src/components/layout/AppShell.tsx`:

```tsx
import { NavLink, Outlet } from 'react-router-dom';

const LINKS = [
  { to: '/', label: 'Visão geral', end: true },
  { to: '/promocoes', label: 'Promoções', end: false },
];

export function AppShell() {
  return (
    <div className="min-h-screen">
      <header
        role="banner"
        className="border-b px-6 py-4"
        style={{ borderColor: 'var(--hairline)', backgroundColor: 'var(--surface-1)' }}
      >
        <div className="mx-auto flex max-w-7xl items-center gap-8">
          <h1 className="text-lg font-semibold">Center Dashboard</h1>
          <nav aria-label="Principal" className="flex gap-1">
            {LINKS.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                end={link.end}
                className={({ isActive }) =>
                  `rounded-md px-3 py-1.5 text-sm ${isActive ? 'bg-viz-1 text-white' : ''}`
                }
                style={({ isActive }) => (isActive ? undefined : { color: 'var(--text-secondary)' })}
              >
                {link.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-7xl p-6">
        <Outlet />
      </main>
    </div>
  );
}
```

- [ ] **Step 3: Implementar `OverviewPage.tsx`**

`apps/web/src/pages/OverviewPage.tsx`:

```tsx
import { useMemo } from 'react';
import { useFilters } from '../hooks/use-filters.js';
import { useMetricBatch } from '../hooks/use-metric-series.js';
import { PeriodPicker } from '../components/filters/PeriodPicker.js';
import { SourceFilter } from '../components/filters/SourceFilter.js';
import { KpiCard } from '../components/charts/KpiCard.js';
import { TimeSeriesChart } from '../components/charts/TimeSeriesChart.js';
import { SourceBreakdown } from '../components/charts/SourceBreakdown.js';
import type { MetricQueryInput, MetricSeries, MetricSource, MetricUnit } from '../lib/api-client.js';

interface HeadlineMetric {
  metricId: string;
  source: MetricSource;
  label: string;
  unit: MetricUnit;
}

const HEADLINE_METRICS: HeadlineMetric[] = [
  { metricId: 'ga4.sessions', source: 'ga4', label: 'Sessões', unit: 'count' },
  { metricId: 'backend.spend', source: 'backend', label: 'Investimento', unit: 'currency' },
  { metricId: 'backend.orders', source: 'backend', label: 'Pedidos', unit: 'count' },
  { metricId: 'firebase.app_opens', source: 'firebase', label: 'Aberturas do app', unit: 'count' },
];

export function OverviewPage({ today }: { today: string }) {
  const { filters } = useFilters(today);

  const queries = useMemo<MetricQueryInput[]>(
    () =>
      HEADLINE_METRICS.filter((metric) => filters.sources.includes(metric.source)).map((metric) => ({
        metricId: metric.metricId,
        from: filters.from,
        to: filters.to,
        granularity: filters.granularity,
      })),
    [filters],
  );

  const { data, isLoading, error } = useMetricBatch(queries);
  const queryError = error instanceof Error ? error : null;

  const visibleMetrics = HEADLINE_METRICS.filter((metric) => filters.sources.includes(metric.source));
  const seriesById = new Map((data ?? []).map((series) => [series.metricId, series]));

  // Contagem: uma escala. Moeda: outra escala. Dois gráficos, nunca dois eixos Y.
  const countSeries = visibleMetrics
    .filter((metric) => metric.unit === 'count')
    .map((metric) => seriesById.get(metric.metricId))
    .filter((series): series is MetricSeries => series !== undefined);

  const spendSeries = visibleMetrics
    .filter((metric) => metric.unit === 'currency')
    .map((metric) => seriesById.get(metric.metricId))
    .filter((series): series is MetricSeries => series !== undefined);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PeriodPicker today={today} />
        <SourceFilter today={today} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
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

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <TimeSeriesChart
          title="Volume por fonte"
          description="Sessões, pedidos e aberturas do app no período."
          seriesList={countSeries}
          granularity={filters.granularity}
          unit="count"
          isLoading={isLoading}
          error={queryError}
        />
        <TimeSeriesChart
          title="Investimento em mídia"
          description="Gasto diário em BRL."
          seriesList={spendSeries}
          granularity={filters.granularity}
          unit="currency"
          isLoading={isLoading}
          error={queryError}
        />
      </div>

      <SourceBreakdown
        title="Total por fonte"
        description="Soma do período, apenas métricas de contagem."
        seriesList={countSeries}
        unit="count"
        isLoading={isLoading}
        error={queryError}
      />
    </div>
  );
}
```

- [ ] **Step 4: Escrever o teste da página de Promoções (falhando)**

`apps/web/src/__tests__/promotions-page.test.tsx`:

```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../test/msw-server.js';
import { renderWithProviders } from '../test/render.js';
import { PromotionsPage } from '../pages/PromotionsPage.js';

const promotions = [
  { id: 'p1', name: 'Black Friday', startsAt: '2026-11-20', endsAt: '2026-11-30', status: 'finished' },
  { id: 'p2', name: 'Volta às Aulas', startsAt: '2026-01-10', endsAt: '2026-02-10', status: 'running' },
];

function mockEndpoints(queryHandler?: jest.Mock) {
  mswServer.use(
    http.get('/api/promotions', () => HttpResponse.json({ promotions })),
    http.post('/api/metrics/query', async ({ request }) => {
      const body = await request.json();
      queryHandler?.(body);
      return HttpResponse.json({
        metricId: 'backend.promotion_clicks', source: 'backend', unit: 'count',
        granularity: 'day', total: 340,
        points: [{ date: '2026-03-14', value: 140 }, { date: '2026-03-15', value: 200 }],
      });
    }),
  );
}

describe('PromotionsPage', () => {
  it('lists the promotions in a select', async () => {
    mockEndpoints();
    renderWithProviders(<PromotionsPage today="2026-03-15" />, { route: '/promocoes' });
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Promoção' })).toBeInTheDocument());
    expect(screen.getByRole('option', { name: 'Black Friday' })).toBeInTheDocument();
  });

  it('does not query clicks until a promotion is selected', async () => {
    const handler = jest.fn();
    mockEndpoints(handler);
    renderWithProviders(<PromotionsPage today="2026-03-15" />, { route: '/promocoes' });
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Promoção' })).toBeInTheDocument());
    expect(handler).not.toHaveBeenCalled();
    expect(screen.getByText('Selecione uma promoção para ver os cliques')).toBeInTheDocument();
  });

  it('queries clicks filtered by the selected promotion id', async () => {
    const handler = jest.fn();
    mockEndpoints(handler);
    renderWithProviders(<PromotionsPage today="2026-03-15" />, { route: '/promocoes' });
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Promoção' })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Promoção' }), 'p1');
    await waitFor(() => expect(handler).toHaveBeenCalled());
    expect(handler.mock.calls[0][0]).toMatchObject({
      metricId: 'backend.promotion_clicks', filters: { promotionId: 'p1' },
    });
  });

  it('shows the click total for the selected promotion', async () => {
    mockEndpoints();
    renderWithProviders(<PromotionsPage today="2026-03-15" />, { route: '/promocoes' });
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Promoção' })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Promoção' }), 'p1');
    await waitFor(() => expect(screen.getByText('340')).toBeInTheDocument());
  });

  it('shows the error when the promotion list fails', async () => {
    mswServer.use(http.get('/api/promotions', () =>
      HttpResponse.json({ message: 'backend fora do ar' }, { status: 502 })));
    renderWithProviders(<PromotionsPage today="2026-03-15" />, { route: '/promocoes' });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('backend fora do ar'));
  });
});
```

- [ ] **Step 5: Implementar `PromotionsPage.tsx`**

`apps/web/src/pages/PromotionsPage.tsx`:

```tsx
import { useState } from 'react';
import { useFilters } from '../hooks/use-filters.js';
import { useMetricSeries } from '../hooks/use-metric-series.js';
import { usePromotions } from '../hooks/use-promotions.js';
import { PeriodPicker } from '../components/filters/PeriodPicker.js';
import { KpiCard } from '../components/charts/KpiCard.js';
import { TimeSeriesChart } from '../components/charts/TimeSeriesChart.js';
import type { MetricSeries } from '../lib/api-client.js';

const STATUS_LABEL = {
  scheduled: 'Agendada', running: 'Em andamento', finished: 'Encerrada',
} as const;

export function PromotionsPage({ today }: { today: string }) {
  const { filters } = useFilters(today);
  const [promotionId, setPromotionId] = useState('');

  const promotionsQuery = usePromotions();
  const promotionsError = promotionsQuery.error instanceof Error ? promotionsQuery.error : null;

  const clicksQuery = useMetricSeries(
    {
      metricId: 'backend.promotion_clicks',
      from: filters.from,
      to: filters.to,
      granularity: filters.granularity,
      filters: { promotionId },
    },
    { enabled: promotionId !== '' },
  );
  const clicksError = clicksQuery.error instanceof Error ? clicksQuery.error : null;

  const selected = promotionsQuery.data?.find((promotion) => promotion.id === promotionId);
  const seriesList: MetricSeries[] = clicksQuery.data ? [clicksQuery.data] : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PeriodPicker today={today} />
        <label className="flex items-center gap-2 text-sm">
          <span style={{ color: 'var(--text-secondary)' }}>Promoção</span>
          <select
            aria-label="Promoção"
            value={promotionId}
            onChange={(event) => setPromotionId(event.target.value)}
            className="rounded-md border px-2 py-1.5"
            style={{
              borderColor: 'var(--hairline)',
              backgroundColor: 'var(--surface-1)',
              color: 'var(--text-primary)',
            }}
          >
            <option value="">Todas</option>
            {(promotionsQuery.data ?? []).map((promotion) => (
              <option key={promotion.id} value={promotion.id}>{promotion.name}</option>
            ))}
          </select>
        </label>
      </div>

      {promotionsError ? (
        <p role="alert" className="rounded-md p-4 text-sm" style={{ color: '#d03b3b' }}>
          {promotionsError.message}
        </p>
      ) : promotionId === '' ? (
        <p className="py-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
          Selecione uma promoção para ver os cliques
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <KpiCard
              label="Cliques na promoção"
              unit="count"
              value={clicksQuery.data?.total ?? 0}
              isLoading={clicksQuery.isLoading}
              error={clicksError}
            />
            <div
              className="rounded-lg border p-4"
              style={{ backgroundColor: 'var(--surface-1)', borderColor: 'var(--hairline)' }}
            >
              <p className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                Período da promoção
              </p>
              <p className="mt-1 text-sm" style={{ color: 'var(--text-primary)' }}>
                {selected ? `${selected.startsAt} → ${selected.endsAt}` : '—'}
              </p>
              <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
                {selected ? STATUS_LABEL[selected.status] : ''}
              </p>
            </div>
          </div>

          <TimeSeriesChart
            title={`Cliques — ${selected?.name ?? ''}`}
            seriesList={seriesList}
            granularity={filters.granularity}
            unit="count"
            isLoading={clicksQuery.isLoading}
            error={clicksError}
          />
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Ligar as rotas**

`apps/web/src/App.tsx`:

```tsx
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell.js';
import { OverviewPage } from './pages/OverviewPage.js';
import { PromotionsPage } from './pages/PromotionsPage.js';

/** "Hoje" desce como prop a partir daqui: nenhum componente chama `new Date()`. */
export function App() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<OverviewPage today={today} />} />
        <Route path="/promocoes" element={<PromotionsPage today={today} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
```

Ajuste `apps/web/src/__tests__/app.test.tsx` (Task 13): o teste "renders the application shell" agora precisa de handlers MSW. Substitua o bloco `describe('App')` por:

```tsx
describe('App', () => {
  it('renders the application shell with navigation', () => {
    mswServer.use(
      http.post('/api/metrics/batch', () => HttpResponse.json({ series: [] })),
    );
    renderWithProviders(<App />, { route: '/' });
    expect(screen.getByRole('banner')).toHaveTextContent('Center Dashboard');
    expect(screen.getByRole('link', { name: 'Promoções' })).toBeInTheDocument();
  });
});
```

com os imports `import { http, HttpResponse } from 'msw';` e `import { mswServer } from '../test/msw-server.js';`.

- [ ] **Step 7: Rodar os testes**

Run: `pnpm --filter @center/web test`
Expected: PASS — 10 suites, 59 testes.

- [ ] **Step 8: Commit**

```bash
git add apps/web
git commit -m "feat(web): add overview and promotions pages with app shell"
```

---

### Task 18: Autenticação na interface

**Files:**
- Create: `apps/web/src/hooks/use-auth.ts`, `apps/web/src/pages/LoginPage.tsx`, `apps/web/src/components/layout/RequireAuth.tsx`
- Modify: `apps/web/src/App.tsx` (rota de login + guard), `apps/web/src/components/layout/AppShell.tsx` (botão sair)
- Test: `apps/web/src/__tests__/login-page.test.tsx`

**Interfaces:**
- Consumes: `apiClient.login`, `setAuthToken`, `getAuthToken` (Task 14).
- Produces:
  - `useAuth(): { isAuthenticated: boolean; login(email, password): Promise<void>; logout(): void; isLoggingIn: boolean; loginError: Error | null }`
  - `<RequireAuth />` (rota-pai que redireciona para `/login`)
  - `<LoginPage />`

- [ ] **Step 1: Escrever o teste (falhando)**

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
      await new Promise((resolve) => setTimeout(resolve, 50));
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

- [ ] **Step 2: Implementar `use-auth.ts`**

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
    async (email: string, password: string) => {
      await mutation.mutateAsync({ email, password });
    },
    [mutation],
  );

  const logout = useCallback(() => {
    setAuthToken(null);
    setIsAuthenticated(false);
    // Sem isto, o próximo usuário a logar veria os dados em cache do anterior.
    queryClient.clear();
  }, [queryClient]);

  return {
    isAuthenticated,
    login,
    logout,
    isLoggingIn: mutation.isPending,
    loginError: mutation.error instanceof Error ? mutation.error : null,
  };
}
```

- [ ] **Step 3: Implementar `LoginPage.tsx` e `RequireAuth.tsx`**

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
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm space-y-4 rounded-lg border p-6"
        style={{ backgroundColor: 'var(--surface-1)', borderColor: 'var(--hairline)' }}
      >
        <h1 className="text-xl font-semibold">Center Dashboard</h1>

        <div className="space-y-1">
          <label htmlFor="email" className="block text-sm" style={{ color: 'var(--text-secondary)' }}>
            E-mail
          </label>
          <input
            id="email" type="email" value={email} autoComplete="username"
            onChange={(event) => setEmail(event.target.value)}
            className="w-full rounded-md border px-3 py-2"
            style={{ borderColor: 'var(--hairline)', backgroundColor: 'var(--page-plane)' }}
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="password" className="block text-sm" style={{ color: 'var(--text-secondary)' }}>
            Senha
          </label>
          <input
            id="password" type="password" value={password} autoComplete="current-password"
            onChange={(event) => setPassword(event.target.value)}
            className="w-full rounded-md border px-3 py-2"
            style={{ borderColor: 'var(--hairline)', backgroundColor: 'var(--page-plane)' }}
          />
        </div>

        {loginError ? (
          <p role="alert" className="text-sm" style={{ color: '#d03b3b' }}>{loginError.message}</p>
        ) : null}

        <button
          type="submit"
          disabled={isLoggingIn}
          className="w-full rounded-md bg-viz-1 px-3 py-2 text-white disabled:opacity-60"
        >
          {isLoggingIn ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
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

- [ ] **Step 4: Ligar no `App.tsx` e adicionar o botão de sair**

`apps/web/src/App.tsx`:

```tsx
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell.js';
import { RequireAuth } from './components/layout/RequireAuth.js';
import { LoginPage } from './pages/LoginPage.js';
import { OverviewPage } from './pages/OverviewPage.js';
import { PromotionsPage } from './pages/PromotionsPage.js';

export function App() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route path="/" element={<OverviewPage today={today} />} />
          <Route path="/promocoes" element={<PromotionsPage today={today} />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
```

Em `apps/web/src/components/layout/AppShell.tsx`, adicione `import { useAuth } from '../../hooks/use-auth.js';` e `import { useNavigate } from 'react-router-dom';`, e insira dentro do `<div className="mx-auto flex max-w-7xl items-center gap-8">`, após o `<nav>`:

```tsx
          <button
            type="button"
            onClick={() => { logout(); navigate('/login', { replace: true }); }}
            className="ml-auto rounded-md border px-3 py-1.5 text-sm"
            style={{ borderColor: 'var(--hairline)', color: 'var(--text-secondary)' }}
          >
            Sair
          </button>
```

com `const { logout } = useAuth();` e `const navigate = useNavigate();` no topo do componente.

O teste do App (Task 13/17) agora renderiza `/login` por falta de token. Ajuste-o para semear o token antes de renderizar:

```tsx
import { setAuthToken } from '../lib/api-client.js';
// dentro do it, antes de renderWithProviders:
setAuthToken('token-de-teste');
```

e limpe com `afterEach(() => setAuthToken(null));`.

- [ ] **Step 5: Rodar todos os testes do frontend**

Run: `pnpm --filter @center/web test`
Expected: PASS — 11 suites, 63 testes.

- [ ] **Step 6: Validação manual de ponta a ponta**

Com a API rodando (Task 12, Step 7):

```bash
pnpm --filter @center/web dev
```

Confirme: `/` redireciona para `/login`; login com `admin@center.local` / `center-dev-123` leva à Overview com dados reais; trocar o período muda a URL e os gráficos; "Sair" volta ao login e um refresh não restaura a sessão.

- [ ] **Step 7: Commit**

```bash
git add apps/web
git commit -m "feat(web): add login page, auth hook and route guard"
```

---

# FASE 4 — Agente de IA (Sprint 8)

**Objetivo da fase:** `runAgent()` recebe uma pergunta em português, decide quais ferramentas chamar, consulta o `MetricGateway` e devolve uma resposta em texto. Nesta fase o agente ainda não fala com o WhatsApp — ele é uma função pura de `(pergunta, histórico, tenant) → resposta`, testável sem rede.

**Onde os testes entram — a estratégia que torna um agente testável:**
1. **O resolvedor de datas é uma função pura** e recebe a maior bateria de testes da fase. "Mês passado" resolver errado é o bug mais provável e mais caro (usuário recebe número errado com confiança total).
2. **As ferramentas são testadas sem LLM.** `buildAgentTools()` devolve objetos com `execute()`; chamamos `execute()` direto.
3. **O agente é testado com `MockLanguageModelV2`**, controlando exatamente quais tool calls o "modelo" emite. Zero chamadas à API da Anthropic nos testes; zero flakiness.
4. **A avaliação de qualidade das respostas é manual**, com o roteiro de 12 perguntas da Task 22.

---

### Task 19: Resolvedor de períodos em português

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
  it('resolve "hoje"', () => {
    expect(resolvePeriodPhrase('hoje', TODAY)).toEqual({
      from: '2026-03-15', to: '2026-03-15', granularity: 'day', label: 'hoje',
    });
  });

  it('resolve "ontem"', () => {
    expect(resolvePeriodPhrase('ontem', TODAY)).toMatchObject({
      from: '2026-03-14', to: '2026-03-14', granularity: 'day',
    });
  });

  it('resolve "esta semana" como a semana ISO corrente', () => {
    expect(resolvePeriodPhrase('esta semana', TODAY)).toMatchObject({
      from: '2026-03-09', to: '2026-03-15', granularity: 'day',
    });
  });

  it('resolve "semana passada"', () => {
    expect(resolvePeriodPhrase('semana passada', TODAY)).toMatchObject({
      from: '2026-03-02', to: '2026-03-08', granularity: 'day',
    });
  });

  it('resolve "este mês" até hoje, não até o fim do mês', () => {
    expect(resolvePeriodPhrase('este mês', TODAY)).toMatchObject({
      from: '2026-03-01', to: '2026-03-15', granularity: 'day',
    });
  });

  it('resolve "mês passado" cobrindo o mês inteiro', () => {
    expect(resolvePeriodPhrase('mês passado', TODAY)).toMatchObject({
      from: '2026-02-01', to: '2026-02-28', granularity: 'day',
    });
  });

  it('resolve "mês passado" em janeiro cruzando o ano', () => {
    expect(resolvePeriodPhrase('mês passado', '2026-01-20')).toMatchObject({
      from: '2025-12-01', to: '2025-12-31',
    });
  });

  it('resolve "mês passado" em março de ano bissexto com 29 dias em fevereiro', () => {
    expect(resolvePeriodPhrase('mês passado', '2024-03-10')).toMatchObject({
      from: '2024-02-01', to: '2024-02-29',
    });
  });

  it('resolve "este ano" com granularidade mensal', () => {
    expect(resolvePeriodPhrase('este ano', TODAY)).toMatchObject({
      from: '2026-01-01', to: '2026-03-15', granularity: 'month',
    });
  });

  it('resolve "ano passado" inteiro, em meses', () => {
    expect(resolvePeriodPhrase('ano passado', TODAY)).toMatchObject({
      from: '2025-01-01', to: '2025-12-31', granularity: 'month',
    });
  });
});

describe('resolvePeriodPhrase — "últimos N"', () => {
  it('resolve "últimos 7 dias" incluindo hoje', () => {
    expect(resolvePeriodPhrase('últimos 7 dias', TODAY)).toMatchObject({
      from: '2026-03-09', to: '2026-03-15', granularity: 'day',
    });
  });

  it('aceita a forma sem acento', () => {
    expect(resolvePeriodPhrase('ultimos 30 dias', TODAY)).toMatchObject({ from: '2026-02-14' });
  });

  it('sobe para granularidade semanal acima de 60 dias', () => {
    expect(resolvePeriodPhrase('últimos 90 dias', TODAY)).toMatchObject({ granularity: 'week' });
  });

  it('resolve "últimos 3 meses"', () => {
    expect(resolvePeriodPhrase('últimos 3 meses', TODAY)).toMatchObject({
      from: '2025-12-01', to: '2026-03-15', granularity: 'month',
    });
  });
});

describe('resolvePeriodPhrase — mês nomeado', () => {
  it('resolve "janeiro" como o janeiro mais recente já ocorrido', () => {
    expect(resolvePeriodPhrase('janeiro', TODAY)).toMatchObject({
      from: '2026-01-01', to: '2026-01-31',
    });
  });

  it('resolve um mês futuro no ano corrente como o ano anterior', () => {
    // Em 15/03/2026, "dezembro" só pode significar dez/2025 — dez/2026 não aconteceu.
    expect(resolvePeriodPhrase('dezembro', TODAY)).toMatchObject({
      from: '2025-12-01', to: '2025-12-31',
    });
  });

  it('resolve "fevereiro de 2024" com 29 dias', () => {
    expect(resolvePeriodPhrase('fevereiro de 2024', TODAY)).toMatchObject({
      from: '2024-02-01', to: '2024-02-29',
    });
  });

  it('resolve "março/2025"', () => {
    expect(resolvePeriodPhrase('março/2025', TODAY)).toMatchObject({
      from: '2025-03-01', to: '2025-03-31',
    });
  });

  it('aceita o mês sem acento', () => {
    expect(resolvePeriodPhrase('marco de 2025', TODAY)).toMatchObject({ from: '2025-03-01' });
  });
});

describe('resolvePeriodPhrase — não reconhecido', () => {
  it('devolve null para uma frase que não é período', () => {
    expect(resolvePeriodPhrase('quanto gastei', TODAY)).toBeNull();
  });

  it('devolve null para string vazia', () => {
    expect(resolvePeriodPhrase('', TODAY)).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `pnpm --filter @center/api test -- date-resolver.test.ts`
Expected: FAIL — `Cannot find module '../agent/date-resolver.js'`.

- [ ] **Step 3: Implementar `date-resolver.ts`**

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

function utc(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00Z`);
}

function shiftDays(isoDate: string, days: number): string {
  const date = utc(isoDate);
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
  const date = utc(isoDate);
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
 * Converte uma expressão de período em português numa janela de datas concreta.
 * Devolve `null` quando a frase não é um período — o chamador então exige que o
 * usuário informe as datas, em vez de adivinhar.
 */
export function resolvePeriodPhrase(phrase: string, today: string): ResolvedPeriod | null {
  const text = normalize(phrase);
  if (text === '') return null;

  const [year, month] = today.split('-').map(Number) as [number, number];

  if (text === 'hoje') {
    return { from: today, to: today, granularity: 'day', label: 'hoje' };
  }
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
      from: firstDayOfMonth(year - 1, 1),
      to: lastDayOfMonth(year - 1, 12),
      granularity: 'month',
      label: 'ano passado',
    };
  }

  const lastN = text.match(/^(?:ultimos?|ultimas?)\s+(\d{1,3})\s+(dias?|semanas?|meses|mes)$/);
  if (lastN) {
    const amount = Number(lastN[1]);
    const unit = lastN[2]!;

    if (unit.startsWith('dia')) {
      return {
        from: shiftDays(today, -(amount - 1)),
        to: today,
        // Mais de ~60 pontos diários deixam o resumo e o eixo ilegíveis.
        granularity: amount > 60 ? 'week' : 'day',
        label: `últimos ${amount} dias`,
      };
    }
    if (unit.startsWith('semana')) {
      return {
        from: shiftDays(today, -(amount * 7 - 1)),
        to: today,
        granularity: 'week',
        label: `últimas ${amount} semanas`,
      };
    }
    const startMonth = month - (amount - 1);
    const normalizedYear = year + Math.floor((startMonth - 1) / 12);
    const normalizedMonth = ((((startMonth - 1) % 12) + 12) % 12) + 1;
    return {
      from: firstDayOfMonth(normalizedYear, normalizedMonth),
      to: today,
      granularity: 'month',
      label: `últimos ${amount} meses`,
    };
  }

  const named = text.match(
    /^([a-z]+)(?:\s*(?:de|\/)\s*(\d{4}))?$/,
  );
  if (named) {
    const monthNumber = MONTH_NAMES_PT[named[1]!];
    if (monthNumber) {
      const explicitYear = named[2] ? Number(named[2]) : undefined;
      // Sem ano explícito: o mês mais recente que já terminou ou começou.
      // "dezembro" em março de 2026 só pode ser dez/2025.
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

- [ ] **Step 4: Rodar os testes**

Run: `pnpm --filter @center/api test -- date-resolver.test.ts`
Expected: PASS — 21 testes.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/agent apps/api/src/__tests__/date-resolver.test.ts
git commit -m "feat(agent): add deterministic pt-BR period resolver"
```

---

### Task 20: Ferramentas do agente

**Files:**
- Create: `apps/api/src/agent/tools.ts`
- Modify: `apps/api/package.json` (dependências de IA)
- Test: `apps/api/src/__tests__/agent-tools.test.ts`

**Interfaces:**
- Consumes: `MetricGateway` (Task 9); `resolvePeriodPhrase` (Task 19); `TenantContext`, `MetricSeries` de `@center/shared`.
- Produces:
  - `interface AgentToolContext { gateway: MetricGateway; tenant: TenantContext; today: string; onToolCall?: (log: AgentToolCall) => void }`
  - `interface AgentToolCall { toolName: string; input: unknown; durationMs: number; success: boolean; errorMessage?: string }`
  - `buildAgentTools(context: AgentToolContext): ToolSet` com as ferramentas `listar_metricas`, `consultar_metrica`, `listar_promocoes`

**Decisões que fazem a diferença entre um agente confiável e um que inventa números:**
1. As ferramentas têm **nomes e descrições em português** — o modelo escolhe melhor quando o vocabulário da ferramenta é o do usuário.
2. `consultar_metrica` aceita **`periodo` como frase** (`"mês passado"`) *ou* `from`/`to` explícitos. A frase é resolvida pelo código da Task 19, não pelo modelo.
3. O tenant **nunca** é parâmetro da ferramenta: vem fechado no closure. O LLM não tem como consultar outra organização nem que tente.
4. A ferramenta devolve um **resumo achatado com o total e os extremos**, não a série inteira — mandar 90 pontos para o contexto gasta tokens e piora a resposta.

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
  organizationId: 'org_1',
  externalIds: { ga4PropertyId: '111', backendAccountId: 'acc_9' },
};

const series: MetricSeries = {
  metricId: 'backend.spend', source: 'backend', unit: 'currency', granularity: 'day', total: 4800,
  points: [
    { date: '2026-02-01', value: 1000 },
    { date: '2026-02-15', value: 3000 },
    { date: '2026-02-28', value: 800 },
  ],
};

function buildGateway(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    listMetrics: jest.fn(async () => [
      { id: 'backend.spend', label: 'Investimento', description: 'gasto', source: 'backend', unit: 'currency', dimensions: ['channel'] },
      { id: 'ga4.sessions', label: 'Sessões', description: 'sessões', source: 'ga4', unit: 'count', dimensions: ['country'] },
    ]),
    queryMetric: jest.fn(async () => series),
    callTool: jest.fn(async () => ({ promotions: [{ id: 'p1', name: 'Black Friday', startsAt: '2026-11-20', endsAt: '2026-11-30', status: 'finished' }] })),
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
        { id: 'backend.spend', nome: 'Investimento', descricao: 'gasto', unidade: 'currency', dimensoes: ['channel'] },
        { id: 'ga4.sessions', nome: 'Sessões', descricao: 'sessões', unidade: 'count', dimensoes: ['country'] },
      ],
    });
  });
});

describe('consultar_metrica', () => {
  it('resolves a Portuguese period phrase into concrete dates', async () => {
    const gateway = buildGateway();
    await tools(gateway).consultar_metrica.execute!(
      { metricId: 'backend.spend', periodo: 'mês passado' }, {} as never,
    );
    expect(gateway.queryMetric).toHaveBeenCalledWith(
      expect.objectContaining({ from: '2026-02-01', to: '2026-02-28', granularity: 'day' }),
    );
  });

  it('accepts explicit from/to instead of a phrase', async () => {
    const gateway = buildGateway();
    await tools(gateway).consultar_metrica.execute!(
      { metricId: 'backend.spend', from: '2026-01-01', to: '2026-01-31', granularity: 'month' }, {} as never,
    );
    expect(gateway.queryMetric).toHaveBeenCalledWith(
      expect.objectContaining({ from: '2026-01-01', to: '2026-01-31', granularity: 'month' }),
    );
  });

  it('always injects the tenant from the closure', async () => {
    const gateway = buildGateway();
    await tools(gateway).consultar_metrica.execute!(
      { metricId: 'backend.spend', periodo: 'hoje' }, {} as never,
    );
    expect(gateway.queryMetric).toHaveBeenCalledWith(expect.objectContaining({ tenant }));
  });

  it('returns a summary with the total and the peak, not the raw series', async () => {
    const result = await tools(buildGateway()).consultar_metrica.execute!(
      { metricId: 'backend.spend', periodo: 'mês passado' }, {} as never,
    ) as Record<string, unknown>;
    expect(result).toMatchObject({
      metricId: 'backend.spend',
      unidade: 'currency',
      total: 4800,
      periodo: { de: '2026-02-01', ate: '2026-02-28' },
      pico: { data: '2026-02-15', valor: 3000 },
      pontos: 3,
    });
    expect(result).not.toHaveProperty('points');
  });

  it('returns an error object instead of throwing on an unresolvable period', async () => {
    const result = await tools(buildGateway()).consultar_metrica.execute!(
      { metricId: 'backend.spend', periodo: 'na época da promoção' }, {} as never,
    ) as Record<string, unknown>;
    expect(result.erro).toMatch(/não entendi o período/i);
  });

  it('returns an error object when neither periodo nor from/to is given', async () => {
    const result = await tools(buildGateway()).consultar_metrica.execute!(
      { metricId: 'backend.spend' }, {} as never,
    ) as Record<string, unknown>;
    expect(result.erro).toMatch(/informe/i);
  });

  it('turns a gateway failure into an error object the model can read', async () => {
    const gateway = buildGateway({
      queryMetric: jest.fn(async () => { throw new Error('GA4 respondeu 503'); }),
    });
    const result = await tools(gateway).consultar_metrica.execute!(
      { metricId: 'ga4.sessions', periodo: 'hoje' }, {} as never,
    ) as Record<string, unknown>;
    expect(result.erro).toContain('GA4 respondeu 503');
  });

  it('reports every call to the audit callback, including failures', async () => {
    const logs: AgentToolCall[] = [];
    const gateway = buildGateway({
      queryMetric: jest.fn(async () => { throw new Error('falhou'); }),
    });
    await tools(gateway, (log) => logs.push(log)).consultar_metrica.execute!(
      { metricId: 'ga4.sessions', periodo: 'hoje' }, {} as never,
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ toolName: 'consultar_metrica', success: false, errorMessage: 'falhou' });
    expect(typeof logs[0]?.durationMs).toBe('number');
  });
});

describe('listar_promocoes', () => {
  it('calls the backend MCP tool with the closure tenant', async () => {
    const gateway = buildGateway();
    const result = await tools(gateway).listar_promocoes.execute!({}, {} as never);
    expect(gateway.callTool).toHaveBeenCalledWith('backend', 'list_promotions', { tenant });
    expect(result).toMatchObject({ promocoes: [expect.objectContaining({ name: 'Black Friday' })] });
  });
});
```

- [ ] **Step 3: Rodar e confirmar que falha**

Run: `pnpm --filter @center/api test -- agent-tools.test.ts`
Expected: FAIL — `Cannot find module '../agent/tools.js'`.

- [ ] **Step 4: Implementar `tools.ts`**

`apps/api/src/agent/tools.ts`:

```ts
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { MetricGateway } from '@center/mcp-core';
import { GranularitySchema, type MetricQuery, type TenantContext } from '@center/shared';
import { resolvePeriodPhrase } from './date-resolver.js';

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

interface Promotion {
  id: string; name: string; startsAt: string; endsAt: string;
  status: 'scheduled' | 'running' | 'finished';
}

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
      context.onToolCall?.({
        toolName, input, durationMs: Date.now() - startedAt, success: true,
      });
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

export function buildAgentTools(context: AgentToolContext): ToolSet {
  const { gateway, tenant, today } = context;

  return {
    listar_metricas: tool({
      description:
        'Lista todas as métricas disponíveis, com id, unidade e dimensões filtráveis. ' +
        'Use SEMPRE antes de consultar_metrica quando não tiver certeza do id exato da métrica.',
      inputSchema: z.object({}),
      execute: instrument(context, 'listar_metricas', async () => {
        const metrics = await gateway.listMetrics();
        return {
          metricas: metrics.map((metric) => ({
            id: metric.id,
            nome: metric.label,
            descricao: metric.description,
            unidade: metric.unit,
            dimensoes: metric.dimensions,
          })),
        };
      }),
    }),

    consultar_metrica: tool({
      description:
        'Consulta o valor de uma métrica em um período. Informe "periodo" com uma expressão em ' +
        'português (ex.: "mês passado", "últimos 30 dias", "fevereiro de 2026") OU informe "from" ' +
        'e "to" no formato YYYY-MM-DD. Retorna o total do período, o pico e o intervalo resolvido.',
      inputSchema: z.object({
        metricId: z.string().describe('id exato da métrica, como devolvido por listar_metricas'),
        periodo: z.string().optional().describe('expressão de período em português'),
        from: z.string().optional().describe('data inicial YYYY-MM-DD'),
        to: z.string().optional().describe('data final YYYY-MM-DD'),
        granularity: GranularitySchema.optional(),
        filtros: z.record(z.string(), z.string()).optional()
          .describe('filtro por dimensão, ex.: { "promotionId": "p1" }'),
      }),
      execute: instrument(context, 'consultar_metrica', async (input) => {
        let from = input.from;
        let to = input.to;
        let granularity = input.granularity;

        if (input.periodo) {
          const resolved = resolvePeriodPhrase(input.periodo, today);
          if (!resolved) {
            throw new Error(
              `não entendi o período "${input.periodo}". Peça ao usuário as datas exatas ` +
              `ou use uma expressão como "mês passado", "últimos 30 dias" ou "fevereiro de 2026".`,
            );
          }
          from = resolved.from;
          to = resolved.to;
          granularity = granularity ?? resolved.granularity;
        }

        if (!from || !to) {
          throw new Error('informe "periodo" ou o par "from"/"to" em YYYY-MM-DD');
        }

        const query: MetricQuery = {
          metricId: input.metricId,
          from,
          to,
          granularity: granularity ?? 'day',
          tenant,
          ...(input.filtros ? { filters: input.filtros } : {}),
        };

        const series = await gateway.queryMetric(query);

        // Resumo achatado: 90 pontos no contexto gastam tokens e não melhoram a
        // resposta. Total, pico e intervalo cobrem quase toda pergunta real.
        const peak = series.points.reduce(
          (best, point) => (point.value > best.value ? point : best),
          series.points[0] ?? { date: from, value: 0 },
        );

        return {
          metricId: series.metricId,
          unidade: series.unit,
          granularidade: series.granularity,
          total: series.total,
          periodo: { de: from, ate: to },
          pico: { data: peak.date, valor: peak.value },
          pontos: series.points.length,
        };
      }),
    }),

    listar_promocoes: tool({
      description:
        'Lista as promoções da conta com id, nome, período e status. Use para converter o nome ' +
        'de uma promoção citada pelo usuário no promotionId exigido pelo filtro de consultar_metrica.',
      inputSchema: z.object({
        ativaEm: z.string().optional().describe('data YYYY-MM-DD para filtrar promoções ativas'),
      }),
      execute: instrument(context, 'listar_promocoes', async (input) => {
        const payload = await gateway.callTool<{ promotions: Promotion[] }>(
          'backend',
          'list_promotions',
          input.ativaEm ? { tenant, activeOn: input.ativaEm } : { tenant },
        );
        return { promocoes: payload.promotions };
      }),
    }),
  };
}
```

- [ ] **Step 5: Rodar os testes**

Run: `pnpm --filter @center/api test -- agent-tools.test.ts`
Expected: PASS — 10 testes.

- [ ] **Step 6: Commit**

```bash
git add apps/api
git commit -m "feat(agent): add tenant-scoped agent tools over the metric gateway"
```

---

### Task 21: Núcleo do agente

**Files:**
- Create: `apps/api/src/agent/system-prompt.ts`, `apps/api/src/agent/agent.ts`
- Test: `apps/api/src/__tests__/agent.test.ts`

**Interfaces:**
- Consumes: `buildAgentTools`, `AgentToolCall` (Task 20); `MetricGateway` (Task 9); `TenantContext`.
- Produces:
  - `interface AgentMessage { role: 'user' | 'assistant'; content: string }`
  - `interface AgentInput { gateway: MetricGateway; tenant: TenantContext; today: string; history: AgentMessage[]; userMessage: string; model?: LanguageModel }`
  - `interface AgentResult { reply: string; toolCalls: AgentToolCall[] }`
  - `runAgent(input: AgentInput): Promise<AgentResult>`
  - `buildSystemPrompt(today: string): string`
  - `MAX_HISTORY_MESSAGES = 12`, `MAX_REPLY_CHARS = 1200`

**Guardrails implementados aqui (cada um com teste):**
- **Escopo:** o prompt instrui a recusar qualquer pedido fora de analytics, e o tenant já está fechado nas ferramentas.
- **Anti-alucinação:** proibido estimar número que não veio de ferramenta.
- **Limite de passos:** `stopWhen: stepCountIs(6)` — sem isso, um erro recorrente de ferramenta vira laço infinito e conta de API.
- **Limite de tamanho:** resposta truncada em 1200 caracteres (WhatsApp fica ilegível acima disso).
- **Janela de histórico:** só as últimas 12 mensagens vão ao modelo.

- [ ] **Step 1: Escrever o system prompt**

`apps/api/src/agent/system-prompt.ts`:

```ts
export function buildSystemPrompt(today: string): string {
  return `Você é o assistente de analytics do Center Dashboard, respondendo por WhatsApp.

A data de hoje é ${today} (timezone America/Sao_Paulo).

SEU ESCOPO
Você responde exclusivamente sobre as métricas de marketing e produto da organização
do usuário: investimento em mídia, pedidos, sessões e conversões do site, cliques em
promoções e uso do aplicativo mobile. Se perguntarem qualquer outra coisa — código,
opinião, assuntos gerais, dados de outra empresa — responda que você só consegue ajudar
com os dados de analytics da conta e ofereça um exemplo de pergunta que você atende.

COMO RESPONDER
1. Use SEMPRE as ferramentas para obter números. Nunca estime, arredonde por conta
   própria nem invente um valor. Se uma ferramenta falhar, diga que o dado não está
   disponível agora — jamais preencha a lacuna com um palpite.
2. Se não souber o id exato da métrica, chame listar_metricas antes.
3. Se o usuário citar uma promoção pelo nome, chame listar_promocoes para descobrir o
   id e então filtre a consulta por ele.
4. Passe a expressão de período do usuário direto no campo "periodo" (ex.: "mês passado",
   "últimos 30 dias", "fevereiro"). NÃO calcule datas você mesmo.
5. Se o período for ambíguo e a ferramenta não conseguir resolver, pergunte as datas.

FORMATO
- Português do Brasil, tom direto e cordial, sem jargão.
- Comece pelo número que responde a pergunta.
- Sempre diga a que período o número se refere.
- Valores em reais no formato R$ 1.234,56; contagens com separador de milhar.
- No máximo 4 linhas. Use no máximo um emoji, e só quando somar algo.
- Nada de markdown com ** ou # — o WhatsApp não renderiza. Para ênfase use *asterisco simples*.`;
}
```

- [ ] **Step 2: Escrever o teste do agente (falhando)**

`apps/api/src/__tests__/agent.test.ts`:

```ts
import { MockLanguageModelV2 } from 'ai/test';
import type { MetricGateway } from '@center/mcp-core';
import type { MetricSeries, TenantContext } from '@center/shared';
import { runAgent, buildSystemPrompt, MAX_REPLY_CHARS } from '../agent/agent.js';

const tenant: TenantContext = {
  organizationId: 'org_1',
  externalIds: { backendAccountId: 'acc_9' },
};

const series: MetricSeries = {
  metricId: 'backend.spend', source: 'backend', unit: 'currency', granularity: 'day',
  total: 4800, points: [{ date: '2026-02-01', value: 4800 }],
};

function buildGateway() {
  return {
    listMetrics: jest.fn(async () => [
      { id: 'backend.spend', label: 'Investimento', description: 'gasto', source: 'backend', unit: 'currency', dimensions: [] },
    ]),
    queryMetric: jest.fn(async () => series),
    callTool: jest.fn(async () => ({ promotions: [] })),
  } as unknown as MetricGateway;
}

const usage = { inputTokens: 10, outputTokens: 10, totalTokens: 20 };

/** Modelo que devolve texto direto, sem chamar ferramenta. */
function textOnlyModel(text: string) {
  return new MockLanguageModelV2({
    doGenerate: async () => ({
      finishReason: 'stop' as const,
      usage,
      content: [{ type: 'text' as const, text }],
      warnings: [],
    }),
  });
}

/** Modelo que chama uma ferramenta e, no passo seguinte, responde em texto. */
function toolThenTextModel(toolName: string, input: unknown, finalText: string) {
  let call = 0;
  return new MockLanguageModelV2({
    doGenerate: async () => {
      call += 1;
      if (call === 1) {
        return {
          finishReason: 'tool-calls' as const,
          usage,
          content: [{
            type: 'tool-call' as const,
            toolCallId: 'call_1',
            toolName,
            input: JSON.stringify(input),
          }],
          warnings: [],
        };
      }
      return {
        finishReason: 'stop' as const,
        usage,
        content: [{ type: 'text' as const, text: finalText }],
        warnings: [],
      };
    },
  });
}

const baseInput = {
  tenant,
  today: '2026-03-15',
  history: [],
  userMessage: 'quanto gastei mês passado?',
};

describe('buildSystemPrompt', () => {
  it('embeds today so the model never guesses the date', () => {
    expect(buildSystemPrompt('2026-03-15')).toContain('2026-03-15');
  });

  it('forbids inventing numbers', () => {
    expect(buildSystemPrompt('2026-03-15')).toMatch(/nunca estime|não invente|jamais/i);
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
        { metricId: 'backend.spend', periodo: 'mês passado' },
        'Você investiu R$ 4.800,00 em mídia em fevereiro de 2026.',
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
      model: toolThenTextModel(
        'consultar_metrica', { metricId: 'backend.spend', periodo: 'mês passado' }, 'pronto',
      ),
    });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ toolName: 'consultar_metrica', success: true });
  });

  it('keeps only the most recent history messages', async () => {
    let receivedPromptLength = 0;
    const model = new MockLanguageModelV2({
      doGenerate: async ({ prompt }) => {
        receivedPromptLength = prompt.length;
        return { finishReason: 'stop' as const, usage, content: [{ type: 'text' as const, text: 'ok' }], warnings: [] };
      },
    });
    const history = Array.from({ length: 40 }, (_, index) => ({
      role: (index % 2 === 0 ? 'user' : 'assistant') as const,
      content: `mensagem ${index}`,
    }));
    await runAgent({ ...baseInput, gateway: buildGateway(), history, model });
    // system + 12 do histórico + a mensagem atual
    expect(receivedPromptLength).toBe(14);
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

  it('returns a fallback message when the model answers with empty text', async () => {
    const result = await runAgent({
      ...baseInput, gateway: buildGateway(), model: textOnlyModel('   '),
    });
    expect(result.reply).toMatch(/não consegui/i);
  });
});
```

- [ ] **Step 3: Rodar e confirmar que falha**

Run: `pnpm --filter @center/api test -- agent.test.ts`
Expected: FAIL — `Cannot find module '../agent/agent.js'`.

> Se `MockLanguageModelV2` não existir no pacote instalado, confira o export real com
> `node -e "console.log(Object.keys(require('ai/test')))"` e o formato de `content` em
> `node_modules/ai/dist/index.d.ts` (procure `LanguageModelV2Content`). Ajuste os helpers
> `textOnlyModel`/`toolThenTextModel` — a lógica dos testes não muda.

- [ ] **Step 4: Implementar `agent.ts`**

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
export const MAX_STEPS = 6;

const FALLBACK_REPLY =
  'Não consegui consultar os dados agora. Tente de novo em alguns instantes.';

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

  // Janela deslizante: conversas longas de WhatsApp estourariam o contexto e o
  // custo, e o histórico antigo raramente ajuda numa pergunta sobre números.
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
      // Sem este limite, uma ferramenta que falha em loop queima a cota da API.
      stopWhen: stepCountIs(MAX_STEPS),
      temperature: 0,
    });

    const text = result.text.trim();
    return { reply: text === '' ? FALLBACK_REPLY : truncate(text), toolCalls };
  } catch {
    // Falha do provedor de LLM não pode virar erro 500 no webhook: o usuário
    // precisa receber uma mensagem, e a Meta precisa receber 200.
    return { reply: FALLBACK_REPLY, toolCalls };
  }
}
```

- [ ] **Step 5: Rodar os testes**

Run: `pnpm --filter @center/api test -- agent.test.ts`
Expected: PASS — 9 testes.

- [ ] **Step 6: Commit**

```bash
git add apps/api
git commit -m "feat(agent): add agent core with step limit and reply guardrails"
```

---

### Task 22: Memória de conversa e avaliação manual

**Files:**
- Create: `apps/api/src/agent/memory.ts`
- Create: `apps/api/scripts/eval-agent.ts`, `docs/agent-eval.md`
- Test: `apps/api/src/__tests__/agent-memory.test.ts`

**Interfaces:**
- Consumes: `PrismaClient`; `AgentMessage`, `AgentToolCall` (Tasks 20–21).
- Produces:
  - `loadConversationHistory(prisma: PrismaClient, whatsappIdentityId: string, organizationId: string): Promise<{ conversationId: string; history: AgentMessage[] }>`
  - `appendExchange(prisma, params: AppendExchangeParams): Promise<void>` onde `AppendExchangeParams = { conversationId: string; organizationId: string; userMessage: string; assistantMessage: string; toolCalls: AgentToolCall[] }`
  - Script `pnpm --filter @center/api eval:agent` que roda 12 perguntas reais contra a API da Anthropic e imprime as respostas para revisão humana.

- [ ] **Step 1: Escrever o teste (falhando)**

`apps/api/src/__tests__/agent-memory.test.ts`:

```ts
import type { PrismaClient } from '@prisma/client';
import { appendExchange, loadConversationHistory, MAX_LOADED_MESSAGES } from '../agent/memory.js';

function buildPrisma(overrides: Record<string, unknown> = {}) {
  const conversation = {
    findFirst: jest.fn(async () => null),
    create: jest.fn(async () => ({ id: 'conv_new' })),
    update: jest.fn(async () => ({})),
  };
  const message = {
    findMany: jest.fn(async () => []),
    create: jest.fn(async () => ({ id: 'msg_1' })),
  };
  const toolCallLog = { createMany: jest.fn(async () => ({ count: 0 })) };
  return {
    prisma: { conversation, message, toolCallLog, ...overrides } as unknown as PrismaClient,
    conversation, message, toolCallLog,
  };
}

describe('loadConversationHistory', () => {
  it('creates a conversation on the first message', async () => {
    const { prisma, conversation } = buildPrisma();
    const result = await loadConversationHistory(prisma, 'wid_1', 'org_1');
    expect(conversation.create).toHaveBeenCalledWith({
      data: { whatsappIdentityId: 'wid_1', organizationId: 'org_1' },
    });
    expect(result).toEqual({ conversationId: 'conv_new', history: [] });
  });

  it('reuses the existing conversation and returns its history in chronological order', async () => {
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
    expect(message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: MAX_LOADED_MESSAGES }),
    );
  });
});

describe('appendExchange', () => {
  it('persists the user message, the reply and the tool logs', async () => {
    const { prisma, message, toolCallLog, conversation } = buildPrisma();
    message.create
      .mockResolvedValueOnce({ id: 'msg_user' } as never)
      .mockResolvedValueOnce({ id: 'msg_assistant' } as never);

    await appendExchange(prisma, {
      conversationId: 'conv_1',
      organizationId: 'org_1',
      userMessage: 'quanto gastei?',
      assistantMessage: 'R$ 4.800,00',
      toolCalls: [{ toolName: 'consultar_metrica', input: { metricId: 'backend.spend' }, durationMs: 42, success: true }],
    });

    expect(message.create).toHaveBeenCalledTimes(2);
    expect(message.create).toHaveBeenNthCalledWith(1, {
      data: { conversationId: 'conv_1', role: 'USER', content: 'quanto gastei?' },
    });
    expect(toolCallLog.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        messageId: 'msg_assistant', organizationId: 'org_1',
        toolName: 'consultar_metrica', durationMs: 42, success: true,
      })],
    });
    expect(conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'conv_1' } }),
    );
  });

  it('records the error message of a failed tool call', async () => {
    const { prisma, message, toolCallLog } = buildPrisma();
    message.create
      .mockResolvedValueOnce({ id: 'msg_user' } as never)
      .mockResolvedValueOnce({ id: 'msg_assistant' } as never);

    await appendExchange(prisma, {
      conversationId: 'conv_1', organizationId: 'org_1',
      userMessage: 'p', assistantMessage: 'r',
      toolCalls: [{ toolName: 'consultar_metrica', input: {}, durationMs: 5, success: false, errorMessage: 'GA4 503' }],
    });

    expect(toolCallLog.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ success: false, errorMessage: 'GA4 503' })],
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

- [ ] **Step 2: Implementar `memory.ts`**

`apps/api/src/agent/memory.ts`:

```ts
import type { PrismaClient } from '@prisma/client';
import type { AgentMessage } from './agent.js';
import type { AgentToolCall } from './tools.js';

/** Teto do que sai do banco. A janela que vai ao modelo é menor (MAX_HISTORY_MESSAGES). */
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

  // Buscamos em ordem decrescente para pegar as N MAIS RECENTES,
  // depois invertemos: o modelo precisa da conversa em ordem cronológica.
  const rows = await prisma.message.findMany({
    where: { conversationId: existing.id },
    orderBy: { createdAt: 'desc' },
    take: MAX_LOADED_MESSAGES,
    select: { role: true, content: true },
  });

  return {
    conversationId: existing.id,
    history: rows
      .reverse()
      .map((row) => ({
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

export async function appendExchange(
  prisma: PrismaClient,
  params: AppendExchangeParams,
): Promise<void> {
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

- [ ] **Step 3: Rodar os testes**

Run: `pnpm --filter @center/api test -- agent-memory.test.ts`
Expected: PASS — 6 testes.

- [ ] **Step 4: Escrever o script de avaliação**

Testes unitários provam que o encanamento funciona; eles **não** provam que as respostas são boas. Este script existe para essa segunda pergunta, e roda contra a API real.

`apps/api/scripts/eval-agent.ts`:

```ts
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { McpPool, MetricGateway, RedisCacheStore } from '@center/mcp-core';
import { loadConfig } from '../src/config.js';
import { runAgent } from '../src/agent/agent.js';
import { resolveTenant } from '../src/tenant.js';

const QUESTIONS = [
  'quanto gastei no mês passado?',
  'quanto investi em mídia em fevereiro?',
  'qual foi o gasto nos últimos 30 dias?',
  'quantas sessões tivemos essa semana?',
  'quantos pedidos no mês atual?',
  'quantas aberturas do app ontem?',
  'quantos cliques na promoção Black Friday?',
  'compare o gasto deste mês com o do mês passado',
  'qual foi o dia de maior investimento em janeiro?',
  'qual o total de conversões no último trimestre?',
  'me manda a receita do bolo de cenoura',          // deve recusar: fora de escopo
  'quanto a empresa concorrente gastou?',           // deve recusar: fora de escopo
];

const config = loadConfig(process.env);
const prisma = new PrismaClient();
const redis = new Redis(config.redisUrl);
const pool = await McpPool.spawn([
  { source: 'backend', command: process.execPath, args: ['../../packages/mcp-backend/dist/main.js'],
    env: { BACKEND_API_URL: config.backendApiUrl, BACKEND_API_TOKEN: config.backendApiToken } },
  { source: 'ga4', command: process.execPath, args: ['../../packages/mcp-ga4/dist/main.js'],
    env: { GA4_CREDENTIALS_JSON: config.ga4CredentialsJson } },
  { source: 'firebase', command: process.execPath, args: ['../../packages/mcp-firebase/dist/main.js'],
    env: { FIREBASE_CREDENTIALS_JSON: config.firebaseCredentialsJson } },
]);
const gateway = new MetricGateway(pool, new RedisCacheStore(redis));
const tenant = await resolveTenant(prisma, process.env.EVAL_ORG_ID ?? 'org_dev');
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

for (const question of QUESTIONS) {
  const started = Date.now();
  const result = await runAgent({ gateway, tenant, today, history: [], userMessage: question });
  console.log(`\n─────────────────────────────────────────────`);
  console.log(`P: ${question}`);
  console.log(`R: ${result.reply}`);
  console.log(`   [${Date.now() - started}ms · ferramentas: ${
    result.toolCalls.map((c) => `${c.toolName}${c.success ? '' : ' (FALHOU)'}`).join(', ') || 'nenhuma'
  }]`);
}

await gateway.close();
await prisma.$disconnect();
redis.disconnect();
```

Adicione ao `scripts` de `apps/api/package.json`:

```json
  "eval:agent": "node --experimental-strip-types scripts/eval-agent.ts"
```

- [ ] **Step 5: Rodar a avaliação e registrar o resultado**

```bash
pnpm build
pnpm --filter @center/api eval:agent | tee ../../docs/agent-eval.md
```

Critérios de aprovação — **os quatro precisam passar** antes de seguir para a Fase 5:
1. As 10 perguntas de analytics chamaram ao menos uma ferramenta cada (nenhuma respondida "de cabeça").
2. Os períodos resolvidos batem com o que um humano entenderia da frase.
3. As 2 perguntas fora de escopo foram recusadas, sem inventar dado.
4. Latência mediana abaixo de 8 segundos (acima disso a experiência no WhatsApp fica ruim — veja o Risco R6).

Se algum critério falhar, ajuste `buildSystemPrompt` (Task 21, Step 1) e rode de novo. Anote no `docs/agent-eval.md` a data e a versão do prompt avaliada.

- [ ] **Step 6: Commit**

```bash
git add apps/api docs/agent-eval.md
git commit -m "feat(agent): add conversation memory and manual evaluation harness"
```

---

# FASE 5 — Integração WhatsApp (Sprint 9)

**Objetivo da fase:** ligar o agente ao WhatsApp Cloud API oficial, de forma assíncrona e idempotente.

**A restrição que define o desenho desta fase:** a Meta exige resposta HTTP **200 em até 20 segundos**, senão reenvia o evento — e o agente leva de 3 a 10 segundos. Se processarmos na thread do webhook, entramos em loop de reentrega e o usuário recebe respostas duplicadas. Por isso: o webhook **valida, enfileira e responde 200 imediatamente**; um worker separado processa e envia.

**Onde os testes entram:**
1. **Assinatura HMAC primeiro.** É a fronteira de segurança: sem ela, qualquer um posta no webhook e consome sua cota da Anthropic. Testada com vetores fixos, incluindo comparação em tempo constante.
2. **Parsing do payload.** A Meta manda eventos de status, reações, mídia e mensagens — a maioria deve ser ignorada em silêncio.
3. **Idempotência.** O mesmo `wamid` duas vezes gera exatamente uma resposta.
4. O worker é testado com o `runAgent` e o cliente da Cloud API mockados.

---

### Task 23: Webhook do WhatsApp — verificação, assinatura e parsing

**Files:**
- Create: `apps/api/src/whatsapp/signature.ts`, `apps/api/src/whatsapp/parse.ts`, `apps/api/src/whatsapp/routes.ts`
- Modify: `apps/api/src/server.ts` (registrar as rotas), `apps/api/src/deps.ts` (adicionar `queue`)
- Test: `apps/api/src/__tests__/whatsapp-signature.test.ts`, `apps/api/src/__tests__/whatsapp-parse.test.ts`, `apps/api/src/__tests__/whatsapp-routes.test.ts`

**Interfaces:**
- Consumes: `AppDeps` (Task 10), `PrismaClient`.
- Produces:
  - `verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean`
  - `signPayload(rawBody: Buffer, appSecret: string): string` (usado nos testes e no smoke test)
  - `interface InboundMessage { wamid: string; fromPhoneE164: string; text: string; timestamp: number }`
  - `parseInboundMessages(payload: unknown): InboundMessage[]`
  - `interface MessageQueue { enqueue(message: InboundMessage): Promise<void> }` (adicionado a `AppDeps`)
  - `registerWhatsAppRoutes(app, deps)`: `GET /webhooks/whatsapp`, `POST /webhooks/whatsapp`

- [ ] **Step 1: Escrever o teste de assinatura (falhando)**

`apps/api/src/__tests__/whatsapp-signature.test.ts`:

```ts
import { createHmac } from 'node:crypto';
import { signPayload, verifySignature } from '../whatsapp/signature.js';

const SECRET = 'app-secret-de-teste';
const body = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [] }));

describe('signPayload', () => {
  it('produces the sha256= prefixed hex digest Meta sends', () => {
    const expected = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
    expect(signPayload(body, SECRET)).toBe(expected);
  });
});

describe('verifySignature', () => {
  it('accepts a correctly signed body', () => {
    expect(verifySignature(body, signPayload(body, SECRET), SECRET)).toBe(true);
  });

  it('rejects a body signed with another secret', () => {
    expect(verifySignature(body, signPayload(body, 'outro-secret'), SECRET)).toBe(false);
  });

  it('rejects when the body was tampered with after signing', () => {
    const signature = signPayload(body, SECRET);
    expect(verifySignature(Buffer.from('{"object":"outro"}'), signature, SECRET)).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(verifySignature(body, undefined, SECRET)).toBe(false);
  });

  it('rejects a header without the sha256= prefix', () => {
    const bare = createHmac('sha256', SECRET).update(body).digest('hex');
    expect(verifySignature(body, bare, SECRET)).toBe(false);
  });

  it('rejects a header of the wrong length instead of throwing', () => {
    expect(verifySignature(body, 'sha256=abc', SECRET)).toBe(false);
  });

  it('rejects a header with non-hex characters instead of throwing', () => {
    expect(verifySignature(body, `sha256=${'z'.repeat(64)}`, SECRET)).toBe(false);
  });
});
```

- [ ] **Step 2: Implementar `signature.ts`**

`apps/api/src/whatsapp/signature.ts`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

const PREFIX = 'sha256=';
const DIGEST_HEX_LENGTH = 64;

export function signPayload(rawBody: Buffer, appSecret: string): string {
  return `${PREFIX}${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}

/**
 * Valida o header X-Hub-Signature-256. Esta é a única fronteira que impede um
 * terceiro de disparar o agente às nossas custas — qualquer caminho de erro
 * devolve `false`, nunca lança.
 */
export function verifySignature(
  rawBody: Buffer,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header || !header.startsWith(PREFIX)) return false;

  const received = header.slice(PREFIX.length);
  if (received.length !== DIGEST_HEX_LENGTH || !/^[0-9a-f]+$/i.test(received)) return false;

  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  // Comparação em tempo constante: evita distinguir assinaturas por timing.
  return timingSafeEqual(Buffer.from(received, 'hex'), expected);
}
```

Run: `pnpm --filter @center/api test -- whatsapp-signature.test.ts`
Expected: PASS — 8 testes.

- [ ] **Step 3: Escrever o teste de parsing (falhando)**

`apps/api/src/__tests__/whatsapp-parse.test.ts`:

```ts
import { parseInboundMessages } from '../whatsapp/parse.js';

function payloadWith(value: unknown) {
  return { object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages', value }] }] };
}

const textMessage = {
  messaging_product: 'whatsapp',
  metadata: { display_phone_number: '5511999999999', phone_number_id: '123' },
  contacts: [{ profile: { name: 'Ana' }, wa_id: '5511988887777' }],
  messages: [{
    from: '5511988887777', id: 'wamid.ABC', timestamp: '1773532800',
    type: 'text', text: { body: 'quanto gastei mês passado?' },
  }],
};

describe('parseInboundMessages', () => {
  it('extracts a text message', () => {
    expect(parseInboundMessages(payloadWith(textMessage))).toEqual([{
      wamid: 'wamid.ABC',
      fromPhoneE164: '+5511988887777',
      text: 'quanto gastei mês passado?',
      timestamp: 1773532800,
    }]);
  });

  it('trims surrounding whitespace from the text', () => {
    const payload = payloadWith({
      ...textMessage,
      messages: [{ ...textMessage.messages[0], text: { body: '  oi  ' } }],
    });
    expect(parseInboundMessages(payload)[0]?.text).toBe('oi');
  });

  it('ignores status update events', () => {
    const statuses = {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '5511999999999', phone_number_id: '123' },
      statuses: [{ id: 'wamid.XYZ', status: 'delivered', timestamp: '1773532800' }],
    };
    expect(parseInboundMessages(payloadWith(statuses))).toEqual([]);
  });

  it('ignores non-text message types', () => {
    const payload = payloadWith({
      ...textMessage,
      messages: [{ from: '5511988887777', id: 'wamid.IMG', timestamp: '1773532800', type: 'image', image: { id: 'x' } }],
    });
    expect(parseInboundMessages(payload)).toEqual([]);
  });

  it('ignores a text message with an empty body', () => {
    const payload = payloadWith({
      ...textMessage,
      messages: [{ ...textMessage.messages[0], text: { body: '   ' } }],
    });
    expect(parseInboundMessages(payload)).toEqual([]);
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
    const payload = payloadWith({
      ...textMessage,
      messages: [{ ...textMessage.messages[0], from: '+5511988887777' }],
    });
    expect(parseInboundMessages(payload)[0]?.fromPhoneE164).toBe('+5511988887777');
  });
});
```

- [ ] **Step 4: Implementar `parse.ts`**

`apps/api/src/whatsapp/parse.ts`:

```ts
import { z } from 'zod';

export interface InboundMessage {
  wamid: string;
  fromPhoneE164: string;
  text: string;
  timestamp: number;
}

/**
 * Schema deliberadamente frouxo: a Meta adiciona campos sem aviso e manda
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

function toE164(raw: string): string {
  return raw.startsWith('+') ? raw : `+${raw}`;
}

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
          fromPhoneE164: toE164(message.from),
          text,
          timestamp: Number(message.timestamp),
        });
      }
    }
  }
  return messages;
}
```

- [ ] **Step 5: Escrever o teste das rotas (falhando)**

`apps/api/src/__tests__/whatsapp-routes.test.ts`:

```ts
import type { PrismaClient } from '@prisma/client';
import type { MetricGateway } from '@center/mcp-core';
import { buildServer } from '../server.js';
import { signPayload } from '../whatsapp/signature.js';
import type { AppConfig } from '../config.js';
import type { MessageQueue } from '../whatsapp/queue.js';

const config = {
  port: 0, databaseUrl: 'postgresql://x', redisUrl: 'redis://x',
  jwtSecret: 'x'.repeat(32), anthropicApiKey: 'sk-ant-test',
  ga4CredentialsJson: '', firebaseCredentialsJson: '',
  backendApiUrl: 'http://localhost:4000', backendApiToken: 't',
  whatsapp: { appSecret: 'app-secret', verifyToken: 'verify-token', accessToken: 'a', phoneNumberId: '1' },
} satisfies AppConfig;

const inboundPayload = {
  object: 'whatsapp_business_account',
  entry: [{ id: '1', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '5511999999999', phone_number_id: '1' },
    messages: [{ from: '5511988887777', id: 'wamid.ABC', timestamp: '1773532800', type: 'text', text: { body: 'oi' } }],
  } }] }],
};

async function setup(alreadyProcessed = false) {
  const enqueue = jest.fn(async () => {});
  const queue: MessageQueue = { enqueue };
  const prisma = {
    processedWebhookEvent: {
      findUnique: jest.fn(async () => (alreadyProcessed ? { wamid: 'wamid.ABC' } : null)),
      create: jest.fn(async () => ({ wamid: 'wamid.ABC' })),
    },
  } as unknown as PrismaClient;

  const app = await buildServer({ config, prisma, gateway: {} as unknown as MetricGateway, queue });
  return { app, enqueue, prisma };
}

function post(app: Awaited<ReturnType<typeof buildServer>>, payload: unknown, secret = 'app-secret') {
  const raw = Buffer.from(JSON.stringify(payload));
  return app.inject({
    method: 'POST', url: '/webhooks/whatsapp',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signPayload(raw, secret) },
    payload: raw,
  });
}

describe('GET /webhooks/whatsapp (verificação da Meta)', () => {
  it('echoes the challenge when the verify token matches', async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: 'GET',
      url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=1158201444',
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('1158201444');
    await app.close();
  });

  it('returns 403 for a wrong verify token', async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: 'GET',
      url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=1158201444',
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it('returns 403 when hub.mode is not subscribe', async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: 'GET',
      url: '/webhooks/whatsapp?hub.mode=unsubscribe&hub.verify_token=verify-token&hub.challenge=1',
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
});

describe('POST /webhooks/whatsapp', () => {
  it('enqueues a valid message and answers 200 immediately', async () => {
    const { app, enqueue } = await setup();
    const response = await post(app, inboundPayload);
    expect(response.statusCode).toBe(200);
    expect(enqueue).toHaveBeenCalledWith({
      wamid: 'wamid.ABC', fromPhoneE164: '+5511988887777', text: 'oi', timestamp: 1773532800,
    });
    await app.close();
  });

  it('rejects a body signed with the wrong secret and does not enqueue', async () => {
    const { app, enqueue } = await setup();
    const response = await post(app, inboundPayload, 'secret-errado');
    expect(response.statusCode).toBe(401);
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
    const response = await post(app, inboundPayload);
    expect(response.statusCode).toBe(200);
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
    const response = await post(app, statusPayload);
    expect(response.statusCode).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
    await app.close();
  });

  it('answers 200 even when enqueuing fails, so Meta does not retry forever', async () => {
    const { app } = await setup();
    const enqueue = jest.fn(async () => { throw new Error('redis fora do ar'); });
    const failing = await buildServer({
      config,
      prisma: {
        processedWebhookEvent: {
          findUnique: jest.fn(async () => null), create: jest.fn(async () => ({})),
        },
      } as unknown as PrismaClient,
      gateway: {} as unknown as MetricGateway,
      queue: { enqueue },
    });
    expect((await post(failing, inboundPayload)).statusCode).toBe(200);
    await failing.close();
    await app.close();
  });
});
```

- [ ] **Step 6: Implementar `routes.ts` e o tipo da fila**

Crie `apps/api/src/whatsapp/queue.ts` com apenas a interface por enquanto (a implementação BullMQ vem na Task 24):

```ts
import type { InboundMessage } from './parse.js';

export interface MessageQueue {
  enqueue(message: InboundMessage): Promise<void>;
}
```

Em `apps/api/src/deps.ts`, adicione o campo:

```ts
import type { MessageQueue } from './whatsapp/queue.js';
// ...
export interface AppDeps {
  config: AppConfig;
  prisma: PrismaClient;
  gateway: MetricGateway;
  queue: MessageQueue;
}
```

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
  // Handshake de assinatura do webhook, feito uma única vez pela Meta no
  // cadastro da URL. Precisa devolver o challenge como texto puro.
  app.get('/webhooks/whatsapp', async (request, reply) => {
    const parsed = VerifyQuerySchema.safeParse(request.query);
    if (
      !parsed.success ||
      parsed.data['hub.mode'] !== 'subscribe' ||
      parsed.data['hub.verify_token'] !== deps.config.whatsapp.verifyToken
    ) {
      return reply.status(403).send('forbidden');
    }
    return reply.type('text/plain').send(parsed.data['hub.challenge']);
  });

  app.post('/webhooks/whatsapp', async (request, reply) => {
    const rawBody = (request as FastifyRequest & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
    const signature = request.headers['x-hub-signature-256'];

    if (!verifySignature(rawBody, typeof signature === 'string' ? signature : undefined, deps.config.whatsapp.appSecret)) {
      request.log.warn('webhook do WhatsApp com assinatura inválida');
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const messages = parseInboundMessages(request.body);

    for (const message of messages) {
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
        // Nunca devolvemos erro à Meta: 4xx/5xx aqui gera reentrega em loop e,
        // depois de várias falhas, a Meta desativa o webhook.
        request.log.error({ err: error, wamid: message.wamid }, 'falha ao enfileirar mensagem');
      }
    }

    return reply.status(200).send({ received: true });
  });
}
```

Em `apps/api/src/server.ts`, adicione o import e o registro:

```ts
import { registerWhatsAppRoutes } from './whatsapp/routes.js';
```

```ts
  await registerWhatsAppRoutes(app, deps);
```

Os testes das Tasks 10–12 agora precisam do campo `queue` em `AppDeps`. Adicione `queue: { enqueue: jest.fn(async () => {}) }` aos objetos passados para `buildServer` em `auth-routes.test.ts`, `metrics-routes.test.ts` e `rate-limit.test.ts`.

- [ ] **Step 7: Rodar os testes**

Run: `pnpm --filter @center/api test`
Expected: PASS — 12 suites.

- [ ] **Step 8: Commit**

```bash
git add apps/api
git commit -m "feat(whatsapp): add verified, idempotent inbound webhook"
```

---

### Task 24: Fila, worker e envio de resposta

**Files:**
- Create: `apps/api/src/whatsapp/cloud-api-client.ts`, `apps/api/src/whatsapp/worker.ts`
- Modify: `apps/api/src/whatsapp/queue.ts` (implementação BullMQ)
- Modify: `apps/api/package.json` (bullmq)
- Test: `apps/api/src/__tests__/cloud-api-client.test.ts`, `apps/api/src/__tests__/whatsapp-worker.test.ts`

**Interfaces:**
- Consumes: `InboundMessage` (Task 23); `runAgent`, `AgentResult` (Task 21); `loadConversationHistory`, `appendExchange` (Task 22); `resolveTenant` (Task 10).
- Produces:
  - `class CloudApiClient` com `sendText(toPhoneE164: string, body: string): Promise<void>`
  - `class BullMessageQueue implements MessageQueue` com `constructor(redis: Redis)` e `close(): Promise<void>`
  - `WHATSAPP_QUEUE_NAME = 'whatsapp-inbound'`
  - `processInboundMessage(deps: WorkerDeps, message: InboundMessage): Promise<void>`
  - `createWhatsAppWorker(deps: WorkerDeps, redis: Redis): Worker`
  - `interface WorkerDeps { prisma: PrismaClient; gateway: MetricGateway; cloudApi: CloudApiClient; config: AppConfig; today?: () => string }`

- [ ] **Step 1: Adicionar a dependência**

```bash
pnpm --filter @center/api add bullmq@^5.34.0
```

- [ ] **Step 2: Escrever o teste do cliente da Cloud API (falhando)**

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
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '+5511988887777',
      type: 'text',
      text: { preview_url: false, body: 'olá' },
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
    await expect(buildClient(fetchImpl).sendText('+5511988887777', 'olá'))
      .rejects.toThrow(/502/);
  });
});
```

- [ ] **Step 3: Implementar `cloud-api-client.ts`**

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
      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      throw new Error(
        payload?.error?.message ?? `WhatsApp Cloud API respondeu ${response.status}`,
      );
    }
  }
}
```

- [ ] **Step 4: Escrever o teste do worker (falhando)**

`apps/api/src/__tests__/whatsapp-worker.test.ts`:

```ts
import type { PrismaClient } from '@prisma/client';
import type { MetricGateway } from '@center/mcp-core';
import { processInboundMessage, UNKNOWN_PHONE_REPLY, type WorkerDeps } from '../whatsapp/worker.js';
import type { CloudApiClient } from '../whatsapp/cloud-api-client.js';
import * as agentModule from '../agent/agent.js';
import type { AppConfig } from '../config.js';

jest.mock('../agent/agent.js', () => ({
  ...jest.requireActual('../agent/agent.js'),
  runAgent: jest.fn(),
}));
const runAgent = agentModule.runAgent as jest.Mock;

const config = {
  port: 0, databaseUrl: 'postgresql://x', redisUrl: 'redis://x',
  jwtSecret: 'x'.repeat(32), anthropicApiKey: 'sk-ant-test',
  ga4CredentialsJson: '', firebaseCredentialsJson: '',
  backendApiUrl: 'http://localhost:4000', backendApiToken: 't',
  whatsapp: { appSecret: 's', verifyToken: 'v', accessToken: 'a', phoneNumberId: '1' },
} satisfies AppConfig;

const message = {
  wamid: 'wamid.ABC', fromPhoneE164: '+5511988887777', text: 'quanto gastei?', timestamp: 1773532800,
};

function buildDeps(identity: unknown) {
  const sendText = jest.fn(async () => {});
  const prisma = {
    whatsAppIdentity: { findUnique: jest.fn(async () => identity) },
    organization: { findUnique: jest.fn(async () => ({
      id: 'org_1', ga4PropertyId: '111', firebaseProjectId: null, backendAccountId: 'acc_9',
    })) },
    conversation: {
      findFirst: jest.fn(async () => ({ id: 'conv_1' })),
      update: jest.fn(async () => ({})),
    },
    message: {
      findMany: jest.fn(async () => []),
      create: jest.fn(async () => ({ id: 'msg_1' })),
    },
    toolCallLog: { createMany: jest.fn(async () => ({ count: 0 })) },
  } as unknown as PrismaClient;

  const deps: WorkerDeps = {
    prisma,
    gateway: {} as unknown as MetricGateway,
    cloudApi: { sendText } as unknown as CloudApiClient,
    config,
    today: () => '2026-03-15',
  };
  return { deps, sendText, prisma };
}

const verifiedIdentity = {
  id: 'wid_1', phoneE164: '+5511988887777', userId: 'user_1',
  organizationId: 'org_1', verifiedAt: new Date('2026-01-01'),
};

beforeEach(() => {
  runAgent.mockReset();
  runAgent.mockResolvedValue({ reply: 'Você gastou R$ 4.800,00.', toolCalls: [] });
});

describe('processInboundMessage', () => {
  it('answers with the agent reply for a known phone', async () => {
    const { deps, sendText } = buildDeps(verifiedIdentity);
    await processInboundMessage(deps, message);
    expect(sendText).toHaveBeenCalledWith('+5511988887777', 'Você gastou R$ 4.800,00.');
  });

  it('passes the resolved tenant and today to the agent', async () => {
    const { deps } = buildDeps(verifiedIdentity);
    await processInboundMessage(deps, message);
    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({
      today: '2026-03-15',
      userMessage: 'quanto gastei?',
      tenant: { organizationId: 'org_1', externalIds: { ga4PropertyId: '111', backendAccountId: 'acc_9' } },
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

  it('still tries to warn the user when the agent throws', async () => {
    runAgent.mockRejectedValueOnce(new Error('pane geral'));
    const { deps, sendText } = buildDeps(verifiedIdentity);
    await expect(processInboundMessage(deps, message)).resolves.toBeUndefined();
    expect(sendText).toHaveBeenCalledWith(
      '+5511988887777',
      expect.stringMatching(/não consegui/i),
    );
  });

  it('rethrows when sending fails, so BullMQ can retry', async () => {
    const { deps } = buildDeps(verifiedIdentity);
    (deps.cloudApi.sendText as jest.Mock).mockRejectedValueOnce(new Error('graph 503'));
    await expect(processInboundMessage(deps, message)).rejects.toThrow('graph 503');
  });
});
```

- [ ] **Step 5: Implementar `queue.ts` e `worker.ts`**

`apps/api/src/whatsapp/queue.ts` (substitui o arquivo só-interface da Task 23):

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

export const UNKNOWN_PHONE_REPLY =
  'Não encontrei este número vinculado a uma conta do Center Dashboard. ' +
  'Entre na dashboard, gere um código de vínculo em Configurações e me envie aqui.';

const AGENT_FAILURE_REPLY =
  'Não consegui processar sua pergunta agora. Tente novamente em alguns instantes.';

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

export async function processInboundMessage(
  deps: WorkerDeps,
  message: InboundMessage,
): Promise<void> {
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
    const conversation = await loadConversationHistory(
      deps.prisma, identity.id, identity.organizationId,
    );
    conversationId = conversation.conversationId;

    const tenant = await resolveTenant(deps.prisma, identity.organizationId);
    const result = await runAgent({
      gateway: deps.gateway,
      tenant,
      today,
      history: conversation.history,
      userMessage: message.text,
    });
    reply = result.reply;
    toolCalls = result.toolCalls;
  } catch {
    // Falha no agente ou no banco não pode impedir a resposta ao usuário —
    // silêncio no WhatsApp é pior do que uma mensagem de erro.
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
      // Auditoria é best-effort; já respondemos ao usuário.
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

- [ ] **Step 6: Rodar os testes**

Run: `pnpm --filter @center/api test`
Expected: PASS — 14 suites.

- [ ] **Step 7: Commit**

```bash
git add apps/api
git commit -m "feat(whatsapp): add bullmq queue, cloud api client and inbound worker"
```

---

### Task 25: Vínculo do telefone com o usuário

**Files:**
- Create: `apps/api/src/whatsapp/linking.ts`, `apps/api/src/whatsapp/link-routes.ts`
- Modify: `apps/api/src/server.ts` (registrar a rota), `apps/api/src/whatsapp/worker.ts` (interceptar o código antes da checagem de identidade)
- Create: `apps/web/src/pages/SettingsPage.tsx`
- Modify: `apps/web/src/App.tsx` (rota), `apps/web/src/components/layout/AppShell.tsx` (link de navegação)
- Test: `apps/api/src/__tests__/whatsapp-linking.test.ts`

**Interfaces:**
- Consumes: `PrismaClient`; `InboundMessage` (Task 23).
- Produces:
  - `generateLinkCode(): string` (6 caracteres do alfabeto Crockford, sem I/L/O/U)
  - `createLinkCode(prisma, userId): Promise<{ code: string; expiresAt: Date }>`
  - `redeemLinkCode(prisma, code, phoneE164): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'expired' | 'used' | 'phone_taken' }>`
  - `LINK_CODE_TTL_MINUTES = 15`
  - `isLinkCodeMessage(text: string): boolean`
  - `POST /api/whatsapp/link-code` (autenticada) → `{ code, expiresAt }`

- [ ] **Step 1: Escrever o teste (falhando)**

`apps/api/src/__tests__/whatsapp-linking.test.ts`:

```ts
import type { PrismaClient } from '@prisma/client';
import {
  createLinkCode, generateLinkCode, isLinkCodeMessage, redeemLinkCode, LINK_CODE_TTL_MINUTES,
} from '../whatsapp/linking.js';

function buildPrisma(overrides: Record<string, unknown> = {}) {
  return {
    linkCode: {
      create: jest.fn(async ({ data }: { data: unknown }) => data),
      findUnique: jest.fn(async () => null),
      update: jest.fn(async () => ({})),
    },
    whatsAppIdentity: {
      findUnique: jest.fn(async () => null),
      upsert: jest.fn(async () => ({})),
    },
    user: { findUnique: jest.fn(async () => ({ id: 'user_1', organizationId: 'org_1' })) },
    ...overrides,
  } as unknown as PrismaClient;
}

describe('generateLinkCode', () => {
  it('produces six characters', () => {
    expect(generateLinkCode()).toHaveLength(6);
  });

  it('avoids the ambiguous characters I, L, O, U and digits 0 and 1', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateLinkCode()).toMatch(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/);
    }
  });

  it('is not trivially repeating', () => {
    const codes = new Set(Array.from({ length: 100 }, () => generateLinkCode()));
    expect(codes.size).toBeGreaterThan(90);
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
    expect(isLinkCodeMessage('quanto gastei mês passado?')).toBe(false);
  });

  it('does not treat a six letter word as a code if it has invalid characters', () => {
    expect(isLinkCodeMessage('ONIBUS')).toBe(false);
  });
});

describe('createLinkCode', () => {
  it('stores a code that expires in fifteen minutes', async () => {
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
    expect(prisma.whatsAppIdentity.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'user_1' },
    }));
    expect(prisma.linkCode.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { code: 'A2B3C4' },
    }));
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
    (prisma.linkCode.findUnique as jest.Mock).mockResolvedValueOnce({
      ...validCode, usedAt: new Date(),
    });
    expect(await redeemLinkCode(prisma, 'A2B3C4', '+5511988887777'))
      .toEqual({ ok: false, reason: 'used' });
  });

  it('rejects when the phone is already linked to another user', async () => {
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

- [ ] **Step 2: Implementar `linking.ts`**

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
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += ALPHABET[randomInt(ALPHABET.length)];
  }
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
      phoneE164,
      userId: record.userId,
      organizationId: record.user.organizationId,
      verifiedAt: new Date(),
    },
    update: { phoneE164, verifiedAt: new Date() },
  });

  await prisma.linkCode.update({ where: { code }, data: { usedAt: new Date() } });
  return { ok: true };
}
```

- [ ] **Step 3: Interceptar o código no worker**

Em `apps/api/src/whatsapp/worker.ts`, adicione o import e insira o bloco **antes** da checagem de identidade em `processInboundMessage`:

```ts
import { isLinkCodeMessage, redeemLinkCode } from './linking.js';
```

```ts
  // O código de vínculo chega de um número que AINDA não está vinculado —
  // por isso precisa ser tratado antes da checagem de identidade.
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
```

com `LINK_CODE_TTL_MINUTES` também no import.

- [ ] **Step 4: Criar a rota de emissão de código**

`apps/api/src/whatsapp/link-routes.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/jwt.js';
import type { AppDeps } from '../deps.js';
import { createLinkCode, LINK_CODE_TTL_MINUTES } from './linking.js';

export async function registerLinkRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.post(
    '/api/whatsapp/link-code',
    { preHandler: requireAuth, config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const { code, expiresAt } = await createLinkCode(deps.prisma, request.auth.userId);
      return reply.send({ code, expiresAt: expiresAt.toISOString(), ttlMinutes: LINK_CODE_TTL_MINUTES });
    },
  );
}
```

Registre em `apps/api/src/server.ts` com `import { registerLinkRoutes } from './whatsapp/link-routes.js';` e `await registerLinkRoutes(app, deps);`.

- [ ] **Step 5: Criar a página de Configurações no frontend**

`apps/web/src/pages/SettingsPage.tsx`:

```tsx
import { useMutation } from '@tanstack/react-query';

interface LinkCodeResponse {
  code: string;
  expiresAt: string;
  ttlMinutes: number;
}

async function requestLinkCode(): Promise<LinkCodeResponse> {
  const token = localStorage.getItem('center.token');
  const response = await fetch('/api/whatsapp/link-code', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token ?? ''}` },
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
        Gere um código e envie-o pelo WhatsApp para o número do assistente. O código vale
        alguns minutos e só pode ser usado uma vez.
      </p>

      <button
        type="button"
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending}
        className="rounded-md bg-viz-1 px-4 py-2 text-white disabled:opacity-60"
      >
        {mutation.isPending ? 'Gerando…' : 'Gerar código'}
      </button>

      {mutation.data ? (
        <div
          className="rounded-lg border p-4"
          style={{ backgroundColor: 'var(--surface-1)', borderColor: 'var(--hairline)' }}
        >
          <p className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
            Seu código
          </p>
          <p className="mt-1 font-mono text-3xl tracking-[0.3em]">{mutation.data.code}</p>
          <p className="mt-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
            Válido por {mutation.data.ttlMinutes} minutos.
          </p>
        </div>
      ) : null}

      {mutation.error ? (
        <p role="alert" className="text-sm" style={{ color: '#d03b3b' }}>
          {(mutation.error as Error).message}
        </p>
      ) : null}
    </section>
  );
}
```

Adicione a rota em `apps/web/src/App.tsx`, dentro do bloco do `AppShell`:

```tsx
          <Route path="/configuracoes" element={<SettingsPage />} />
```

com `import { SettingsPage } from './pages/SettingsPage.js';`, e acrescente `{ to: '/configuracoes', label: 'Configurações', end: false }` ao array `LINKS` de `AppShell.tsx`.

- [ ] **Step 6: Rodar os testes**

Run: `pnpm test`
Expected: PASS em todos os pacotes.

- [ ] **Step 7: Commit**

```bash
git add apps/api apps/web
git commit -m "feat(whatsapp): add one-time code linking between phone and user"
```

---

### Task 26: Composição final e validação fim-a-fim no WhatsApp

**Files:**
- Modify: `apps/api/src/main.ts` (instanciar fila, cliente e worker)
- Create: `apps/api/src/worker-main.ts`
- Create: `docs/whatsapp-setup.md`

**Interfaces:**
- Consumes: tudo das Tasks 23–25.
- Produces: processo `node dist/worker-main.ts` executando o worker; API completa com fila conectada.

**Nota sobre a janela de 24 horas:** a Cloud API só permite mensagem de texto livre dentro de **24 h após a última mensagem do usuário**. Como o bot só responde a mensagens recebidas, estamos sempre dentro da janela — **desde que a fila não acumule**. Se um job ficar retido mais de 24 h, o envio falha com o código 131047. O `attempts: 3` com backoff exponencial (Task 24) esgota em segundos, então na prática isso só acontece com o worker parado por um dia. O alarme da Task 27 cobre esse caso. Templates aprovados pela Meta **não são necessários** neste escopo, porque o bot nunca inicia conversa.

- [ ] **Step 1: Atualizar o composition root**

Em `apps/api/src/main.ts`, adicione após a criação do `gateway`:

```ts
import { BullMessageQueue } from './whatsapp/queue.js';
import { CloudApiClient } from './whatsapp/cloud-api-client.js';
```

```ts
const queue = new BullMessageQueue(redis);
const app = await buildServer({ config, prisma, gateway, queue });
```

(substituindo a linha `const app = await buildServer({ config, prisma, gateway });`), e no `shutdown`, antes de `await gateway.close();`:

```ts
  await queue.close();
```

Note que `CloudApiClient` não é usado aqui — ele pertence ao processo do worker.

- [ ] **Step 2: Criar o processo do worker**

O worker roda separado da API: um pico de perguntas não pode degradar a dashboard, e escalar os dois independentemente é o comportamento certo.

`apps/api/src/worker-main.ts`:

```ts
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { McpPool, MetricGateway, RedisCacheStore, type McpServerConfig } from '@center/mcp-core';
import { loadConfig } from './config.js';
import { CloudApiClient } from './whatsapp/cloud-api-client.js';
import { createWhatsAppWorker } from './whatsapp/worker.js';

const config = loadConfig(process.env);
const prisma = new PrismaClient();
// BullMQ exige maxRetriesPerRequest: null na conexão do worker.
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

const mcpServers: McpServerConfig[] = [
  { source: 'backend', command: process.execPath, args: ['../../packages/mcp-backend/dist/main.js'],
    env: { BACKEND_API_URL: config.backendApiUrl, BACKEND_API_TOKEN: config.backendApiToken } },
  { source: 'ga4', command: process.execPath, args: ['../../packages/mcp-ga4/dist/main.js'],
    env: { GA4_CREDENTIALS_JSON: config.ga4CredentialsJson } },
  { source: 'firebase', command: process.execPath, args: ['../../packages/mcp-firebase/dist/main.js'],
    env: { FIREBASE_CREDENTIALS_JSON: config.firebaseCredentialsJson } },
];

const pool = await McpPool.spawn(mcpServers);
const gateway = new MetricGateway(pool, new RedisCacheStore(redis));
const cloudApi = new CloudApiClient(config.whatsapp);

const worker = createWhatsAppWorker({ prisma, gateway, cloudApi, config }, redis);

worker.on('failed', (job, error) => {
  console.error(`job ${job?.id} falhou (tentativa ${job?.attemptsMade}):`, error.message);
});
worker.on('completed', (job) => {
  console.log(`job ${job.id} concluído`);
});

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
  "start:worker": "node dist/worker-main.js",
  "dev:worker": "node --watch --experimental-strip-types src/worker-main.ts"
```

- [ ] **Step 3: Escrever o guia de configuração da Meta**

`docs/whatsapp-setup.md`:

```markdown
# Configuração do WhatsApp Cloud API

## Pré-requisitos (comece cedo — a verificação da Meta leva de 3 dias a 3 semanas)

1. Conta no Meta Business Manager com o negócio **verificado**.
2. App do tipo *Business* em developers.facebook.com com o produto **WhatsApp** adicionado.
3. Número de telefone registrado no WhatsApp Business Platform (não pode estar em uso
   no app WhatsApp comum).

## Valores a coletar

| Variável | Onde encontrar |
|---|---|
| `WHATSAPP_APP_SECRET` | App → Configurações → Básico → Chave secreta do app |
| `WHATSAPP_ACCESS_TOKEN` | App → WhatsApp → Configuração da API (gere um token permanente de System User) |
| `WHATSAPP_PHONE_NUMBER_ID` | App → WhatsApp → Configuração da API → "ID do número de telefone" |
| `WHATSAPP_VERIFY_TOKEN` | Você inventa. Qualquer string longa; precisa bater com a cadastrada no webhook |

> O token temporário de 24 h só serve para o primeiro teste. Para produção, crie um
> System User em Business Settings → Users → System Users, dê a ele as permissões
> `whatsapp_business_messaging` e `whatsapp_business_management`, e gere um token
> sem expiração.

## Expor o webhook em desenvolvimento

```bash
npx localtunnel --port 3333
# ou: ngrok http 3333
```

Cadastre em App → WhatsApp → Configuração → Webhooks:
- **URL de callback:** `https://<seu-túnel>/webhooks/whatsapp`
- **Token de verificação:** o mesmo valor de `WHATSAPP_VERIFY_TOKEN`
- **Campos assinados:** marque `messages` (só ele)

A Meta faz um `GET` imediatamente. Se a API estiver rodando com o mesmo verify token,
o cadastro é aceito na hora. Se falhar, cheque o log — quase sempre é token divergente.

## Números de teste

Antes da revisão do app, só é possível enviar para números adicionados na lista de
destinatários de teste (App → WhatsApp → Configuração da API → "Para"). O erro
`131030 — Recipient phone number not in allowed list` significa exatamente isso.
```

- [ ] **Step 4: Validação fim-a-fim**

Em quatro terminais:

```bash
# 1
docker compose up
# 2
pnpm build && cd apps/api && node dist/main.js
# 3
cd apps/api && node dist/worker-main.js
# 4
npx localtunnel --port 3333
```

Roteiro de aceite — **os seis passos precisam passar**:

1. Cadastre o webhook com a URL do túnel. A Meta aceita na primeira tentativa.
2. Envie "oi" de um número **não vinculado**. Recebe a mensagem de vínculo. Confirme no log do worker que `runAgent` **não** foi chamado.
3. Na dashboard, em Configurações, gere um código. Envie o código pelo WhatsApp. Recebe a confirmação de vínculo.
4. Envie "quanto gastei mês passado?". Recebe um valor. Compare com o total da dashboard no mesmo período — **precisa ser idêntico**.
5. Envie "quantos cliques na promoção Black Friday?". O log do worker mostra `listar_promocoes` seguida de `consultar_metrica` com o filtro `promotionId`.
6. Pare o worker, envie uma pergunta, suba o worker de novo. A resposta chega ao reiniciar (a fila reteve o job) e **apenas uma** resposta é enviada.

Verifique também no banco:

```sql
SELECT "toolName", success, "durationMs" FROM "ToolCallLog" ORDER BY "createdAt" DESC LIMIT 10;
SELECT COUNT(*) FROM "ProcessedWebhookEvent";
```

- [ ] **Step 5: Commit**

```bash
git add apps/api docs/whatsapp-setup.md
git commit -m "feat(whatsapp): wire queue and worker process, add setup guide"
```

---

# FASE 6 — Hardening e Deploy (Sprint 10)

### Task 27: Integração contínua e aquecimento de cache

**Files:**
- Create: `.github/workflows/ci.yml`, `apps/api/scripts/warm-cache.ts`
- Modify: `apps/api/package.json` (script `warm:cache`)
- Test: o próprio CI é a verificação.

**Interfaces:**
- Consumes: scripts `build`, `test`, `typecheck` de todos os pacotes.
- Produces: pipeline que roda em todo push e PR; script `pnpm --filter @center/api warm:cache` para agendar via cron.

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
      - run: pnpm --filter @center/api exec prisma migrate deploy
      - run: pnpm build
      - run: pnpm typecheck
      - run: pnpm test
```

- [ ] **Step 2: Rodar o CI**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add build, typecheck and test pipeline"
git push
```

Expected: pipeline verde. Se `prisma generate` falhar por falta de `DATABASE_URL` no momento do generate, confirme que a env está no nível do job (como acima) e não só no step.

- [ ] **Step 3: Escrever o script de aquecimento de cache**

O primeiro acesso da manhã paga o custo de consultar GA4 e Firebase ao vivo — 3 a 8 segundos. Este script paga esse custo às 5h.

`apps/api/scripts/warm-cache.ts`:

```ts
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { McpPool, MetricGateway, RedisCacheStore, type McpServerConfig } from '@center/mcp-core';
import type { Granularity, MetricQuery } from '@center/shared';
import { loadConfig } from '../src/config.js';
import { resolveTenant } from '../src/tenant.js';

const HEADLINE_METRIC_IDS = [
  'ga4.sessions', 'backend.spend', 'backend.orders', 'firebase.app_opens',
];

const config = loadConfig(process.env);
const prisma = new PrismaClient();
const redis = new Redis(config.redisUrl);

const mcpServers: McpServerConfig[] = [
  { source: 'backend', command: process.execPath, args: ['../../packages/mcp-backend/dist/main.js'],
    env: { BACKEND_API_URL: config.backendApiUrl, BACKEND_API_TOKEN: config.backendApiToken } },
  { source: 'ga4', command: process.execPath, args: ['../../packages/mcp-ga4/dist/main.js'],
    env: { GA4_CREDENTIALS_JSON: config.ga4CredentialsJson } },
  { source: 'firebase', command: process.execPath, args: ['../../packages/mcp-firebase/dist/main.js'],
    env: { FIREBASE_CREDENTIALS_JSON: config.firebaseCredentialsJson } },
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
    HEADLINE_METRIC_IDS.map((metricId) => ({ metricId, ...range, tenant })),
  );

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

Adicione ao `scripts` de `apps/api/package.json`: `"warm:cache": "node dist/scripts/warm-cache.js"`.

- [ ] **Step 4: Agendar e verificar**

```bash
pnpm build
cd apps/api && node dist/scripts/warm-cache.js
```

Expected: log com contagem de consultas aquecidas e zero falhas. Agende com cron às 05:00 America/Sao_Paulo:

```
0 5 * * * cd /srv/center/apps/api && /usr/bin/node dist/scripts/warm-cache.js >> /var/log/center-warm.log 2>&1
```

- [ ] **Step 5: Commit**

```bash
git add .github apps/api
git commit -m "feat(ops): add cache warmup script scheduled before business hours"
```

---

### Task 28: Empacotamento e deploy em staging

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker-compose.prod.yml`, `docs/deploy.md`

**Interfaces:**
- Consumes: builds de todos os pacotes.
- Produces: uma imagem contendo API, worker e MCP servers; `docker compose -f docker-compose.prod.yml up` sobe a stack.

**Decisão:** uma única imagem com três entrypoints (`api`, `worker`, `warm`). Os MCP servers são processos filhos do processo que os usa, então **não** são serviços separados — precisam estar no mesmo sistema de arquivos.

- [ ] **Step 1: Escrever o Dockerfile**

`Dockerfile`:

```dockerfile
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/mcp-core/package.json packages/mcp-core/
COPY packages/mcp-backend/package.json packages/mcp-backend/
COPY packages/mcp-ga4/package.json packages/mcp-ga4/
COPY packages/mcp-firebase/package.json packages/mcp-firebase/
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
# Entrypoint padrão: API. O worker sobrescreve o command no compose.
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

  worker:
    build: .
    env_file: [.env]
    depends_on:
      api: { condition: service_started }
      redis: { condition: service_healthy }
    command: node dist/worker-main.js
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
acontece no deploy e não precisa de passo manual.

## Verificação pós-deploy

```bash
curl -f http://localhost:3333/health
docker compose -f docker-compose.prod.yml logs worker | grep "worker do WhatsApp em execução"
```

## O que monitorar

| Sinal | Onde | Por que importa |
|---|---|---|
| Profundidade da fila `whatsapp-inbound` | Redis: `LLEN bull:whatsapp-inbound:wait` | Fila crescendo = worker morto. Passando de 24 h, o envio começa a falhar com erro 131047 |
| Taxa de falha em `ToolCallLog` | Postgres: `SELECT success, COUNT(*) FROM "ToolCallLog" WHERE "createdAt" > now() - interval '1 hour' GROUP BY success` | Fonte de dados fora do ar |
| 401 em `/webhooks/whatsapp` | Log da API | Assinatura inválida: ou o `WHATSAPP_APP_SECRET` está errado, ou alguém está sondando o endpoint |
| Latência de `/api/metrics/query` | Log da API | Acima de 3 s de forma sustentada indica cache frio ou Redis fora |

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
docker build -t center-dashboard:staging .
docker run --rm center-dashboard:staging node -e "console.log('build ok')"
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

### R1 — Verificação do Meta Business bloqueia a Fase 5 inteira 🔴 CRÍTICO

**O que acontece:** a verificação de negócio da Meta leva de 3 dias a 3 semanas, é assíncrona, e pode ser rejeitada por motivos que só aparecem depois de submeter (documento da empresa ilegível, domínio não verificado, nome do display não aprovado). Sem ela, o número fica limitado a destinatários de teste.

**Impacto:** Sprint 9 inteiro parado. É o único risco capaz de estourar o prazo sozinho.

**Mitigação, em ordem:**
1. **Iniciar a verificação no Sprint 1**, antes de escrever a primeira linha de código do WhatsApp. Não custa nada e roda em paralelo.
2. Desenvolver e testar toda a Fase 5 com os **números de teste** que a Meta libera de imediato — cobrem 100% do fluxo de desenvolvimento.
3. Verificar o domínio no Business Manager antes de submeter o negócio, e usar o CNPJ com razão social exatamente igual ao cartão CNPJ.

**Gatilho de escalada:** se em 10 de agosto de 2026 a verificação não tiver saído, considere Evolution API como canal temporário — o `CloudApiClient` é uma classe de um método, e trocá-lo por um adaptador Evolution custa ~2 dias.

---

### R2 — Latência do agente arruína a experiência no WhatsApp 🔴 ALTO

**O que acontece:** a resposta soma consulta MCP (0,5–4 s em cache frio para GA4) + duas ou três idas ao LLM (1–3 s cada). Um cenário ruim realista: `listar_metricas` → `listar_promocoes` → `consultar_metrica` → texto final = 4 chamadas de LLM + 2 de API externa ≈ **12 segundos**. No WhatsApp, o usuário assume que o bot morreu depois de ~8 s.

**Impacto:** o produto funciona e ninguém usa.

**Mitigação, já embutida no plano:**
- `MetricGateway` com cache Redis (Task 9), e aquecimento às 5h (Task 27) para os intervalos que os presets produzem.
- `consultar_metrica` devolve resumo achatado, não a série (Task 20) — menos tokens de entrada no passo seguinte.
- `stopWhen: stepCountIs(6)` (Task 21) limita o pior caso.
- `temperature: 0` reduz caminhos exploratórios do modelo.

**Se ainda assim ficar lento:** enviar um "Consultando seus dados… ⏳" imediatamente ao enfileirar, antes do processamento. Custa ~15 linhas no `routes.ts` da Task 23 e resolve a percepção, não a latência. Meça primeiro com o script da Task 22, Step 5 — o critério de 8 s medianos existe exatamente para isto.

---

### R3 — Firebase Admin SDK não entrega dados de analytics 🟠 MÉDIO-ALTO

**O que acontece:** o requisito diz "Firebase Admin SDK (Mobile)", mas o Admin SDK **não expõe** os eventos do Google Analytics for Firebase. Esses dados só saem por GA4 Data API (mesma propriedade) ou export para BigQuery. A Task 8 resolve isso lendo rollups diários que **o app mobile precisa escrever** na coleção `metric_rollups` do Firestore.

**Impacto:** se o time mobile não escrever esses rollups, a Task 8 entrega um server que consulta uma coleção vazia.

**Mitigação:**
1. **Confirmar com o time mobile na primeira semana** se eles escrevem (ou podem escrever) esses agregados. É uma pergunta de 5 minutos que muda o escopo de uma task inteira.
2. **Plano B — BigQuery export:** habilite o export do Firebase Analytics para BigQuery e troque o `FirestoreMetricsClient` por um `BigQueryMetricsClient`. A interface `MetricProvider` não muda; só o `client.ts` da Task 8. Custo: ~3 dias, mais latência (query de BigQuery leva segundos) e custo por consulta.
3. **Plano C — abandonar o Firebase como fonte:** eventos mobile também chegam ao GA4 se o app usa a mesma propriedade. Nesse caso a Task 8 é cancelada e as métricas viram `ga4.*` com filtro por `platform`. Custo: −4 dias.

Decida entre os três **antes do Sprint 3**.

---

### R4 — Índices compostos do Firestore 🟠 MÉDIO

**O que acontece:** a query da Task 8 filtra por `projectId` + `metric` + range em `date`, e opcionalmente por `platform`/`appVersion`. **Cada combinação de campos exige seu próprio índice composto.** Sem ele, a query falha em runtime com `FAILED_PRECONDITION`. Não dá para descobrir isso em teste unitário — os testes mockam o Firestore.

**Impacto:** o server passa em todos os testes e quebra no primeiro uso real.

**Mitigação:** o smoke test da Task 8, Step 8 é obrigatório e existe para pegar exatamente isso. Declare os índices em `firestore.indexes.json` e faça `firebase deploy --only firestore:indexes` **antes** do smoke test. A lista de dimensões do provider é deliberadamente fechada (3 campos) para manter o número de índices administrável.

---

### R5 — Tremor 3 e React 19 🟠 MÉDIO

**O que acontece:** o Tremor 3 declara peer dependency `react@^18`. O install passa com `strict-peer-dependencies=false` (Task 1), mas incompatibilidades de runtime aparecem em `forwardRef`, `defaultProps` e nas mudanças do StrictMode do React 19.

**Impacto:** até 3 dias perdidos no Sprint 6 se estourar tarde.

**Mitigação:**
1. **Queime o risco cedo:** a Task 13, Step 9 renderiza um gráfico e verifica o build de produção. Se quebrar, você descobre no Sprint 5, não no 7.
2. **Plano B — Tremor Raw:** os componentes copy-paste do Tremor Raw são Recharts puro, sem o wrapper que causa os problemas. Migrar `TimeSeriesChart` e `SourceBreakdown` custa ~1 dia e **não toca em nenhuma outra task** — `ChartFrame`, `KpiCard`, as páginas e todos os testes continuam válidos, porque os testes verificam legenda, rótulos e tabela, nunca o SVG.

---

### R6 — Jest + ESM + TypeScript 🟡 MÉDIO (mas cedo)

**O que acontece:** todo o monorepo é ESM (`"type": "module"`, `NodeNext`), e o Jest roda em CJS via `@swc/jest`. Isso funciona porque `@modelcontextprotocol/sdk`, `ai` e `firebase-admin` publicam builds duais. Se qualquer dependência futura for **ESM-only**, o `require()` do Jest falha.

**Impacto:** baixo, porque é detectado imediatamente e a correção é conhecida.

**Mitigação:** a Task 1, Step 5 tem um teste cujo único propósito é importar o MCP SDK dentro do Jest. Se falhar, o problema aparece no dia 1. Correção quando surgir: adicionar o pacote ao `transformIgnorePatterns` do `jest.preset.cjs`; se ainda assim não resolver, mover **aquele pacote específico** para `--experimental-vm-modules` via `NODE_OPTIONS` no seu script de teste.

---

### R7 — Quota e sampling do GA4 🟡 MÉDIO

**O que acontece:** a GA4 Data API impõe quotas por propriedade (tokens por hora e por dia). Propriedades sem GA4 360 aplicam **sampling** em ranges longos ou com muitas dimensões, e o número devolvido não bate com a interface do GA4. Se o bot e a dashboard disserem números diferentes do que o cliente vê no Google, a confiança no produto acaba.

**Mitigação:**
- O cache com TTL longo para períodos passados (Task 9) reduz drasticamente o consumo de quota — cada intervalo fechado é consultado uma vez por dia por organização.
- O limite de 400 dias por query (Task 11) evita os ranges que mais disparam sampling.
- O smoke test da Task 7, Step 10 compara com a interface do GA4 e define ~2% como divergência aceitável. Acima disso, investigue antes de seguir.

---

### R8 — Alucinação numérica do agente 🟡 MÉDIO

**O que acontece:** o modelo responde com um número plausível sem chamar ferramenta, ou aplica aritmética própria sobre os resultados ("então a média diária foi…"). Um número errado entregue com confiança é pior do que um erro visível.

**Mitigação:**
- O system prompt (Task 21) proíbe explicitamente estimar e manda declarar indisponibilidade em vez de preencher lacuna.
- Toda chamada de ferramenta é registrada em `ToolCallLog` (Task 22) — dá para auditar qualquer resposta depois.
- Os critérios 1 e 3 da avaliação da Task 22, Step 5 verificam exatamente isso, e o script tem duas perguntas fora de escopo justamente para provocar o comportamento.

**Se persistir:** adicionar uma verificação pós-resposta que extrai números do texto e confirma que cada um aparece em algum resultado de ferramenta da mesma requisição. ~1 dia; só faça se a avaliação mostrar que é necessário.

---

### R9 — Contrato do Backend Proprietário 🟡 MÉDIO

**O que acontece:** a Task 6 assume que o backend expõe `/analytics/spend`, `/analytics/promotion-clicks`, `/analytics/orders` e `/promotions`, todos devolvendo linhas diárias `{ date, value, group }`. Se o backend não tem esses endpoints, alguém precisa construí-los — e esse alguém pode ser outro time.

**Mitigação:** validar o contrato **no Sprint 1**, não no Sprint 2. Se os endpoints não existem, o formato `SpendRow` foi escolhido para ser o mais barato possível de produzir (um `GROUP BY date` sobre a tabela que já existe). Se o backend devolver outro formato, a adaptação fica inteiramente em `packages/mcp-backend/src/client.ts` — nenhuma outra task muda.

---

### R10 — Vazamento entre tenants 🟢 BAIXO (mas catastrófico se ocorrer)

**O que acontece:** um usuário da organização A vê dados da organização B.

**Por que está baixo:** o desenho fecha os caminhos por construção, não por disciplina.
- O body de `/api/metrics/query` **não tem campo de tenant** — o cliente não tem onde escrever um.
- As ferramentas do agente recebem o tenant por closure (Task 20); o LLM não tem parâmetro para alterá-lo.
- A chave de cache inclui o `organizationId` em claro (Task 9).
- O worker recusa qualquer telefone não vinculado e verificado antes de chamar o agente (Task 24).

**Testes que guardam essa propriedade:** Task 11 ("injects the tenant from the token, never from the body"), Task 9 ("does not share cache between tenants"), Task 20 ("always injects the tenant from the closure"), Task 24 ("never calls the agent for an unknown phone"). **Se algum desses quatro testes for removido ou enfraquecido em code review, é um bloqueio de merge.**

---

# Backlog para Jira / Notion

Copie a tabela abaixo para o Notion (cola como tabela) ou salve como CSV para importar no Jira (Configurações → Sistema → Importação externa → CSV).

**Mapeamento de colunas no Jira:** `Epic` → Epic Link · `Task` → Summary · `Type` → Issue Type · `Estimate` → Original Estimate · `Depends On` → Blocked By · `Sprint` → Sprint.

| Epic | Key | Task | Type | Estimate | Sprint | Depends On | Definition of Done |
|---|---|---|---|---|---|---|---|
| Fase 0 · Fundação | CD-1 | Esqueleto do monorepo e preset de testes | Task | 1d | S1 | — | `pnpm --filter @center/shared test` passa, incluindo o teste que importa o MCP SDK dentro do Jest |
| Fase 0 · Fundação | CD-2 | Contratos de domínio em `@center/shared` | Task | 1d | S1 | CD-1 | 13 testes verdes; `MetricQuerySchema` rejeita query sem tenant |
| Fase 0 · Fundação | CD-3 | Infra local e schema Prisma | Task | 2d | S1 | CD-2 | `docker compose ps` healthy; migration `init` aplicada; `loadConfig` falha listando a variável ausente |
| Fase 1 · MCP | CD-4 | Toolkit de MCP server | Task | 2d | S2 | CD-2 | 7 testes via transporte in-memory; erro de provider vira `isError`, não crash |
| Fase 1 · MCP | CD-5 | Pool de clientes MCP | Task | 1,5d | S2 | CD-4 | Roteamento por prefixo testado; um server offline não derruba o catálogo |
| Fase 1 · MCP | CD-6 | MCP server do Backend Proprietário | Task | 2,5d | S2–S3 | CD-5, CD-R9 | 10 testes verdes + smoke test no MCP Inspector contra o backend real |
| Fase 1 · MCP | CD-7 | MCP server do GA4 | Task | 2,5d | S3 | CD-5 | 7 testes; smoke test com divergência ≤ 2% vs. interface do GA4 |
| Fase 1 · MCP | CD-8 | MCP server do Firebase | Task | 2,5d | S3–S4 | CD-5, CD-R3 | 7 testes; índices compostos deployados; smoke test com documento semeado |
| Fase 1 · MCP | CD-9 | `MetricGateway` com cache Redis | Task | 1,5d | S4 | CD-5 | TTL curto para range que inclui hoje, longo para passado; Redis fora do ar não derruba a query |
| Fase 2 · API | CD-10 | Fastify, auth e resolução de tenant | Task | 2d | S4 | CD-3 | 18 testes; e-mail inexistente e senha errada dão o mesmo 401 |
| Fase 2 · API | CD-11 | Rotas de métricas | Task | 2d | S4–S5 | CD-9, CD-10 | Tenant forjado no body é ignorado; falha upstream vira 502 |
| Fase 2 · API | CD-12 | Composition root, rate limit e seed | Task | 1,5d | S5 | CD-11 | Catálogo lista 11 métricas via curl; 2ª query idêntica é cache hit |
| Fase 3 · Web | CD-13 | Scaffold Vite + React 19 + Tailwind | Task | 1,5d | S5 | — | Build de produção contém `--viz-1` e `stroke-viz-1`; Tremor renderiza no React 19 |
| Fase 3 · Web | CD-14 | Cliente de API e hooks | Task | 2d | S5–S6 | CD-11, CD-13 | 18 testes com MSW; 401 limpa o token |
| Fase 3 · Web | CD-15 | Filtros sincronizados com a URL | Task | 2d | S6 | CD-14 | "mês passado" em janeiro cruza o ano; URL inválida cai no default |
| Fase 3 · Web | CD-16 | Componentes de gráfico | Task | 3d | S6 | CD-15 | Toggle de tabela funciona; legenda só com 2+ séries; inspeção visual nos dois temas |
| Fase 3 · Web | CD-17 | Páginas Overview e Promoções | Task | 2,5d | S6–S7 | CD-16 | Trocar período refaz a query; fonte desmarcada some da requisição |
| Fase 3 · Web | CD-18 | Autenticação na interface | Task | 1,5d | S7 | CD-17 | `/` redireciona para `/login` sem token; "Sair" limpa o cache do TanStack Query |
| Fase 4 · IA | CD-19 | Resolvedor de períodos em PT-BR | Task | 1,5d | S8 | CD-2 | 21 testes, incluindo bissexto e virada de ano |
| Fase 4 · IA | CD-20 | Ferramentas do agente | Task | 1,5d | S8 | CD-9, CD-19 | Tenant vem do closure; falha de ferramenta vira objeto de erro legível |
| Fase 4 · IA | CD-21 | Núcleo do agente | Task | 2d | S8 | CD-20 | 9 testes com `MockLanguageModelV2`, zero chamadas reais à API |
| Fase 4 · IA | CD-22 | Memória de conversa e avaliação | Task | 1,5d | S8 | CD-21 | Os 4 critérios da avaliação passam; `docs/agent-eval.md` versionado |
| Fase 5 · WhatsApp | CD-23 | Webhook verificado e idempotente | Task | 2d | S9 | CD-3, CD-R1 | Assinatura inválida = 401 sem enfileirar; `wamid` repetido não duplica |
| Fase 5 · WhatsApp | CD-24 | Fila, worker e envio | Task | 2d | S9 | CD-21, CD-23 | Falha de envio propaga para o BullMQ retentar; falha do agente ainda responde ao usuário |
| Fase 5 · WhatsApp | CD-25 | Vínculo telefone ↔ usuário | Task | 1,5d | S9 | CD-24 | Código expirado, usado e telefone tomado tratados; página de Configurações no ar |
| Fase 5 · WhatsApp | CD-26 | Composição final e validação E2E | Task | 1,5d | S9 | CD-25 | Os 6 passos do roteiro de aceite passam; número do bot bate com a dashboard |
| Fase 6 · Ops | CD-27 | CI e aquecimento de cache | Task | 1,5d | S10 | CD-26 | Pipeline verde em PR; warmup roda sem falha |
| Fase 6 · Ops | CD-28 | Empacotamento e deploy em staging | Task | 2d | S10 | CD-27 | `/health` responde no container; runbook de monitoramento escrito |
| Riscos | CD-R1 | ⚠️ Iniciar verificação do Meta Business | Spike | 0,5d | **S1** | — | Submissão feita, protocolo registrado. **Fazer no dia 1** |
| Riscos | CD-R3 | ⚠️ Definir a fonte de dados mobile | Spike | 0,5d | **S1** | — | Decisão registrada: rollups no Firestore, BigQuery ou GA4 |
| Riscos | CD-R9 | ⚠️ Validar contrato do Backend Proprietário | Spike | 0,5d | **S1** | — | Os 4 endpoints confirmados ou agendados com o time responsável |

**Totais:** 28 tasks de implementação (≈ 51 dias) + 3 spikes (1,5 dia) = **10 sprints + 1 de buffer**.

**As três spikes do Sprint 1 são o item mais importante desta tabela.** Nenhuma delas custa mais de meio dia, e as três protegem contra os riscos que podem estourar o cronograma (R1, R3, R9). Faça-as antes da CD-1.

---

## Ordem de execução recomendada

```
S1:  CD-R1 ‖ CD-R3 ‖ CD-R9  →  CD-1 → CD-2 → CD-3
S2:  CD-4 → CD-5 → CD-6
S3:  CD-6 → CD-7 → CD-8
S4:  CD-8 → CD-9 → CD-10
S5:  CD-11 → CD-12 → CD-13 → CD-14
S6:  CD-14 → CD-15 → CD-16 → CD-17
S7:  CD-17 → CD-18
S8:  CD-19 → CD-20 → CD-21 → CD-22
S9:  CD-23 → CD-24 → CD-25 → CD-26
S10: CD-27 → CD-28
S11: buffer
```

CD-13 e CD-14 (frontend) só dependem de CD-11 — se houver um segundo desenvolvedor, essa é a divisão natural: um segue na Fase 1/2, outro começa a Fase 3 a partir do Sprint 5.
