# Design: multi-tenant, módulos contratáveis e conectores de e-commerce

**Data:** 2026-10-29
**Status:** aprovado em conversa; aguardando revisão deste documento
**Substitui:** a premissa de "uma organização, uma integração Uappi fixa" do plano
`docs/superpowers/plans/2026-08-05-center-analytics-uappi.md`.

Este documento descreve **para onde** o projeto vai. O que existe hoje está no
README e no código; a seção 12 lista o caminho de migração.

---

## 1. Intenção

O Center Dashboard deixa de ser o painel de um cliente com a Uappi embutida e
passa a ser um **SaaS de analytics para lojas**, vendido por módulos.

- **Público:** clientes da Blan *e* empresas sem nenhuma relação de
  desenvolvimento com a Blan. Por isso nenhum módulo pode presumir que o cliente
  tem app mobile ou projeto com a equipe da Blan.
- **Um cliente = uma loja = uma plataforma de e-commerce.** A Uappi é a primeira
  plataforma; outras virão como **conectores**, sem tocar no resto do sistema.
- **O que o cliente vê depende do que ele contratou.** A equipe Blan ativa os
  módulos de cada cliente num **back-office** separado; o **Admin do cliente**
  decide o que cada pessoa da equipe dele enxerga.

### Por que agora
A primeira versão provou o valor do painel e do agente com um cliente. Para
vender a outros, o sistema precisa separar dados por cliente de forma
estrutural, cobrar por módulo e não depender da Uappi em todo canto.

### Como fica o sucesso
- Cadastrar um cliente novo (de ponta a ponta, com módulos e integrações) sem
  escrever código e sem acessar o banco.
- Adicionar uma plataforma de e-commerce nova escrevendo **só** um conector.
- Adicionar um módulo novo registrando-o num catálogo, sem espalhar `if`s.
- Nenhum usuário consegue ler dado de um módulo que não pode ver: nem pela
  tela, nem pela API, nem perguntando ao agente.

## 2. Objetivos, não-objetivos e anti-objetivos

**Objetivos do MVP**
1. Back-office da equipe Blan (`apps/backoffice`) com login próprio.
2. Módulos ativados por cliente, checados no menu, na API e no agente.
3. Admin do cliente gerencia os próprios usuários e o acesso deles a módulos.
4. Integrações por cliente num modelo único (`Integration`), configuradas só
   pela equipe Blan.
5. Interface de conector de e-commerce, com a Uappi reescrita como o primeiro.
6. Visualização do painel do cliente pela equipe Blan, somente leitura.

**Não-objetivos (ficam documentados como evolução)**
- Planos, preços e cobrança integrada (gateway). A ativação é manual.
- Cliente atualizar a própria credencial (hoje só a Blan configura).
- Papéis customizados por cliente.
- Convite por e-mail e recuperação de senha por e-mail.
- Canal de WhatsApp.
- Uma segunda plataforma de e-commerce (o conector é desenhado para ela, mas
  ela não é escrita agora).
- Sync real de Play Console, App Store Connect e Monday (hoje esses read models
  só são preenchidos pelo seed; ver seção 13).
- Deploy separado da API do back-office.
- Mais de uma loja por cliente.

**Anti-objetivos — falharia mesmo "funcionando" se:**
- Um usuário de um cliente conseguir ver dado de outro cliente, por qualquer
  caminho (rota, cache, agente, sessão de visualização).
- Um token de cliente for aceito em rota do back-office, ou vice-versa.
- O agente responder sobre um módulo que o usuário não pode ver.
- Código fora do conector precisar saber que a plataforma é a Uappi.
- O back-office virar uma tela "escondida" dentro do bundle do painel do
  cliente.

## 3. Restrições

- Mantém a stack atual: monorepo pnpm + Turborepo, TypeScript ESM, Node 22,
  Fastify 5, Prisma 6 + PostgreSQL 16, Redis 7 + BullMQ, React 19 + Vite.
- Mantém as garantias atuais: dinheiro em centavos, fuso `America/Sao_Paulo`,
  PII com HMAC (`@center/pii`), credenciais com AES-256-GCM (`@center/secrets`),
  `TenantContext` só com identificadores públicos, cache 5 min / 24 h.
- O cliente atual não pode perder dados nem acesso na migração.
- Sem infraestrutura de e-mail no MVP.

## 4. Arquitetura em três camadas

