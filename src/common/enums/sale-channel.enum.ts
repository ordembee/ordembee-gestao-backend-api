export enum SaleChannel {
  CAIXA = 'CAIXA',
  IFOOD = 'IFOOD',
  FOOD99 = 'FOOD99',
  DELIVERY_PROPRIO = 'DELIVERY_PROPRIO',
  /**
   * Canal "OrdemBee": venda gerada pela entrega de um pedido do modulo `orders`,
   * vindo do cardapio digital ou digitado pelo operador na plataforma. Vendas
   * do PDV (inclusive de pedidos online) seguem nos canais acima, para o
   * batimento de caixa.
   */
  ENCOMENDA = 'ENCOMENDA',
}
