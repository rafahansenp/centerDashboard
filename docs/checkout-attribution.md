# Integração de atribuição no checkout

> **Multi-tenant (alvo aprovado em 2026-10-29).** Cada cliente tem o próprio
> `organizationId`; o back-office mostra o snippet pronto com o valor certo.
> `POST /public/attribution` só aceita clientes ativos. Os passos 2 e 3 abaixo
> são **específicos da Uappi** (`informacoesAdicionais`): cada conector de
> e-commerce documenta como os campos de atribuição chegam ao pedido na sua
> plataforma. Ver
> [design](superpowers/specs/2026-10-29-multi-tenant-modular-design.md), §10.2.

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
`visitorHash` — e **não existe fallback**. O join da atribuição é feito
exclusivamente por `visitorHash`; sem ele, o toque e o pedido nunca se
encontram, e a atribuição daquele pedido é perdida por completo.

> A coluna `AttributionTouch.emailHash` existe no schema e está indexada, mas
> hoje nada a preenche (o script desta página nunca envia e-mail) e nada a
> consulta. Ela é espaço reservado para um casamento por e-mail que ainda não
> foi construído — não conte com ela.

Das 6 perguntas do Grupo C, apenas "quais canais possuem maior ticket médio"
continua exata, porque usa o campo `canal` nativo da Uappi e não depende de
atribuição. As outras 5 ficam sem resposta confiável até os passos 2 e 3 serem
feitos.

## Privacidade

O `client_id` do GA4 identifica o navegador, não a pessoa. Ele é convertido em
HMAC-SHA256 no servidor, antes de qualquer gravação — não existe coluna no banco
capaz de armazenar o valor original, e não existe chave capaz de revertê-lo.
Nenhum e-mail sai do site por este script.
