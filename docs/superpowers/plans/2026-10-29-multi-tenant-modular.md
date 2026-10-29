# Multi-tenant, módulos, back-office e conectores — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transformar o Center Dashboard num SaaS multi-tenant: módulos contratados por cliente, back-office da Blan, administração de usuários pelo Admin do cliente e e-commerce plugado por conectores (Uappi primeiro).

**Architecture:** Funções puras de acesso em `packages/entitlements` decidem o que cada usuário vê. A API lê do banco a cada requisição e aplica essas funções por **fonte** (rotas de dados e agente) ou por **módulo** (rotas de funcionalidade). Um plugin Fastify encapsulado em `/internal/*`, com autenticação própria de operador (senha + TOTP), atende o novo `apps/backoffice`. O sync passa por `packages/connectors`, que absorve `uappi-sync`.

**Tech Stack:** pnpm 9 + Turborepo, TypeScript ESM (NodeNext), Node 22, Fastify 5 (`@fastify/jwt` com namespace), Prisma 6 + PostgreSQL 16, Vercel AI SDK 5, React 19 + Vite 6 + Tailwind + TanStack Query, Jest + Testing Library + msw, `otplib` (TOTP), `qrcode` (QR no back-office).

**Spec:** [docs/superpowers/specs/2026-10-29-multi-tenant-modular-design.md](../specs/2026-10-29-multi-tenant-modular-design.md). Leia junto com este plano; as seções citadas como "§N" são dela.

## Global Constraints

- Node `>=22`, pnpm `9.15.0`, TypeScript ESM `NodeNext`, imports relativos com sufixo `.js`.
- Testes: Jest via `jest.preset.cjs`, arquivos em `**/__tests__/**/*.test.ts(x)`. Pacotes novos copiam o `jest.config.cjs` de um pacote irmão, com `coverageThreshold` global de 80.
- Ao mudar um pacote que outro importa, rode `pnpm --filter <pacote> build` antes dos testes do consumidor (o `turbo test` depende de `^build`).
- Chaves de módulo, exatamente nesta ordem de catálogo: `overview`, `products`, `acquisition`, `app_usage`, `quality`, `sprint`, `assistant`.
- Nomes exibidos: `Visão geral`, `Produtos`, `Aquisição`, `Uso do app`, `Qualidade`, `Sprint`, `Assistente de IA`.
- Tipos de integração: `COMMERCE`, `WEB_ANALYTICS`, `APP_ANALYTICS`, `PLAY_STORE`, `APP_STORE`, `SPRINT_BOARD`. Provedores: `UAPPI`, `GA4`, `GOOGLE_PLAY`, `APP_STORE_CONNECT`, `MONDAY`. Status: `PENDING`, `OK`, `ERROR`, `DISABLED`.
- Códigos de erro (campo `error` do corpo):
  - `module_not_available` (403), `organization_suspended` (403), `password_change_required` (403), `readonly_session` (403), `forbidden` (403);
  - `integration_pending` (409), `email_in_use` (409), `slug_in_use` (409), `last_admin` (409);
  - `cannot_deactivate_self` (400), `bad_request` (400), `unauthorized` (401), `not_found` (404), `upstream_error` (502).
- Validade dos tokens: cliente 12 h (atual), sessão de operador 8 h, desafio de MFA 5 min, cadastro de TOTP 10 min, visualização como cliente 30 min.
- Senhas novas ou provisórias: mínimo 12 caracteres, com hash scrypt (`apps/api/src/auth/password.ts`).
- Rate limit de 10/min em `/auth/login` (já existe), `/auth/password`, `/internal/auth/login` e `/internal/auth/totp`.
- Segredos só com `SecretBox` (`@center/secrets`). Nunca aparecem em resposta HTTP, log, `OperatorAuditLog.metadata` ou `TenantContext`.
- Permissões (módulos, papel, `active`, status do cliente) são lidas do banco a cada requisição. O papel que vale é o do banco, não o do token.
- Textos de interface e mensagens de erro em pt-BR. Dinheiro em centavos. Fuso `America/Sao_Paulo`.
- **Regra do projeto (CLAUDE.md): quem executa nunca faz commit.** Todo passo "Commit" deste plano é um **ponto de parada**: mostre os arquivos alterados e a saída dos testes, sugira a mensagem e espere o aceite do responsável, que faz o commit. Mensagens sugeridas no padrão `tipo(escopo): descrição`, numa branch `feature/multi-tenant-modular`.
- Nunca rode `prisma migrate reset` sem confirmação do responsável: ele apaga o banco local. Para aplicar migrações, use `prisma migrate deploy`. Testes que precisam de banco limpo usam o banco de teste do CI (`center_test`).

## Review Focus

1. **Token antigo depois de uma mudança.** Um token emitido antes de suspender um módulo, desativar ou rebaixar um usuário, ou suspender o cliente deve perder o acesso na **próxima requisição**. Testes nas Tarefas 7 e 8.
2. **E-mail já usado em outro cliente.** Criar um usuário com esse e-mail deve responder 409 `email_in_use` sem revelar qual cliente o usa. Testes nas Tarefas 10 e 14.
3. **Último Admin.** Rebaixar ou desativar o último Admin ativo, inclusive em duas requisições simultâneas, deve responder 409 `last_admin`. Teste na Tarefa 10.
4. **Vazamento de segredo.** Nenhuma resposta do back-office, linha de auditoria ou `TenantContext` pode conter a credencial decifrada ou o texto cifrado. Testes nas Tarefas 4, 12 e 14.
5. **Visão geral com fontes parciais.** Um usuário sem `acquisition` abre a Visão geral, e ela não pode pedir métricas `ga4.*` no lote, senão o lote inteiro recebe 403. Teste na Tarefa 16.

---

## Mapa de arquivos

```
packages/entitlements/                 NOVO  catálogo + funções puras de acesso
packages/connectors/                   NOVO  interface, registro, executor, persistência, conector Uappi
packages/uappi-sync/                   REMOVIDO (conteúdo vai para connectors)
apps/api/prisma/schema.prisma          tabelas novas; depois remoção das colunas antigas
apps/api/src/lib/slug.ts               NOVO  slugify
apps/api/src/integrations/             NOVO  schemas por tipo, leitura de estados, cifra de segredos
apps/api/src/authz/                    NOVO  principal, AccessContext, guards, gateway restrito
apps/api/src/routes/users.ts           NOVO  usuários do cliente (Admin)
apps/api/src/internal/                 NOVO  plugin /internal/*: auth de operador, clientes, módulos,
                                             integrações, usuários, auditoria, operadores, visualização
apps/api/scripts/migrate-to-multitenant.ts   NOVO  script de dados
apps/api/scripts/create-operator.ts          NOVO
apps/web/src/hooks/use-me.ts           NOVO  sessão (/auth/me)
apps/web/src/pages/{UsersPage,ChangePasswordPage,ViewSessionPage,NoModulesPage}.tsx  NOVOS
apps/backoffice/                       NOVO  console da Blan
```

---

# Fase 1 — Fundação

### Task 1: `packages/entitlements`

**Files:**
- Create: `packages/entitlements/package.json` (nome `@center/entitlements`, mesmo formato de `packages/pii/package.json`, dependência `@center/shared: workspace:*`)
- Create: `packages/entitlements/tsconfig.json`, `packages/entitlements/jest.config.cjs` (copiar de `packages/pii`)
- Create: `packages/entitlements/src/catalog.ts`, `src/access.ts`, `src/index.ts`
- Test: `packages/entitlements/src/__tests__/catalog.test.ts`, `src/__tests__/access.test.ts`

**Interfaces:**
- Produces (`catalog.ts`):
  ```ts
  export const MODULE_KEYS = ['overview','products','acquisition','app_usage','quality','sprint','assistant'] as const;
  export type ModuleKey = (typeof MODULE_KEYS)[number];
  export const INTEGRATION_KINDS = ['COMMERCE','WEB_ANALYTICS','APP_ANALYTICS','PLAY_STORE','APP_STORE','SPRINT_BOARD'] as const;
  export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];
  export interface ModuleDefinition {
    key: ModuleKey; label: string; menuPath: string | null;
    sources: readonly MetricSource[];   // o que o módulo libera
    requires: readonly MetricSource[];  // o que precisa estar pronto para o módulo ficar 'ready'
  }
  export const MODULES: readonly ModuleDefinition[];
  export function getModule(key: ModuleKey): ModuleDefinition;
  export function isModuleKey(value: string): value is ModuleKey;
  export const SOURCE_INTEGRATIONS: Record<MetricSource, readonly IntegrationKind[]>;
  ```
- Produces (`access.ts`):
  ```ts
  export interface ContractRow { moduleKey: string; status: 'ACTIVE' | 'SUSPENDED'; startsAt: Date; endsAt: Date | null }
  export interface IntegrationState { kind: IntegrationKind; status: 'PENDING' | 'OK' | 'ERROR' | 'DISABLED'; hasBigQueryDataset: boolean }
  export type SourceDecision = 'allowed' | 'forbidden' | 'pending';
  export function isContractInForce(contract: ContractRow, now: Date): boolean;
  export function visibleModules(input: { organizationActive: boolean; role: 'ADMIN' | 'MEMBER'; contracts: ContractRow[]; grants: string[]; now: Date }): ModuleKey[];
  export function allowedSources(modules: readonly ModuleKey[]): Set<MetricSource>;
  export function isSourceReady(source: MetricSource, integrations: readonly IntegrationState[]): boolean;
  export function moduleReadiness(key: ModuleKey, integrations: readonly IntegrationState[]): 'ready' | 'awaiting_setup';
  export function decideSource(source: MetricSource, modules: readonly ModuleKey[], integrations: readonly IntegrationState[]): SourceDecision;
  ```

Valores do catálogo:

| key | menuPath | sources | requires |
|---|---|---|---|
| overview | `/` | commerce | commerce |
| products | `/produtos` | commerce | commerce |
| acquisition | `/aquisicao` | ga4, behavior, commerce | ga4, commerce |
| app_usage | `/uso-do-app` | firebase | firebase |
| quality | `/qualidade` | quality | quality |
| sprint | `/sprint` | sprint | sprint |
| assistant | `null` | — | — |

Valores de `SOURCE_INTEGRATIONS`:

| Fonte | Integrações aceitas |
|---|---|
| commerce | COMMERCE |
| ga4 | WEB_ANALYTICS |
| behavior | WEB_ANALYTICS |
| firebase | APP_ANALYTICS |
| quality | PLAY_STORE, APP_STORE |
| sprint | SPRINT_BOARD |

`isSourceReady` exige `status === 'OK'`. Para `behavior`, exige também `hasBigQueryDataset`.

- [ ] **Step 1: Write the failing tests**

`catalog.test.ts`:
- `lists the seven modules in catalog order`: `MODULES.map(m => m.key)` é igual a `MODULE_KEYS`.
- `every requires is a subset of sources`.
- `isModuleKey rejects unknown keys`: `isModuleKey('billing') === false`.

`access.test.ts`, com `now = new Date('2026-11-01T12:00:00Z')`:
- `contract in force when active, started and not ended` → `true`.
- `contract ending exactly now is not in force` (`endsAt: now`) → `false`.
- `contract starting in the future is not in force` → `false`.
- `suspended contract is not in force` → `false`.
- `suspended organization sees nothing`: `visibleModules({ organizationActive: false, … })` → `[]`.
- `admin sees every in-force contract in catalog order`: contratos `['sprint','overview']` → `['overview','sprint']`.
- `member sees only granted modules that are in force`: contratos `overview`, `products`; grants `products`, `quality` → `['products']`.
- `unknown module keys in contracts are ignored`.
- `allowedSources unions the module sources`: `['products','acquisition']` → `{commerce, ga4, behavior}`; `['assistant']` → vazio.
- `decideSource forbidden when no visible module grants the source`.
- `decideSource pending when the integration exists but is not OK`.
- `quality is allowed with only APP_STORE OK`.
- `behavior is pending without BigQuery dataset`.
- `acquisition is ready without BigQuery dataset`: WEB_ANALYTICS OK sem dataset + COMMERCE OK → `'ready'`.
- `assistant is always ready`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @center/entitlements test`
Expected: FAIL, "Cannot find module '../catalog.js'".

- [ ] **Step 3: Implement `catalog.ts` and `access.ts`; re-export both from `index.ts`**

`visibleModules` percorre `MODULES` (preserva a ordem) e filtra. O `MetricSource` vem de `@center/shared`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm install && pnpm --filter @center/entitlements build && pnpm --filter @center/entitlements test -- --coverage`
Expected: PASS, cobertura ≥ 80%.

