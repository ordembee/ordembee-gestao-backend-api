import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Expense, ExpenseDocument } from './schemas/expense.schema';
import { CreateExpenseDto, UpdateExpenseDto } from './dto/expense.dto';
import { BusinessService } from '../business/business.service';
import {
  pureDateFilter,
  pureDateCurrentMonthFilter,
  toYmd,
  utcDayStart,
} from '../common/date/timezone.util';

export const OPERATIONAL_HOURS_PER_MONTH = 168;

@Injectable()
export class ExpensesService {
  constructor(
    @InjectModel(Expense.name)
    private readonly expenseModel: Model<ExpenseDocument>,
    private readonly businessService: BusinessService,
  ) {}

  async create(businessId: string, dto: CreateExpenseDto): Promise<Expense> {
    const tz = await this.businessService.getTimezone(businessId);
    const expense = new this.expenseModel({
      ...dto,
      // Data pura: normaliza para meia-noite UTC do dia de calendario informado.
      date: utcDayStart(toYmd(dto.date, tz)),
      businessId: new Types.ObjectId(businessId),
    });
    return expense.save();
  }

  async findAll(
    businessId: string,
    dateFrom?: string,
    dateTo?: string,
    category?: string,
  ): Promise<Expense[]> {
    const tz = await this.businessService.getTimezone(businessId);
    const filter: Record<string, unknown> = {
      businessId: new Types.ObjectId(businessId),
    };
    const dateFilter = pureDateFilter(dateFrom, dateTo, tz);
    if (dateFilter) filter.date = dateFilter;
    if (category) filter.category = category;

    return this.expenseModel.find(filter).sort({ date: -1 }).lean();
  }

  async findOne(id: string, businessId: string): Promise<Expense> {
    const expense = await this.expenseModel.findOne({
      _id: new Types.ObjectId(id),
      businessId: new Types.ObjectId(businessId),
    });
    if (!expense) throw new NotFoundException('Despesa não encontrada');
    return expense;
  }

  async update(
    id: string,
    businessId: string,
    dto: UpdateExpenseDto,
  ): Promise<Expense> {
    const update: Record<string, unknown> = { ...dto };
    if (dto.date) {
      const tz = await this.businessService.getTimezone(businessId);
      update.date = utcDayStart(toYmd(dto.date, tz));
    }

    const expense = await this.expenseModel.findOneAndUpdate(
      {
        _id: new Types.ObjectId(id),
        businessId: new Types.ObjectId(businessId),
      },
      { $set: update },
      { new: true },
    );
    if (!expense) throw new NotFoundException('Despesa não encontrada');
    return expense;
  }

  async remove(id: string, businessId: string): Promise<void> {
    const result = await this.expenseModel.deleteOne({
      _id: new Types.ObjectId(id),
      businessId: new Types.ObjectId(businessId),
    });
    if (!result.deletedCount)
      throw new NotFoundException('Despesa não encontrada');
  }

  async getSummary(
    businessId: string,
    dateFrom?: string,
    dateTo?: string,
  ): Promise<{
    total: number;
    totalFixed: number;
    totalVariable: number;
    byCategory: { category: string; total: number }[];
  }> {
    const tz = await this.businessService.getTimezone(businessId);
    const match: Record<string, unknown> = {
      businessId: new Types.ObjectId(businessId),
    };
    const dateFilter = pureDateFilter(dateFrom, dateTo, tz);
    if (dateFilter) match.date = dateFilter;

    const [result] = await this.expenseModel.aggregate([
      { $match: match },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                total: { $sum: '$amount' },
                totalFixed: {
                  $sum: { $cond: [{ $eq: ['$type', 'FIXO'] }, '$amount', 0] },
                },
                totalVariable: {
                  $sum: {
                    $cond: [{ $eq: ['$type', 'VARIAVEL'] }, '$amount', 0],
                  },
                },
              },
            },
          ],
          byCategory: [
            { $group: { _id: '$category', total: { $sum: '$amount' } } },
            { $sort: { total: -1 } },
          ],
        },
      },
    ]);

    const t = result?.totals?.[0] ?? {
      total: 0,
      totalFixed: 0,
      totalVariable: 0,
    };
    return {
      total: t.total,
      totalFixed: t.totalFixed,
      totalVariable: t.totalVariable,
      byCategory: (result?.byCategory ?? []).map(
        (c: { _id: string; total: number }) => ({
          category: c._id,
          total: c.total,
        }),
      ),
    };
  }

  async sumOperational(
    businessId: string,
    dateFrom: Date,
    dateTo: Date,
  ): Promise<number> {
    const [result] = await this.expenseModel.aggregate([
      {
        $match: {
          businessId: new Types.ObjectId(businessId),
          isOperational: true,
          date: { $gte: dateFrom, $lte: dateTo },
        },
      },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    return result?.total ?? 0;
  }

  async getCurrentMonthOperationalCost(businessId: string): Promise<{
    total: number;
    hourlyRate: number;
    periodStart: Date;
    periodEnd: Date;
  }> {
    const tz = await this.businessService.getTimezone(businessId);
    const { $gte: start, $lte: end } = pureDateCurrentMonthFilter(tz);
    const total = await this.sumOperational(businessId, start, end);
    return {
      total,
      hourlyRate: total / OPERATIONAL_HOURS_PER_MONTH,
      periodStart: start,
      periodEnd: end,
    };
  }
}
