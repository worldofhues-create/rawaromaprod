/**
 * reference cluster DTOs — zod create bodies (one per reference master) plus the generic
 * cursor list query. Bodies carry only the Data Dictionary columns; the service fills the
 * meta tail (status default "ACTIVE", created_by/updated_by from the principal). Numerics
 * are accepted as numbers and stringified at insert; timestamps as ISO strings.
 */
import { z } from 'zod';

/** Generic cursor list query shared by every master. */
export const listQuery = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListQuery = z.infer<typeof listQuery>;

/* ── geo / locale ─────────────────────────────────────────────────────── */

export const createCountry = z.object({
  countryCode: z.string(),
  countryName: z.string(),
});
export type CreateCountry = z.infer<typeof createCountry>;

export const createCurrency = z.object({
  currencyCode: z.string(),
  currencyName: z.string(),
});
export type CreateCurrency = z.infer<typeof createCurrency>;

export const createLanguage = z.object({
  languageCode: z.string(),
  languageName: z.string(),
});
export type CreateLanguage = z.infer<typeof createLanguage>;

export const createTimezone = z.object({
  timezoneCode: z.string(),
  utcOffset: z.string(),
});
export type CreateTimezone = z.infer<typeof createTimezone>;

export const createAddress = z.object({
  addressLine1: z.string(),
  addressLine2: z.string().optional(),
  city: z.string(),
  stateName: z.string(),
  countryId: z.string().uuid().optional(),
  pincode: z.string(),
});
export type CreateAddress = z.infer<typeof createAddress>;

export const createGeoLocation = z.object({
  latitude: z.number(),
  longitude: z.number(),
});
export type CreateGeoLocation = z.infer<typeof createGeoLocation>;

export const createContact = z.object({
  contactName: z.string(),
  email: z.string(),
  mobileNumber: z.string(),
});
export type CreateContact = z.infer<typeof createContact>;

/* ── documents ────────────────────────────────────────────────────────── */

export const createDocumentType = z.object({
  documentTypeCode: z.string(),
  documentTypeName: z.string(),
});
export type CreateDocumentType = z.infer<typeof createDocumentType>;

export const createDocument = z.object({
  documentTypeId: z.string().uuid().optional(),
  fileName: z.string(),
  filePath: z.string(),
  uploadedDt: z.string().datetime().optional(),
});
export type CreateDocument = z.infer<typeof createDocument>;

/* ── uom + brand ──────────────────────────────────────────────────────── */

export const createUomType = z.object({
  typeCode: z.string(),
  typeName: z.string(),
  description: z.string().optional(),
});
export type CreateUomType = z.infer<typeof createUomType>;

export const createUom = z.object({
  uomCode: z.string(),
  uomName: z.string(),
});
export type CreateUom = z.infer<typeof createUom>;

export const createUomConversion = z.object({
  uomTypeId: z.string().uuid().optional(),
  fromUomId: z.string().uuid().optional(),
  toUomId: z.string().uuid().optional(),
  conversionFactor: z.number(),
  isActive: z.boolean().optional(),
});
export type CreateUomConversion = z.infer<typeof createUomConversion>;

export const createBrand = z.object({
  brandCode: z.string(),
  brandName: z.string(),
});
export type CreateBrand = z.infer<typeof createBrand>;
