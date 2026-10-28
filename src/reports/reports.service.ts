import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Sale, SaleDocument, SaleStatus } from '../sales/schemas/sale.schema';
import {
  StockMovement,
  StockMovementDocument,
  MovementType,
} from '../stock-movements/schemas/stock-movement.schema';
import { Expense, ExpenseDocument } from '../expenses/schemas/expense.schema';
import { BusinessService } from '../business/business.service';
import {
  pureDateFilter,
  zonedDateString,
  zonedEndOfDay,
  zonedStartOfDay,
} from '../common/date/timezone.util';
import { normalizeCampaignName } from '../common/campaigns/campaign.util';

@Injectable()
export class ReportsService {
  constructor(
    @InjectModel(Sale.name) private readonly saleModel: Model<SaleDocument>,
    @InjectModel(StockMovement.name)
    private readonly movementModel: Model<StockMovementDocument>,
    @InjectModel(Expense.name)
    private readonly expenseModel: Model<ExpenseDocument>,
    private readonly businessService: BusinessService,
  ) {}

  async getOverview(
    businessId: string,
    dateFrom?: string,
    dateTo?: string,
    campaign?: string,
  ): Promise<{
    totalRevenue: number;
    totalProfit: number;
    profitMargin: number;
    count: number;
    avgTicket: number;
    cancelledCount: number;
    cancelledRevenue: number;
  }> {
    const match = this.buildMatch(
      businessId,
      [SaleStatus.CONCLUIDA],
      dateFrom,
      dateTo,
      campaign,
    );
    const cancelMatch = this.buildMatch(
      businessId,
      [SaleStatus.CANCELADA],
      dateFrom,
      dateTo,
      campaign,
    );

    const [result, cancelResult] = await Promise.all([
      this.saleModel.aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            totalRevenue: { $sum: '$total' },
            totalProfit: { $sum: '$totalProfit' },
            count: { $sum: 1 },
          },
        },
      ]),
      this.saleModel.aggregate([
        { $match: cancelMatch },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            revenue: { $sum: '$total' },
          },
        },
      ]),
    ]);

    const s = result[0] ?? { totalRevenue: 0, totalProfit: 0, count: 0 };
    const c = cancelResult[0] ?? { count: 0, revenue: 0 };

    return {
      totalRevenue: s.totalRevenue,
      totalProfit: s.totalProfit,
      profitMargin:
        s.totalRevenue > 0 ? (s.totalProfit / s.totalRevenue) * 100 : 0,
      count: s.count,
      avgTicket: s.count > 0 ? s.totalRevenue / s.count : 0,
      cancelledCount: c.count,
      cancelledRevenue: c.revenue,
    };
  }

  async getPeriodComparison(
    businessId: string,
    dateFrom?: string,
    dateTo?: string,
    campaign?: string,
  ): Promise<{
    current: {
      revenue: number;
      profit: number;
      count: number;
      avgTicket: number;
    };
    previous: {
      revenue: number;
      profit: number;
      count: number;
      avgTicket: number;
    };
    growth: {
      revenue: number;
      profit: number;
      count: number;
      avgTicket: number;
    };
  }> {
    const tz = await this.businessService.getTimezone(businessId);
    const { from, to } = this.parseDateRange(dateFrom, dateTo, tz);
    const diffMs = to.getTime() - from.getTime();

    const prevTo = new Date(from.getTime() - 1);
    const prevFrom = new Date(prevTo.getTime() - diffMs);

    // A comparacao respeita a campaign ativa — senao os cards da visao geral
    // mostrariam o faturamento da campanha com uma variacao calculada em cima
    // do periodo inteiro.
    const [current, previous] = await Promise.all([
      this.getOverviewRaw(
        businessId,
        from.toISOString(),
        to.toISOString(),
        campaign,
      ),
      this.getOverviewRaw(
        businessId,
        prevFrom.toISOString(),
        prevTo.toISOString(),
        campaign,
      ),
    ]);

    const growth = (curr: number, prev: number) =>
      prev > 0 ? ((curr - prev) / prev) * 100 : curr > 0 ? 100 : 0;

    return {
      current,
      previous,
      growth: {
        revenue: growth(current.revenue, previous.revenue),
        profit: growth(current.profit, previous.profit),
        count: growth(current.count, previous.count),
        avgTicket: growth(current.avgTicket, previous.avgTicket),
      },
    };
  }

  async getSalesByPeriod(
    businessId: string,
    dateFrom?: string,
    dateTo?: string,
    groupBy: 'day' | 'week' | 'month' = 'day',
    campaign?: string,
  ): Promise<
    { period: string; revenue: number; profit: number; count: number }[]
  > {
    const tz = await this.businessService.getTimezone(businessId);
    const match = this.buildMatch(
      businessId,
      [SaleStatus.CONCLUIDA],
      dateFrom,
      dateTo,
      campaign,
    );
    const dateFormat =
      groupBy === 'month' ? '%Y-%m' : groupBy === 'week' ? '%Y-%V' : '%Y-%m-%d';

    const result = await this.saleModel.aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            $dateToString: {
              format: dateFormat,
              date: '$createdAt',
              timezone: tz,
            },
          },
          revenue: { $sum: '$total' },
          profit: { $sum: '$totalProfit' },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    return result.map((r) => ({
      period: r._id as string,
      revenue: r.revenue,
      profit: r.profit,
      count: r.count,
    }));
  }

  async getTopProducts(
    businessId: string,
    dateFrom?: string,
    dateTo?: string,
    limit = 10,
    campaign?: string,
  ): Promise<
    {
      productId: string;
      productName: string;
      totalRevenue: number;
      totalQty: number;
      totalProfit: number;
    }[]
  > {
    const match = this.buildMatch(
      businessId,
      [SaleStatus.CONCLUIDA],
      dateFrom,
      dateTo,
      campaign,
    );

    const result = await this.saleModel.aggregate([
      { $match: match },
      { $unwind: '$items' },
      {
        $group: {
          _id: {
            productId: '$items.productId',
            productName: '$items.productName',
          },
          totalRevenue: { $sum: '$items.subtotal' },
          totalQty: { $sum: '$items.quantity' },
          totalProfit: { $sum: '$items.profit' },
        },
      },
      { $sort: { totalRevenue: -1 } },
      { $limit: limit },
    ]);

    return result.map((r) => ({
      productId: (r._id.productId as Types.ObjectId).toString(),
      productName: r._id.productName as string,
      totalRevenue: r.totalRevenue,
      totalQty: r.totalQty,
      totalProfit: r.totalProfit,
    }));
  }

  async getABCCurve(
    businessId: string,
    dateFrom?: string,
    dateTo?: string,
    campaign?: string,
  ): Promise<
    {
      productId: string;
      productName: string;
      totalRevenue: number;
      totalQty: number;
      totalProfit: number;
      margin: number;
      revenueShare: number;
      cumulativeShare: number;
      abc: 'A' | 'B' | 'C';
    }[]
  > {
    const match = this.buildMatch(
      businessId,
      [SaleStatus.CONCLUIDA],
      dateFrom,
      dateTo,
      campaign,
    );

    const result = await this.saleModel.aggregate([
      { $match: match },
      { $unwind: '$items' },
      {
        $group: {
          _id: {
            productId: '$items.productId',
            productName: '$items.productName',
          },
          totalRevenue: { $sum: '$items.subtotal' },
          totalQty: { $sum: '$items.quantity' },
          totalProfit: { $sum: '$items.profit' },
        },
      },
      { $sort: { totalRevenue: -1 } },
    ]);

    const grandTotal = result.reduce((sum, r) => sum + r.totalRevenue, 0);
    let cumulative = 0;

    return result.map((r) => {
      const revenueShare =
        grandTotal > 0 ? (r.totalRevenue / grandTotal) * 100 : 0;
      cumulative += revenueShare;
      const abc: 'A' | 'B' | 'C' =
        cumulative <= 80 ? 'A' : cumulative <= 95 ? 'B' : 'C';
      return {
        productId: (r._id.productId as Types.ObjectId).toString(),
        productName: r._id.productName as string,
        totalRevenue: r.totalRevenue,
        totalQty: r.totalQty,
        totalProfit: r.totalProfit,
        margin: r.totalRevenue > 0 ? (r.totalProfit / r.totalRevenue) * 100 : 0,
        revenueShare,
        cumulativeShare: cumulative,
        abc,
      };
    });
  }

  async getWasteReport(
    businessId: string,
    dateFrom?: string,
    dateTo?: string,
  ): Promise<{
    totalWasteQty: number;
    totalSoldQty: number;
    wasteRate: number;
    byProduct: {
      productId: string;
      productName: string;
      wasteQty: number;
      soldQty: number;
      wasteRate: number;
    }[];
  }> {
    const matchBase: Record<string, unknown> = {
      businessId: new Types.ObjectId(businessId),
    };
    if (dateFrom || dateTo) {
      const dateFilter: Record<string, Date> = {};
      if (dateFrom) dateFilter.$gte = new Date(dateFrom);
      if (dateTo) dateFilter.$lte = new Date(dateTo);
      matchBase.createdAt = dateFilter;
    }

    const result = await this.movementModel.aggregate([
      { $match: matchBase },
      {
        $match: {
          type: { $in: [MovementType.DESPERDICIO, MovementType.VENDA] },
        },
      },
      {
        $group: {
          _id: {
            productId: '$productId',
            productName: '$productName',
            type: '$type',
          },
          qty: { $sum: '$quantity' },
        },
      },
      {
        $group: {
          _id: { productId: '$_id.productId', productName: '$_id.productName' },
          metrics: { $push: { type: '$_id.type', qty: '$qty' } },
        },
      },
    ]);

    let totalWasteQty = 0;
    let totalSoldQty = 0;

    const byProduct = result.map((r) => {
      const wasteMetric = r.metrics.find(
        (m: { type: string }) => m.type === MovementType.DESPERDICIO,
      );
      const soldMetric = r.metrics.find(
        (m: { type: string }) => m.type === MovementType.VENDA,
      );
      const wasteQty = wasteMetric?.qty ?? 0;
      const soldQty = soldMetric?.qty ?? 0;
      totalWasteQty += wasteQty;
      totalSoldQty += soldQty;
      const produced = wasteQty + soldQty;
      return {
        productId: (r._id.productId as Types.ObjectId).toString(),
        productName: r._id.productName as string,
        wasteQty,
        soldQty,
        wasteRate: produced > 0 ? (wasteQty / produced) * 100 : 0,
      };
    });

    const totalProduced = totalWasteQty + totalSoldQty;

    return {
      totalWasteQty,
      totalSoldQty,
      wasteRate: totalProduced > 0 ? (totalWasteQty / totalProduced) * 100 : 0,
      byProduct: byProduct.sort((a, b) => b.wasteRate - a.wasteRate),
    };
  }

  async getBreakeven(
    businessId: string,
    dateFrom?: string,
    dateTo?: string,
  ): Promise<{
    fixedCosts: number;
    variableCosts: number;
    totalCosts: number;
    revenue: number;
    profit: number;
    breakevenRevenue: number;
    surplusOrDeficit: number;
    isBeyondBreakeven: boolean;
  }> {
    const tz = await this.businessService.getTimezone(businessId);
    const [expenseSummary, overview] = await Promise.all([
      this.getExpenseSummaryRaw(businessId, dateFrom, dateTo, tz),
      this.getOverviewRaw(businessId, dateFrom, dateTo),
    ]);

    const totalCosts = expenseSummary.total;
    const productCosts = overview.revenue - overview.profit;
    const breakevenRevenue = totalCosts + productCosts;

    return {
      fixedCosts: expenseSummary.totalFixed,
      variableCosts: expenseSummary.totalVariable,
      totalCosts,
      revenue: overview.revenue,
      profit: overview.profit - totalCosts,
      breakevenRevenue,
      surplusOrDeficit: overview.revenue - breakevenRevenue,
      isBeyondBreakeven: overview.revenue >= breakevenRevenue,
    };
  }

  async getCashFlow(
    businessId: string,
    dateFrom?: string,
    dateTo?: string,
  ): Promise<{
    entries: {
      date: string;
      amount: number;
      type: 'in' | 'out';
      description: string;
    }[];
    dailySummary: {
      date: string;
      totalIn: number;
      totalOut: number;
      balance: number;
    }[];
    totalIn: number;
    totalOut: number;
    netBalance: number;
  }> {
    const tz = await this.businessService.getTimezone(businessId);
    const { from, to } = this.parseDateRange(dateFrom, dateTo, tz);

    const saleDateFilter: Record<string, Date> = { $gte: from, $lte: to };
    // Expense.date e gravado como meia-noite UTC de um dia puro — alinha o filtro a isso.
    const expenseDateFilter = pureDateFilter(dateFrom, dateTo, tz) ?? {
      $gte: from,
      $lte: to,
    };

    const [salesRaw, expenses] = await Promise.all([
      this.saleModel.aggregate<{ total: number; createdAt: Date }>([
        {
          $match: {
            businessId: new Types.ObjectId(businessId),
            status: SaleStatus.CONCLUIDA,
            createdAt: saleDateFilter,
          },
        },
        { $project: { total: 1, createdAt: 1 } },
      ]),
      this.expenseModel
        .find({
          businessId: new Types.ObjectId(businessId),
          date: expenseDateFilter,
        })
        .select('amount date name')
        .lean(),
    ]);

    const entries: {
      date: string;
      amount: number;
      type: 'in' | 'out';
      description: string;
    }[] = [];

    for (const sale of salesRaw) {
      // Venda tem instante real: agrupa pelo dia no fuso do negocio.
      entries.push({
        date: zonedDateString(new Date(sale.createdAt), tz),
        amount: sale.total,
        type: 'in',
        description: 'Venda',
      });
    }
    for (const exp of expenses) {
      // Despesa e dia puro (meia-noite UTC): a data de calendario e a propria string UTC.
      entries.push({
        date: new Date(exp.date).toISOString().slice(0, 10),
        amount: exp.amount,
        type: 'out',
        description: exp.name,
      });
    }

    entries.sort((a, b) => a.date.localeCompare(b.date));

    // Build daily summary
    const dailyMap = new Map<string, { totalIn: number; totalOut: number }>();
    for (const e of entries) {
      const day = dailyMap.get(e.date) ?? { totalIn: 0, totalOut: 0 };
      if (e.type === 'in') day.totalIn += e.amount;
      else day.totalOut += e.amount;
      dailyMap.set(e.date, day);
    }

    const dailySummary = Array.from(dailyMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, { totalIn, totalOut }]) => ({
        date,
        totalIn,
        totalOut,
        balance: totalIn - totalOut,
      }));

    const totalIn = entries
      .filter((e) => e.type === 'in')
      .reduce((s, e) => s + e.amount, 0);
    const totalOut = entries
      .filter((e) => e.type === 'out')
      .reduce((s, e) => s + e.amount, 0);

    return {
      entries,
      dailySummary,
      totalIn,
      totalOut,
      netBalance: totalIn - totalOut,
    };
  }

  async getByChannel(
    businessId: string,
    dateFrom?: string,
    dateTo?: string,
    campaign?: string,
  ): Promise<
    {
      channel: string;
      revenue: number;
      profit: number;
      count: number;
      byPaymentMethod: {
        paymentMethod: string;
        revenue: number;
        count: number;
      }[];
    }[]
  > {
    const match = this.buildMatch(
      businessId,
      [SaleStatus.CONCLUIDA],
      dateFrom,
      dateTo,
      campaign,
    );

    const result = await this.saleModel.aggregate([
      { $match: match },
      {
        $facet: {
          byChannelPM: [
            {
              $group: {
                _id: { channel: '$channel', paymentMethod: '$paymentMethod' },
                revenue: { $sum: '$total' },
                profit: { $sum: '$totalProfit' },
                count: { $sum: 1 },
              },
            },
            {
              $group: {
                _id: '$_id.channel',
                revenue: { $sum: '$revenue' },
                profit: { $sum: '$profit' },
                count: { $sum: '$count' },
                byPaymentMethod: {
                  $push: {
                    paymentMethod: '$_id.paymentMethod',
                    revenue: '$revenue',
                    count: '$count',
                  },
                },
              },
            },
            { $sort: { revenue: -1 } },
          ],
        },
      },
    ]);

    const raw = result[0] as {
      byChannelPM: {
        _id: string;
        revenue: number;
        profit: number;
        count: number;
        byPaymentMethod: {
          paymentMethod: string;
          revenue: number;
          count: number;
        }[];
      }[];
    };

    return (raw.byChannelPM ?? []).map((c) => ({
      channel: c._id,
      revenue: c.revenue,
      profit: c.profit,
      count: c.count,
      byPaymentMethod: c.byPaymentMethod.sort((a, b) => b.revenue - a.revenue),
    }));
  }

  // ---- Private helpers ----

  private async getOverviewRaw(
    businessId: string,
    dateFrom?: string,
    dateTo?: string,
    campaign?: string,
  ): Promise<{
    revenue: number;
    profit: number;
    count: number;
    avgTicket: number;
  }> {
    const match = this.buildMatch(
      businessId,
      [SaleStatus.CONCLUIDA],
      dateFrom,
      dateTo,
      campaign,
    );
    const result = await this.saleModel.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          revenue: { $sum: '$total' },
          profit: { $sum: '$totalProfit' },
          count: { $sum: 1 },
        },
      },
    ]);
    const s = result[0] ?? { revenue: 0, profit: 0, count: 0 };
    return {
      revenue: s.revenue,
      profit: s.profit,
      count: s.count,
      avgTicket: s.count > 0 ? s.revenue / s.count : 0,
    };
  }

  private async getExpenseSummaryRaw(
    businessId: string,
    dateFrom: string | undefined,
    dateTo: string | undefined,
    tz: string,
  ): Promise<{ total: number; totalFixed: number; totalVariable: number }> {
    const match: Record<string, unknown> = {
      businessId: new Types.ObjectId(businessId),
    };
    const dateFilter = pureDateFilter(dateFrom, dateTo, tz);
    if (dateFilter) match.date = dateFilter;
    const result = await this.expenseModel.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          total: { $sum: '$amount' },
          totalFixed: {
            $sum: { $cond: [{ $eq: ['$type', 'FIXO'] }, '$amount', 0] },
          },
          totalVariable: {
            $sum: { $cond: [{ $eq: ['$type', 'VARIAVEL'] }, '$amount', 0] },
          },
        },
      },
    ]);
    return result[0] ?? { total: 0, totalFixed: 0, totalVariable: 0 };
  }

  private parseDateRange(
    dateFrom: string | undefined,
    dateTo: string | undefined,
    tz: string,
  ): { from: Date; to: Date } {
    // Quando o cliente envia os limites (caso normal), usa exatamente o que veio —
    // nao re-ancorar com setHours() sobre um instante ja parseado (dependia do TZ do servidor).
    if (dateFrom && dateTo)
      return { from: new Date(dateFrom), to: new Date(dateTo) };
    // Sem limites: ultimos 30 dias contados no fuso do negocio (o servidor roda em UTC).
    const now = new Date();
    const to = dateTo
      ? new Date(dateTo)
      : zonedEndOfDay(zonedDateString(now, tz), tz);
    const from = dateFrom
      ? new Date(dateFrom)
      : zonedStartOfDay(
          zonedDateString(new Date(now.getTime() - 29 * 86_400_000), tz),
          tz,
        );
    return { from, to };
  }

  private buildMatch(
    businessId: string,
    statuses: SaleStatus[],
    dateFrom?: string,
    dateTo?: string,
    campaign?: string,
  ): Record<string, unknown> {
    const match: Record<string, unknown> = {
      businessId: new Types.ObjectId(businessId),
      status: { $in: statuses },
    };
    // Filtro de campanha (#NATAL2025): a campaign e gravada normalizada na venda.
    if (campaign) {
      const normalized = normalizeCampaignName(campaign);
      if (normalized) match.tags = normalized;
    }
    if (dateFrom || dateTo) {
      const dateFilter: Record<string, Date> = {};
      if (dateFrom) dateFilter.$gte = new Date(dateFrom);
      if (dateTo) dateFilter.$lte = new Date(dateTo);
      match.createdAt = dateFilter;
    }
    return match;
  }
}