- [ ] **Step 5: Commit**

```bash
git add packages/entitlements pnpm-lock.yaml
git commit -m "feat(entitlements): catálogo de módulos e regras puras de acesso"
```

### Task 2: Schema multi-tenant (migração sem remoção)

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20261030000000_multitenant_foundation/migration.sql`
- Modify: `apps/api/src/auth/jwt.ts` (tipo `role`) e todo uso de `'VIEWER'` (`grep -rn "VIEWER" apps packages --include=*.ts*`)
- Test: `apps/api/src/__tests__/prisma-schema.test.ts`, `apps/api/src/__tests__/migration-sql.test.ts` (novo)

**Interfaces:**
- Produces (Prisma):
  - **Enums:**
    - `Role { ADMIN MEMBER }`
    - `OrganizationStatus { ACTIVE SUSPENDED }`
    - `ModuleStatus { ACTIVE SUSPENDED }`
    - `ModuleOrigin { MANUAL PLAN BILLING }`
    - `IntegrationKind`, `IntegrationProvider` e `IntegrationStatus`, com os valores das Global Constraints
  - **`Organization`:** `+ status OrganizationStatus @default(ACTIVE)`, `+ slug String? @unique`. Fica opcional até a Task 21.
  - **`User`:** `+ mustChangePassword Boolean @default(false)`, `+ active Boolean @default(true)`; o padrão de `role` passa a ser `MEMBER`.
  - **`PlatformOperator`:** `id`, `email @unique`, `name`, `passwordHash`, `totpSecret String?` (cifrado), `totpEnabledAt DateTime?`, `active Boolean @default(true)`, `lastLoginAt DateTime?`, `createdAt`.
  - **`OrganizationModule`:**
    - `id`, `organizationId`, `moduleKey String`;
    - `status ModuleStatus @default(ACTIVE)`, `startsAt DateTime @default(now())`, `endsAt DateTime?`;
    - `origin ModuleOrigin @default(MANUAL)`, `updatedByOperatorId String?`;
    - `createdAt`, `updatedAt @updatedAt`;
    - `@@unique([organizationId, moduleKey])`.
  - **`UserModuleAccess`:** `id`, `userId`, `moduleKey`, `grantedByUserId String?`, `createdAt`, `@@unique([userId, moduleKey])`, com cascade a partir de `User`.
  - **`Integration`:**
    - `id`, `organizationId`, `kind`, `provider`;
    - `config Json @default("{}")`, `secrets String?`, `secretsUpdatedAt DateTime?`;
    - `status IntegrationStatus @default(PENDING)`, `lastCheckAt DateTime?`, `lastError String?`;
    - `createdAt`, `updatedAt`;
    - `@@unique([organizationId, kind])`.
  - **`OperatorAuditLog`:**
    - `id`, `operatorId` (FK `Restrict`), `action String`;
    - `organizationId String?` (sem FK, para sobreviver à exclusão do cliente), `targetType String?`, `targetId String?`;
    - `metadata Json @default("{}")`, `ip String?`, `userAgent String?`, `createdAt`;
    - `@@index([organizationId, createdAt])`, `@@index([operatorId, createdAt])`.
  - **`Message`:** `+ model String?`, `+ inputTokens Int?`, `+ outputTokens Int?`.
  - **`WhatsAppIdentity`, `LinkCode`, `ProcessedWebhookEvent`:** ganham o comentário `/// Não usado no MVP (WhatsApp fora do escopo desde 2026-10-29).`
- Produces (TS): `AuthPayload.role: 'ADMIN' | 'MEMBER'`.

- [ ] **Step 1: Write the failing tests**

`prisma-schema.test.ts`, novos casos:
- `keeps one integration per organization and kind`: `Integration` contém `@@unique([organizationId, kind])`.
- `keeps one contract per organization and module`.
- `Role enum has MEMBER and no VIEWER`.
- `platform operators are a separate model and User has no operator flag`: `model PlatformOperator` existe; o corpo de `User` não casa com `/superadmin|operator|isPlatform/i`.
- `Integration has no plaintext credential columns`: o corpo não casa com `/apiKey|secretKey|token\s+String/i`.

`migration-sql.test.ts` lê `migrations/20261030000000_multitenant_foundation/migration.sql` e verifica:
- `renames VIEWER to MEMBER in place`: contém `ALTER TYPE "Role" RENAME VALUE 'VIEWER' TO 'MEMBER'`;
- `makes the audit log append-only`: contém `BEFORE UPDATE OR DELETE ON "OperatorAuditLog"`;
- `drops nothing`: não contém `DROP COLUMN` nem `DROP TABLE`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @center/api test -- src/__tests__/prisma-schema.test.ts src/__tests__/migration-sql.test.ts`
Expected: FAIL.

- [ ] **Step 3: Edit the schema and create the migration**

Gere o esqueleto com `pnpm --filter @center/api exec prisma migrate dev --create-only --name multitenant_foundation` e renomeie a pasta para `20261030000000_multitenant_foundation`. Depois **edite o SQL**:

1. Troque o trecho que o Prisma gera para o enum `Role` (ele recria o tipo) por:

```sql
ALTER TYPE "Role" RENAME VALUE 'VIEWER' TO 'MEMBER';
ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'MEMBER';
```

2. Acrescente ao final:

```sql
CREATE FUNCTION operator_audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'OperatorAuditLog é somente inserção';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER operator_audit_log_no_change
  BEFORE UPDATE OR DELETE ON "OperatorAuditLog"
  FOR EACH ROW EXECUTE FUNCTION operator_audit_log_append_only();
```

Depois troque `'VIEWER'` por `'MEMBER'` nos tipos e testes encontrados pelo `grep`.

- [ ] **Step 4: Apply and verify**

Run:
- `pnpm --filter @center/api exec prisma migrate deploy`
- `pnpm --filter @center/api exec prisma generate`
- `pnpm --filter @center/api test`
- `pnpm -w typecheck`

Expected:
- a migração aplica sem erro;
- todos os testes passam;
- o typecheck fica limpo.

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma apps/api/src
git commit -m "feat(db): tabelas de operador, módulos, integrações e auditoria"
```

### Task 3: Script de dados `migrate-to-multitenant`

**Files:**
- Create: `apps/api/src/lib/slug.ts`
- Create: `apps/api/scripts/lib/migrate-to-multitenant.ts`, `apps/api/scripts/migrate-to-multitenant.ts`
- Modify: `apps/api/package.json` (script `migrate:multitenant`: `node dist/scripts/migrate-to-multitenant.js`)
- Test: `apps/api/src/__tests__/slug.test.ts`, `apps/api/scripts/__tests__/migrate-to-multitenant.test.ts`

**Interfaces:**
- Consumes: `MODULE_KEYS` (Task 1); `SecretBox` (`@center/secrets`).
- Produces:
  ```ts
  // src/lib/slug.ts
  export function slugify(name: string): string;  // minúsculas, sem acento, [a-z0-9-], vazio → 'cliente'
  // scripts/lib/migrate-to-multitenant.ts
  export interface LegacyOrgRow { id: string; name: string; slug: string | null;
    uappiApiKey: string | null; uappiSecretKey: string | null; statusMapping: unknown;
    ga4PropertyId: string | null; ga4BigQueryDataset: string | null; ga4AppPropertyId: string | null;
    playConsoleCredsJson: string | null; appStoreConnectKeyJson: string | null; mondayBoardId: string | null }
  export interface IntegrationWrite { kind: IntegrationKind; provider: string; config: Record<string, unknown>; secrets: string | null }
  export function planIntegrations(org: LegacyOrgRow, box: SecretBox): { writes: IntegrationWrite[]; warnings: string[] };
  export interface MigrationReport { organizations: number; integrationsCreated: number; integrationsSkipped: number; modulesCreated: number; grantsCreated: number; warnings: string[] }
  export async function migrateToMultiTenant(prisma: PrismaClient, box: SecretBox): Promise<MigrationReport>;
  ```

**Regras do script:**
- **Leitura das colunas antigas:** é feita com `prisma.$queryRaw`, não pelo client tipado, para continuar compilando depois da Task 21. Antes de ler, o script consulta `information_schema.columns`. Sem a coluna `uappiApiKey`, `planIntegrations` não roda, e o script só preenche slug, módulos e acessos.
- **Integrações que já existem:** se já há uma linha para (cliente, `kind`), o script não a altera e conta em `integrationsSkipped`.
- **Status:** as integrações migradas entram com `status: 'OK'`, porque já funcionavam.
- **Mapeamento de cada campo:**

| Campos antigos | Integração | config | secrets (JSON cifrado) |
|---|---|---|---|
| `uappiApiKey` e `uappiSecretKey` (os dois preenchidos) | COMMERCE / UAPPI | `statusMapping`, se houver | `{ apiKey, secretKey }` |
| `ga4PropertyId` | WEB_ANALYTICS / GA4 | `{ propertyId, bigQueryDataset? }` | — |
| `ga4AppPropertyId` | APP_ANALYTICS / GA4 | `{ propertyId }` | — |
| `playConsoleCredsJson` | PLAY_STORE / GOOGLE_PLAY | `{}` | `{ credentialsJson }` |
| `appStoreConnectKeyJson` | APP_STORE / APP_STORE_CONNECT | `{}` | `{ keyJson }` |
| `mondayBoardId` | SPRINT_BOARD / MONDAY | `{ boardId }` | — |

- **Monday:** o `mondayApiToken` antigo é ignorado e gera um aviso ("o token do Monday agora é global: defina MONDAY_API_TOKEN").
- **Falha ao decifrar:** quando um valor antigo não decifra (dado gravado em claro pelo `prisma/seed.ts` antigo), o script gera um aviso com o nome do campo, sem o valor, e pula aquela integração.
- **Módulos:** `organizationModule.createMany({ skipDuplicates: true })` com as 7 chaves e `origin: 'MANUAL'`.
- **Acessos:** cada usuário `MEMBER` ganha `userModuleAccess.createMany` das 7 chaves, com `skipDuplicates`.
- **Slug:** só quando é nulo. Usa `slugify(name)`; se já existir, acrescenta `-2`, `-3` e assim por diante.

- [ ] **Step 1: Write the failing tests**

`slug.test.ts`:
- `'Loja de Desenvolvimento'` → `'loja-de-desenvolvimento'`;
- `'Ação & Cia.'` → `'acao-cia'`;
- `'!!!'` → `'cliente'`.

`migrate-to-multitenant.test.ts`, com `SecretBox` de chave fixa e Prisma falso com `jest.fn`:
- `plans a COMMERCE integration with both secrets in one encrypted JSON`: `JSON.parse(box.decrypt(write.secrets))` é igual a `{ apiKey: 'k', secretKey: 's' }`.
- `skips commerce when only one Uappi key is set`.
- `warns about the Monday token without leaking it`: o aviso não contém o valor do token.
- `warns and skips a field that does not decrypt`.
- `does not overwrite an existing integration`: com uma linha `COMMERCE` existente, `integration.create` não é chamado para `COMMERCE`.
- `is idempotent`: na segunda execução sobre o mesmo estado, `integrationsCreated === 0`.
- `skips integration planning when legacy columns are gone`: `information_schema` vazio → `planIntegrations` não roda, módulos e acessos ainda rodam.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @center/api test -- src/__tests__/slug.test.ts scripts/__tests__/migrate-to-multitenant.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the functions and the thin entry script** (a entrada carrega a config, cria `PrismaClient` e `SecretBox`, imprime o `MigrationReport` como JSON)

