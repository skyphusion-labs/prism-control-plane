// Prism control plane entry (skeleton).
// Host-billed entitlements and tenant provisioning land here.

export const CONTROL_PLANE_NAME = "prism-control-plane";

export function health(): { ok: true; service: string } {
  return { ok: true, service: CONTROL_PLANE_NAME };
}
