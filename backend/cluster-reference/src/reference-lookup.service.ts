/**
 * ReferenceLookupService — in-cluster implementation of the `ReferenceLookup` public port.
 * Provided under `REFERENCE_LOOKUP` so consumers depend only on the interface, never on a
 * concrete class. Each resolver is a single keyed select returning id + code/name refs.
 */
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { REFERENCE_DB, referenceSchema, type ReferenceDb } from './reference.tokens.js';
import type {
  BrandRef,
  CountryRef,
  CurrencyRef,
  DocumentRef,
  ReferenceLookup,
  UomRef,
} from './public-api.js';

const { uomMaster, currencyMaster, countryMaster, brandMaster, documentMaster } = referenceSchema;

@Injectable()
export class ReferenceLookupService implements ReferenceLookup {
  constructor(@Inject(REFERENCE_DB) private readonly db: ReferenceDb) {}

  async findUom(uomId: string): Promise<UomRef | null> {
    const row = (
      await this.db
        .select({ uomId: uomMaster.uomId, uomCode: uomMaster.uomCode, uomName: uomMaster.uomName })
        .from(uomMaster)
        .where(eq(uomMaster.uomId, uomId))
        .limit(1)
    )[0];
    return row ?? null;
  }

  async findCurrency(currencyId: string): Promise<CurrencyRef | null> {
    const row = (
      await this.db
        .select({
          currencyId: currencyMaster.currencyId,
          currencyCode: currencyMaster.currencyCode,
          currencyName: currencyMaster.currencyName,
        })
        .from(currencyMaster)
        .where(eq(currencyMaster.currencyId, currencyId))
        .limit(1)
    )[0];
    return row ?? null;
  }

  async findCountry(countryId: string): Promise<CountryRef | null> {
    const row = (
      await this.db
        .select({
          countryId: countryMaster.countryId,
          countryCode: countryMaster.countryCode,
          countryName: countryMaster.countryName,
        })
        .from(countryMaster)
        .where(eq(countryMaster.countryId, countryId))
        .limit(1)
    )[0];
    return row ?? null;
  }

  async findBrand(brandId: string): Promise<BrandRef | null> {
    const row = (
      await this.db
        .select({
          brandId: brandMaster.brandId,
          brandCode: brandMaster.brandCode,
          brandName: brandMaster.brandName,
        })
        .from(brandMaster)
        .where(eq(brandMaster.brandId, brandId))
        .limit(1)
    )[0];
    return row ?? null;
  }

  async findDocument(documentId: string): Promise<DocumentRef | null> {
    const row = (
      await this.db
        .select({
          documentId: documentMaster.documentId,
          fileName: documentMaster.fileName,
          filePath: documentMaster.filePath,
        })
        .from(documentMaster)
        .where(eq(documentMaster.documentId, documentId))
        .limit(1)
    )[0];
    return row ?? null;
  }
}
