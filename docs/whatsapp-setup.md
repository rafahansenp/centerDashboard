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

## Sobre a janela de 24 horas

A Cloud API só permite texto livre dentro de 24 h após a última mensagem do
usuário. Como o bot só responde a mensagens recebidas, estamos sempre dentro da
janela — **desde que a fila não acumule**. Um job retido mais de 24 h falha com o
código 131047; com `attempts: 3` e backoff exponencial isso só ocorre com o worker
parado por um dia, e o alarme da T38 cobre esse caso. **Templates aprovados pela
Meta não são necessários neste escopo**, porque o bot nunca inicia conversa.

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

## Validação fim-a-fim

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