| Camada | Quem | O que faz | Onde |
|---|---|---|---|
| Back-office | Equipe Blan (`PlatformOperator`) | Cria clientes, ativa módulos, configura integrações, cria o primeiro Admin, suporte | `apps/backoffice` → `admin.<domínio>` |
| Administração do cliente | Admin do cliente (`User.role = ADMIN`) | Cria e remove usuários do próprio cliente; marca os módulos de cada Membro | Dentro de `apps/web` |
| Uso | Usuários do cliente | Usam os módulos liberados | `apps/web` → `app.<domínio>` |

```
 Equipe Blan ─► apps/backoffice ──/internal/*──┐
                                                ▼
                                         apps/api (um processo)
                                          ├─ plugin /internal/*  (auth de operador)
                                          └─ plugin /api/*       (auth de cliente)
                                                │  checagem de módulo
                                                ▼
                                 MetricGateway → MCP servers → read models
                                                ▲
                                 sync worker → conectores (Uappi, …)
 Usuários ───► apps/web ─────────/api/*────────┘
```

### 4.1 Monorepo
Decisão: o back-office vive **no mesmo monorepo**. Ele grava nas mesmas tabelas
que o painel lê e reutiliza `@center/secrets`, o Prisma e o `check` dos
conectores; repositórios separados duplicariam schema ou exigiriam pacotes
publicados.

O isolamento é garantido assim:
- `apps/backoffice` tem build e deploy próprios. Nenhum código dele entra no
  bundle de `apps/web`.
- Na API, `/internal/*` é um plugin Fastify **encapsulado**, com verificador de
  token próprio. Ele pode virar `apps/backoffice-api` depois sem reescrita.

### 4.2 Pacotes novos

| Pacote | Conteúdo |
|---|---|
| `packages/db` | `schema.prisma`, migrações e o client, extraídos de `apps/api`. |
| `packages/entitlements` | Catálogo de módulos e as funções de checagem de acesso. Sem dependência de Fastify. |
| `packages/connectors` | Interface de conector, modelo canônico de commerce e o conector Uappi (absorve `uappi-client` e `uappi-sync`). |

O nome e a divisão interna exata de `packages/connectors` (um pacote com
subpastas por plataforma ou um pacote por conector) ficam a critério de quem
implementa; a regra é que **nada fora dele importa código da Uappi**.

## 5. Catálogo de módulos

O catálogo é **código**, em `packages/entitlements`. O banco guarda só a `key`
do módulo. Um módulo sem código não teria efeito, por isso não existe tabela
`Module`.

Cada módulo declara:

```ts
interface ModuleDefinition {
  key: ModuleKey;                 // estável, nunca renomeada
  label: string;                  // nome exibido
  menuPath: string;               // rota no apps/web
  apiPrefixes: string[];          // rotas de API que só respondem com o módulo
  metricSources: MetricSource[];  // fontes do MetricGateway liberadas
  agentTools: string[];           // ferramentas do agente liberadas
  requiredIntegrations: IntegrationKind[]; // o que precisa estar configurado
}
```

Módulos do MVP (as rotas e fontes refletem o que as telas usam hoje):

| key | Nome | Rota | Fontes | Integrações exigidas |
|---|---|---|---|---|
| `overview` | Visão geral | `/` | commerce (+ cards de outros módulos, ver abaixo) | COMMERCE |
| `products` | Produtos | `/produtos` | commerce | COMMERCE |
| `acquisition` | Aquisição | `/aquisicao` | ga4, behavior, commerce | WEB_ANALYTICS, COMMERCE |
| `app_usage` | Uso do app | `/uso-do-app` | firebase | APP_ANALYTICS |
| `quality` | Qualidade | `/qualidade` | quality | PLAY_STORE e/ou APP_STORE |
| `sprint` | Sprint | `/sprint` | sprint | SPRINT_BOARD |
| `assistant` | Assistente de IA | painel lateral | — (usa as fontes dos outros módulos) | nenhuma |

Regras:
- **Visão geral** hoje mostra cards de ga4, quality e sprint. Cada card só
  aparece se o usuário puder ver o módulo dono daquela fonte.
- **`/api/analysis/correlate`** pertence a `acquisition`;
  **`/api/analysis/app-version-impact`** pertence a `app_usage`. *(Decisão de
  design, não do cliente.)*
- **Fontes compartilhadas:** uma fonte liberada por qualquer módulo visível
  está liberada. `commerce` aparece em vários módulos de propósito.
