/**
 * InspectionsController — REST over the QC inspection document + its child rows. Reads
 * require `quality:<table>:read`, writes `:write`. The flow endpoints are POST actions under
 * the inspection: `/results` adds result rows, `/disposition` records the disposition and
 * fires the cross-cluster signal. Per-arg ZodValidationPipe; principal from the token.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CurrentUser,
  Permissions,
  ZodValidationPipe,
  type AuthPrincipal,
} from '@core/backend-kernel';
import { InspectionsService } from './inspections.service.js';
import {
  addResults,
  createQcAttachment,
  createQcInspection,
  disposeInspection,
  listQuery,
  type AddResults,
  type CreateQcAttachment,
  type CreateQcInspection,
  type DisposeInspection,
  type ListQuery,
} from '../quality.dtos.js';

@Controller()
export class InspectionsController {
  constructor(private readonly inspections: InspectionsService) {}

  /* ── qc inspections ───────────────────────────────────────────────── */

  @Permissions('quality:qc_inspections:read')
  @Get('v1/qc-inspections')
  listInspections(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.inspections.listInspections(query);
  }

  @Permissions('quality:qc_inspections:read')
  @Get('v1/qc-inspections/:id')
  getInspection(@Param('id') id: string) {
    return this.inspections.getInspection(id);
  }

  @Permissions('quality:qc_inspections:write')
  @Post('v1/qc-inspections')
  createInspection(
    @Body(new ZodValidationPipe(createQcInspection)) body: CreateQcInspection,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.inspections.createInspection(body, principal);
  }

  /* ── flow: add results ────────────────────────────────────────────── */

  @Permissions('quality:qc_inspections:write')
  @Post('v1/qc-inspections/:id/results')
  addResults(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(addResults)) body: AddResults,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.inspections.addResults(id, body, principal);
  }

  /* ── flow: disposition ────────────────────────────────────────────── */

  @Permissions('quality:qc_inspections:write')
  @Post('v1/qc-inspections/:id/disposition')
  dispose(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(disposeInspection)) body: DisposeInspection,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.inspections.dispose(id, body, principal);
  }

  /* ── qc result details ────────────────────────────────────────────── */

  @Permissions('quality:qc_result_details:read')
  @Get('v1/qc-result-details')
  listResultDetails(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.inspections.listResultDetails(query);
  }

  @Permissions('quality:qc_result_details:read')
  @Get('v1/qc-result-details/:id')
  getResultDetail(@Param('id') id: string) {
    return this.inspections.getResultDetail(id);
  }

  /* ── qc attachments ───────────────────────────────────────────────── */

  @Permissions('quality:qc_attachments:read')
  @Get('v1/qc-attachments')
  listAttachments(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.inspections.listAttachments(query);
  }

  @Permissions('quality:qc_attachments:read')
  @Get('v1/qc-attachments/:id')
  getAttachment(@Param('id') id: string) {
    return this.inspections.getAttachment(id);
  }

  @Permissions('quality:qc_attachments:write')
  @Post('v1/qc-attachments')
  createAttachment(
    @Body(new ZodValidationPipe(createQcAttachment)) body: CreateQcAttachment,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.inspections.createAttachment(body, principal);
  }

  /* ── qc disposition (reads) ───────────────────────────────────────── */

  @Permissions('quality:qc_disposition:read')
  @Get('v1/qc-dispositions')
  listDispositions(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.inspections.listDispositions(query);
  }

  @Permissions('quality:qc_disposition:read')
  @Get('v1/qc-dispositions/:id')
  getDisposition(@Param('id') id: string) {
    return this.inspections.getDisposition(id);
  }
}
