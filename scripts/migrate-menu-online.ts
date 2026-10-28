/**
 * Migra o cardapio digital de `businesses.menu` para a colecao `menuonlines`
 * e as integracoes (Uber, Pix) para `businesses.config`.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/migrate-menu-online.ts            # so mostra o plano
 *   npx ts-node -r tsconfig-paths/register scripts/migrate-menu-online.ts --apply    # grava
 *   npx ts-node -r tsconfig-paths/register scripts/migrate-menu-online.ts --cleanup  # remove businesses.menu
 *
 * Idempotente: negocio que ja tem documento em `menuonlines` e pulado. O
 * `--cleanup` so roda depois do --apply, com o backend novo no ar (o antigo
 * ainda le `businesses.menu`).
 *
 * - Selos (`items[].tag`) e ordem de produtos (`items[].order`) deixam de existir.
 * - A ordem das categorias nasce da ordem antiga dos produtos (menor ordem
 *   entre os produtos de cada categoria), para o cardapio nao mudar de cara.
 * - A logo do cardapio nasce igual a logo do negocio (`businesses.logoUrl`).
 *
 * Requires MONGODB_URI (.env).
 */

import * as dotenv from 'dotenv';
dotenv.config();

import mongoose, { Types } from 'mongoose';

type OldItem = {
  productId: Types.ObjectId;
  active?: boolean;
  tag?: string;
  order?: number;
  optionGroupIds?: Types.ObjectId[];
};

type OldBusiness = {
  _id: Types.ObjectId;
  name: string;
  logoUrl?: string;
  config?: { uber?: unknown; pix?: unknown };
  menu?: Record<string, any> & { items?: OldItem[] };
};

const apply = process.argv.includes('--apply');
const cleanup = process.argv.includes('--cleanup');

/** Remove chaves undefined (o driver gravaria null). */
function compact<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as T;
}

async function categoryOrder(
  db: mongoose.mongo.Db,
  items: OldItem[],
): Promise<{ categoryId: Types.ObjectId; order: number }[]> {
  const withOrder = items.filter((i) => typeof i.order === 'number');
  if (!withOrder.length) return [];
  const products = await db
    .collection('products')
    .find(
      { _id: { $in: withOrder.map((i) => i.productId) } },
      { projection: { categoryId: 1 } },
    )
    .toArray();
  const categoryOf = new Map(
    products.map((p) => [String(p._id), p.categoryId as Types.ObjectId]),
  );
  const rank = new Map<string, { id: Types.ObjectId; order: number }>();
  for (const item of withOrder) {
    const categoryId = categoryOf.get(String(item.productId));
    if (!categoryId) continue;
    const current = rank.get(String(categoryId));
    if (!current || item.order! < current.order) {
      rank.set(String(categoryId), { id: categoryId, order: item.order! });
    }
  }
  return [...rank.values()]
    .sort((a, b) => a.order - b.order)
    .map((c, order) => ({ categoryId: c.id, order }));
}

async function toMenuOnline(db: mongoose.mongo.Db, b: OldBusiness) {
  const m = b.menu ?? {};
  const items = m.items ?? [];
  const now = new Date();
  return {
    businessId: b._id,
    ...compact({ slug: m.slug }),
    enabled: !!m.enabled,
    categories: await categoryOrder(db, items),
    items: items.map((i) => ({
      productId: i.productId,
      active: !!i.active,
      optionGroupIds: i.optionGroupIds ?? [],
    })),
    optionGroups: m.optionGroups ?? [],
    store: {
      ...compact({ acceptedPayments: m.acceptedPayments }),
      delivery: {
        deliveryProvider: m.deliveryProvider ?? 'PROPRIA',
        deliveryFee: m.deliveryFee ?? 0,
        deliveryEnabled: m.deliveryEnabled !== false,
        pickupEnabled: m.pickupEnabled !== false,
      },
      contact: compact({ address: m.address, whatsapp: m.whatsapp }),
      socialMedia: compact({ instagram: m.instagram }),
      images: compact({ coverUrl: m.coverUrl, logoUrl: b.logoUrl }),
      colors: compact({ themeColor: m.themeColor }),
      openingHours: m.openingHours ?? {},
    },
    labelText: compact({
      description: m.description,
      highlightLabel: m.highlightLabel,
      highlightTitle: m.highlightTitle,
    }),
    publication: {
      version: m.publishedVersion ?? 0,
      lastPublishedAt: m.lastPublishedAt ?? null,
      slug: m.publishedSlug ?? null,
      hash: m.publishedHash ?? null,
    },
    createdAt: now,
    updatedAt: now,
  };
}

async function migrate(db: mongoose.mongo.Db) {
  const businesses = db.collection<OldBusiness>('businesses');
  const menus = db.collection('menuonlines');
  const list = await businesses.find({ menu: { $exists: true } }).toArray();
  console.log(`${list.length} negócio(s) com businesses.menu`);

  for (const b of list) {
    const label = `${b.name} (${String(b._id)})`;
    if (await menus.findOne({ businessId: b._id })) {
      console.log(`- ${label}: já migrado, pulando`);
      continue;
    }
    const doc = await toMenuOnline(db, b);
    const config = compact({
      'config.uber': b.menu?.uberDirect,
      'config.pix': b.menu?.pix,
    });
    const tags = (b.menu?.items ?? []).filter((i) => i.tag).length;
    console.log(
      `- ${label}: slug=${doc.slug ?? '—'} itens=${doc.items.length} grupos=${doc.optionGroups.length} ` +
        `categorias ordenadas=${doc.categories.length} selos descartados=${tags} ` +
        `config=${Object.keys(config).join(',') || '—'}`,
    );
    if (!apply) continue;
    await menus.insertOne(doc);
    if (Object.keys(config).length) {
      await businesses.updateOne({ _id: b._id }, { $set: config });
    }
  }
}

async function removeOldMenu(db: mongoose.mongo.Db) {
  const businesses = db.collection('businesses');
  const pending = await businesses
    .find({ menu: { $exists: true } }, { projection: { _id: 1, name: 1 } })
    .toArray();
  const menus = db.collection('menuonlines');
  for (const b of pending) {
    if (!(await menus.findOne({ businessId: b._id }))) {
      throw new Error(
        `${b.name} (${String(b._id)}) ainda não foi migrado — rode --apply antes`,
      );
    }
  }
  const { modifiedCount } = await businesses.updateMany(
    { menu: { $exists: true } },
    { $unset: { menu: '' } },
  );
  console.log(`businesses.menu removido de ${modifiedCount} negócio(s)`);
  const indexes = await businesses.indexes();
  if (indexes.some((i) => i.name === 'menu.slug_1')) {
    await businesses.dropIndex('menu.slug_1');
    console.log('índice menu.slug_1 removido');
  }
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI!);
  const db = mongoose.connection.db!;
  console.log(`Conectado em ${db.databaseName}`);
  if (cleanup) await removeOldMenu(db);
  else {
    await migrate(db);
    if (!apply) console.log('\nNada gravado. Rode com --apply para migrar.');
  }
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
