/**
 * PlanningController — REST over the planning masters + the order vault flow. Reads require
 * `production:<table>:read`, writes `:write`. `POST /v1/production-orders` is the vault
 * integration: it expands an APPROVED formula into the order's bill-of-materials. The
 * production_order_ingredients have no create route (expanded server-side); they expose a
 * keyed read of one order's ingredients. Per-arg ZodValidationPipe; principal from the token.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CurrentUser,
  Permissions,
  ZodValidationPipe,
  type AuthPrincipal,
} from '@core/backend-kernel';
import { PlanningService } from './planning.service.js';
import {
  createOrder,
  createPlan,
  createPlanItem,
  listQuery,
  type CreateOrder,
  type CreatePlan,
  type CreatePlanItem,
  type ListQuery,
} from '../production.dtos.js';

@Controller()
export class PlanningController {
  constructor(private readonly planning: PlanningService) {}

  /* ── production plan ──────────────────────────────────────────────── */

  @Permissions('production:production_plan:read')
  @Get('v1/production-plans')
  listPlans(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.planning.listPlans(query);
  }

  @Permissions('production:production_plan:read')
  @Get('v1/production-plans/:id')
  getPlan(@Param('id') id: string) {
    return this.planning.getPlan(id);
  }

  @Permissions('production:production_plan:write')
  @Post('v1/production-plans')
  createPlan(
    @Body(new ZodValidationPipe(createPlan)) body: CreatePlan,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.planning.createPlan(body, principal);
  }

  /* ── production plan items ────────────────────────────────────────── */

  @Permissions('production:production_plan_items:read')
  @Get('v1/production-plan-items')
  listPlanItems(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.planning.listPlanItems(query);
  }

  @Permissions('production:production_plan_items:read')
  @Get('v1/production-plan-items/:id')
  getPlanItem(@Param('id') id: string) {
    return this.planning.getPlanItem(id);
  }

  @Permissions('production:production_plan_items:write')
  @Post('v1/production-plan-items')
  createPlanItem(
    @Body(new ZodValidationPipe(createPlanItem)) body: CreatePlanItem,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.planning.createPlanItem(body, principal);
  }

  /* ── production order ─────────────────────────────────────────────── */

  @Permissions('production:production_order:read')
  @Get('v1/production-orders')
  listOrders(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.planning.listOrders(query);
  }

  @Permissions('production:production_order:read')
  @Get('v1/production-orders/:id')
  getOrder(@Param('id') id: string) {
    return this.planning.getOrder(id);
  }

  /* ── flow: create order (vault integration) ──────────────────────── */

  @Permissions('production:production_order:write')
  @Post('v1/production-orders')
  createOrder(
    @Body(new ZodValidationPipe(createOrder)) body: CreateOrder,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.planning.createOrder(body, principal);
  }

  /* ── production order ingredients (reads) ─────────────────────────── */

  @Permissions('production:production_order_ingredients:read')
  @Get('v1/production-order-ingredients')
  listOrderIngredients(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.planning.listOrderIngredients(query);
  }

  @Permissions('production:production_order_ingredients:read')
  @Get('v1/production-orders/:id/ingredients')
  listIngredientsForOrder(@Param('id') id: string) {
    return this.planning.listIngredientsForOrder(id);
  }

  @Permissions('production:production_order_ingredients:read')
  @Get('v1/production-order-ingredients/:id')
  getOrderIngredient(@Param('id') id: string) {
    return this.planning.getOrderIngredient(id);
  }
}