- **Assistente:** recebe só as ferramentas dos módulos que o usuário pode ver.
  Sem o módulo `assistant`, o painel lateral não aparece e
  `/api/agent/*` responde 403.
- **Sprint** mostra o desempenho da equipe de desenvolvimento da Blan no board
  do cliente. Só faz sentido para clientes com projeto na Blan; para os outros,
  simplesmente não é ativado.

## 6. Modelo de dados

### 6.1 Tabelas novas

**`PlatformOperator`** — equipe Blan. Separada de `User` de propósito: uma flag
"superadmin" em `User` transformaria qualquer falha de permissão em escalada
para todos os clientes.
- `email` (único), `name`, `passwordHash`, `totpSecret` (cifrado com
  `@center/secrets`), `totpEnabledAt`, `active`, `createdAt`, `lastLoginAt`.
- TOTP **obrigatório**: o operador cadastra o TOTP no primeiro login e só então
  acessa o resto do back-office.
- Sem papéis entre operadores no MVP; todo operador ativo pode tudo no
  back-office. *(Decisão de design.)*

**`OrganizationModule`** — o que cada cliente contratou.
- `organizationId`, `moduleKey`, `status` (`ACTIVE` | `SUSPENDED`),
  `startsAt`, `endsAt?`, `origin` (`MANUAL` hoje; `PLAN` e `BILLING` no futuro),
  `updatedByOperatorId`, timestamps.
- Único em (`organizationId`, `moduleKey`).
- Um módulo está **em vigor** quando `status = ACTIVE`, `startsAt <= agora` e
  (`endsAt` é nulo ou `endsAt > agora`). Vencer o `endsAt` tem o mesmo efeito
  de suspender, sem job: a checagem é feita na leitura.

**`UserModuleAccess`** — o que o Admin do cliente liberou para cada Membro.
- `userId`, `moduleKey`, `grantedByUserId`, `createdAt`. Único em
  (`userId`, `moduleKey`).
- Só faz sentido para `MEMBER`; o Admin vê todos os módulos em vigor.
- Suspender um módulo **não apaga** as linhas: ao reativar, cada Membro volta a
  ver o que via.

**`Integration`** — as integrações de cada cliente.
- `organizationId`, `kind`, `provider`, `config` (Json, só valores públicos),
  `secrets` (texto cifrado de um Json, `@center/secrets`), `status`
  (`PENDING` | `OK` | `ERROR` | `DISABLED`), `lastCheckAt?`, `lastError?`,
  timestamps.
- Único em (`organizationId`, `kind`). **É isso que garante uma loja por
  cliente.**
- `kind` × `provider` no MVP:

| kind | provider | config (público) | secrets (cifrado) |
|---|---|---|---|
| `COMMERCE` | `UAPPI` | `statusMapping?` | `apiKey`, `secretKey` |
| `WEB_ANALYTICS` | `GA4` | `propertyId`, `bigQueryDataset?` | — (service account global) |
| `APP_ANALYTICS` | `GA4` | `propertyId` | — (service account global) |
| `PLAY_STORE` | `GOOGLE_PLAY` | `packageName` | credencial da Play Console |
| `APP_STORE` | `APP_STORE_CONNECT` | `appId` | chave da App Store Connect |
| `SPRINT_BOARD` | `MONDAY` | `boardId` | — (token global da Blan) |

- GA4: a Blan usa **uma service account global** (variáveis de ambiente atuais).
  O cliente concede acesso à propriedade dele para o e-mail dessa service
  account; o back-office mostra esse e-mail na tela de cadastro.
- Monday: o token é **da Blan**, em variável de ambiente; por cliente só existe
  o `boardId`.
- `secrets` nunca sai da API: nem para o back-office (que só grava e vê
  "configurado em <data>"), nem para o painel.

**`OperatorAuditLog`** — tudo o que um operador faz.
- `operatorId`, `action` (ex.: `organization.create`, `module.activate`,
  `integration.update`, `view_session.start`), `organizationId?`,
  `targetType?`, `targetId?`, `metadata` (Json, **sem segredos**), `ip`,
  `userAgent`, `createdAt`.
- Só inserção: a aplicação não expõe update nem delete, e a migração cria um
  trigger que recusa `UPDATE`/`DELETE` na tabela.

### 6.2 Tabelas alteradas

**`Organization`**
- Ganha `status` (`ACTIVE` | `SUSPENDED`) e `slug` (único, para URLs do
  back-office).
