# CLAUDE.md

Guia para agentes e pessoas trabalhando neste repositório.

## O que é

**Center Dashboard**: SaaS de analytics para lojas virtuais, da Blan. Junta
vendas do e-commerce, GA4, uso do app, qualidade nas lojas de apps e o sprint
da equipe de desenvolvimento num painel, com um assistente de IA que responde
perguntas sobre esses dados.

## Estado atual × arquitetura-alvo

O projeto está **em transição**. Leia isto antes de mudar qualquer coisa.

| | Hoje (no código) | Alvo (aprovado em 2026-10-29) |
|---|---|---|
| Clientes | Uma `Organization` com tudo dentro | Multi-tenant: vários clientes, isolados |
| E-commerce | Uappi embutida (`uappi-client`, `uappi-sync`) | Conectores; a Uappi é o primeiro |
| Funcionalidades | Todas para todos | **Módulos** contratados por cliente |
| Administração | `ADMIN` do cliente edita credenciais | **Back-office** da Blan (`apps/backoffice`) configura clientes, módulos e integrações; Admin do cliente gerencia só os próprios usuários |
| Papéis | `ADMIN`, `VIEWER` | `ADMIN`, `MEMBER` + módulos por Membro |

**Fonte da verdade do alvo:**
[docs/superpowers/specs/2026-10-29-multi-tenant-modular-design.md](docs/superpowers/specs/2026-10-29-multi-tenant-modular-design.md).
**Plano de execução:**
[docs/superpowers/plans/2026-10-29-multi-tenant-modular.md](docs/superpowers/plans/2026-10-29-multi-tenant-modular.md).
Código novo segue o alvo. Não estenda o modelo antigo (ex.: não adicione mais
colunas de integração em `Organization`).

## Dúvidas sobre a nova arquitetura: pergunte antes

Se uma tarefa esbarrar em algo que o design **não decide** e que muda o que é
construído (regra de negócio, o que o cliente vê, o que a Blan controla,
segurança, cobrança), **pare e pergunte ao responsável pelo produto**. Não
escolha sozinho. Detalhes de implementação (nomes, divisão de arquivos,
bibliotecas) são decisão sua; registre-os no PR.

## Regras do produto (alvo)

- **Público:** clientes da Blan e empresas sem relação com ela. Nenhum módulo
  pode presumir app mobile ou projeto com a Blan.
- **Um cliente = uma loja = uma plataforma de e-commerce.** Garantido pela
  restrição única (`organizationId`, `kind`) em `Integration`.
- **Módulos do MVP** (catálogo em código, `packages/entitlements`):
  `overview`, `products`, `acquisition`, `app_usage`, `quality`, `sprint`,
  `assistant`. Novo módulo = nova entrada no catálogo.
- **Ativação de módulo é manual**, pelo operador no back-office
  (`OrganizationModule.origin = MANUAL`). Cobrança fora do sistema.
- **Integrações** (credenciais, propriedades GA4, board do Monday) são
  configuradas **só pela equipe Blan**. O painel do cliente mostra status, nunca
  credenciais.
- **Monday:** token global da Blan (`MONDAY_API_TOKEN`); por cliente só o
  `boardId`. O módulo Sprint mostra o desempenho da equipe de dev da Blan.
- **GA4:** service accounts globais da Blan (`GA4_CREDENTIALS_JSON`,
  `GA4_APP_CREDENTIALS_JSON`); o cliente concede acesso à propriedade dele.
- **Modelo canônico de commerce = tabelas atuais** (`CommerceOrder` etc.), sem
  `integrationId` e sem renomear campos no MVP.
- **Usuários do cliente:** o Admin cria com senha provisória
  (`mustChangePassword`); sem e-mail no MVP.
- **Fora do MVP:** WhatsApp, planos/cobrança integrada, cliente editando
  credencial, papéis customizados, segunda plataforma de e-commerce.

## Invariantes de segurança

Quebrar qualquer um destes é bug crítico.

1. **Isolamento por cliente.** Toda consulta a dado de cliente filtra por
   `organizationId` vindo do token, nunca do corpo da requisição.
2. **Três checagens em toda rota de dados ou de módulo**, com as funções de
   `packages/entitlements`: módulo em vigor no cliente → usuário pode ver →
   papel permite a ação. Rotas de dados checam a **fonte** pedida
   (`metricId` ou `:source`); rotas de funcionalidade (agente, análise de
   versão) checam o módulo. O agente recebe um gateway restrito às fontes
   liberadas. Permissões são lidas do banco **a cada requisição**, nunca do
   token.
3. **Dois mundos de autenticação.** `/internal/*` (operador,
   `PlatformOperator`, TOTP, `aud = "operator"`, `OPERATOR_JWT_SECRET`) e
   `/api/*` (cliente, `User`, `aud = "client"`). Um token nunca vale no outro
   lado. Operador **não** é uma flag em `User`.
