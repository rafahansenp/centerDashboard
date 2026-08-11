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

No mesmo terminal do passo anterior:

```bash
pnpm install
pnpm exec prisma generate
pnpm exec prisma migrate deploy
cd ../.. && pnpm build
```

Você deve ver `No pending migrations to apply.` ou a lista de migrações
aplicadas.

O `pnpm build` compila os 11 pacotes, inclusive os três servidores MCP que a API
executa como processos filhos e o `apps/web/dist` que a API serve como painel.

> O aviso `The configuration property package.json#prisma is deprecated` é
> esperado e inofensivo — o Prisma 6 ainda aceita, e migrar para
> `prisma.config.ts` é assunto para outra hora.

### Passo 5: criar o primeiro usuário

Existem dois caminhos. Para desenvolvimento local, o seed é mais rápido (no
terminal com o `.env` já carregado, dentro de `apps/api`):

```bash
pnpm db:seed
```

Isso cria a organização `org_dev` e o login **`admin@center.local` /
`center-dev-123`**.

> ⚠️ **Nunca use o seed fora da sua máquina** — essa senha está publicada neste
> repositório. Para qualquer ambiente compartilhado, use o provisionamento, que
> exige uma senha sua de 12+ caracteres e se recusa a rodar num banco que já
> tenha organização ou usuário:
>
> ```bash
> cd apps/api
> PROVISION_ORG_NAME="Minha Loja" \
> PROVISION_ADMIN_NAME="Rafael" \
> PROVISION_ADMIN_EMAIL="rafael@exemplo.com" \
> PROVISION_ADMIN_PASSWORD="uma-senha-longa-de-verdade" \
>   pnpm provision:admin
> ```

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

### Passo 8 (opcional): sincronizar dados

Em modo mock o painel já mostra dados de fixture. Para exercitar o pipeline de
sincronização:

```bash
cd apps/api
set -a && . ../../.env && set +a   # PowerShell: veja o Passo 3
pnpm start:sync
```

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
| `ERR_MODULE_NOT_FOUND … config.js` | Você usou `pnpm dev` na `apps/api` | Use `pnpm build` + `pnpm start` |
| `Can't reach database server at localhost:5432` | Docker parado | `docker compose up -d` |
| Login não aceita nada | Banco sem usuário | Passo 5 (seed ou provisionamento) |
| Painel abre mas os números vêm zerados | Sem dados sincronizados | Confirme `MOCK_EXTERNAL_APIS="true"` (literal) ou rode o sync |
| A Meta recusa o webhook | Verify token diferente | O valor no painel da Meta tem que ser idêntico ao do `.env` |
| Bot responde "não encontrei este número" | Número não vinculado | Passo 5 da Parte 2 |
| Bot sempre responde a mensagem de fallback | `ANTHROPIC_API_KEY` inválida | Confira a chave; o erro real aparece no log do worker |
| `131030 — Recipient phone number not in allowed list` | Antes da revisão do app, a Meta só entrega para números de teste | Adicione seu número em App → WhatsApp → Configuração da API |

### Conferir a saúde geral

```bash
cd apps/api
set -a && . ../../.env && set +a   # PowerShell: veja o Passo 3
pnpm health:report
```

Ele avisa se o sync parou, se a fila do WhatsApp está crescendo, se as chamadas
de ferramenta estão falhando — e se você está em modo mock, porque nesse caso os
números que você está vendo são fixture, não dados reais.

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