- **Perde** `uappiApiKey`, `uappiSecretKey`, `ga4PropertyId`,
  `ga4BigQueryDataset`, `ga4AppPropertyId`, `playConsoleCredsJson`,
  `appStoreConnectKeyJson`, `mondayApiToken`, `mondayBoardId`, `statusMapping`
  (todos vão para `Integration`).
- Cliente suspenso: os usuários não conseguem logar (mensagem clara), o sync
  para, os dados ficam. *(Decisão de design.)*

**`User`**
- `role`: `ADMIN | MEMBER` (o atual `VIEWER` vira `MEMBER`).
- Ganha `mustChangePassword` (bool) e `active` (bool).
- `email` continua único no sistema inteiro: uma pessoa pertence a um cliente.

**Read models de commerce** (`CommerceOrder`, `CommerceOrderItem`,
`CommerceCustomer`, `AttributionTouch`)
- Ganham `integrationId`.
- Os campos com nome da Uappi (`numeroPedido`, `idPedido`, `statusId`, `canal`,
  `origem`, `tipoVenda`) são renomeados para nomes canônicos
  (ex.: `externalNumber`, `externalId`, `sourceStatusCode`, `channel`,
  `origin`, `saleType`). `statusLabel`, `statusGroup` e `rawPayload` ficam.
  Os nomes exatos são do implementador.

**`SyncState`**: passa a ser por integração — único em
(`integrationId`, `resource`).

**`WhatsAppIdentity`, `LinkCode`, `ProcessedWebhookEvent`**: ficam no schema,
com comentário "não usado no MVP". Sem migração destrutiva.

## 7. Autorização

### 7.1 Dois mundos de autenticação

| | Cliente | Operador |
|---|---|---|
| Tabela | `User` | `PlatformOperator` |
| Rotas | `/api/*` | `/internal/*` |
| Login | e-mail + senha | e-mail + senha + TOTP |
| Token | JWT `aud = "client"` | JWT `aud = "operator"`, segredo próprio (`OPERATOR_JWT_SECRET`) |
| Validade | 12 h (atual) | curta, 8 h *(decisão de design)* |

Cada plugin só aceita o próprio `aud` e o próprio segredo. Os testes provam que
um token de um lado é recusado no outro.

### 7.2 A cadeia de checagem (toda rota de `/api/*` de módulo)
1. **O cliente está ativo e o módulo está em vigor?** (`OrganizationModule`)
2. **O usuário pode ver o módulo?** `ADMIN` vê todos os em vigor; `MEMBER` só os
   que estão em `UserModuleAccess` **e** em vigor.
3. **O papel permite a ação?** Gestão de usuários é só de `ADMIN`.

Falha em 1 ou 2 → **403** com código `module_not_available`. A resposta não
diz se o problema é contrato ou permissão.

A checagem acontece em três lugares, todos com a mesma função de
`packages/entitlements`:
- **API:** um hook por prefixo de rota (do catálogo). Rotas genéricas
  (`/api/metrics/*`, `/api/tools/:source/:name`) checam a `source` pedida
  contra as fontes liberadas.
- **Agente:** o conjunto de ferramentas é montado por requisição a partir dos
  módulos visíveis. Ferramenta fora do conjunto não existe para o modelo. O
  system prompt lista só os módulos visíveis.
- **Menu:** `GET /api/me` devolve os módulos visíveis com o estado de cada um
  (`ready` | `awaiting_setup`). O front só usa isso para esconder itens; quem
  protege é a API.

### 7.3 "Aguardando configuração"
Módulo em vigor cuja integração exigida não existe ou não está `OK`:
- aparece no menu com o estado `awaiting_setup` e uma tela explicando que a
  equipe Blan está configurando;
- suas rotas de dados respondem **409** `integration_pending` (não 502);
- no back-office, o cliente aparece com alerta de pendência.

Para `quality`, basta **uma** das duas lojas (`PLAY_STORE` ou `APP_STORE`).

### 7.4 Cache
A chave do cache do `MetricGateway` já inclui a organização. A autorização
acontece **antes** do gateway, então o cache não precisa conhecer usuário nem
módulo.

## 8. Conectores de e-commerce

Inspirado no protocolo do Airbyte (`check` / `discover` / `read` com estado).

