/**
 * Lane F5 (RP-DEADTABLES) — RelayService (backend/api/src/relay/relay.service.ts): the air-gap
 * sync's exportPackage/importPackage/status all depend on platform.relay_cursor,
 * platform.relay_inbox, and/or platform.relay_package, none of which exist in @core/data-platform
 * or @ra/data-reference (db:push's only sources for the `platform` schema, per
 * scripts/db-schema-groups.ts) nor the Phase-1A Data Dictionary. All three now throw
 * NotImplementedException instead of a 500 (or a crash partway through a "committed" export).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotImplementedException } from '@nestjs/common';
import { RelayService } from '../relay/relay.service.js';
import { testClient, closeTestClient } from '../../../test-support/db.js';

const svc = new RelayService(testClient());

test('relay export (lane F5): honest "not available" — platform.relay_cursor/relay_package do not exist', async () => {
  await assert.rejects(() => svc.exportPackage('online-to-offline', false), NotImplementedException);
});

test('relay import (lane F5): honest "not available" — platform.relay_inbox/relay_package do not exist', async () => {
  await assert.rejects(
    () =>
      svc.importPackage({
        manifest: {
          packageId: crypto.randomUUID(),
          direction: 'online-to-offline',
          createdAt: new Date().toISOString(),
          eventCount: 0,
          sources: {},
          prevPackageHash: null,
          contentSha256: 'x',
          algo: 'ed25519',
        },
        events: [],
        signature: 'x',
      }),
    NotImplementedException,
  );
});

test('relay status (lane F5): honest "not available" — platform.relay_cursor/relay_inbox/relay_package do not exist', async () => {
  await assert.rejects(() => svc.status(), NotImplementedException);
  await closeTestClient();
});
