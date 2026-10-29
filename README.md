# Center Dashboard

SaaS de analytics para lojas virtuais da Blan: vendas do e-commerce, GA4, uso do
app, qualidade nas lojas de apps e sprint da equipe de desenvolvimento num
painel, com um assistente de IA que responde perguntas sobre esses dados.

> **Arquitetura em transição (aprovada em 2026-10-29).** O produto está virando
> **multi-tenant**, com **módulos contratados por cliente**, um **back-office**
> da Blan para gerir clientes, módulos e integrações, e plataformas de
> e-commerce plugadas como **conectores** (a Uappi é o primeiro). O canal de
> WhatsApp sai do MVP e fica como evolução futura.
>
> - Design: [docs/superpowers/specs/2026-10-29-multi-tenant-modular-design.md](docs/superpowers/specs/2026-10-29-multi-tenant-modular-design.md)
> - Regras e invariantes para quem desenvolve: [CLAUDE.md](CLAUDE.md)
>
> O guia abaixo descreve o código **como ele está hoje** (uma organização,
> Uappi embutida, `ADMIN`/`VIEWER`). Ele será atualizado conforme a migração
> avançar.

# Rodar o projeto localmente

Do zero a um painel preenchido. Tudo aqui foi executado neste repositório; os
⚠️ marcam armadilhas reais, não hipóteses.

## Pré-requisitos

| Ferramenta | Versão |
|---|---|
| Node.js | 22 LTS |
| pnpm | 9.x |
| Docker Desktop | qualquer recente |

Postgres e Redis sobem via Docker — não instale nenhum dos dois.

---

# Parte 1 — Painel

## 1. Subir banco e cache

```bash
docker compose up -d
docker compose ps          # os dois devem estar "Up (healthy)"
```

## 2. Criar o `.env`

```bash
cp .env.example .env
```

Edite com estes valores para rodar sem credenciais externas:

```bash
DATABASE_URL="postgresql://center:center@localhost:5432/center?schema=public"
REDIS_URL="redis://localhost:6379"
JWT_SECRET="dev-jwt-secret-com-no-minimo-32-caracteres"
PII_PEPPER="dev-pii-pepper-com-no-minimo-32-caracteres"
CREDENTIALS_ENCRYPTION_KEY="0000000000000000000000000000000000000000000000000000000000000000"
MOCK_EXTERNAL_APIS="true"
UAPPI_BASE_URL="https://api.uappi.com.br"
GA4_CREDENTIALS_JSON=""
ANTHROPIC_API_KEY="placeholder"
WHATSAPP_APP_SECRET="placeholder"
WHATSAPP_VERIFY_TOKEN="placeholder"
WHATSAPP_ACCESS_TOKEN="placeholder"
WHATSAPP_PHONE_NUMBER_ID="placeholder"
```

⚠️ `JWT_SECRET` e `PII_PEPPER` precisam de 32+ caracteres;
`CREDENTIALS_ENCRYPTION_KEY` de exatamente 64 hex (`openssl rand -hex 32`).

⚠️ Só a string literal `"true"` liga o modo mock. `1`, `yes` ou `True` viram
`false` em silêncio.

⚠️ `ANTHROPIC_API_KEY` e as quatro `WHATSAPP_*` são obrigatórias **mesmo em modo
mock** — a API não sobe sem elas. Placeholders bastam para o painel.

## 3. Carregar o `.env` no terminal

```bash
cd apps/api
set -a && . ../../.env && set +a
```

<details>
<summary>PowerShell</summary>

```powershell
Set-Location apps\api
Get-Content ..\..\.env | Where-Object { $_ -match '^\s*[^#].*=' } | ForEach-Object {
  $name, $value = $_ -split '=', 2
  Set-Item -Path "env:$($name.Trim())" -Value $value.Trim('"', ' ')
}
```
</details>

⚠️ **Nada neste projeto lê o `.env` sozinho** — nem a API, nem o Prisma (ele
procura em `apps/api/`, e o nosso está na raiz). Sem isso você recebe
`Environment variable not found: DATABASE_URL`.

⚠️ Vale **só para o terminal atual**. Cada terminal novo (API, sync, worker)
precisa repetir este passo.

## 4. Instalar, migrar e compilar

```bash
pnpm install
pnpm exec prisma generate
pnpm exec prisma migrate deploy
pnpm -w build
```

