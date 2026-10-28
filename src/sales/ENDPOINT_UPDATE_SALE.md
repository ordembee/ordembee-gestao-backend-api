# Endpoint PATCH /sales/:id - Editar Venda Completa

## Descrição

Edita uma venda completa com validações no servidor. Permite atualizar data, canal de venda, itens (produtos, quantidades, preços) e formas de pagamento.

## Rota

```
PATCH /sales/:id
```

## Autorização

- **Role obrigatória:** `OWNER`
- Apenas proprietários podem editar vendas completas

## Request Body (UpdateSaleDto)

### Campos Opcionais (pelo menos um deve ser fornecido)

```typescript
{
  createdAt?: string;          // ISO 8601 format (ex: "2026-08-19T14:30:00Z")
  channel?: string;            // Enum: "CAIXA" | "IFOOD" | "FOOD99" | "DELIVERY_PROPRIO"
  items?: Array<{              // Array de itens da venda
    productId: string;         // MongoDB ObjectId do produto
    unitPrice: number;         // Preço unitário (>= 0)
    quantity: number;          // Quantidade (>= 1)
  }>;
  payments?: Array<{           // Array de pagamentos
    method: string;            // Enum: "DINHEIRO" | "CARTAO_CREDITO" | "CARTAO_DEBITO" | "PIX" | "FIADO"
    amount: number;            // Valor do pagamento (>= 0)
  }>;
  notes?: string;              // Observações da venda
}
```

## Validações Realizadas no Servidor

### 1. Validações de Negócio

- ✅ Venda deve existir e pertencer ao negócio do usuário
- ✅ **Bloqueio:** Não é possível editar vendas com status `CANCELADA`
- ✅ `createdAt` não pode ser uma data futura
- ✅ `createdAt` deve ser uma data válida (ISO 8601)

### 2. Cálculos Automáticos

- ✅ **Subtotal de cada item:** `unitPrice × quantity`
- ✅ **Total da venda:** `sum(itens.subtotal)`
- ✅ **Lucro total:** calculado com base em preços de custo

### 3. Validação de Pagamentos

- ✅ **Obrigatorio:** `sum(payments.amount) === total da venda`
- ✅ Erro 400 se houver divergência (com valor esperado no mensagem)
- ✅ Se apenas itens são atualizados: pagamentos existentes devem corresponder ao novo total
- ✅ Se pagamentos não são fornecidos mas itens mudaram de valor: erro descritivo

### 4. Movimentação de Estoque

- ✅ Se quantidade de item mudar: gera `StockMovement` tipo `AJUSTE`
- ✅ Registro: `Ajuste venda #<id> (<qty_antiga> → <qty_nova>)`
- ✅ Quantidade ajustada: `|qty_nova - qty_antiga|`
- ✅ Estoque nunca vai abaixo de 0

### 5. Auditoria

- ✅ Registra quem editou (userId do usuário autenticado)
- ✅ Registra quando editou (updatedAt do documento)

## Response (200 OK)

Retorna o objeto `Sale` completo atualizado:

```typescript
{
  _id: string;                    // ID da venda
  items: Array<{
    productId: string;
    productName: string;
    unitPrice: number;
    costPrice: number;
    quantity: number;
    subtotal: number;
    profit: number;
    comboComponents: Array<...>;  // Componentes de combo, se aplicável
  }>;
  total: number;                  // Total recalculado
  channel: string;                // Canal de venda
  payments: Array<{
    method: string;
    amount: number;
  }>;
  status: string;                 // PENDENTE | CONCLUIDA | CANCELADA
  businessId: string;
  userId: string;                 // Quem criou a venda (original)
  totalProfit: number;
  notes?: string;
  createdAt: Date;                // Data da venda (pode ter sido atualizada)
  updatedAt: Date;                // Data da última atualização (nova)
}
```

## Exemplos de Uso

### Exemplo 1: Atualizar apenas quantidade de um item

```bash
PATCH /sales/507f1f77bcf86cd799439011
Authorization: Bearer <token>
Content-Type: application/json

{
  "items": [
    {
      "productId": "507f1f77bcf86cd799439012",
      "unitPrice": 25.90,
      "quantity": 3
    }
  ],
  "payments": [
    {
      "method": "DINHEIRO",
      "amount": 77.70
    }
  ]
}
```

**Resultado:** Subtotal recalculado (25.90 × 3 = 77.70), estoque ajustado, StockMovement criado.

### Exemplo 2: Atualizar múltiplos itens e pagamentos

```bash
PATCH /sales/507f1f77bcf86cd799439011
Authorization: Bearer <token>
Content-Type: application/json

{
  "items": [
    {
      "productId": "507f1f77bcf86cd799439012",
      "unitPrice": 25.90,
      "quantity": 2
    },
    {
      "productId": "507f1f77bcf86cd799439013",
      "unitPrice": 15.50,
      "quantity": 1
    }
  ],
  "payments": [
    {
      "method": "DINHEIRO",
      "amount": 66.80
    }
  ]
}
```

