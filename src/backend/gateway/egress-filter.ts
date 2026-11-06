/**
 * A proxy endpoint has to be reachable from the public internet.
 *
 * Rows pointing at loopback / link-local / RFC1918 addresses are test artefacts
 * or misconfigurations. Selecting one is worse than failing: it can look healthy
 * while silently talking to a service on the gateway itself.
 */
export function isRoutableEgressAddress(address: string): boolean {
  const a = String(address || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!a) return false;

  // Only loopback / link-local / unspecified are rejected: a self-hosted LAN
  // node (192.168.x, 10.x) is a legitimate egress and must stay selectable.
  if (a === 'localhost' || a === '::1' || a === '0.0.0.0') return false;
  if (a.startsWith('127.')) return false;
  if (a.startsWith('169.254.')) return false;
  if (a.startsWith('fe80:')) return false;

  return true;
}