⚠️ Fique em `apps/api` daqui até o fim da Parte 1 — `db:seed`, `start` e
`start:sync` só existem nesse pacote. O `-w` alcança a raiz do workspace sem te
mover de pasta.

## 5. Criar o usuário

```bash
pnpm db:seed
```

Cria **`admin@center.local` / `center-dev-123`**.

⚠️ Essa senha está publicada no repositório. Serve para a sua máquina e nada
mais. Para ambiente compartilhado use o provisionamento, que exige senha de 12+
caracteres e recusa banco que já tenha organização ou usuário:

```bash
PROVISION_ORG_NAME="Minha Loja" \
PROVISION_ADMIN_NAME="Rafael" \
PROVISION_ADMIN_EMAIL="rafael@exemplo.com" \
PROVISION_ADMIN_PASSWORD="uma-senha-longa-de-verdade" \
  node dist/scripts/provision-admin.js
```

## 6. Popular os dados

```bash
node dist/scripts/seed-demo.js
```

Um comando cobre as três integrações mockadas: configura a organização
(`ga4PropertyId`, `ga4BigQueryDataset`, credenciais Uappi cifradas) e sincroniza
os pedidos pelo pipeline real. Ao final ele imprime as contagens e **o período
que você deve escolher no painel**.

Esperado: 15 pedidos, 20 itens, 14 clientes, R$ 3.947,10, de 2026-07-01 a
2026-07-20.

⚠️ Recusa se `MOCK_EXTERNAL_APIS` não for `"true"`, e nunca sobrescreve
credencial já configurada. Pode rodar duas vezes sem duplicar nada.

## 7. Subir a API

```bash
pnpm start
```

Painel em **http://localhost:3333**. Confira com
`curl http://localhost:3333/health`.

Para mexer no frontend com hot reload, em outro terminal:

```bash
pnpm --filter @center/web dev      # http://localhost:5173
```

⚠️ O proxy do Vite cobre só `/api` e `/auth`. Para `/public/*` e `/webhooks/*`
use a 3333 direto.

## 8. Escolher o período

⚠️ As fixtures são de **julho/2026**. Se hoje for agosto, os presets **Hoje**,
**7 dias** e **30 dias** aparecem vazios — corretamente. Clique em **Mês
passado** ou **90 dias**.

Os dois estados vazios significam coisas diferentes:

| No card | Significado |
|---|---|
| `fonte de dados indisponível` (vermelho) | A consulta **falhou** — quase sempre `ga4PropertyId` ausente |
| `Sem dados no período selecionado` | A consulta **funcionou** e voltou vazia — falta dado ou o período não cobre |

---

# Parte 2 — WhatsApp

> **Fora do MVP.** O canal está desligado no código (rotas comentadas desde
> 2026-09-30) e foi adiado na nova arquitetura até que os detalhes do canal e
> os custos dos agentes sejam definidos. Os passos abaixo ficam como
> referência.

Precisa de três coisas que o painel não precisa: chave real da Anthropic,
credenciais reais da Meta e um **túnel público** (a Meta entrega por webhook e
precisa alcançar sua máquina). Não há como testar só com mock.

## 1. Credenciais da Meta

Detalhes em [`whatsapp-setup.md`](./whatsapp-setup.md). Preencha no `.env`:

| Variável | Onde achar |
|---|---|
| `WHATSAPP_APP_SECRET` | App → Configurações → Básico → Chave secreta |
| `WHATSAPP_ACCESS_TOKEN` | App → WhatsApp → Configuração da API |
| `WHATSAPP_PHONE_NUMBER_ID` | App → WhatsApp → Configuração da API |
| `WHATSAPP_VERIFY_TOKEN` | Você inventa |

Mais uma `ANTHROPIC_API_KEY` real.

⚠️ A verificação do negócio na Meta leva de 3 dias a 3 semanas.

## 2. Expor a API

```bash
npx localtunnel --port 3333
```

## 3. Cadastrar o webhook

App → WhatsApp → Configuração → Webhooks:

- **URL:** `https://<sua-url>/webhooks/whatsapp`
- **Token:** o mesmo de `WHATSAPP_VERIFY_TOKEN`
- **Campos:** só `messages`

A Meta faz um `GET` na hora. Falha aqui é quase sempre token divergente.

## 4. Subir o worker

