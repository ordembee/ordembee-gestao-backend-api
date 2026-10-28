import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { APP_GUARD } from '@nestjs/core';
import * as admin from 'firebase-admin';
import { AuthModule } from './auth/auth.module';
import { BusinessModule } from './business/business.module';
import { CategoriesModule } from './categories/categories.module';
import { CustomersModule } from './customers/customers.module';
import { ProductsModule } from './products/products.module';
import { SalesModule } from './sales/sales.module';
import { UsersModule } from './users/users.module';
import { ReportsModule } from './reports/reports.module';
import { StockMovementsModule } from './stock-movements/stock-movements.module';
import { ExpensesModule } from './expenses/expenses.module';
import { IngredientsModule } from './ingredients/ingredients.module';
import { PricingsModule } from './pricings/pricings.module';
import { CampaignsModule } from './campaigns/campaigns.module';
import { OrdersModule } from './orders/orders.module';
import { MenuModule } from './menu/menu.module';
import { DeliveryModule } from './delivery/delivery.module';
import { PaymentsModule } from './payments/payments.module';
import { FirebaseAuthGuard } from './common/guards/firebase-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),

    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>('MONGODB_URI'),
      }),
    }),

    AuthModule,
    BusinessModule,
    CategoriesModule,
    CustomersModule,
    ProductsModule,
    SalesModule,
    UsersModule,
    ReportsModule,
    StockMovementsModule,
    ExpensesModule,
    IngredientsModule,
    PricingsModule,
    CampaignsModule,
    OrdersModule,
    MenuModule,
    DeliveryModule,
    PaymentsModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: FirebaseAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
  ],
})
export class AppModule {
  constructor() {
    if (!admin.apps.length) {
      // Inside Firebase Functions the runtime provides credentials automatically.
      // K_SERVICE is set by Cloud Run (which Functions v2 uses).
      if (process.env.K_SERVICE || process.env.FUNCTIONS_EMULATOR) {
        admin.initializeApp();
      } else {
        admin.initializeApp({
          credential: admin.credential.cert({
            projectId: process.env.ADMIN_PROJECT_ID,
            clientEmail: process.env.ADMIN_CLIENT_EMAIL,
            privateKey: process.env.ADMIN_PRIVATE_KEY?.replace(/\\n/g, '\n'),
          }),
          storageBucket: process.env.STORAGE_BUCKET,
        });
      }
    }
  }
}
