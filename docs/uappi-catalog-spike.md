# Spike — catálogo e estoque na Uappi

**Data:** 2026-08-06
**Executado por:** Execução automatizada (subagent-driven development) — Claude, sessão `feat/center-analytics`

## Status: BLOQUEADO — sem acesso à API real da Uappi

Este spike (CD-S2 no backlog) depende de uma chamada real contra
`$UAPPI_BASE_URL/v2/collection/apiv2` (e `front`/`marketplace`) usando
credenciais reais de uma loja Uappi. Esta sessão de execução não tem acesso a:

- Uma instância real da API da Uappi (`UAPPI_BASE_URL` apontando para produção
  ou sandbox de um cliente real)
- Credenciais reais (`apiKey`/`secretKey`) de nenhuma organização

O Step 1 do brief (`curl -H 'App-Token: wapstore' "$UAPPI_BASE_URL/v2/collection/apiv2"`)
não pôde ser executado. Nenhum `docs/uappi-endpoints.txt` foi gerado.

## Endpoints encontrados na coleção

Não aplicável — spike não executado.

## Existe endpoint de produtos com saldo de estoque?

- [ ] Sim — path: `_______`, campo de saldo: `_______`, limite de taxa: `___/min`
- [x] **Não confirmado** — spike bloqueado por falta de acesso à API real.

## Decisão

Seguindo a própria contingência que o brief desta task já prevê para o caso
"Não": **A pergunta A10 ("quais produtos estão sem estoque") sai do escopo
desta rodada de implementação.** Os Steps 3–6 (condicionais — `listProducts`
no `UappiClient`, `out_of_stock_products` em `mcp-commerce/inventory.ts`, e
seus testes) **não foram implementados**. Escrever esse contrato sem
confirmar o endpoint real seria inventar uma API que pode não existir ou ter
nomes de campo diferentes — exatamente o risco que este spike existe para
evitar.

**Próximo passo humano, quando o acesso à Uappi estiver disponível:**

1. Rodar o Step 1 deste brief (`docs/superpowers/plans/2026-08-05-center-analytics-uappi.md`,
   Task 15) contra a API real.
2. Se um endpoint de produtos com saldo de estoque existir: reabrir esta
   task, preencher esta tabela com os achados reais, e executar os Steps 3–6
   (implementação condicional de `listProducts`/`out_of_stock_products`).
3. Se não existir: abrir chamado no suporte da Uappi perguntando sobre acesso
   a saldo de estoque via API, e manter A10 fora do escopo — o agente de
   WhatsApp (T29/T31) deve responder que não tem acesso ao catálogo para essa
   pergunta específica.

Esta pendência é a mesma categoria de bloqueio documentado no ledger de
execução (`.superpowers/sdd/2026-08-05-center-analytics-uappi/progress.md`)
para os steps de validação contra API real já pulados nas Tasks 5, 5B, 6 e 8
— todas aguardando as mesmas credenciais reais da Uappi.