```ts
interface CommerceConnector {
  provider: CommerceProvider;               // 'UAPPI'
  configSchema: ZodSchema;                  // valida config + secrets no back-office
  check(input: ConnectorInput): Promise<CheckResult>;     // credencial válida?
  discover(input: ConnectorInput): Promise<StreamInfo[]>; // o que dá para ler
  read(input: ConnectorInput, stream: StreamName, state: StreamState | null):
    AsyncIterable<CanonicalRecord | StateCheckpoint>;
}
```

- **Modelo canônico:** pedidos, itens e clientes com os campos de §6.2. O sync
  grava só registros canônicos; o MCP de commerce lê só o modelo canônico.
- **Estado:** o conector emite checkpoints; o sync persiste em `SyncState`. A
  estratégia atual da Uappi (janela por `dataEmissao`, backfill de
  `SYNC_BACKFILL_DAYS`, overlap de 3 dias, limites de 120/60 req/min) passa a
  ser detalhe interno do conector Uappi.
- **Status de pedido:** o mapeamento para `OrderStatusGroup` é responsabilidade
  do conector. `REVENUE_STATUS_GROUPS` continua global.
- **PII:** o conector entrega dados crus; a pseudonimização com
  `@center/pii` acontece no sync, antes de gravar, para todo conector.
- **Registro:** um mapa `provider → connector`. O sync worker percorre as
  integrações `COMMERCE` de clientes ativos e chama o conector do provider.
- **`check`** é chamado pelo back-office ao salvar a integração e grava
  `status` e `lastError` em `Integration`.

## 9. Back-office (MVP)

App `apps/backoffice` (React + Vite, mesmo stack visual do painel).

| Tela | Faz |
|---|---|
| Login | e-mail + senha + TOTP; cadastro do TOTP no primeiro acesso |
| Clientes | lista com status, módulos e pendências; criar, editar, suspender, reativar |
| Cliente › Módulos | ativar, suspender, definir `startsAt`/`endsAt` |
| Cliente › Integrações | cadastrar/editar cada `kind`, testar (`check`), ver status do sync e último erro; segredos só de escrita |
| Cliente › Usuários | criar o primeiro Admin (senha provisória); listar usuários; desativar em caso de suporte |
| Cliente › Visualizar | abre a sessão de visualização (§9.1) |
| Operadores | criar, desativar |
| Auditoria | `OperatorAuditLog` filtrável por cliente, operador e ação |

Toda ação que altera dados grava em `OperatorAuditLog`.

### 9.1 Visualização como cliente (somente leitura)
1. Operador clica em "Visualizar painel" → `POST /internal/organizations/:id/view-session`.
2. A API grava `view_session.start` na auditoria e emite um JWT de cliente
   (`aud = "client"`) com validade de **30 min** e as claims
   `readonly: true`, `viewedBy: <operatorId>`, `organizationId`, papel efetivo
   `ADMIN` (vê todos os módulos em vigor).
3. O back-office abre `app.<domínio>/view-session#<token>`; o painel guarda o
   token e mostra uma **faixa fixa**: "Visualização da equipe Blan — somente
   leitura".
4. Na API, a sessão `readonly` só passa por rotas **marcadas como leitura** no
   registro da rota. Não dá para usar o método HTTP como critério, porque
   `/api/metrics/query` e `/batch` são `POST`. Ficam bloqueados: gestão de
   usuários, troca de senha e `/api/agent/*`.
5. As requisições da sessão são logadas com o `viewedBy`.

## 10. Painel do cliente (mudanças)

- Menu e Visão geral montados a partir de `GET /api/me` (§7.2).
- **Usuários** (só Admin): criar usuário com nome, e-mail, papel e senha
  provisória; marcar os módulos de cada Membro; desativar. O Admin não pode
  desativar a si mesmo nem rebaixar o último Admin do cliente.
- **Primeiro acesso:** `mustChangePassword = true` → o usuário só consegue
  acessar a tela de troca de senha até trocar.
- **Configurações:** passa a mostrar só o status das integrações (conectada,
  com erro, última sincronização), sem campos de credencial.
  `PUT /api/settings/integrations` deixa de existir.
- Rota `/view-session` e a faixa da visualização (§9.1).
- **Página inicial:** Visão geral, se visível; senão, o primeiro módulo visível
  na ordem do catálogo; sem nenhum módulo visível, uma tela "nenhum módulo
  liberado, fale com o Admin". *(Decisão de design.)*

