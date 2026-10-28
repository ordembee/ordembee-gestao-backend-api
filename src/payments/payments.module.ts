import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Business, BusinessSchema } from '../business/schemas/business.schema';
import {
  MenuOnline,
  MenuOnlineSchema,
} from '../menu/schemas/menu-online.schema';
import { Order, OrderSchema } from '../orders/schemas/order.schema';
import { InternalSignatureGuard } from '../common/guards/internal-signature.guard';
import { InfinitePayClient } from './infinitepay.client';
import { InfinitePayService } from './infinitepay.service';
import {
  InfinitePaySettingsController,
  InternalInfinitePayController,
  InternalMenuPaymentsController,
  OrderInfinitePayController,
} from './payments.controller';

/** Pagamento online (hoje: InfinitePay). */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Business.name, schema: BusinessSchema },
      { name: MenuOnline.name, schema: MenuOnlineSchema },
      { name: Order.name, schema: OrderSchema },
    ]),
  ],
  controllers: [
    InfinitePaySettingsController,
    OrderInfinitePayController,
    InternalInfinitePayController,
    InternalMenuPaymentsController,
  ],
  providers: [InfinitePayClient, InfinitePayService, InternalSignatureGuard],
  exports: [InfinitePayService],
})
export class PaymentsModule {}
