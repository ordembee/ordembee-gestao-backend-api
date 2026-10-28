# Implantação em produção — InfinitePay + Uber Direct + cardápio reestruturado

Tudo o que está **sem commit** nos 4 repositórios (desde o deploy de 22/10) vai junto neste release:
Uber Direct (entrega + Pix/InfinitePay antecipado), InfinitePay, cardápio na coleção própria
`menuonlines`, ajustes de fuso/relatórios e as telas novas do painel e do cardápio.

## 1. Antes de publicar (GitHub → Settings → Environments → `production`)

**my-store-back-api** (já existem: `MONGODB_URI`, `FRONTEND_URL`, `INTERNAL_API_SECRET`, `FIREBASE_SERVICE_ACCOUNT`)

| Tipo | Nome | Valor |
|---|---|---|
| secret | `CREDENTIALS_ENCRYPTION_KEY` | `openssl rand -hex 32` (64 hex). **Guarde uma cópia**: trocar a chave depois de salvar credenciais da Uber as invalida. |
| variável | `UBER_WEBHOOK_PUBLIC_URL` | `https://my-store-cardapio.web.app/v1/webhooks/uber-direct` |
| variável | `INFINITEPAY_WEBHOOK_PUBLIC_URL` | `https://my-store-cardapio.web.app/v1/webhooks/infinitepay` |

O workflow (`.github/workflows/ci-cd.yml`) grava essas três no `.env.my-store-prd` e **avisa** (`::warning::`) se faltar alguma.

**my-store-cardapio-web-back-api**: nada novo, mas confira `MENU_PUBLIC_URL` no environment `production`
(`https://my-store-cardapio.web.app/`): é para lá que a InfinitePay devolve o cliente depois de pagar.

**Frontends** (painel e cardápio): nenhuma variável nova.

## 2. Migração do Mongo de produção (ANTES de publicar o backend novo)

O backend novo lê o cardápio de `menuonlines` e as integrações de `businesses.config`. A migração é aditiva
(o backend antigo continua funcionando com `businesses.menu`).

```bash
cd my-store-back-api            # com MONGODB_URI de produção no .env (cuidado: o .env local aponta para o Atlas de testes)
npx ts-node -r tsconfig-paths/register scripts/migrate-menu-online.ts            # só mostra o plano — confira
npx ts-node -r tsconfig-paths/register scripts/migrate-menu-online.ts --apply    # grava
```

Depois que o backend novo estiver no ar e o cardápio funcionando: `... --cleanup` (remove `businesses.menu`).

## 3. Ordem de publicação

1. **my-store-back-api** (push em `main` publica direto em produção — não há branch `staging`).
2. **my-store-cardapio-web-back-api** (gateway): `staging` → conferir → PR para `main`.
3. **my-store-cardapio-web-frontend**: `staging` → conferir → PR para `main`.
4. **frontend** (painel): push em `main`.

Atenção: o gateway novo **não tem mais** a rota `GET /v1/menus/:slug/live` (disponibilidade "ao vivo"). Publique o gateway e o
frontend do cardápio juntos (um logo após o outro) para o cardápio antigo não chamar uma rota que sumiu.

Backend primeiro porque ele passa a devolver `checkoutUrl`; o gateway/cardápio antigos simplesmente ignorariam o campo.
Campos novos que o gateway envia (`redirectUrl`, `customer.email`) são aceitos (ou descartados) pelo backend antigo sem erro.

## 4. Depois de publicar

1. **Painel → Cardápio → Loja**: preencher **Pagamento online (InfinitePay)** (InfiniteTag + "Habilitar pagamento via InfinitePay") e as credenciais da **Uber**.
2. **App da InfinitePay → Configurações**: ativar o **Checkout externo** (sem isso a API recusa criar links: `external_checkout_not_enabled`).
3. **Publicar o cardápio** (o painel mostra "alterações não publicadas").
4. Teste de ponta a ponta com um pedido barato (retirada e entrega): pagar no link, conferir "Pago integralmente" no painel,
   solicitar o entregador, cancelar o pedido de teste.
5. Conferir nos logs da função `api`: nenhum `InfinitePay: valor divergente` nem `external_checkout_not_enabled`.

## 5. Riscos conhecidos / pendências

- A resposta de `POST /links` da InfinitePay não é documentada: o código aceita `url`, `checkout_url`, `link` e `payment_url` (funcionou com `url` no teste).
- O webhook da InfinitePay não é assinado: ele só dispara uma consulta (`payment_check`) e o valor é conferido contra o total do pedido.
  Falta um limite de chamadas por pedido nesse endpoint (público).
- Pedido pago depois de cancelado só gera um erro no log (reembolso manual).
- `lint` do back-api roda com `continue-on-error` no CI (dívida antiga); o do gateway é estrito e passa.

## 6. Voltar atrás

- Funções: republicar o commit anterior (`dc0195d` no back-api).
- Migração: não destrutiva até o `--cleanup`; antes dele, o backend antigo ainda lê `businesses.menu`.
- InfinitePay: desmarcar "Habilitar pagamento via InfinitePay" volta ao Pix local (a chave Pix continua guardada).