- [ ] **Step 4: Run tests and a real run**

Run:
- `pnpm --filter @center/api test -- scripts/__tests__/migrate-to-multitenant.test.ts`
- com o `.env` carregado: `pnpm --filter @center/api build && node apps/api/dist/scripts/migrate-to-multitenant.js`, rodado **duas vezes**.

Expected:
- os testes passam;
- a primeira execução cria as integrações, módulos e acessos;
- a segunda execução imprime `"integrationsCreated":0`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib apps/api/scripts apps/api/package.json
git commit -m "feat(api): script idempotente de migração para multi-tenant"
```

# Fase 2 — Integrações e conectores

### Task 4: Leitura via `Integration` (tenant, status no painel)

**Files:**
- Create: `apps/api/src/integrations/kinds.ts`, `apps/api/src/integrations/repository.ts`
- Modify: `apps/api/src/tenant.ts`, `apps/api/src/routes/settings.ts`
- Modify: `apps/web/src/lib/api-client.ts` (remove `IntegrationsUpdate` e `updateIntegrations`; troca `IntegrationsView`), `apps/web/src/pages/SettingsPage.tsx`
- Create: `apps/web/src/components/settings/IntegrationStatusList.tsx`
- Delete: `apps/web/src/components/settings/IntegrationCredentialsForm.tsx` e `apps/web/src/__tests__/integration-credentials-form.test.tsx`
- Test: `apps/api/src/__tests__/tenant.test.ts`, `settings-routes.test.ts` (reescrito), `integrations-repository.test.ts` (novo), `apps/web/src/__tests__/integration-status-list.test.tsx` (novo)

**Interfaces:**
- Consumes: `IntegrationKind`, `IntegrationState` (Task 1).
- Produces:
  ```ts
  // kinds.ts
  export const IntegrationConfigSchemas: {
    WEB_ANALYTICS: z.ZodObject<{ propertyId: /^\d+$/; bigQueryDataset?: string(min 1) }>;
    APP_ANALYTICS: { propertyId: /^\d+$/ }; PLAY_STORE: { packageName: string(min 1) };
    APP_STORE: { appId: string(min 1) }; SPRINT_BOARD: { boardId: string(min 1) };
  };  // COMMERCE é validado pelo conector (Task 5)
  export const IntegrationSecretSchemas: { PLAY_STORE: { credentialsJson: string(min 1) }; APP_STORE: { keyJson: string(min 1) } };
  export const ALLOWED_PROVIDERS: Record<IntegrationKind, IntegrationProvider>;  // COMMERCE→UAPPI, WEB/APP→GA4, PLAY→GOOGLE_PLAY, APP_STORE→APP_STORE_CONNECT, SPRINT→MONDAY
  // repository.ts
  export async function loadIntegrationStates(prisma: PrismaClient, organizationId: string): Promise<IntegrationState[]>;
  export function encryptSecrets(box: SecretBox, value: Record<string, unknown>): string;
  export function decryptSecrets(box: SecretBox, ciphertext: string | null): Record<string, unknown> | null;
  ```
- `resolveTenant(prisma, organizationId)` mantém a assinatura e passa a ler das integrações `WEB_ANALYTICS` e `APP_ANALYTICS` com `status !== 'DISABLED'`, gerando `ga4PropertyId`, `ga4BigQueryDataset` e `ga4AppPropertyId`.
- `GET /api/settings/integrations`, só para Admin:
  - responde `{ integrations: Array<{ kind: IntegrationKind; provider: string; status: IntegrationStatus; lastSyncedAt: string | null }> }`;
  - `lastSyncedAt` vem de `SyncState(resource 'orders')` apenas para `COMMERCE`; nos outros tipos é `null`.
- `PUT /api/settings/integrations` é removida e passa a responder 404.

- [ ] **Step 1: Write the failing tests**

`tenant.test.ts`:
- `reads GA4 ids from integrations`;
- `omits a DISABLED integration`;
- `never includes secrets`: com `secrets: 'v1:…'` na linha, `JSON.stringify(tenant)` não contém `'v1:'`.

`settings-routes.test.ts`:
- `MEMBER gets 403`;
- `returns kind, provider, status and lastSyncedAt only`: `Object.keys(item)` é exatamente `['kind','provider','status','lastSyncedAt']`;
- `PUT is gone (404)`.

`integrations-repository.test.ts`:
- `hasBigQueryDataset reflects config`;
- `encrypt/decrypt round-trips`.

`integration-status-list.test.tsx`:
- `shows "Conectada", "Com erro" and "Aguardando configuração" for OK, ERROR and PENDING`;
- `shows the last sync date`;
- `renders no credential inputs`: `screen.queryByRole('textbox')` é nulo.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @center/api test -- src/__tests__/tenant.test.ts src/__tests__/settings-routes.test.ts src/__tests__/integrations-repository.test.ts && pnpm --filter @center/web test -- integration-status-list`
Expected: FAIL.

- [ ] **Step 3: Implement** the API files, then the web list. Rótulos: OK → "Conectada", ERROR → "Com erro", PENDING → "Aguardando configuração", DISABLED → "Desativada". Nomes dos tipos: COMMERCE → "Loja (e-commerce)", WEB_ANALYTICS → "Google Analytics do site", APP_ANALYTICS → "Analytics do app", PLAY_STORE → "Google Play", APP_STORE → "App Store", SPRINT_BOARD → "Board do Monday".

- [ ] **Step 4: Run tests to verify they pass**

