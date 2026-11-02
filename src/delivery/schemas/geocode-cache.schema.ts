import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type GeocodeCacheDocument = GeocodeCache & Document;

/** Quao perto do endereco o ponto esta. */
export type GeocodePrecision = 'ADDRESS' | 'STREET' | 'CEP';

/**
 * Endereco ja convertido em coordenadas. Evita repetir consultas (o Nominatim
 * limita a 1 por segundo) e deixa o frete do mesmo endereco estavel.
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class GeocodeCache {
  /** `dropoffKey` do endereco. */
  @Prop({ required: true })
  key: string;

  @Prop({ required: true })
  lat: number;

  @Prop({ required: true })
  lng: number;

  @Prop({ required: true, enum: ['ADDRESS', 'STREET', 'CEP'] })
  precision: GeocodePrecision;

  /** De onde veio: 'nominatim' | 'brasilapi'. */
  @Prop({ required: true })
  source: string;

  createdAt?: Date;
}

export const GeocodeCacheSchema = SchemaFactory.createForClass(GeocodeCache);

GeocodeCacheSchema.index({ key: 1 }, { unique: true });
// Ruas e CEPs mudam pouco; 180 dias.
GeocodeCacheSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 180 * 24 * 3600 },
);