Em outro terminal (com o `.env` carregado, passo 3 da Parte 1):

```bash
node dist/whatsapp/worker-main.js
```

Espere `worker do WhatsApp em execução`.

## 5. Vincular seu número

1. No painel, **Configurações** → gere um código.
2. Mande só o código (6 caracteres) pelo WhatsApp para o número do bot.
3. Recebe a confirmação.

O código vale 15 minutos; gerar um novo invalida o anterior.

⚠️ Número não vinculado nunca chega ao agente — é a fronteira de autorização do
bot, não um bug.

## 6. Conversar

`quanto vendemos no mês passado?` · `qual produto mais vendeu?` ·
`quantos pedidos foram cancelados este mês?`

---

# Problemas comuns

| Sintoma | Causa | Solução |
|---|---|---|
| `Configuração inválida — DATABASE_URL: Required…` | `.env` não carregado neste terminal | Passo 3 |
| Prisma: `Environment variable not found: DATABASE_URL` | Idem | Passo 3 |
| `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "prisma" not found` | Mensagem enganosa do pnpm — o Prisma rodou e falhou por outro motivo | Leia o erro logo acima |
| `Command "db:seed" not found` / *"a sintaxe do nome do arquivo… está incorreta"* | Você está na raiz | `cd apps/api` |
| `ERR_MODULE_NOT_FOUND … config.js` | Usou `pnpm dev` na `apps/api` | Use `pnpm -w build` + `pnpm start` |
| `ERR_MODULE_NOT_FOUND … scripts/lib/….js` | Script rodado via `pnpm`, não pelo compilado | `node dist/scripts/<nome>.js` |
| `Can't reach database server` | Docker parado | `docker compose up -d` |
| Cards de GA4 em `fonte de dados indisponível` | `ga4PropertyId` ausente | Passo 6 |
| Tudo em `Sem dados no período` | Banco vazio ou período errado | Passo 6, depois passo 8 |
| Sync não grava nada | Organização sem credenciais Uappi — o agendador a ignora, mesmo em mock | Passo 6 |
| Bot responde "não encontrei este número" | Número não vinculado | Parte 2, passo 5 |
| Bot só responde o fallback | `ANTHROPIC_API_KEY` inválida | Veja o log do worker |
| `131030 Recipient phone number not in allowed list` | Antes da revisão do app a Meta só entrega a números de teste | Adicione o seu em Configuração da API |

## ⚠️ Scripts quebrados no Node 22

`provision:admin`, `health:report`, `warm:cache`, `eval:agent` e `seed:demo`
usam `--experimental-strip-types`, que não remapeia `./x.js` para o `.ts` irmão
— morrem com `ERR_MODULE_NOT_FOUND`. Use sempre o compilado:

| Em vez de | Use |
|---|---|
| `pnpm provision:admin` | `node dist/scripts/provision-admin.js` |
| `pnpm health:report` | `node dist/scripts/health-report.js` |
| `pnpm warm:cache` | `node dist/scripts/warm-cache.js` |
| `pnpm eval:agent` | `node dist/scripts/eval-agent.js` |
| `pnpm seed:demo` | `node dist/scripts/seed-demo.js` |
| `pnpm dev` / `dev:sync` / `dev:whatsapp` | `pnpm start` / `start:sync` / `start:whatsapp` |

`pnpm db:seed` é a exceção e funciona: importa de `dist/`, não de um `.ts` irmão.

---

# Referência

```bash
node dist/scripts/health-report.js   # sync parado? fila crescendo? modo mock?
pnpm test                            # suíte inteira
pnpm -w build                        # compila tudo
docker compose down                  # derruba
docker compose down -v               # derruba e APAGA os dados
```

Ver os usuários do banco (a senha é hash `scrypt`, **não é recuperável**):

```bash
docker compose exec postgres psql -U center -d center \
  -c 'SELECT email, name, role FROM "User";'
```

## Mock vs. real

| | Mock (`"true"`) | Real (`"false"`) |
|---|---|---|
| Uappi, GA4, BigQuery | Fixtures locais, sem rede | Credenciais reais |
| Painel | Funciona | Funciona |
| Agente do WhatsApp | Precisa de chave Anthropic real | Precisa de chave Anthropic real |

Os números em modo mock são **inventados** — não use nenhum deles para conferir
negócio. O `health-report` avisa quando você está em modo mock justamente por
isso.
