import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as admin from 'firebase-admin';
import sharp from 'sharp';

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);

  private get bucket() {
    return admin.storage().bucket();
  }

  async uploadProductImage(
    businessId: string,
    productId: string,
    file: Express.Multer.File,
  ): Promise<string> {
    this.validateImage(file);

    const optimized = await sharp(file.buffer)
      .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 75 })
      .toBuffer();

    return this.savePublic(
      `business/${businessId}/products/${productId}.webp`,
      optimized,
    );
  }

  async uploadUserAvatar(
    businessId: string,
    userId: string,
    file: Express.Multer.File,
  ): Promise<string> {
    this.validateImage(file);

    const optimized = await sharp(file.buffer)
      .resize(256, 256, { fit: 'cover' })
      .webp({ quality: 85 })
      .toBuffer();

    return this.savePublic(
      `business/${businessId}/users/${userId}.webp`,
      optimized,
    );
  }

  /**
   * Imagens da loja no cardapio. O nome leva um carimbo de tempo porque o
   * arquivo publico tem cache de 1 ano: trocar a imagem gera URL nova, e o
   * cliente nunca fica vendo a antiga. Devolve URL e caminho (para apagar depois).
   */
  async uploadStoreImage(
    businessId: string,
    kind: 'logo' | 'cover',
    file: Express.Multer.File,
  ): Promise<{ url: string; path: string }> {
    this.validateImage(file);
    const image = sharp(file.buffer).rotate();
    const optimized =
      kind === 'logo'
        ? await image
            .resize(512, 512, { fit: 'cover' })
            .webp({ quality: 85 })
            .toBuffer()
        : await image
            .resize(1600, 600, { fit: 'cover', withoutEnlargement: true })
            .webp({ quality: 78 })
            .toBuffer();
    const path = `business/${businessId}/menu/${kind}-${Date.now()}.webp`;
    return { url: await this.savePublic(path, optimized), path };
  }

  /** Caminho no bucket de uma URL publica nossa (null se a URL for de fora). */
  pathFromPublicUrl(url: string | undefined | null): string | null {
    const prefix = `https://storage.googleapis.com/${this.bucket.name}/`;
    return url?.startsWith(prefix) ? url.slice(prefix.length) : null;
  }

  /**
   * JSON publico com cache curto — usado pelo cardapio digital, que le o
   * arquivo direto do Storage/CDN em vez de bater na API a cada visita.
   */
  async uploadPublicJson(
    path: string,
    data: unknown,
    maxAgeSeconds = 60,
  ): Promise<string> {
    return this.savePublic(path, Buffer.from(JSON.stringify(data)), {
      contentType: 'application/json; charset=utf-8',
      cacheControl: `public, max-age=${maxAgeSeconds}`,
    });
  }

  publicUrl(path: string): string {
    return `https://storage.googleapis.com/${this.bucket.name}/${path}`;
  }

  async deleteFile(path: string): Promise<void> {
    await this.bucket.file(path).delete({ ignoreNotFound: true });
  }

  private async savePublic(
    path: string,
    data: Buffer,
    metadata: { contentType: string; cacheControl: string } = {
      contentType: 'image/webp',
      cacheControl: 'public, max-age=31536000',
    },
  ): Promise<string> {
    const fileRef = this.bucket.file(path);

    await fileRef.save(data, { metadata });

    await fileRef.makePublic();

    const url = this.publicUrl(path);
    this.logger.log(`Arquivo enviado: ${url}`);
    return url;
  }

  private validateImage(file: Express.Multer.File): void {
    if (!file) throw new BadRequestException('Arquivo não enviado');
    if (!file.mimetype.startsWith('image/')) {
      throw new BadRequestException('Apenas imagens são permitidas');
    }
  }
}
