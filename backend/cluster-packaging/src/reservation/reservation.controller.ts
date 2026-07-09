/**
 * ReservationController — REST over finished-good stock reservations. Reads/writes reuse the
 * FG-batch permissions (no new perm seed). release is a POST flow that frees the hold.
 * Per-arg ZodValidationPipe; principal from the token.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CurrentUser,
  Permissions,
  ZodValidationPipe,
  type AuthPrincipal,
} from '@core/backend-kernel';
import { ReservationService } from './reservation.service.js';
import {
  createFinishedGoodReservation,
  listQuery,
  type CreateFinishedGoodReservation,
  type ListQuery,
} from '../packaging.dtos.js';

@Controller()
export class ReservationController {
  constructor(private readonly reservations: ReservationService) {}

  @Permissions('packaging:finished_good_batch_master:read')
  @Get('v1/fg-reservations')
  list(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.reservations.listReservations(query);
  }

  @Permissions('packaging:finished_good_batch_master:read')
  @Get('v1/fg-reservations/:id')
  get(@Param('id') id: string) {
    return this.reservations.getReservation(id);
  }

  @Permissions('packaging:finished_good_batch_master:write')
  @Post('v1/fg-reservations')
  create(
    @Body(new ZodValidationPipe(createFinishedGoodReservation)) body: CreateFinishedGoodReservation,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.reservations.createReservation(body, principal);
  }

  @Permissions('packaging:finished_good_batch_master:write')
  @Post('v1/fg-reservations/:id/release')
  release(@Param('id') id: string, @CurrentUser() principal: AuthPrincipal) {
    return this.reservations.releaseReservation(id, principal);
  }
}
