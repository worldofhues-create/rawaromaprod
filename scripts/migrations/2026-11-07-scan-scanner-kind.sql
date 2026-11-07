-- Migration: 2026-11-07-scan-scanner-kind (SCAN-4, owner: "Product scanning: we need both QR and
-- barcode"). The Devices screen had no way to record a barcode scanner: device_master.kind allowed
-- label_printer, display, kiosk and scale only. A scanner is now a kind, with the symbologies it
-- reads in config.symbologies (validated by DevicesService). It is not paired (a wedge or Bluetooth
-- scanner types into the station's own screen), so it has no token and no heartbeat.
--
-- @target: main

alter table platform.device_master drop constraint if exists device_master_kind_check;
alter table platform.device_master add constraint device_master_kind_check
  check (kind in ('label_printer', 'display', 'kiosk', 'scale', 'scanner'));
