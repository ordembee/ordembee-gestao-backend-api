import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Business, BusinessSchema } from '../business/schemas/business.schema';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import {
  Category,
  CategorySchema,
} from '../categories/schemas/category.schema';
import { Customer, CustomerSchema } from '../customers/schemas/customer.schema';
import { BusinessModule } from '../business/business.module';
import { StorageModule } from '../storage/storage.module';
import { OrdersModule } from '../orders/orders.module';
import { MenuController } from './menu.controller';
import { MenuService } from './menu.service';
import { MenuOrdersService } from './menu-orders.service';
import { InternalMenuOrdersController, InternalMenusController } from './internal-menu-orders.controller';
import { InternalSignatureGuard } from '../common/guards/internal-signature.guard';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Business.name, schema: BusinessSchema },
      { name: Product.name, schema: ProductSchema },
      { name: Category.name, schema: CategorySchema },
      { name: Customer.name, schema: CustomerSchema },
    ]),
    BusinessModule,
    StorageModule,
    OrdersModule,
  ],
  controllers: [
    MenuController,
    InternalMenuOrdersController,
    InternalMenusController,
  ],
  providers: [MenuService, MenuOrdersService, InternalSignatureGuard],
})
export class MenuModule {}