Run: os mesmos comandos do Step 2, depois `pnpm -w typecheck`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/web/src
git commit -m "feat(api,web): integrações lidas da tabela Integration; painel mostra só status"
```

### Task 5: `packages/connectors` (absorve `uappi-sync`)

**Files:**
- Create: `packages/connectors/package.json` (`@center/connectors`; deps `@center/shared`, `@center/pii`, `@center/uappi-client`, `@prisma/client`, `zod`), `tsconfig.json`, `jest.config.cjs`
- Create: `packages/connectors/src/types.ts`, `src/registry.ts`, `src/runner.ts`, `src/index.ts`
- Move (`git mv`): `packages/uappi-sync/src/persist.ts` → `packages/connectors/src/persist.ts`; `mapper.ts`, `schemas.ts`, `status-map.ts` → `packages/connectors/src/uappi/`; `packages/uappi-sync/src/__tests__/*` → `packages/connectors/src/__tests__/`. O `sync.test.ts` vira `runner.test.ts`.
- Create: `packages/connectors/src/uappi/connector.ts`
- Delete: `packages/uappi-sync/`
- Modify: `packages/mcp-commerce/package.json` e os imports dos testes (`@center/uappi-sync` → `@center/connectors`); `apps/api/package.json`; `apps/api/src/sync/sync-worker-main.ts` (só os imports; a lógica muda na Task 6); `Dockerfile` (estágio `deps`: troque a linha de `uappi-sync` por `connectors` e acrescente `entitlements`)
- Test: `packages/connectors/src/__tests__/uappi-connector.test.ts` (novo), `runner.test.ts` (movido e adaptado), os demais movidos

**Interfaces:**
- Consumes: `UappiClientLike`, `UappiClient`, `MockUappiClient`, `UappiCredentials`, `UappiApiError` (`@center/uappi-client`); `Pseudonymizer` (`@center/pii`).
- Produces:
  ```ts
  // types.ts
  export type CommerceProvider = 'UAPPI';
  export interface DateWindow { from: string; to: string }               // YYYY-MM-DD
  export interface ReadContext { pseudonymizer: Pseudonymizer; logger: (message: string, meta?: Record<string, unknown>) => void }
  export interface CanonicalOrderRecord { kind: 'order'; order: MappedOrder; items: MappedOrderItem[] }  // MappedOrder/Item continuam definidos em uappi/mapper.ts e são re-exportados
  export interface ReadFailure { kind: 'failure'; reference: string; error: string }
  export type CheckResult = { ok: true } | { ok: false; error: string };
  export interface CommerceConnector<TSettings = unknown> {
    provider: CommerceProvider;
    parseSettings(config: unknown, secrets: unknown): TSettings;   // lança ZodError
    check(settings: TSettings): Promise<CheckResult>;
    discover(): readonly ['orders'];
    readOrders(settings: TSettings, window: DateWindow, ctx: ReadContext): AsyncIterable<CanonicalOrderRecord | ReadFailure>;
  }
  // uappi/connector.ts
  export interface UappiSettings { credentials: UappiCredentials; statusOverrides: Record<string, string> | null }
  export function createUappiConnector(opts: { baseUrl: string; mock: boolean; buildClient?: (c: UappiCredentials) => UappiClientLike }): CommerceConnector<UappiSettings>;
  // registry.ts
  export interface ConnectorRegistry { get(provider: CommerceProvider): CommerceConnector }
  export function createConnectorRegistry(opts: { uappiBaseUrl: string; mock: boolean }): ConnectorRegistry;
  // runner.ts — mesma semântica de runIncrementalSync de hoje
  export const SYNC_RESOURCE = 'orders'; export const DEFAULT_OVERLAP_DAYS = 3; export const DEFAULT_BACKFILL_DAYS = 90;
  export interface RunSyncDeps { prisma: PrismaClient; connector: CommerceConnector; settings: unknown; pseudonymizer: Pseudonymizer; organizationId: string; now?: () => Date; logger?: ReadContext['logger'] }
  export interface SyncResult { ordersProcessed: number; ordersFailed: number; from: string; to: string }
  export async function runCommerceSync(deps: RunSyncDeps, options?: { overlapDays?: number; backfillDays?: number }): Promise<SyncResult>;
  ```

Comportamento:
- **`parseSettings` da Uappi:**
  - `secrets` precisa ser `{ apiKey: string(min 1), secretKey: string(min 1) }`;
  - `config` é `{ statusMapping?: Record<string, string> }`.
- **`check` da Uappi:**
  - em modo mock, sempre `{ ok: true }`;
  - fora do mock, chama `listOrders` para a primeira página do dia atual em `America/Sao_Paulo`;
  - `UappiApiError` com status 401 ou 403 → `{ ok: false, error: 'credenciais recusadas pela Uappi' }`;
  - qualquer outra falha → `{ ok: false, error: 'Uappi indisponível' }`.
- **`readOrders`:** é o laço atual de `syncWindow`. Um resumo sem `numeroPedido` ou um detalhe que falha vira `ReadFailure` em vez de interromper a leitura.
- **`runCommerceSync`:**
  - mantém `recordSuccess` e `recordFailure` de hoje;
  - grava com `persistOrder`;
  - conta cada `ReadFailure` em `ordersFailed`.
- **Construção do cliente:** igual à de hoje em `sync-worker-main.ts`, com `MockUappiClient` quando `mock` e `UappiClient` caso contrário.

- [ ] **Step 1: Move the files, then write the failing tests**

`uappi-connector.test.ts`:
- `parseSettings rejects missing secretKey`;
- `check is ok in mock mode`;
- `check maps a 401 to "credenciais recusadas pela Uappi"` (com `buildClient` que lança `new UappiApiError(401, '…')`);
- `readOrders yields a failure for a summary without numeroPedido and keeps going`;
- `records contain only hashed customer fields`: nenhuma chave do registro casa com `/^(email|documento|cpf|clientId)$/`.

`runner.test.ts`: os casos do antigo `sync.test.ts`, chamando `runCommerceSync` com `createUappiConnector({ mock: true, … })`, mais `counts ReadFailure as ordersFailed without moving the cursor on total failure`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm install && pnpm --filter @center/connectors test`
Expected: FAIL (connector e runner ainda não existem).

- [ ] **Step 3: Implement types, connector, registry, runner, index**

- [ ] **Step 4: Run the whole suite**

Run: `pnpm -w build && pnpm --filter @center/connectors test -- --coverage && pnpm --filter @center/mcp-commerce test && pnpm -w typecheck`
Expected: PASS, cobertura ≥ 80%, nenhuma referência a `@center/uappi-sync` (`grep -rn "uappi-sync" apps packages --include=*.ts --include=*.json` vazio, fora de `node_modules`).

- [ ] **Step 5: Commit**

```bash
git add -A packages apps/api/package.json apps/api/src/sync Dockerfile pnpm-lock.yaml
git commit -m "refactor(connectors): interface de conector e Uappi como primeiro conector"
```

### Task 6: Sync pelo `Integration` e seeds no modelo novo

**Files:**
- Modify: `apps/api/src/sync/scheduler.ts`, `apps/api/src/sync/sync-worker-main.ts`
- Modify: `apps/api/prisma/seed.ts`, `apps/api/scripts/lib/seed-demo.ts`, `apps/api/scripts/seed-demo.ts`
- Test: `apps/api/src/__tests__/sync-scheduler.test.ts`, `apps/api/scripts/__tests__/seed-demo.test.ts`

**Interfaces:**
- Consumes: `ConnectorRegistry`, `runCommerceSync` (Task 5); `decryptSecrets`, `encryptSecrets` (Task 4).
- Produces:
  ```ts
  export interface SchedulerDeps { prisma: PrismaClient; config: AppConfig; pseudonymizer: Pseudonymizer; secretBox: SecretBox; connectors: ConnectorRegistry; logger?: …; now?: () => Date }
  export async function syncAllOrganizations(deps: SchedulerDeps): Promise<SchedulerReport>;  // SchedulerReport inalterado
  // seed-demo
  export function planDemoIntegrations(existing: Array<{ kind: IntegrationKind }>, box: SecretBox): IntegrationWrite[];  // substitui planIntegrationWrite/shouldSetUappiCredentials/shouldSetField
  ```

Regras do scheduler:
- **Integrações elegíveis:** `kind = COMMERCE`, `status != DISABLED`, `secrets != null` e `organization.status = ACTIVE`. São processadas em sequência, como hoje.
- **Configuração inválida:** se `parseSettings` lança, a integração fica com `status: 'ERROR'` e `lastError: 'configuração inválida'`, e entra em `failed`.
- **Sucesso:** se o status não era `OK`, passa a ser `OK`, e `lastError` volta a `null`.
- **Exceção no sync:** `status: 'ERROR'` e `lastError` com a mensagem do erro. As outras organizações continuam.

Regras dos seeds:
- **`prisma/seed.ts`** cria `org_dev` com:
  - `slug: 'loja-de-desenvolvimento'`;
  - os 7 módulos;
  - o usuário `admin@center.local` como ADMIN.

  Só cria a integração COMMERCE se `SEED_UAPPI_API_KEY` e `SEED_UAPPI_SECRET_KEY` existirem. Nesse caso, os segredos são cifrados com `SecretBox(process.env.CREDENTIALS_ENCRYPTION_KEY)`.
- **`seed-demo`** grava as 6 integrações com as constantes `DEMO_*` atuais, todas com `status: 'OK'`:
  - COMMERCE com os segredos cifrados;
  - WEB_ANALYTICS com `propertyId` e `bigQueryDataset`;
  - APP_ANALYTICS;
  - PLAY_STORE com `packageName: 'com.demo.loja'`;
  - APP_STORE com `appId: 'demo-app'`;
  - SPRINT_BOARD com `boardId`.

  Também garante os 7 módulos e não sobrescreve integração existente. Em seguida, sincroniza com `runCommerceSync`.

- [ ] **Step 1: Write the failing tests**

`sync-scheduler.test.ts`:
- `skips suspended organizations`;
- `skips DISABLED integrations`;
- `one failing organization does not stop the next`;
- `marks ERROR with "configuração inválida" when parseSettings throws`;
- `promotes PENDING to OK after a successful run`.

`seed-demo.test.ts`:
- `plans all six kinds when nothing exists`;
- `never re-plans an existing kind`;
- `commerce secrets decrypt to the demo keys`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @center/api test -- src/__tests__/sync-scheduler.test.ts scripts/__tests__/seed-demo.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Verify end to end in mock mode**

Run:
- `pnpm --filter @center/api exec prisma migrate deploy`
- `pnpm -w build`
- dentro de `apps/api`, com o `.env` carregado e `MOCK_EXTERNAL_APIS="true"`: `pnpm db:seed && node dist/scripts/seed-demo.js`

Expected:
- `seed-demo` imprime as mesmas contagens do README (15 pedidos, 20 itens, 14 clientes, R$ 3.947,10);
- os testes do Step 1 passam.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(sync): sync por integração COMMERCE e seeds no modelo multi-tenant"
```

# Fase 3 — API do cliente: autenticação e autorização

### Task 7: Autenticação do cliente lida do banco

**Files:**
- Create: `apps/api/src/authz/principal.ts`
- Modify: `apps/api/src/auth/jwt.ts`, `apps/api/src/auth/routes.ts`, `apps/api/src/server.ts`, e todo `preHandler: requireAuth` em `apps/api/src/routes/*.ts` e `apps/api/src/whatsapp/link-routes.ts`
- Test: `apps/api/src/__tests__/auth-routes.test.ts`, `apps/api/src/__tests__/client-auth-guard.test.ts` (novo)

**Interfaces:**
- Produces:
  ```ts
  export interface AuthPayload { userId: string; organizationId: string; role: 'ADMIN' | 'MEMBER'; viewedBy?: string }
  export interface Principal { userId: string; organizationId: string; role: 'ADMIN' | 'MEMBER'; viewedBy: string | null; mustChangePassword: boolean }
  declare module 'fastify' {
    interface FastifyRequest { auth: Principal }
    interface FastifyInstance { authenticate: preHandlerAsyncHookHandler }
    interface FastifyContextConfig { readonlySafe?: boolean; allowDuringPasswordChange?: boolean }
  }
  export function makeAuthenticate(prisma: PrismaClient): preHandlerAsyncHookHandler;  // em authz/principal.ts
  ```
- O registro do `@fastify/jwt` em `server.ts` ganha `sign: { aud: 'client' }` e `verify: { allowedAud: 'client' }`.
- `server.ts` passa a fazer `app.decorate('authenticate', makeAuthenticate(deps.prisma))`, e as rotas trocam `requireAuth` por `app.authenticate`. O `requireAdmin` continua, lendo `request.auth.role`.

Ordem das checagens em `makeAuthenticate`:
1. `request.jwtVerify()` falha → 401 `unauthorized`.
2. **Token com `viewedBy`** (sessão de visualização):
   - se o cliente não está `ACTIVE` → 403 `organization_suspended`;
   - se a rota não tem `config.readonlySafe` → 403 `readonly_session`;
   - senão, a requisição segue com o principal `{ role: 'ADMIN', mustChangePassword: false, viewedBy }`, e o acesso é registrado com `request.log.info({ viewedBy, organizationId, url }, 'view_session_request')`.
3. **Token de usuário:** carrega `User` (`active`, `role`, `mustChangePassword`) e o `status` do cliente.
   - usuário inexistente ou `!active` → 401 `unauthorized`;
   - cliente não `ACTIVE` → 403 `organization_suspended`;
   - `mustChangePassword` numa rota sem `config.allowDuringPasswordChange` → 403 `password_change_required`.
4. `request.auth` recebe o principal. O `role` vem **do banco**.

Mudanças nas rotas de autenticação:
- **`/auth/login`:**
  - usuário `!active` responde o mesmo 401 de senha errada;
  - cliente suspenso, com senha certa, responde 403 `organization_suspended`;
  - a resposta inclui `user.mustChangePassword`.
- **`POST /auth/password`** (novo):
  - corpo `{ currentPassword, newPassword }`, `newPassword` com no mínimo 12 caracteres, rate limit de 10/min, `allowDuringPasswordChange`;
  - senha atual errada → 401;
  - em caso de sucesso, grava o hash, zera `mustChangePassword` e responde 204.
- **`/auth/me`:** ganha `allowDuringPasswordChange` e `readonlySafe`. A resposta muda na Task 8.

- [ ] **Step 1: Write the failing tests** (`client-auth-guard.test.ts`, com Prisma falso cujas linhas os testes alteram entre requisições)
- `rejects a token signed with aud=operator` → 401.
- `deactivated user with a still-valid token gets 401`: loga, marca `active: false` no falso e chama `/api/metrics/catalog` → 401.
- `token issued before suspension gets 403 organization_suspended`.
- `role comes from the database`: o token diz ADMIN, o banco diz MEMBER, e `GET /api/settings/integrations` → 403.
- `mustChangePassword blocks data routes but not /auth/me`: catálogo → 403 `password_change_required`; `/auth/me` → 200.
- `view session token gets 403 readonly_session on a route without readonlySafe` (token assinado com `viewedBy: 'op_1'`).

Em `auth-routes.test.ts`:
- `deactivated user login gets the same body as a wrong password` (os dois `res.json()` são iguais);
- `suspended organization login returns 403 organization_suspended`;
- `POST /auth/password rejects a wrong current password (401) and a short new one (400)`;
- `POST /auth/password clears mustChangePassword`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @center/api test -- src/__tests__/client-auth-guard.test.ts src/__tests__/auth-routes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `makeAuthenticate`, the login and password changes, and swap the preHandlers**

- [ ] **Step 4: Run the full API suite**

Run: `pnpm --filter @center/api test && pnpm -w typecheck`
Expected: PASS. Ajuste os Prisma falsos dos testes antigos para devolver `active: true` e `organization.status: 'ACTIVE'`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src
git commit -m "feat(auth): estado do usuário e do cliente lido do banco a cada requisição"
```

### Task 8: Acesso por fonte, gateway restrito e `/auth/me`

**Files:**
- Create: `apps/api/src/authz/access.ts`, `apps/api/src/authz/guards.ts`, `apps/api/src/authz/scoped-gateway.ts`
- Modify: `apps/api/src/routes/metrics.ts`, `apps/api/src/routes/analysis.ts`, `apps/api/src/auth/routes.ts`
- Test: `apps/api/src/__tests__/scoped-gateway.test.ts`, `apps/api/src/__tests__/module-access.test.ts` (novo), `metrics-routes.test.ts`, `auth-routes.test.ts`

**Interfaces:**
- Consumes: `visibleModules`, `allowedSources`, `decideSource`, `moduleReadiness`, `getModule` (Task 1); `loadIntegrationStates` (Task 4); `Principal` (Task 7); `sourceOf` (`@center/mcp-core`).
- Produces:
  ```ts
  // access.ts
  export interface AccessContext { organizationId: string; role: 'ADMIN' | 'MEMBER'; modules: ModuleKey[]; sources: Set<MetricSource>; integrations: IntegrationState[] }
  export async function loadAccess(prisma: PrismaClient, principal: Principal, now: Date): Promise<AccessContext>;
  // guards.ts
  export async function getAccess(request: FastifyRequest, prisma: PrismaClient): Promise<AccessContext>;  // memoiza em request
  export function requireModule(key: ModuleKey, prisma: PrismaClient): preHandlerAsyncHookHandler;  // 403 module_not_available | 409 integration_pending
  export function replyForDecision(reply: FastifyReply, decision: SourceDecision): FastifyReply | null;  // null = allowed
  // scoped-gateway.ts
  export type MetricGatewayLike = Pick<MetricGateway, 'listMetrics' | 'queryMetric' | 'queryBatch' | 'callTool'>;
  export class SourceNotAllowedError extends Error { readonly source: MetricSource }
  export function scopeGateway(gateway: MetricGatewayLike, sources: ReadonlySet<MetricSource>): MetricGatewayLike;
  ```
- Corpos fixos de recusa:
  - `{ error: 'module_not_available', message: 'módulo não disponível para este usuário' }`;
  - `{ error: 'integration_pending', message: 'integração ainda não configurada pela equipe Blan' }`.
- **`loadAccess`:**
  - para a sessão de visualização, usa `grants = []` e `role = 'ADMIN'`;
  - para Membros, lê `UserModuleAccess`;
  - lê sempre `OrganizationModule` e `loadIntegrationStates`.
- **Rotas** (todas `readonlySafe: true`):

| Rota | Checagem |
|---|---|
| `GET /api/metrics/catalog` | `scopeGateway(...).listMetrics()` (filtra por `descriptor.source`) |
| `POST /api/metrics/query` | `decideSource(sourceOf(metricId))`; um `sourceOf` que lança → 400 |
| `POST /api/metrics/batch` | qualquer `forbidden` → 403; senão, qualquer `pending` → 409; em ambos os casos o gateway não é chamado |
| `POST /api/tools/:source/:name` | `decideSource(source)`, depois da validação de allowlist que já existe |
| `POST /api/analysis/correlate` | as duas fontes (`forbidden` vence `pending`) |
| `POST /api/analysis/app-version-impact` | `requireModule('app_usage')` |

- **`GET /auth/me`** responde:
  ```ts
  { user: { id, name, email, role, mustChangePassword },
    organization: { id, name },
    modules: Array<{ key, label, menuPath, state: 'ready' | 'awaiting_setup' }>,
    sources: MetricSource[],
    viewSession: boolean }
  ```
  Na sessão de visualização, `user` é `{ id: auth.userId, name: 'Equipe Blan (visualização)', email: '', role: 'ADMIN', mustChangePassword: false }`.

- [ ] **Step 1: Write the failing tests**

`scoped-gateway.test.ts`:
- `throws SourceNotAllowedError before calling the inner gateway`: o `callTool` interno não é chamado;
- `listMetrics drops descriptors of other sources`;
- `queryBatch rejects when any query is outside the set`.

`module-access.test.ts`, com Prisma falso de contratos, acessos e integrações:
- `member without the products grant gets 403 on a commerce tool although products is contracted`;
- `403 body is identical for not-contracted and not-granted`;
- `module past endsAt is absent from /auth/me and its source is 403`;
- `contracted acquisition without WEB_ANALYTICS returns 409 integration_pending on a ga4 query`;
- `suspending a module takes effect on the next request with the same token`;
- `batch with one forbidden source returns 403 and calls the gateway zero times`;
- `correlate commerce×ga4 needs both sources`;
- `app-version-impact needs app_usage`;
- `/auth/me lists modules with state and the sources array`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @center/api test -- src/__tests__/scoped-gateway.test.ts src/__tests__/module-access.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the full API suite**

Run: `pnpm --filter @center/api test && pnpm -w typecheck`
Expected: PASS. Os testes antigos de `metrics-routes` ganham contratos de todos os módulos e integrações `OK` no Prisma falso.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src
git commit -m "feat(authz): autorização por fonte, gateway restrito e módulos em /auth/me"
```

### Task 9: Agente restrito aos módulos e consumo de tokens

**Files:**
- Modify: `apps/api/src/agent/tools.ts`, `apps/api/src/agent/agent.ts`, `apps/api/src/agent/system-prompt.ts`, `apps/api/src/agent/memory.ts`, `apps/api/src/routes/agent.ts`, `apps/api/src/analysis/app-version-impact.ts` e `packages/mcp-core/src/correlate.ts` (tipo do gateway → `MetricGatewayLike`, se pedirem a classe)
- Modify: `apps/api/scripts/eval-agent.ts` (passa acesso total)
- Test: `apps/api/src/__tests__/agent-tools.test.ts`, `agent.test.ts`, `agent-routes.test.ts`

**Interfaces:**
- Consumes: `scopeGateway`, `SourceNotAllowedError`, `MetricGatewayLike`, `requireModule`, `getAccess` (Task 8); `getModule` (Task 1).
- Produces:
  ```ts
  export interface AgentToolContext { gateway: MetricGatewayLike; tenant: TenantContext; today: string;
    access: { modules: readonly ModuleKey[]; sources: ReadonlySet<MetricSource> }; onToolCall?: … }
  export const TOOL_SOURCES: Record<string, readonly MetricSource[]>;
  // listar_metricas [], consultar_metrica [], correlacionar [], ranking ['commerce','ga4'],
  // funil_de_compra ['ga4'], comparar_periodos ['commerce','ga4'],
  // caminho_ate_a_compra ['behavior'], impacto_da_tela ['behavior'], impacto_da_versao [] + módulo app_usage
  export interface AgentInput { …; access: AgentToolContext['access'] }
  export interface AgentUsage { model: string; inputTokens: number | null; outputTokens: number | null }
  export interface AgentResult { reply: string; toolCalls: AgentToolCall[]; usage: AgentUsage }
  export function buildSystemPrompt(today: string, moduleLabels: readonly string[]): string;
  export interface AppendExchangeParams { …; usage?: AgentUsage }
  ```

Regras:
- **Quando a ferramenta é oferecida:** se `TOOL_SOURCES[name]` está vazio ou ao menos uma das fontes está liberada. `impacto_da_versao` exige também `app_usage` nos módulos.
- **Opções do `ranking`:** o enum só contém as entradas de `RANKINGS` cuja `source` está liberada. Sem nenhuma, a ferramenta não é oferecida.
- **Gateway restrito:** `runAgent` recebe o gateway já restrito.
- **Erro de fonte não liberada:** `SourceNotAllowedError` conta como erro seguro em `isSafeToShareWithModel`, com a mensagem exata `'dado não disponível para esta conta'`.
- **System prompt:**
  - troca "respondendo por WhatsApp" por "respondendo no painel";
  - acrescenta um bloco `MÓDULOS DISPONÍVEIS: <labels separados por vírgula>`;
  - acrescenta a regra: "Se perguntarem sobre algo fora desses módulos, diga que esse conteúdo não está disponível nesta conta."
- **`usage`:** vem de `result.usage.inputTokens`, `result.usage.outputTokens` e `result.response.modelId` do `generateText`. O que vier `undefined` vira `null`.
- **Rota do agente:** `preHandler: [app.authenticate, requireModule('assistant', deps.prisma)]`. Sem `readonlySafe`.

- [ ] **Step 1: Write the failing tests**

`agent-tools.test.ts`:
- `omits ranking options from sources the user cannot see`;
- `does not offer caminho_ate_a_compra without behavior`;
- `does not offer impacto_da_versao without app_usage`;
- `consultar_metrica on a hidden source returns the unavailable message`: a saída da ferramenta contém `'dado não disponível para esta conta'`.

`agent.test.ts`:
- `system prompt lists only the given module labels`;
- `returns usage from the model response` (via `MockLanguageModelV2` com `usage`).

`agent-routes.test.ts`:
- `POST /api/agent/ask without the assistant module → 403 module_not_available`;
- `stores model and token usage on the assistant message`: o `message.create` do assistente recebe `inputTokens`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @center/api test -- src/__tests__/agent-tools.test.ts src/__tests__/agent.test.ts src/__tests__/agent-routes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run with coverage** (o `apps/api` mede cobertura de `src/agent/**`)

Run: `pnpm --filter @center/api test -- --coverage && pnpm -w typecheck`
Expected: PASS, limiar de 80% mantido.

- [ ] **Step 5: Commit**

```bash
git add apps/api packages/mcp-core
git commit -m "feat(agent): ferramentas e gateway restritos aos módulos; consumo de tokens"
```

### Task 10: Usuários do cliente (Admin)

**Files:**
- Create: `apps/api/src/routes/users.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/src/__tests__/users-routes.test.ts`

**Interfaces:**
- Consumes: `requireAdmin`, `app.authenticate` (Task 7); `getAccess` (Task 8); `isModuleKey`, `isContractInForce` (Task 1); `hashPassword`.
- Produces: rotas, todas com `[app.authenticate, requireAdmin]` e sem `readonlySafe`.

| Rota | Corpo | Resposta |
|---|---|---|
| `GET /api/users` | — | `Array<{ id, name, email, role, active, mustChangePassword, modules: ModuleKey[] }>` (o Admin aparece com `modules` = todos os visíveis) |
| `POST /api/users` | `{ name, email, role, temporaryPassword(min 12), modules: ModuleKey[] }` | 201 + usuário; `mustChangePassword: true` |
| `PATCH /api/users/:id` | `{ name?, role?, active?, modules? }` | 200 + usuário |
| `POST /api/users/:id/reset-password` | `{ temporaryPassword(min 12) }` | 204; `mustChangePassword: true` |

Regras:
- **Isolamento:** um usuário de outro cliente → 404 `not_found`.
- **E-mail:** se já existe em **qualquer** cliente → 409 `{ error: 'email_in_use', message: 'e-mail já cadastrado' }`.
- **Módulos:** precisam ser chaves válidas **e** contratos em vigor do cliente. Caso contrário → 400 `bad_request` com a mensagem `módulo não contratado: <key>`.
- **Troca de módulos:** `modules` substitui o conjunto (`deleteMany` + `createMany`), com `grantedByUserId = request.auth.userId`.
- **Auto-desativação:** `active: false` no próprio usuário → 400 `cannot_deactivate_self`.
- **Último Admin:** rebaixar ou desativar o último ADMIN ativo → 409 `last_admin`. A contagem e a escrita acontecem dentro de `prisma.$transaction(…, { isolationLevel: 'Serializable' })`.

- [ ] **Step 1: Write the failing tests**
- `MEMBER gets 403`;
- `returns 404 for a user of another organization`;
- `email used in another organization returns 409 without naming it`: o corpo é exatamente `{ error: 'email_in_use', message: 'e-mail já cadastrado' }`;
- `cannot grant a module the organization has not contracted`;
- `cannot deactivate self`;
- `last admin cannot be demoted or deactivated`;
- `PATCH modules replaces the grant set`;
- `reset-password sets mustChangePassword`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @center/api test -- src/__tests__/users-routes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement and register in `server.ts`**

- [ ] **Step 4: Run tests to verify they pass**

Run: o mesmo comando do Step 2, depois `pnpm -w typecheck`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src
git commit -m "feat(api): Admin do cliente gerencia usuários e módulos de cada Membro"
```

### Task 11: Configuração, CORS e limpeza do WhatsApp

**Files:**
- Modify: `apps/api/src/config.ts`, `apps/api/src/server.ts`, `apps/api/src/main.ts`, `apps/api/src/routes/attribution.ts`, `apps/api/src/whatsapp/worker-main.ts`, `.env.example`, `docker-compose.prod.yml`
- Test: `apps/api/src/__tests__/config.test.ts`, `apps/api/src/__tests__/cors.test.ts` (novo), `attribution-routes.test.ts`, `static-spa.test.ts`, `apps/api/src/__tests__/helpers/config.ts`

**Interfaces:**
- Produces (`AppConfig`):
  - `whatsapp: { … } | null`: fica `null` se qualquer `WHATSAPP_*` estiver vazia;
  - `operatorJwtSecret: string` (`OPERATOR_JWT_SECRET`, mínimo de 32 caracteres e diferente de `JWT_SECRET`);
  - `panelOrigin: string` (`PANEL_ORIGIN`, URL, padrão `http://localhost:5173`);
  - `backofficeOrigin: string` (`BACKOFFICE_ORIGIN`, URL, padrão `http://localhost:5174`);
  - `mondayApiToken: string` (`MONDAY_API_TOKEN`, padrão `''`).

Regras:
- **CORS:** `@fastify/cors` com `delegator`:
  - caminho começando com `/public` → `origin: true`, porque o script de atribuição roda no site da loja;
  - caminho começando com `/internal` → `origin: [backofficeOrigin]`;
  - demais caminhos → `origin: [panelOrigin]`.
- **Rotas desligadas:** `server.ts` deixa de registrar `registerLinkRoutes`. A linha comentada do webhook continua comentada e ganha uma referência ao design.
- **SPA:** `RESERVED_PREFIXES` ganha `'/internal'`.
- **`mcp-firebase`:** passa a receber também `GA4_CREDENTIALS_JSON`.
- **`worker-main.ts`:** com `config.whatsapp === null`, imprime `WhatsApp desativado: variáveis WHATSAPP_* ausentes` e sai com código 0.
- **Atribuição:** um cliente com `status !== 'ACTIVE'` recebe a mesma resposta 404 de um cliente desconhecido.
- **`docker-compose.prod.yml`:** o serviço `whatsapp` ganha `profiles: ["whatsapp"]`.
- **`.env.example`:** ganha as 4 variáveis novas, e as `WHATSAPP_*` ficam marcadas como opcionais.

- [ ] **Step 1: Write the failing tests**

`config.test.ts`:
- `loads without WHATSAPP_* and sets whatsapp to null`;
- `rejects OPERATOR_JWT_SECRET equal to JWT_SECRET`.

`cors.test.ts`, com `OPTIONS` + `Origin`:
- `/internal/auth/login` permite `backofficeOrigin` e não o `panelOrigin`;
- `/api/metrics/catalog` permite `panelOrigin` e não o `backofficeOrigin`;
- `/public/attribution` permite qualquer origem.

`attribution-routes.test.ts`:
- `suspended organization gets the unknown-organization 404`.

`static-spa.test.ts`:
- `GET /internal/whatever returns JSON 404, not index.html`.

Em qualquer teste de rota existente:
- `POST /api/whatsapp/link-code returns 404`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @center/api test -- src/__tests__/config.test.ts src/__tests__/cors.test.ts src/__tests__/attribution-routes.test.ts src/__tests__/static-spa.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** (atualize `helpers/config.ts` com os campos novos)

- [ ] **Step 4: Run the full suite**

Run: `pnpm --filter @center/api test && pnpm -w typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api .env.example docker-compose.prod.yml
git commit -m "chore(api): CORS por área, variáveis novas e WhatsApp opcional"
```

# Fase 4 — API do back-office (`/internal/*`)

### Task 12: Autenticação de operador, TOTP, auditoria e `create-operator`

**Files:**
- Create: `apps/api/src/internal/plugin.ts`, `internal/auth/routes.ts`, `internal/auth/totp.ts`, `internal/auth/guard.ts`, `internal/audit.ts`
- Create: `apps/api/scripts/lib/create-operator.ts`, `apps/api/scripts/create-operator.ts`
- Modify: `apps/api/src/server.ts` (`await registerInternal(app, deps)`), `apps/api/package.json` (dep `otplib@^12.0.1`; script `create:operator`), `apps/api/prisma/seed.ts` (operador de dev `operator@center.local` / `center-dev-123`, sem TOTP)
- Test: `apps/api/src/__tests__/internal-auth.test.ts`, `apps/api/src/__tests__/audit.test.ts`, `apps/api/scripts/__tests__/create-operator.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // plugin.ts — escopo encapsulado com prefixo /internal
  export async function registerInternal(app: FastifyInstance, deps: AppDeps): Promise<void>;
  //   dentro: scope.register(jwt, { secret: deps.config.operatorJwtSecret, namespace: 'operator',
  //     jwtVerify: 'operatorJwtVerify', jwtSign: 'operatorJwtSign',
  //     sign: { aud: 'operator' }, verify: { allowedAud: 'operator' } })
  export interface OperatorPayload { operatorId: string; stage: 'enroll' | 'mfa' | 'session' }
  declare module 'fastify' { interface FastifyRequest { operator: { id: string; email: string; name: string } } }
  // guard.ts
  export function makeRequireOperator(prisma: PrismaClient): preHandlerAsyncHookHandler;  // stage 'session' + operador ativo, senão 401
  // totp.ts
  export function generateTotpSecret(): string;
  export function totpUri(email: string, secret: string): string;   // issuer 'Center Back-office'
  export function verifyTotp(code: string, secret: string): boolean; // janela de 1 passo
  // audit.ts
  export type AuditAction =
    | 'operator.login' | 'operator.create' | 'operator.deactivate'
    | 'organization.create' | 'organization.update' | 'organization.suspend' | 'organization.reactivate'
    | 'module.activate' | 'module.update' | 'module.suspend'
    | 'integration.upsert' | 'integration.check' | 'integration.disable'
    | 'user.create_admin' | 'user.deactivate' | 'user.reset_password'
    | 'view_session.start';
  export async function recordAudit(prisma: PrismaClient, request: FastifyRequest, entry: {
    action: AuditAction; organizationId?: string; targetType?: string; targetId?: string; metadata?: Record<string, unknown> }): Promise<void>;
  // scripts/lib/create-operator.ts
  export async function createOperator(prisma, input: { email: string; name: string; password: string }): Promise<{ id: string }>;  // senha < 12 ou e-mail repetido → lança
  ```

**`recordAudit`:**
- grava `operatorId` (de `request.operator.id`), `ip` e `user-agent`;
- antes de gravar, remove de `metadata` toda chave que case com `/secret|password|apikey|token|credential/i`.

**`POST /internal/auth/login`** (`{ email, password }`, 10/min):
- e-mail inexistente, senha errada ou operador inativo → o mesmo 401, pagando o custo de `DUMMY_HASH`;
- sem `totpEnabledAt`:
  - gera um segredo e grava cifrado em `totpSecret`, substituindo um segredo pendente;
  - responde `{ stage: 'enroll', token, otpauthUri, secret }`, com `token` de estágio `enroll` válido por 10 min;
- com TOTP já ativo: responde `{ stage: 'mfa', token }`, com estágio `mfa` válido por 5 min.

**`POST /internal/auth/totp`** (`{ token, code }`, 10/min):
- valida o token com `scope.jwt.operator.verify` e exige estágio `enroll` ou `mfa`;
- confere o código contra o segredo decifrado;
- se o estágio era `enroll`, grava `totpEnabledAt`;
- grava `lastLoginAt` e audita `operator.login`;
- responde `{ token, operator: { id, name, email } }`, com `token` de sessão válido por 8 h;
- código errado → 401 `unauthorized`, e o TOTP continua desligado se o estágio era `enroll`.

**`GET /internal/auth/me`:** exige `requireOperator` e devolve o operador.

- [ ] **Step 1: Write the failing tests** (códigos de TOTP gerados com `authenticator.generate(secret)` do `otplib`)

`internal-auth.test.ts`:
- `client token is rejected on /internal/auth/me with 401`;
- `operator session token is rejected on /api/metrics/catalog with 401`;
- `mfa-stage token cannot call /internal/auth/me`;
- `first login returns enroll; wrong code keeps TOTP disabled; right code enables it and returns a session`;
- `second login returns mfa and accepts a valid code`;
- `inactive operator gets the same 401 body as a wrong password`;
- `session token expires in 8h`: `exp - iat === 28800`.

`audit.test.ts`:
- `drops secret-looking metadata keys`: com `metadata: { kind: 'COMMERCE', apiKey: 'x', secretsChanged: true }`, grava `{ kind: 'COMMERCE', secretsChanged: true }`.

`create-operator.test.ts`:
- `refuses a password shorter than 12`;
- `refuses a duplicate email`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @center/api test -- src/__tests__/internal-auth.test.ts src/__tests__/audit.test.ts scripts/__tests__/create-operator.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the full suite**

Run: `pnpm install && pnpm --filter @center/api test && pnpm -w typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api pnpm-lock.yaml
git commit -m "feat(internal): login de operador com TOTP, auditoria e create-operator"
```

### Task 13: Clientes e módulos no back-office

**Files:**
- Create: `apps/api/src/internal/organizations.ts`, `apps/api/src/internal/modules.ts`
- Modify: `apps/api/src/internal/plugin.ts`
- Test: `apps/api/src/__tests__/internal-organizations.test.ts`

**Interfaces:**
- Consumes: `makeRequireOperator`, `recordAudit` (Task 12); `slugify` (Task 3); `isModuleKey`, `isContractInForce`, `moduleReadiness`, `MODULE_KEYS` (Task 1); `loadIntegrationStates` (Task 4).
- Produces: rotas, todas com `requireOperator`:

| Rota | Corpo | Resposta / regra |
|---|---|---|
| `GET /internal/organizations` | — | `Array<{ id, name, slug, status, createdAt, modules: Array<{ key, status, startsAt, endsAt, inForce }>, pendingSetup: ModuleKey[] }>` |
| `POST /internal/organizations` | `{ name, slug? }` | 201; slug ausente → `slugify(name)`; slug existente → 409 `slug_in_use`; audita `organization.create` |
| `GET /internal/organizations/:id` | — | o item da lista + `usersCount` + `attribution: { organizationId, apiUrl: config.panelOrigin }` |
| `PATCH /internal/organizations/:id` | `{ name?, status? }` | audita `organization.update`, `organization.suspend` ou `organization.reactivate` |
| `PUT /internal/organizations/:id/modules/:key` | `{ status, startsAt?, endsAt?: string \| null }` | faz upsert; chave desconhecida → 404; `endsAt <= startsAt` → 400; grava `updatedByOperatorId`; audita `module.activate` (criação), `module.update` ou `module.suspend` |

- [ ] **Step 1: Write the failing tests**
- `lists organizations with pendingSetup for in-force modules awaiting setup`;
- `creates with a slug derived from the name and 409 on duplicate`;
- `unknown module key → 404`;
- `endsAt before startsAt → 400`;
- `module upsert writes updatedByOperatorId and an audit row with organizationId`;
- `suspend writes organization.suspend`;
- `client token gets 401 on every route here`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @center/api test -- src/__tests__/internal-organizations.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run tests to verify they pass**

Run: o mesmo comando do Step 2.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src
git commit -m "feat(internal): cadastro de clientes e ativação manual de módulos"
```

### Task 14: Integrações, usuários, auditoria e operadores no back-office

**Files:**
- Create: `apps/api/src/internal/integrations.ts`, `internal/users.ts`, `internal/audit-routes.ts`, `internal/operators.ts`
- Modify: `apps/api/src/internal/plugin.ts`, `apps/api/src/deps.ts` (`connectors: ConnectorRegistry`), `apps/api/src/main.ts` (cria o registro)
- Test: `apps/api/src/__tests__/internal-integrations.test.ts`, `internal-users.test.ts`, `internal-audit.test.ts`

**Interfaces:**
- Consumes: `ConnectorRegistry` (Task 5); `IntegrationConfigSchemas`, `IntegrationSecretSchemas`, `ALLOWED_PROVIDERS`, `encryptSecrets`, `decryptSecrets` (Task 4); `recordAudit` (Task 12); `createOperator` (Task 12).
- Produces: rotas, todas com `requireOperator`.

**Integrações:**
- `IntegrationView`:
  ```ts
  { kind, provider, config, status, lastCheckAt, lastError,
    secretsConfigured: boolean, secretsUpdatedAt,
    lastSyncedAt?, syncError?, serviceAccountEmail? }
  ```
- Rotas:
  - `GET /internal/organizations/:id/integrations`;
  - `PUT /internal/organizations/:id/integrations/:kind` com `{ provider, config, secrets? }`;
  - `POST …/:kind/check`;
  - `POST …/:kind/disable`.
- Regras do `PUT`:
  - provider diferente de `ALLOWED_PROVIDERS[kind]` → 400;
  - `secrets` ausente mantém o texto cifrado atual; presente, recifra e grava `secretsUpdatedAt`;
  - **COMMERCE:** `parseSettings(config, secrets ?? decryptSecrets(atual))`, cujo erro vira 400. Depois roda `check`, que grava `status` (`OK` ou `ERROR`), `lastCheckAt` e `lastError`;
  - **demais tipos:** valida com o schema do tipo e grava `status: 'OK'`;
  - audita `integration.upsert` com `metadata: { kind, provider, secretsChanged }`.
- `check` só vale para COMMERCE; para os outros tipos responde 400 com a mensagem "sem verificação automática para este tipo".
- `serviceAccountEmail` é o `client_email` de `GA4_CREDENTIALS_JSON` (WEB) ou de `GA4_APP_CREDENTIALS_JSON`, com fallback para o primeiro (APP). JSON vazio ou inválido → `null`.
- `lastSyncedAt` e `syncError` vêm de `SyncState` e só existem para COMMERCE.

**Usuários:**
- `GET /internal/organizations/:id/users` → `Array<{ id, name, email, role, active, mustChangePassword }>`;
- `POST /internal/organizations/:id/users` com `{ name, email, temporaryPassword }`:
  - cria um ADMIN com `mustChangePassword: true`;
  - e-mail já usado em qualquer cliente → 409 `email_in_use`;
  - audita `user.create_admin`;
- `POST /internal/users/:id/deactivate` → audita `user.deactivate`;
- `POST /internal/users/:id/reset-password` com `{ temporaryPassword }` → audita `user.reset_password`.

**Auditoria:**
- `GET /internal/audit?organizationId&operatorId&action&before&limit`;
- `limit` padrão 50, máximo 100;
- ordena por `createdAt` decrescente;
- `before` é um ISO de `createdAt` usado como cursor.

**Operadores:**
- `GET /internal/operators`;
- `POST /internal/operators` com `{ email, name, password }` → audita `operator.create`;
- `POST /internal/operators/:id/deactivate`: desativar a si mesmo → 400 `cannot_deactivate_self`; audita `operator.deactivate`.

- [ ] **Step 1: Write the failing tests**

`internal-integrations.test.ts`:
- `response never contains decrypted or encrypted secrets`: depois de um `PUT` com `secrets: { apiKey: 'demo-key-123', secretKey: 'demo-secret-456' }`, `JSON.stringify(body)` não contém `demo-key-123`, `demo-secret-456` nem `v1:`;
- `PUT without secrets keeps the existing ciphertext` (o `update` não recebe `secrets`);
- `COMMERCE check failure stores ERROR and lastError`;
- `wrong provider for kind → 400`;
- `audit metadata has secretsChanged and no secret`;
- `serviceAccountEmail comes from the credentials JSON`;
- `check on WEB_ANALYTICS → 400`.

`internal-users.test.ts`:
- `creates an ADMIN with mustChangePassword`;
- `email in another organization → 409 email_in_use`.

`internal-audit.test.ts`:
- `limit is capped at 100`;
- `filters by organizationId`;
- `operator cannot deactivate self`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @center/api test -- src/__tests__/internal-integrations.test.ts src/__tests__/internal-users.test.ts src/__tests__/internal-audit.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run tests to verify they pass**

Run: os mesmos comandos do Step 2, depois `pnpm --filter @center/api test && pnpm -w typecheck`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src
git commit -m "feat(internal): integrações com segredo só de escrita, usuários, auditoria e operadores"
```

### Task 15: Visualização como cliente

**Files:**
- Create: `apps/api/src/internal/view-session.ts`
- Modify: `apps/api/src/internal/plugin.ts`
- Test: `apps/api/src/__tests__/internal-view-session.test.ts`

**Interfaces:**
- Consumes: o principal com `viewedBy` (Task 7); `readonlySafe` nas rotas de dados (Task 8); `recordAudit` (Task 12).
- Produces: `POST /internal/organizations/:id/view-session` → `{ token, url, expiresAt }`.
  - O token é assinado com o JWT de **cliente** (`app.jwt.sign`): `{ userId: 'operator:<operatorId>', organizationId, role: 'ADMIN', viewedBy: operatorId }`, válido por 30 min.
  - `url` é `${config.panelOrigin}/view-session#${token}`.
  - Cliente inexistente → 404.
  - Audita `view_session.start`.

- [ ] **Step 1: Write the failing tests**
- `token works on /api/metrics/catalog`;
- `token gets 403 readonly_session on POST /api/users and POST /api/agent/ask`;
- `/auth/me returns viewSession: true and the Blan display name`;
- `expires in 30 minutes`: `exp - iat === 1800`;
- `writes view_session.start with the organizationId`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @center/api test -- src/__tests__/internal-view-session.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run tests to verify they pass**

Run: o mesmo comando do Step 2.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src
git commit -m "feat(internal): visualização do painel como cliente, somente leitura"
```

# Fase 5 — Painel do cliente (`apps/web`)

### Task 16: Sessão, menu por módulo e visualização

**Files:**
- Create: `apps/web/src/hooks/use-me.ts`, `apps/web/src/components/layout/RequireModule.tsx`, `apps/web/src/components/layout/AwaitingSetup.tsx`, `apps/web/src/pages/NoModulesPage.tsx`, `apps/web/src/pages/ViewSessionPage.tsx`
- Modify: `apps/web/src/lib/api-client.ts` (`getMe`, tipos `MeView`, `ModuleView`), `apps/web/src/App.tsx`, `apps/web/src/components/layout/AppShell.tsx`, `apps/web/src/components/layout/RequireAuth.tsx`, `apps/web/src/pages/OverviewPage.tsx`
- Test: `apps/web/src/__tests__/app-shell.test.tsx`, `require-module.test.tsx`, `view-session.test.tsx` (novos), `overview-page.test.tsx`

**Interfaces:**
- Consumes: o formato de `GET /auth/me` (Task 8).
- Produces:
  ```ts
  export interface ModuleView { key: string; label: string; menuPath: string | null; state: 'ready' | 'awaiting_setup' }
  export interface MeView { user: { id: string; name: string; email: string; role: 'ADMIN' | 'MEMBER'; mustChangePassword: boolean };
    organization: { id: string; name: string }; modules: ModuleView[]; sources: MetricSource[]; viewSession: boolean }
  export function useMe(): UseQueryResult<MeView, ApiError>;  // queryKey ['me']
  export function RequireModule(props: { moduleKey: string; children: ReactNode }): JSX.Element;
  ```

Comportamento:
- **Menu (`AppShell`):**
  - um item para cada módulo com `menuPath`, na ordem recebida;
  - "Usuários" (`/usuarios`) e "Configurações" só para ADMIN e fora da visualização;
  - `AssistantWidget` só quando há `assistant` e não é visualização.
- **Rotas de módulo:** cada uma é envolvida por `RequireModule`. Módulo ausente → `<Navigate to="/" />`. Módulo em `awaiting_setup` → `<AwaitingSetup label=… />`, com o texto "A equipe Blan está configurando as integrações deste módulo." e sem disparar nenhuma consulta de dados.
- **Rota `/`:**
  - com `overview` visível, renderiza a Visão geral;
  - senão, `<Navigate>` para o primeiro `menuPath` visível;
  - sem nenhum módulo, `NoModulesPage`: "Nenhum módulo liberado para você. Fale com o administrador da sua conta."
- **Visão geral:**
  - o lote de KPIs só inclui métricas cujo prefixo está em `me.sources`;
  - os cards de "Outros módulos" (`firebase`, `quality`, `sprint`) só aparecem com o módulo correspondente.
- **`useMe` com erro 403 `organization_suspended`:** mostra "O acesso desta conta está suspenso. Fale com a Blan." com um botão Sair.
- **`/view-session` (fora do `RequireAuth`):**
  - lê `location.hash`, grava o token e chama `history.replaceState` para tirar o token da URL;
  - navega para `/`.
- **Faixa da visualização:** com `me.viewSession`, `AppShell` mostra uma faixa fixa "Visualização da equipe Blan — somente leitura" e o botão "Encerrar visualização", que faz logout.

- [ ] **Step 1: Write the failing tests** (msw para `/auth/me`)

`app-shell.test.tsx`:
- `menu shows only modules returned by /auth/me`;
- `Usuários and Configurações only for ADMIN`;
- `assistant widget hidden without assistant module`;
- `view session shows the read-only banner and hides Usuários, Configurações and the assistant`.

`require-module.test.tsx`:
- `awaiting_setup renders the setup notice and fires no data request` (o handler msw de `/api/metrics/batch` não é chamado);
- `member without overview lands on the first visible module`;
- `no modules → NoModulesPage`.

`overview-page.test.tsx`:
- `without acquisition the batch has no ga4 metrics`.

`view-session.test.tsx`:
- `stores the token and removes it from the URL`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @center/web test -- app-shell require-module view-session overview-page`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the web suite with coverage**

Run: `pnpm --filter @center/web test -- --coverage && pnpm --filter @center/web typecheck`
Expected: PASS, limiar de 80% mantido.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): menu e rotas por módulo, aguardando configuração e visualização"
```

### Task 17: Usuários e troca de senha no painel

**Files:**
- Create: `apps/web/src/pages/UsersPage.tsx`, `apps/web/src/components/users/UserForm.tsx`, `apps/web/src/pages/ChangePasswordPage.tsx`
- Modify: `apps/web/src/lib/api-client.ts` (`listUsers`, `createUser`, `updateUser`, `resetUserPassword`, `changePassword`), `apps/web/src/App.tsx` (`/usuarios` e `/trocar-senha`), `apps/web/src/components/layout/RequireAuth.tsx`
- Test: `apps/web/src/__tests__/users-page.test.tsx`, `change-password-page.test.tsx`

**Interfaces:**
- Consumes: as rotas da Task 10, `POST /auth/password` (Task 7) e `useMe` (Task 16).

Comportamento:
- **`/usuarios`:** só ADMIN (Membro → `<Navigate to="/" />`). Mostra uma tabela com nome, e-mail, papel, ativo e módulos.
- **Formulário de usuário:**
  - campos nome, e-mail, papel, senha provisória e uma caixa de seleção por módulo de `me.modules`;
  - para ADMIN, as caixas de módulo ficam ocultas;
  - depois de criar, mostra "Passe a senha provisória ao usuário. Ele vai trocá-la no primeiro acesso.";
  - erros da API (`email_in_use`, `last_admin`, `cannot_deactivate_self`) aparecem com a `message` do servidor.
- **Troca de senha obrigatória:** com `me.user.mustChangePassword`, `RequireAuth` redireciona qualquer rota para `/trocar-senha`.
- **`/trocar-senha`:**
  - campos de senha atual, nova senha (mínimo 12) e confirmação, que precisa ser igual;
  - em caso de sucesso, invalida `['me']` e navega para `/`.

- [ ] **Step 1: Write the failing tests**

`users-page.test.tsx`:
- `creating a member sends the selected modules and shows the temporary-password notice`;
- `shows the server message for email_in_use`;
- `MEMBER is redirected away`.

`change-password-page.test.tsx`:
- `requires 12+ chars and matching confirmation before submitting`;
- `success navigates home`;
- `mustChangePassword user is redirected to /trocar-senha from /produtos`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @center/web test -- users-page change-password-page`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @center/web test -- --coverage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): gestão de usuários pelo Admin e troca de senha no primeiro acesso"
```

# Fase 6 — Back-office (`apps/backoffice`)

### Task 18: Esqueleto do back-office e login com TOTP

**Files:**
- Create: `apps/backoffice/package.json` (`@center/backoffice`; mesmas versões de `apps/web/package.json`, mais `qrcode@^1.5.4` e `@types/qrcode`; dep `@center/entitlements: workspace:*`)
- Create: `apps/backoffice/{index.html, vite.config.ts, tsconfig.json, tailwind.config.js, postcss.config.js, jest.config.cjs}`. Copie a config e o tema escuro de `apps/web`. O Vite roda na porta `5174` com `define: { __API_URL__: JSON.stringify(process.env.VITE_API_URL ?? 'http://localhost:3333') }`. O Jest usa os mesmos `setupFiles`/`setupFilesAfterEnv` do web e `globals: { __API_URL__: '' }`.
- Create: `apps/backoffice/src/{main.tsx, App.tsx, index.css}`, `src/lib/api-client.ts`, `src/hooks/use-operator.ts`, `src/components/RequireOperator.tsx`, `src/components/Layout.tsx`, `src/pages/LoginPage.tsx`, `src/test/*` (copiado de `apps/web/src/test`)
- Test: `apps/backoffice/src/__tests__/login-page.test.tsx`, `require-operator.test.tsx`

**Interfaces:**
- Consumes: `/internal/auth/login`, `/internal/auth/totp` e `/internal/auth/me` (Task 12).
- Produces:
  ```ts
  declare const __API_URL__: string;
  export async function request<T>(path: string, init?: RequestInit): Promise<T>;  // base __API_URL__, token em localStorage 'center.operator.token', 401 limpa o token
  export const backofficeApi: { login(email, password); verifyTotp(token, code); me(); … };  // as Tasks 19–20 acrescentam métodos
  ```

Telas:
- **Login:** e-mail e senha.
- **Etapa `enroll`:** mostra o QR (`QRCode.toDataURL(otpauthUri)`), o segredo em texto e o campo de código, com o título "Configure o autenticador".
- **Etapa `mfa`:** só o campo de código.
- **Depois do login:** guarda o token e vai para `/clientes`.
- **Layout:** menu com Clientes, Auditoria e Operadores, nome do operador e botão Sair.

- [ ] **Step 1: Write the failing tests**

`login-page.test.tsx`:
- `enroll flow shows QR image and secret, submits the code and stores the session token`;
- `mfa flow submits the code`;
- `wrong code shows "Código inválido"`.

`require-operator.test.tsx`:
- `redirects to /login without token`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm install && pnpm --filter @center/backoffice test`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Verify tests and build**

Run: `pnpm --filter @center/backoffice test -- --coverage && pnpm --filter @center/backoffice build`
Expected: PASS; `apps/backoffice/dist/index.html` existe.

- [ ] **Step 5: Commit**

```bash
git add apps/backoffice pnpm-lock.yaml
git commit -m "feat(backoffice): app do console da Blan com login e TOTP"
```

### Task 19: Clientes e módulos

**Files:**
- Create: `apps/backoffice/src/pages/OrganizationsPage.tsx`, `src/pages/OrganizationDetailPage.tsx` (abas Módulos, Integrações, Usuários e o botão "Visualizar painel"), `src/components/ModulesTab.tsx`, `src/components/NewOrganizationDialog.tsx`
- Modify: `apps/backoffice/src/lib/api-client.ts`, `src/App.tsx`
- Test: `apps/backoffice/src/__tests__/organizations-page.test.tsx`, `modules-tab.test.tsx`

**Interfaces:**
- Consumes: as rotas da Task 13; `MODULES` de `@center/entitlements` (rótulos e ordem).

Comportamento:
- **Lista de clientes:**
  - colunas nome, slug, status e quantidade de módulos em vigor;
  - selo "Pendências" quando `pendingSetup` não está vazio.
- **Aba Módulos:**
  - uma linha por módulo do catálogo, com status, início, fim e as ações Ativar, Suspender e Salvar datas;
  - fim anterior ao início → erro "A data de fim precisa ser depois do início" sem enviar a requisição.

- [ ] **Step 1: Write the failing tests**

`organizations-page.test.tsx`:
- `shows the pending badge`;
- `creating a client posts name and navigates to its page`.

`modules-tab.test.tsx`:
- `activating sends PUT with status ACTIVE`;
- `suspending sends status SUSPENDED`;
- `end before start is blocked client-side`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @center/backoffice test -- organizations-page modules-tab`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @center/backoffice test -- --coverage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backoffice
git commit -m "feat(backoffice): clientes e ativação de módulos"
```

### Task 20: Integrações, usuários, visualização, auditoria e operadores

**Files:**
- Create: `apps/backoffice/src/components/IntegrationsTab.tsx`, `src/components/UsersTab.tsx`, `src/pages/AuditPage.tsx`, `src/pages/OperatorsPage.tsx`
- Modify: `apps/backoffice/src/pages/OrganizationDetailPage.tsx`, `src/lib/api-client.ts`, `src/App.tsx`
- Test: `apps/backoffice/src/__tests__/integrations-tab.test.tsx`, `users-tab.test.tsx`, `audit-page.test.tsx`, `view-button.test.tsx`

**Interfaces:**
- Consumes: as rotas das Tasks 14 e 15.

Comportamento:
- **Aba Integrações:** um cartão por tipo, com os campos de `config` do tipo:

| Tipo | Campos |
|---|---|
| COMMERCE | `statusMapping` (JSON opcional) e os segredos `apiKey` e `secretKey` |
| WEB_ANALYTICS | `propertyId` e `bigQueryDataset` |
| APP_ANALYTICS | `propertyId` |
| PLAY_STORE | `packageName` e o segredo `credentialsJson` |
| APP_STORE | `appId` e o segredo `keyJson` |
| SPRINT_BOARD | `boardId` |

  - Campos de segredo usam `type="password"`, começam vazios e, se já configurados, mostram o placeholder "Configurado em <data> — deixe em branco para manter".
  - Segredo não tocado não entra no corpo do `PUT`.
  - O cartão mostra status, `lastError`, a última sincronização e, nos tipos GA4, "Conceda acesso à propriedade para: <serviceAccountEmail>".
  - Botão "Testar" (só COMMERCE) e botão "Desativar".
  - Bloco "Script de atribuição" com o snippet de `docs/checkout-attribution.md`, preenchido com `apiUrl` e `organizationId`, e botão Copiar.
- **Aba Usuários:**
  - lista os usuários;
  - "Criar Admin" com nome, e-mail e senha provisória;
  - ações Desativar e Redefinir senha.
- **"Visualizar painel":** chama `POST /internal/organizations/:id/view-session` e faz `window.open(url, '_blank', 'noopener')`.
- **Auditoria:** tabela com data, operador, ação e cliente, filtros por cliente e por ação, e o botão "Carregar mais" (`before`).
- **Operadores:** lista, criação e desativação.

- [ ] **Step 1: Write the failing tests**

`integrations-tab.test.tsx`:
- `secret fields start empty and are omitted from the request when untouched`;
- `shows lastError after a failed check`;
- `shows the service account email for GA4 kinds`.

`users-tab.test.tsx`:
- `creating an admin posts name, email and temporaryPassword`.

`view-button.test.tsx`:
- `opens the returned url in a new tab` (`window.open` mockado).

`audit-page.test.tsx`:
- `filters by organization and loads more with before`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @center/backoffice test -- integrations-tab users-tab view-button audit-page`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @center/backoffice test -- --coverage && pnpm --filter @center/backoffice build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backoffice
git commit -m "feat(backoffice): integrações, usuários, visualização, auditoria e operadores"
```

# Fase 7 — Fechamento

### Task 21: Remover as colunas antigas e o provisionamento antigo

**Files:**
- Modify: `apps/api/prisma/schema.prisma`:
  - remove de `Organization` os campos `uappiApiKey`, `uappiSecretKey`, `ga4PropertyId`, `ga4BigQueryDataset`, `ga4AppPropertyId`, `playConsoleCredsJson`, `appStoreConnectKeyJson`, `mondayApiToken`, `mondayBoardId` e `statusMapping`;
  - `slug` passa a ser obrigatório.
- Create: `apps/api/prisma/migrations/20261115000000_drop_legacy_org_integration_columns/migration.sql`
- Delete: `apps/api/scripts/provision-admin.ts`, `apps/api/scripts/lib/provision-admin.ts`, `apps/api/scripts/__tests__/provision-admin.test.ts` e o script `provision:admin` do `package.json`
- Test: `apps/api/src/__tests__/prisma-schema.test.ts`

**Interfaces:**
- Consumes: o script da Task 3, que precisa continuar rodando sem as colunas.

- [ ] **Step 1: Write the failing test**
- `Organization holds no integration columns`: o corpo de `Organization` não casa com `/uappi|ga4|playConsole|appStoreConnect|monday|statusMapping/`.
- `slug is required`: `slug\s+String\s+@unique` sem `?`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @center/api test -- src/__tests__/prisma-schema.test.ts`
Expected: FAIL.

- [ ] **Step 3: Edit the schema and generate the migration**

Rode `prisma migrate dev --create-only --name drop_legacy_org_integration_columns`. No topo do SQL, acrescente esta proteção:

```sql
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "Organization" WHERE "slug" IS NULL) THEN
    RAISE EXCEPTION 'rode migrate-to-multitenant antes desta migração';
  END IF;
END $$;
```

- [ ] **Step 4: Verify**

Run, nesta ordem:
1. `node apps/api/dist/scripts/migrate-to-multitenant.js`, com o build ainda da Task 20, para garantir os slugs;
2. `pnpm --filter @center/api exec prisma migrate deploy && pnpm --filter @center/api exec prisma generate`;
3. `pnpm -w build && node apps/api/dist/scripts/migrate-to-multitenant.js`, agora sem as colunas antigas;
4. `pnpm test && pnpm -w typecheck`.

Expected:
- a migração aplica, porque a proteção não dispara;
- a segunda execução do script roda sem erro e sem planejar integrações;
- a suíte inteira passa.

- [ ] **Step 5: Commit**

```bash
git add -A apps/api
git commit -m "chore(db): remove colunas de integração de Organization"
```

### Task 22: Docker, compose e CI

**Files:**
- Modify: `Dockerfile`:
  - o estágio `deps` copia o `package.json` de **todos** os workspaces: `shared`, `pii`, `secrets`, `entitlements`, `uappi-client`, `connectors`, `mcp-core`, `mcp-commerce`, `mcp-ga4`, `mcp-behavior`, `mcp-firebase`, `mcp-quality`, `mcp-sprint`, `apps/api`, `apps/web` e `apps/backoffice`. Isso também corrige o build quebrado registrado no Claude Doc;
  - novo estágio `backoffice` (`FROM nginx:1.27-alpine`), que copia `apps/backoffice/dist` e um `nginx.conf` com `try_files $uri /index.html`.
- Create: `apps/backoffice/nginx.conf`
- Modify: `docker-compose.prod.yml`: serviço `backoffice` (`build.target: backoffice`, porta `8080:80`, build arg `VITE_API_URL`); o `api` recebe `OPERATOR_JWT_SECRET`, `PANEL_ORIGIN`, `BACKOFFICE_ORIGIN` e `MONDAY_API_TOKEN`.
- Modify: `.github/workflows/ci.yml` só se o build do back-office precisar de variável. O padrão de `__API_URL__` já cobre o CI.

- [ ] **Step 1: Build both images**

Run: `docker build --target runtime -t center-api . && docker build --target backoffice -t center-backoffice .`
Expected: os dois builds terminam com sucesso. Antes da mudança, o primeiro falha no `pnpm install --frozen-lockfile` por pacotes ausentes.

- [ ] **Step 2: Smoke test the stack**

Run:
- `docker compose -f docker-compose.prod.yml up -d --build`
- `curl -s localhost:3333/health`
- `curl -sI localhost:8080/clientes`

Expected:
- `/health` responde `{"status":"ok"}`;
- `/clientes` responde `200` com `text/html`.

- [ ] **Step 3: Commit**

```bash
git add Dockerfile apps/backoffice/nginx.conf docker-compose.prod.yml .github
git commit -m "build: imagem completa da API e container do back-office"
```

### Task 23: Documentação final

**Files:**
- Modify: `README.md`:
  - remove o aviso de "transição";
  - o guia passa a incluir `OPERATOR_JWT_SECRET`, `create-operator`, o operador de dev do `db:seed` e `pnpm --filter @center/backoffice dev` (porta 5174);
  - acrescenta o roteiro "primeiro acesso ao back-office" (login, TOTP, cliente, módulos, integrações, primeiro Admin).
- Modify: `docs/rodar-local.md` (mesmo conteúdo do README), `docs/deploy.md` (a seção "Provisionamento" é substituída por `migrate-to-multitenant` + `create-operator` + back-office) e `docs/checkout-attribution.md` (o snippet sai do back-office).
- Modify: `CLAUDE.md`: a tabela "Hoje × Alvo" vira "Arquitetura", descrevendo o estado implementado, e os itens "a criar" são removidos.
- Modify: o status da spec passa a ser "implementado em <data>".

- [ ] **Step 1: Follow the new README from zero on a clean database**

Run: os passos do README, incluindo o login no back-office com TOTP, um cliente com os módulos `overview` e `products` e um Membro só com `products`.
Expected: o Membro vê só "Produtos". `POST /api/tools/ga4/traffic_sources` com o token dele responde 403 `module_not_available`.

- [ ] **Step 2: Commit**

```bash
git add README.md docs CLAUDE.md
git commit -m "docs: guia e deploy da arquitetura multi-tenant"
```