4. **Código do back-office nunca entra no bundle de `apps/web`.**
5. **Credenciais** só cifradas (`@center/secrets`, AES-256-GCM), decifradas só
   no ponto de uso (sync/conector). Nunca em log, resposta de API ou
   `OperatorAuditLog.metadata`.
6. **PII** pseudonimizada com HMAC (`@center/pii`) antes de gravar.
7. **`TenantContext`** carrega só identificadores públicos.
8. **Auditoria:** toda ação de operador que altera dados grava em
   `OperatorAuditLog` (só inserção).
9. **Visualização como cliente** (sessão da Blan): somente leitura, 30 min,
   só rotas marcadas como leitura, sem assistente, faixa visível, `viewedBy`
   registrado.
10. **Nada fora do conector conhece a plataforma.** O sync e o MCP de commerce
    trabalham só com o modelo canônico.

## Convenções de domínio

- Dinheiro em **centavos** (`Int`). Nunca `float` para valor.
- Fuso **America/Sao_Paulo** para períodos e agrupamentos.
- Receita = pedidos em `REVENUE_STATUS_GROUPS` (`PAID`, `PROCESSING`,
  `SHIPPED`, `DELIVERED`).
- Cache do `MetricGateway`: 5 min para período aberto, 24 h para fechado; a
  chave inclui a organização. Autorização acontece **antes** do gateway.
- Erros: 403 `module_not_available` (sem revelar se é contrato ou permissão),
  403 `organization_suspended` / `password_change_required` /
  `readonly_session` / `forbidden`, 409 `integration_pending`, 502 para falha
  de fonte externa, 401 para token inválido ou usuário desativado.

## Stack e estrutura

pnpm 9 + Turborepo, TypeScript ESM (NodeNext), Node 22. Fastify 5,
Prisma 6 + PostgreSQL 16, Redis 7 + BullMQ, Vercel AI SDK 5. React 19, Vite 6,
Tailwind, Recharts, TanStack Query. Testes com Jest (`@swc/jest`).

```
apps/
  api/          API Fastify (/api/* cliente; /internal/* operador — alvo), sync worker, agente
  web/          painel do cliente (app.<domínio>)
  backoffice/   console da Blan (admin.<domínio>) — a criar
  api/prisma/   schema e migrações (continua aqui no MVP)
packages/
  entitlements/ catálogo de módulos e checagens puras — a criar
  connectors/   interface de conector, executor de sync, conector Uappi — a criar (absorve uappi-sync)
  uappi-client/ cliente HTTP da Uappi; só packages/connectors importa
  mcp-core/     McpPool, MetricGateway, cache
  mcp-*/        MCP servers por fonte: commerce, ga4, behavior, firebase, quality, sprint
  pii/ secrets/ shared/
```

Os MCP servers rodam como processos filhos via stdio; cada um recebe só as
variáveis de ambiente que declara em `apps/api/src/main.ts`.

## Comandos

```bash
docker compose up -d                 # Postgres + Redis locais
pnpm install
pnpm test                            # todos os testes
pnpm typecheck
pnpm -w build                        # compila tudo

# dentro de apps/api, com o .env da raiz carregado no terminal:
pnpm exec prisma migrate deploy
pnpm db:seed                         # admin@center.local / center-dev-123
node dist/scripts/seed-demo.js       # dados de demonstração (MOCK_EXTERNAL_APIS="true")
node dist/scripts/eval-agent.js      # avaliação pontuada do agente
pnpm start                           # painel em http://localhost:3333
pnpm --filter @center/web dev        # frontend com hot reload (5173)
```

Armadilhas reais (detalhes em [README.md](README.md)):
- Nada lê o `.env` sozinho; carregue-o no terminal antes de rodar a API ou o
  Prisma.
- `pnpm dev`/`dev:sync` e os scripts `pnpm <script>` com
  `--experimental-strip-types` quebram no Node 22; use os compilados em
  `dist/`.
- `MOCK_EXTERNAL_APIS` só liga com a string exata `"true"`.

## Como trabalhar aqui

- Código, comentários e docs em **português**; identificadores em inglês, como
  no código existente.
- **Nunca faça commit.** Ao concluir uma feature ou tarefa, pare, mostre o que
  mudou (arquivos e resultado dos testes) e espere o aceite do responsável. O
  commit é feito por ele. Vale também para passos "Commit" de planos em
  `docs/superpowers/plans/`: trate-os como ponto de parada para aceite. Pode
  sugerir a mensagem no padrão `tipo(escopo): descrição` (ex.:
  `feat(api): ...`), em branch `feature/...`, via PR para `main`.
- Teste junto com a mudança. Em autorização, teste o caminho negado (outro
  cliente, módulo suspenso, Membro sem acesso, token do outro mundo,
  sessão somente leitura).
- Migrações de schema que removem colunas vêm **depois** da migração de dados,
  em PR separado.
- Mantenha esta página e o design atualizados quando uma decisão mudar.
