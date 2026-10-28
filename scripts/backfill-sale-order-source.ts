/**
 * Preenche `sales.orderSource` nas vendas de encomenda antigas, copiando
 * `orders.source` da encomenda de origem.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-sale-order-source.ts          # so mostra o plano
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-sale-order-source.ts --apply  # grava
 *
 * Idempotente: so toca vendas com `orderId` e sem `orderSource`. Encomenda
 * sem `source` (anterior ao campo) e INTERNO, o padrao do schema.
 *
 * Requires MONGODB_URI (.env).
 */

import * as dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';

async function main() {
  const apply = process.argv.includes('--apply');
  await mongoose.connect(process.env.MONGODB_URI as string);
  const db = mongoose.connection.db!;
  const sales = db.collection('sales');
  const orders = db.collection('orders');

  const pending = await sales
    .find({ orderId: { $exists: true }, orderSource: { $exists: false } })
    .project({ orderId: 1 })
    .toArray();
  console.log(`${pending.length} venda(s) sem origem.`);

  const counts = { INTERNO: 0, CARDAPIO: 0 };
  for (const sale of pending) {
    const order = await orders.findOne(
      { _id: sale.orderId },
      { projection: { source: 1 } },
    );
    const source: 'INTERNO' | 'CARDAPIO' =
      order?.source === 'CARDAPIO' ? 'CARDAPIO' : 'INTERNO';
    counts[source]++;
    if (apply) {
      await sales.updateOne({ _id: sale._id }, { $set: { orderSource: source } });
    }
  }
  console.log(counts, apply ? 'GRAVADO' : '(simulacao: use --apply)');
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
