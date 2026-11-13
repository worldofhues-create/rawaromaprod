/**
 * What a paired device is, on its own (STAGE-2-RP). It lived in devices.service.ts, which imports
 * scale.service.ts for a scale's settings, while scale.service.ts imported this type back: a cycle
 * `pnpm boundaries` had reported since FLOOR-FIX-16. devices.service.ts still exports all three.
 */
export const DEVICE_KINDS = ['label_printer', 'display', 'kiosk', 'scale', 'scanner', 'temp_sensor'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

export interface PairedDevice {
  deviceId: string;
  kind: DeviceKind;
  station: string;
  name: string;
  config: Record<string, unknown>;
}
