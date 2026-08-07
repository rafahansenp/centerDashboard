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
