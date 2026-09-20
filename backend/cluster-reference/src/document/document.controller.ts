/**
 * DocumentController — REST over the document reference masters. Reads require
 * `platform:<table>:read`, writes `:write`. Per-arg ZodValidationPipe; principal from token.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CurrentUser,
  Permissions,
  ZodValidationPipe,
  type AuthPrincipal,
} from '@core/backend-kernel';
import { DocumentService } from './document.service.js';
import {
  createDocument,
  createDocumentType,
  listQuery,
  type CreateDocument,
  type CreateDocumentType,
  type ListQuery,
} from '../reference.dtos.js';

@Controller()
export class DocumentController {
  constructor(private readonly documents: DocumentService) {}

  /* ── document type ────────────────────────────────────────────────── */

  @Permissions('platform:document_type_master:read')
  @Get('v1/document-types')
  listDocumentTypes(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.documents.listDocumentTypes(query);
  }

  @Permissions('platform:document_type_master:read')
  @Get('v1/document-types/:id')
  getDocumentType(@Param('id') id: string) {
    return this.documents.getDocumentType(id);
  }

  @Permissions('platform:document_type_master:write')
  @Post('v1/document-types')
  createDocumentType(
    @Body(new ZodValidationPipe(createDocumentType)) body: CreateDocumentType,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.documents.createDocumentType(body, principal);
  }

  /* ── document ─────────────────────────────────────────────────────── */

  @Permissions('platform:document_master:read')
  @Get('v1/documents')
  listDocuments(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.documents.listDocuments(query);
  }

  @Permissions('platform:document_master:read')
  @Get('v1/documents/:id')
  getDocument(@Param('id') id: string) {
    return this.documents.getDocument(id);
  }

  @Permissions('platform:document_master:write')
  @Post('v1/documents')
  createDocument(
    @Body(new ZodValidationPipe(createDocument)) body: CreateDocument,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.documents.createDocument(body, principal);
  }
}
