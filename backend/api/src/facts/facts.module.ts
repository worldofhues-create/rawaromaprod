/**
 * FactsModule — PB-06's RawProd Facts API. No own DB token: `FactsService` injects the
 * shared `PG_CLIENT` (global, from `BackendKernelModule`) for its cross-cluster reads and
 * `BRIDGE_DB` (global, exported by `BridgeModule`) for the connector's sealed HMAC secret.
 */
import { Module } from "@nestjs/common";
import { FactsController } from "./facts.controller.js";
import { FactsService } from "./facts.service.js";

@Module({
  controllers: [FactsController],
  providers: [FactsService],
})
export class FactsModule {}
