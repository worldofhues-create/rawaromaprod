/**
 * reference cluster — PUBLIC API. The reference masters are root config data; other
 * clusters cache them but occasionally need a cold read to resolve a foreign id. The only
 * surface we expose is the `ReferenceLookup` read port (id + code/name refs only). Inject
 * by the `REFERENCE_LOOKUP` token.
 */

export interface UomRef {
  uomId: string;
  uomCode: string | null;
  uomName: string | null;
}

export interface CurrencyRef {
  currencyId: string;
  currencyCode: string | null;
  currencyName: string | null;
}

export interface CountryRef {
  countryId: string;
  countryCode: string | null;
  countryName: string | null;
}

export interface BrandRef {
  brandId: string;
  brandCode: string | null;
  brandName: string | null;
}

export interface DocumentRef {
  documentId: string;
  fileName: string | null;
  filePath: string | null;
}

/** Cold read port into the reference masters. */
export interface ReferenceLookup {
  findUom(uomId: string): Promise<UomRef | null>;
  findCurrency(currencyId: string): Promise<CurrencyRef | null>;
  findCountry(countryId: string): Promise<CountryRef | null>;
  findBrand(brandId: string): Promise<BrandRef | null>;
  findDocument(documentId: string): Promise<DocumentRef | null>;
}

/** DI token for `ReferenceLookup`. */
export const REFERENCE_LOOKUP = Symbol('REFERENCE_LOOKUP');
