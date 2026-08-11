# Rodar o projeto localmente

Passo a passo para subir o painel e o agente do WhatsApp na sua máquina.

Tudo aqui foi executado e verificado neste repositório. Onde existe uma
armadilha conhecida, ela está marcada com ⚠️ — leia essas antes de perder tempo
depurando.

---

## Pré-requisitos

| Ferramenta | Versão | Como conferir |
|---|---|---|
| Node.js | 22 LTS | `node --version` |
| pnpm | 9.x | `pnpm --version` |
| Docker Desktop | qualquer recente | `docker compose version` |

O Postgres e o Redis sobem via Docker — você **não** precisa instalar nenhum dos
dois na máquina.

---

## Parte 1 — Painel

### Passo 1: subir banco e cache

Na raiz do repositório:

```bash
docker compose up -d
```

Confira que os dois ficaram saudáveis antes de seguir:

```bash
docker compose ps
```

Você quer ver `postgres` e `redis` como `Up (healthy)`. Se o Docker Desktop não
estiver aberto, esse comando falha com erro de pipe/daemon — abra o Docker
Desktop e espere o ícone parar de animar.

### Passo 2: criar o `.env`

```bash
cp .env.example .env
```

Agora edite o `.env`. Para rodar **local sem credenciais externas**, use:

```bash
DATABASE_URL="postgresql://center:center@localhost:5432/center?schema=public"
REDIS_URL="redis://localhost:6379"

# Precisam ter 32+ caracteres. Qualquer string longa serve para desenvolvimento.
JWT_SECRET="dev-jwt-secret-com-no-minimo-32-caracteres"
PII_PEPPER="dev-pii-pepper-com-no-minimo-32-caracteres"

# Precisa ter exatamente 64 caracteres hex. Gere com: openssl rand -hex 32
CREDENTIALS_ENCRYPTION_KEY="0000000000000000000000000000000000000000000000000000000000000000"

# Liga os clientes mock de Uappi, GA4 e BigQuery — dados de fixture, sem rede.
MOCK_EXTERNAL_APIS="true"

UAPPI_BASE_URL="https://api.uappi.com.br"
GA4_CREDENTIALS_JSON=""

# ⚠️ Continuam obrigatórias mesmo em modo mock (veja a nota abaixo).
ANTHROPIC_API_KEY="placeholder"
WHATSAPP_APP_SECRET="placeholder"
WHATSAPP_VERIFY_TOKEN="placeholder"
WHATSAPP_ACCESS_TOKEN="placeholder"
WHATSAPP_PHONE_NUMBER_ID="placeholder"
```

> ⚠️ **`MOCK_EXTERNAL_APIS=true` não afrouxa a validação de env.** A API se
> recusa a subir sem `ANTHROPIC_API_KEY` e sem as quatro `WHATSAPP_*`, mesmo em
> modo mock. Preencha com qualquer string não vazia para rodar só o painel — o
> agente do WhatsApp é que vai precisar dos valores reais (Parte 2).

> ⚠️ **Só a string literal `"true"` liga o modo mock.** `1`, `yes` ou `True`
> caem em `false` silenciosamente e o sistema vai tentar falar com a Uappi/GA4
> de verdade.

### Passo 3: carregar o `.env` no terminal

⚠️ **Nada neste projeto lê o `.env` sozinho** — nem a API, nem o Prisma. O
Prisma até procura um `.env`, mas em `apps/api/`, e o nosso está na raiz do
repositório. Sem este passo, o próximo comando falha com
`Environment variable not found: DATABASE_URL`.

Entre em `apps/api` e carregue as variáveis:

**bash / Git Bash / WSL:**

```bash
cd apps/api
set -a && . ../../.env && set +a
```

**PowerShell:**

```powershell
Set-Location apps\api
Get-Content ..\..\.env | Where-Object { $_ -match '^\s*[^#].*=' } | ForEach-Object {
  $name, $value = $_ -split '=', 2
  Set-Item -Path "env:$($name.Trim())" -Value $value.Trim('"', ' ')
}
```

Confira que carregou:

```bash
echo $DATABASE_URL          # bash
echo $env:DATABASE_URL      # PowerShell
```

> Isso vale **só para o terminal atual**. Cada terminal novo que você abrir para
> rodar a API, o worker ou o Prisma precisa repetir este passo. É por isso que
> ele aparece de novo nos passos seguintes.

### Passo 4: instalar, migrar e compilar

No mesmo terminal do passo anterior, **sem sair de `apps/api`**:

```bash
pnpm install
pnpm exec prisma generate
pnpm exec prisma migrate deploy
pnpm -w build
```

Você deve ver `No pending migrations to apply.` ou a lista de migrações
aplicadas.

> O `-w` manda o comando para a raiz do workspace sem te mover de pasta. A
> partir daqui **fique em `apps/api` até o fim da Parte 1** — todos os comandos
> seguintes (`db:seed`, `start`, `start:sync`) são scripts desse pacote e não
> existem na raiz.

O `pnpm build` compila os 11 pacotes, inclusive os três servidores MCP que a API
executa como processos filhos e o `apps/web/dist` que a API serve como painel.

> O aviso `The configuration property package.json#prisma is deprecated` é
> esperado e inofensivo — o Prisma 6 ainda aceita, e migrar para
> `prisma.config.ts` é assunto para outra hora.

### Passo 5: criar o primeiro usuário

Existem dois caminhos. Para desenvolvimento local, o seed é mais rápido — ainda
em `apps/api`, no terminal com o `.env` carregado:

```bash
pnpm db:seed
```

Sucesso é a linha `seed concluído: admin@center.local / center-dev-123`.

> ⚠️ Se aparecer `Command "db:seed" not found` (ou, em português, *"a sintaxe do
> nome do arquivo... está incorreta"*), você está na **raiz** do repositório e
> não em `apps/api` — esse script só existe no pacote da API. Rode `cd apps/api`
> e repita. De qualquer pasta, a alternativa é
> `pnpm --filter @center/api db:seed`, mas o `.env` precisa estar carregado no
> terminal do mesmo jeito.

Isso cria a organização `org_dev` e o login **`admin@center.local` /
`center-dev-123`**.

⚠️ **Nunca use o seed fora da sua máquina** — essa senha está publicada neste
repositório. Para qualquer ambiente compartilhado, use o provisionamento, que
exige uma senha sua de 12+ caracteres e se recusa a rodar num banco que já tenha
organização ou usuário.

Ele roda pelo **compilado**, não pelo script `pnpm provision:admin` (veja a nota
sobre `--experimental-strip-types` logo abaixo):

```bash
PROVISION_ORG_NAME="Minha Loja" \
PROVISION_ADMIN_NAME="Rafael" \
PROVISION_ADMIN_EMAIL="rafael@exemplo.com" \
PROVISION_ADMIN_PASSWORD="uma-senha-longa-de-verdade" \
  node dist/scripts/provision-admin.js
```

No PowerShell, defina as quatro com `$env:` antes de chamar o `node`.

Num banco que já tem usuário (por exemplo, depois do seed) ele recusa de
propósito, e isso é sinal de que está funcionando:

```
recusado: já existem 1 usuário(s) no banco — este script só provisiona
a primeira instalação (banco vazio). Nada foi alterado.
```

> ⚠️ **Os scripts `pnpm provision:admin`, `health:report`, `warm:cache`,
> `eval:agent` e `seed:demo` estão quebrados no Node 22.** Todos usam
> `--experimental-strip-types`, que remove tipos mas **não** remapeia imports
> `./x.js` para o `.ts` irmão — então morrem com `ERR_MODULE_NOT_FOUND` antes de
> executar qualquer coisa. É a mesma dívida técnica dos scripts `dev`.
> **Use sempre a versão em `dist/scripts/`**, que o `pnpm -w build` gera:
>
> | Em vez de | Use |
> |---|---|
> | `pnpm provision:admin` | `node dist/scripts/provision-admin.js` |
> | `pnpm health:report` | `node dist/scripts/health-report.js` |
> | `pnpm warm:cache` | `node dist/scripts/warm-cache.js` |
> | `pnpm eval:agent` | `node dist/scripts/eval-agent.js` |
> | `pnpm seed:demo` | `node dist/scripts/seed-demo.js` (Passo 8) |
>
> O `pnpm db:seed` é a exceção e funciona normalmente: ele importa de `dist/`,
> não de um `.ts` irmão.

### Passo 6: subir a API

No terminal com o `.env` carregado (Passo 3), dentro de `apps/api`:

```bash
pnpm start
```

Se você abriu um terminal novo, carregue o `.env` de novo antes — a API valida
`process.env` direto e recusa subir listando todas as variáveis faltantes.

Confirme que subiu:

```bash
curl http://localhost:3333/health     # {"status":"ok"}
```

> ⚠️ **Não use `pnpm dev` na `apps/api`.** Os scripts `dev`, `dev:sync` e
> `dev:whatsapp` estão quebrados no Node 22: o `--experimental-strip-types` não
> remapeia os imports `./config.js` para os `.ts` irmãos, então o processo morre
> na hora com `ERR_MODULE_NOT_FOUND`. É dívida técnica conhecida e registrada.
> Use sempre `pnpm build` + `pnpm start`. Pelo mesmo motivo, `pnpm dev` na raiz
> também não funciona para a API.

### Passo 7: abrir o painel

Você tem duas opções.

**Opção A — painel servido pela própria API** (mais próximo de produção, sem
processo extra):

Já está no ar. Abra **http://localhost:3333** e faça login.

**Opção B — Vite com hot reload** (para mexer no frontend):

Em outro terminal:

```bash
pnpm --filter @center/web dev
```

Abra **http://localhost:5173**. O Vite redireciona `/api` e `/auth` para a API
na 3333.

> ⚠️ O proxy do Vite cobre **apenas** `/api` e `/auth`. As rotas `/public/*` e
> `/webhooks/*` não são redirecionadas — se você precisar testá-las, use a porta
> 3333 direto (Opção A).

### Passo 8: popular os dados (não é opcional)

Logo após o login o painel aparece **vazio**, e isso é esperado: o seed e o
provisionamento criam apenas organização e usuário — nenhum pedido, nenhuma
configuração de integração. O modo mock troca os *clientes* externos por
fixtures, mas não preenche o banco sozinho nem dispensa a configuração.

Você vai ver dois estados diferentes, e eles significam coisas diferentes:

| O que aparece no card | Significado |
|---|---|
| `fonte de dados indisponível` (vermelho) | A consulta **falhou**. Para os cards de GA4, quase sempre é `ga4PropertyId` não configurado |
| `Sem dados no período selecionado` | A consulta **funcionou** e voltou vazia — falta dado no banco, ou o período não cobre os dados |

#### Caminho rápido: um comando

Ainda em `apps/api`, com o `.env` carregado (Passo 3) e **depois** de `pnpm -w
build` (Passo 4):

```bash
node dist/scripts/seed-demo.js
```

> Por que o compilado e não `pnpm seed:demo` diretamente: mesma dívida de
> `--experimental-strip-types` já descrita na nota do Passo 5 — o script
> importa de arquivos `.ts` irmãos, que só existem resolvidos em `dist/`.

Isso faz, na organização já existente (criada pelo seed ou pelo
provisionamento):

1. **Configura GA4 e Uappi** exatamente pelas colunas que a página de
   Configurações grava — `ga4PropertyId`, `ga4BigQueryDataset`,
   `uappiApiKey`/`uappiSecretKey` (cifradas com o mesmo `SecretBox` da
   Settings). Nunca sobrescreve um valor já configurado — se a organização já
   tiver credenciais reais, o script avisa e as deixa intactas.
2. **Roda o sync de verdade** contra o `MockUappiClient` (mesmo caminho de
   código do sync de produção: schema Zod → `mapOrder` → `persistOrder`),
   populando `CommerceOrder`/`CommerceOrderItem`/`CommerceCustomer`.
3. **Deriva os toques de atribuição** (`AttributionTouch`) dos pedidos que já
   têm `visitorHash`, reaproveitando o hash que o sync real já calculou —
   nunca escreve um identificador bruto.

É seguro rodar mais de uma vez: nada é duplicado (o sync já é idempotente por
`numeroPedido`, e o script confere antes de gravar cada resto). Ele se recusa
a rodar se `MOCK_EXTERNAL_APIS` não for `"true"`, para nunca gravar
credenciais de demonstração por cima de uma integração real.

Ao final ele imprime um resumo com as contagens, o faturamento total e —
importante — **o período real coberto pelos dados**, calculado a partir do
banco, não fixo no texto:

```
estado do banco após o seed:
  pedidos: 15
  itens de pedido: 20
  clientes: 14
  toques de atribuição: 3 (3 criados nesta rodada)
  faturamento total (todos os status): R$ 3.947,10

período coberto pelos pedidos: 2026-07-01 a 2026-07-20
no painel, escolha um período que inclua essas datas (ex.: "Mês passado", "90 dias" ou um
intervalo customizado). Se "hoje" estiver fora dessa janela, os presets "Hoje"/"7 dias"/
"30 dias" aparecerão corretamente vazios — não é um bug.
```

#### Caminho manual (para entender o que o comando acima faz)

**1. Configure a organização.** Pelo painel, em **Configurações**, preencha:

- **ID da propriedade GA4** — em modo mock, qualquer valor serve (ex.: `000000000`).
  Sem ele, todas as ferramentas de GA4 recusam antes de chegar ao mock.
- **Chave e segredo da Uappi** — em modo mock, qualquer valor serve
  (ex.: `mock` / `mock`). Não é decoração: o agendador só sincroniza
  organizações que têm as duas credenciais gravadas, mesmo em modo mock.

Salvar pelo painel é o caminho certo, porque as credenciais são cifradas na
gravação.

**2. Rode o sync**, em `apps/api` com o `.env` carregado:

```bash
node dist/sync/sync-worker-main.js
```

Ele faz o backfill e depois fica rodando em intervalos. Espere as primeiras
linhas de log e pode interromper com `Ctrl+C` — o que já entrou fica no banco.

Confira:

```bash
docker compose exec postgres psql -U center -d center \
  -c 'SELECT count(*) FROM "CommerceOrder";'
```

**3. Escolha o período certo.** ⚠️ As fixtures da Uappi são de **julho de 2026**.
Se o seu "hoje" for agosto, os presets **Hoje**, **7 dias** e **30 dias** vão
aparecer vazios — corretamente. Clique em **Mês passado** ou **90 dias** para ver
os números. (O caminho rápido acima imprime a data real em vez de você ter que
lembrar disso.)

Com as 15 fixtures você deve ver algo em torno de **R$ 3.947,10** de faturamento
em julho. O caminho manual acima **não** popula `AttributionTouch` — essa tabela
só é escrita pelo beacon público do checkout (`docs/checkout-attribution.md`) ou
pelo `seed-demo.js`.

---

## Parte 2 — WhatsApp

O agente do WhatsApp precisa de três coisas que o painel não precisa: uma chave
real da Anthropic, credenciais reais da Meta e um **túnel público**, porque a
Meta entrega mensagens via webhook — ela precisa alcançar sua máquina de fora.

Não há como testar o fluxo completo só com mock.

### Passo 1: credenciais da Meta

O guia detalhado está em [`docs/whatsapp-setup.md`](./whatsapp-setup.md). Você
vai precisar de:

| Variável | Onde achar |
|---|---|
| `WHATSAPP_APP_SECRET` | App → Configurações → Básico → Chave secreta |
| `WHATSAPP_ACCESS_TOKEN` | App → WhatsApp → Configuração da API |
| `WHATSAPP_PHONE_NUMBER_ID` | App → WhatsApp → Configuração da API |
| `WHATSAPP_VERIFY_TOKEN` | Você inventa — só precisa bater com o que cadastrar |

Preencha as quatro no `.env`, junto com uma `ANTHROPIC_API_KEY` real.

> A verificação do negócio na Meta leva de 3 dias a 3 semanas. Comece cedo.

### Passo 2: expor a API na internet

```bash
npx localtunnel --port 3333
```

Guarde a URL gerada (algo como `https://xyz.loca.lt`).

### Passo 3: cadastrar o webhook

Em App → WhatsApp → Configuração → Webhooks:

- **URL de callback:** `https://<sua-url-do-tunel>/webhooks/whatsapp`
- **Token de verificação:** o mesmo valor de `WHATSAPP_VERIFY_TOKEN`
- **Campos assinados:** marque apenas `messages`

A Meta faz um `GET` na hora. Se a API estiver no ar com o mesmo verify token, o
cadastro é aceito imediatamente. Se falhar, quase sempre é token divergente.

### Passo 4: subir o worker

O worker é um processo separado da API. Em outro terminal:

```bash
cd apps/api
set -a && . ../../.env && set +a   # PowerShell: veja o Passo 3
pnpm start:whatsapp
```

Você deve ver `worker do WhatsApp em execução`.

Nesse ponto você tem 4 processos: Docker (Postgres + Redis), API, worker do
WhatsApp e o túnel.

### Passo 5: vincular seu número

O bot só responde a números vinculados a um usuário — é a fronteira de
autorização dele. Um número desconhecido nunca chega ao agente e nunca toca em
dado de organização nenhuma.

1. No painel, vá em **Configurações** e gere um código de vínculo.
2. Mande esse código (só ele, 6 caracteres) pelo WhatsApp para o número do bot.
3. Você recebe a confirmação de vínculo.

O código vale **15 minutos** e gerar um novo invalida o anterior.

### Passo 6: conversar

Mande perguntas em português:

- `quanto vendemos no mês passado?`
- `qual produto mais vendeu?`
- `quantos pedidos foram cancelados este mês?`

Para conferir o que o agente fez por baixo:

```sql
SELECT "toolName", success, "durationMs"
FROM "ToolCallLog" ORDER BY "createdAt" DESC LIMIT 10;
```

---

## Resolvendo problemas

| Sintoma | Causa | Solução |
|---|---|---|
| `Configuração inválida — DATABASE_URL: Required…` | O `.env` não foi carregado neste terminal | Refaça o Passo 3 |
| Prisma: `Environment variable not found: DATABASE_URL` | Idem — o Prisma procura o `.env` em `apps/api/`, não na raiz | Refaça o Passo 3 antes de rodar o Prisma |
| `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "prisma" not found` | Mensagem enganosa do pnpm: o Prisma **foi** encontrado e falhou por outro motivo | Leia o erro logo acima dela — quase sempre é o `DATABASE_URL` |
| `Command "db:seed" not found` / `a sintaxe do nome do arquivo... está incorreta` | Você está na raiz; `db:seed`, `start`, `start:sync` e `start:whatsapp` só existem em `apps/api` | `cd apps/api` (e recarregue o `.env` se for terminal novo) |
| `ERR_MODULE_NOT_FOUND … config.js` | Você usou `pnpm dev` na `apps/api` | Use `pnpm -w build` + `pnpm start` |
| `ERR_MODULE_NOT_FOUND … scripts/lib/….js` ou `… src/config.js` ao rodar um script | `--experimental-strip-types` não resolve `.js` → `.ts` irmão | Rode o compilado: `node dist/scripts/<nome>.js` (tabela no Passo 5) |
| `Can't reach database server at localhost:5432` | Docker parado | `docker compose up -d` |
| Login não aceita nada | Banco sem usuário | Passo 5 (seed ou provisionamento) |
| Cards de GA4 com `fonte de dados indisponível` | `ga4PropertyId` não configurado na organização | `node dist/scripts/seed-demo.js`, ou Configurações → ID da propriedade GA4 (Passo 8) |
| `Sem dados no período selecionado` em tudo | Banco sem pedidos, ou período errado | `node dist/scripts/seed-demo.js` (Passo 8) e escolha **Mês passado** / **90 dias** — ele imprime o período real dos dados |
| Sync roda e não grava nada | Organização sem credenciais Uappi — o agendador a ignora, mesmo em mock | `node dist/scripts/seed-demo.js`, ou Configurações → chave e segredo da Uappi (qualquer valor em mock) |
| A Meta recusa o webhook | Verify token diferente | O valor no painel da Meta tem que ser idêntico ao do `.env` |
| Bot responde "não encontrei este número" | Número não vinculado | Passo 5 da Parte 2 |
| Bot sempre responde a mensagem de fallback | `ANTHROPIC_API_KEY` inválida | Confira a chave; o erro real aparece no log do worker |
| `131030 — Recipient phone number not in allowed list` | Antes da revisão do app, a Meta só entrega para números de teste | Adicione seu número em App → WhatsApp → Configuração da API |

### Conferir a saúde geral

```bash
cd apps/api
set -a && . ../../.env && set +a   # PowerShell: veja o Passo 3
node dist/scripts/health-report.js
```

Ele avisa se o sync parou, se a fila do WhatsApp está crescendo, se as chamadas
de ferramenta estão falhando — e se você está em modo mock, porque nesse caso os
números que você está vendo são fixture, não dados reais. Numa máquina de
desenvolvimento é normal ver algo assim:

```
PROBLEMAS DETECTADOS:
 - MOCK_EXTERNAL_APIS está ligado — os dados servidos são fixtures, não reais
 - sync de "Loja de Desenvolvimento" parado há 6524 minutos
```

---

## Comandos úteis

```bash
pnpm test           # suíte inteira
pnpm typecheck      # tipos
pnpm build          # compila tudo

docker compose down            # derruba os serviços
docker compose down -v         # derruba e APAGA os dados
```

## Modo mock vs. real

| | Mock (`MOCK_EXTERNAL_APIS="true"`) | Real (`"false"`) |
|---|---|---|
| Uappi, GA4, BigQuery | Fixtures locais, sem rede | Credenciais reais obrigatórias |
| Painel | Funciona | Funciona |
| Agente do WhatsApp | Precisa de chave Anthropic real | Precisa de chave Anthropic real |
| Serve para | Desenvolver e navegar a interface | Validar números de verdade |

Os números em modo mock são **inventados**. Não use nenhum deles para conferir
nada de negócio.