**Resultado:** Total = (25.90 × 2) + (15.50 × 1) = 66.80 ✅

### Exemplo 3: Atualizar data da venda

```bash
PATCH /sales/507f1f77bcf86cd799439011
Authorization: Bearer <token>
Content-Type: application/json

{
  "createdAt": "2026-08-18T10:30:00Z"
}
```

**Resultado:** Data da venda atualizada (sem alterar itens ou pagamentos).

### Exemplo 4: Erro - Soma de pagamentos incorreta

```bash
PATCH /sales/507f1f77bcf86cd799439011
Authorization: Bearer <token>
Content-Type: application/json

{
  "items": [
    {
      "productId": "507f1f77bcf86cd799439012",
      "unitPrice": 25.90,
      "quantity": 2
    }
  ],
  "payments": [
    {
      "method": "DINHEIRO",
      "amount": 50.00  // Esperado: 51.80
    }
  ]
}
```

**Resultado:**

```json
{
  "statusCode": 400,
  "message": "A soma dos pagamentos deve ser igual ao total da venda (R$ 51.80)",
  "error": "Bad Request"
}
```

### Exemplo 5: Erro - Venda cancelada

```bash
PATCH /sales/507f1f77bcf86cd799439011
```

**Resultado:**

```json
{
  "statusCode": 400,
  "message": "Não é possível editar uma venda cancelada",
  "error": "Bad Request"
}
```

## Erros Possíveis

| Status | Mensagem                                         | Causa                                        |
| ------ | ------------------------------------------------ | -------------------------------------------- |
| 400    | Não é possível editar uma venda cancelada        | Venda com status CANCELADA                   |
| 400    | A data da venda não pode ser no futuro           | createdAt é futuro                           |
| 400    | Data inválida                                    | createdAt formato inválido                   |
| 400    | Um ou mais produtos não foram encontrados        | Produto não existe                           |
| 400    | A soma dos pagamentos deve ser igual ao total... | Pagamentos não correspondem ao total         |
| 404    | Venda não encontrada                             | Venda não existe ou pertence a outro negócio |
| 403    | Forbidden                                        | Usuário não tem role OWNER                   |

## Diferenças vs. Endpoints Existentes

| Endpoint                    | Função               | Restrição                         |
| --------------------------- | -------------------- | --------------------------------- |
| `@Patch(':id')`             | **Editar completo**  | Nenhuma (itens, pagamentos, data) |
| `@Patch(':id/payments')`    | Editar só pagamentos | Apenas pagamentos                 |
| `@Patch(':id/cancel')`      | Cancelar venda       | Apenas cancela, restaura estoque  |
| `@Patch(':id/settle-debt')` | Quitar dívida        | Apenas marca como quitada         |

## StockMovements Gerados

Quando quantidade muda:

```typescript
{
  type: 'ajuste',
  productId: string;
  productName: string;
  quantity: number;           // |qty_nova - qty_antiga|
  reason: 'Ajuste venda #<id> (<oldQty> → <newQty>)',
  previousStock: number;
  newStock: number;
  saleId: string;
}
```

Exemplo: Se quantidade vai de 2 para 5 (+ 3 itens):

- StockMovement registra quantity = 3
- Estoque decrementado de 3 unidades

## Implementação no Frontend (Exemplo com Axios)

```typescript
async function updateSale(saleId: string, updateData: UpdateSaleDto) {
  try {
    const response = await axios.patch(`/sales/${saleId}`, updateData, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    return response.data; // Sale atualizada
  } catch (error) {
    if (error.response?.status === 400) {
      console.error('Erro de validação:', error.response.data.message);
    }
    throw error;
  }
}

// Uso
const updatedSale = await updateSale('507f1f77bcf86cd799439011', {
  items: [
    { productId: '507f1f77bcf86cd799439012', unitPrice: 25.9, quantity: 3 },
  ],
  payments: [{ method: 'DINHEIRO', amount: 77.7 }],
});
```

## Notas de Implementação

1. **Transações:** A operação não é transacional - se falhar na atualização de estoque, dados já terão sido salvos. Recomenda-se melhorar com transações do Mongoose em versões futuras.

2. **Performance:** Bulk updates de estoque poderiam ser otimizadas com aggregation pipeline.

3. **Validação de Data:** Usa timezone local do servidor. Recomenda-se normalizar para UTC no frontend.

4. **Segurança:** Apenas @Roles(Role.OWNER) pode acessar - role-based access control implementado.

5. **Auditoria:** Log informacional é registrado no console de aplicação com ID da venda e novo total.
