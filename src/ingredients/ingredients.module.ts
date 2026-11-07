import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { IngredientsController } from './ingredients.controller';
import { IngredientsService } from './ingredients.service';
import { Ingredient, IngredientSchema } from './schemas/ingredient.schema';
import {
  IngredientPriceHistory,
  IngredientPriceHistorySchema,
} from './schemas/ingredient-price-history.schema';
import { Pricing, PricingSchema } from '../pricings/schemas/pricing.schema';
import { ExpensesModule } from '../expenses/expenses.module';
import { BusinessModule } from '../business/business.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Ingredient.name, schema: IngredientSchema },
      {
        name: IngredientPriceHistory.name,
        schema: IngredientPriceHistorySchema,
      },
      // Só o schema (não o PricingsModule inteiro) — usado apenas para checar
      // se um ingrediente está referenciado por uma precificação ativa antes
      // de removê-lo, evitando um ciclo de injeção de dependência.
      { name: Pricing.name, schema: PricingSchema },
    ]),
    // Usado para sincronizar o ingrediente de sistema "Custo Operacional" a
    // partir das despesas marcadas como operacionais.
    ExpensesModule,
    // Checa a permissao canEditIngredientPrices do Caixa.
    BusinessModule,
  ],
  controllers: [IngredientsController],
  providers: [IngredientsService],
  exports: [IngredientsService],
})
export class IngredientsModule {}
