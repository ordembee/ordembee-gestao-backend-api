import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Business, BusinessSchema } from '../business/schemas/business.schema';
import {
  MenuOnline,
  MenuOnlineSchema,
} from '../menu/schemas/menu-online.schema';
import { Order, OrderSchema } from '../orders/schemas/order.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { OrdersModule } from '../orders/orders.module';
import { InternalSignatureGuard } from '../common/guards/internal-signature.guard';
import {
  DeliveryQuote,
  DeliveryQuoteSchema,
} from './schemas/delivery-quote.schema';
import { UberDirectClient } from './uber-direct.client';
import { UberDirectService } from './uber-direct.service';
import { DeliverySettingsService } from './delivery-settings.service';
import {
  DeliverySettingsController,
  InternalUberWebhookController,
  OrderUberDeliveryController,
  PanelDeliveryController,
} from './delivery.controller';

/** Entregas por terceiros (hoje: Uber Direct). */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Business.name, schema: BusinessSchema },
      { name: MenuOnline.name, schema: MenuOnlineSchema },
      { name: Order.name, schema: OrderSchema },
      { name: User.name, schema: UserSchema },
      { name: DeliveryQuote.name, schema: DeliveryQuoteSchema },
    ]),
    OrdersModule,
  ],
  controllers: [
    DeliverySettingsController,
    OrderUberDeliveryController,
    PanelDeliveryController,
    InternalUberWebhookController,
  ],
  providers: [
    UberDirectClient,
    UberDirectService,
    DeliverySettingsService,
    InternalSignatureGuard,
  ],
  exports: [UberDirectService],
})
export class DeliveryModule {}