### 10.1 Assistente: consumo por cliente
Sem limite de uso no MVP. O consumo de tokens do LLM passa a ser gravado por
mensagem (cliente, usuário, modelo, tokens de entrada e saída), para que a Blan
consiga medir custo por cliente antes de decidir preço ou cota.
*(Decisão de design.)*

### 10.2 Endpoint público de atribuição
`POST /public/attribution` continua identificando o cliente pelo
`organizationId` enviado pelo script do checkout. Passa a aceitar só clientes
`ACTIVE`; não checa módulo, porque o script é instalado no onboarding e o dado
coletado já é pseudonimizado. O back-office mostra o snippet pronto, com o
`organizationId` do cliente. *(Decisão de design.)*

## 11. Configuração e deploy

- Novas variáveis: `OPERATOR_JWT_SECRET`, `BACKOFFICE_ORIGIN`,
  `PANEL_ORIGIN`, `MONDAY_API_TOKEN` (global).
- `WHATSAPP_*` deixam de ser obrigatórias; o serviço `whatsapp` sai do compose
  padrão.
- CORS: `/internal/*` só aceita `BACKOFFICE_ORIGIN`; `/api/*` só
  `PANEL_ORIGIN`.
- Script `create-operator` para criar o primeiro operador (não existe tela para
  isso sem operador).

## 12. Migração do cliente atual

Uma migração de dados, idempotente:
1. A `Organization` existente recebe `status = ACTIVE` e um `slug`.
2. Recebe **todos os módulos** do MVP em `OrganizationModule`
   (`origin = MANUAL`).
3. Cada campo de integração preenchido vira uma linha de `Integration` com o
   mesmo valor cifrado (sem decifrar e recifrar quando o formato for igual).
4. `VIEWER` vira `MEMBER` com `UserModuleAccess` para todos os módulos.
5. Pedidos, itens, clientes e `SyncState` recebem o `integrationId` da
   integração `COMMERCE`.
6. Só depois, uma segunda migração remove as colunas antigas de
   `Organization`.

O `seed-demo` passa a criar um operador, um cliente, módulos e integrações no
modelo novo.

## 13. O que fica para quem implementa

- Divisão em tarefas e ordem (sugestão: `packages/db` → entitlements e schema →
  autorização na API → conector Uappi → back-office → painel → migração).
- Nomes exatos de rotas de `/internal/*`, de campos canônicos e de pacotes.
- Biblioteca de TOTP e formato do QR code.
- Layout das telas do back-office.

**Lacuna conhecida, fora deste design:** os read models de Qualidade
(`AppStoreSnapshot`, `AppFeedback`) e Sprint (`SprintTask`, `SprintCycle`) hoje
só são preenchidos pelo `seed-demo`. O `Integration` já reserva os `kind`s
deles, mas os syncs reais de Play Console, App Store Connect e Monday são
projetos separados.

## 14. Decisões tomadas e de quem

| Decisão | De quem |
|---|---|
| Multi-tenant, público inclui empresas sem relação com a Blan | Cliente |
| Uma loja por cliente, numa plataforma | Cliente |
| Plataformas como conectores desacoplados | Cliente |
| Módulos do MVP (7) e catálogo extensível | Cliente |
| Back-office separado; cliente gerencia os próprios usuários | Cliente |
| Monorepo | Cliente (por recomendação) |
| Ativação manual de módulos; cobrança fora do sistema | Cliente |
| Papéis fixos Admin/Membro + módulos por Membro | Cliente |
| Integrações só pela Blan (futuro: cliente atualiza credencial) | Cliente |
| WhatsApp fora do MVP | Cliente |
| Visualização somente leitura pela Blan | Cliente |
| Senha provisória sem e-mail no MVP | Cliente |
| Monday: token global da Blan, `boardId` por cliente | Cliente |
| Catálogo de módulos em código, sem tabela `Module` | Design |
| `Integration` única com (`kind`, `provider`) | Design |
| TOTP obrigatório para operador; sem papéis entre operadores | Design |
| Cliente suspenso não loga; sync para | Design |
| 403 `module_not_available` / 409 `integration_pending` | Design |
| `correlate` em Aquisição, `app-version-impact` em Uso do app | Design |
| Visão geral esconde cards de módulos não visíveis | Design |
| Página inicial = primeiro módulo visível | Design |
| Assistente sem cota no MVP; consumo de tokens gravado por cliente | Design |
| Atribuição pública aceita só cliente ativo, sem checar módulo | Design |
| Token de operador com validade de 8 h | Design |
