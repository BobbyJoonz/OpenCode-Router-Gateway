import crypto from 'crypto';
import { parse as parseYaml } from 'yaml';
import { ParsedConfig } from './config-parser';

function hash(protocol: string, address: string, port: number, auth: string): string {
  return crypto
    .createHash('sha256')
    .update(`${protocol}:${address.toLowerCase()}:${port}:${auth}`)
    .digest('hex');
}

function build(
  protocol: ParsedConfig['protocol'],
  address: string,
  port: number,
  security: ParsedConfig['security'],
  network: ParsedConfig['network'],
  details: Record<string, any>,
  remark?: string
): ParsedConfig | null {
  if (!address || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const auth = String(details.uuid || details.password || details.method || '');
  if (!auth) return null;

  return {
    protocol,
    address: String(address),
    port,
    remark: String(remark || `${address}:${port}`).replace(/[\r\n\t]/g, ' ').slice(0, 70),
    security,
    network,
    raw_url: `structured://${protocol}/${address}:${port}`,
    config_hash: hash(protocol, address, port, auth),
    details
  };
}

function asNetwork(value: any): ParsedConfig['network'] {
  const v = String(value || 'tcp').toLowerCase();
  return (['ws', 'grpc', 'h2', 'tcp'].includes(v) ? v : 'tcp') as ParsedConfig['network'];
}

function asAlpn(value: any): string[] | undefined {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.trim()) return value.split(',').map((s) => s.trim());
  return undefined;
}

/**
 * Clash / Clash.Meta YAML importer.
 * Handles the `proxies:` list with vless / vmess / trojan / ss entries.
 */
export function parseClash(text: string): ParsedConfig[] {
  let doc: any;
  try {
    doc = parseYaml(text);
  } catch {
    return [];
  }
  const proxies = Array.isArray(doc?.proxies) ? doc.proxies : [];
  const out: ParsedConfig[] = [];

  for (const p of proxies) {
    if (!p || typeof p !== 'object') continue;
    const type = String(p.type || '').toLowerCase();
    const address = p.server;
    const port = parseInt(p.port, 10);
    if (!address || !Number.isInteger(port)) continue;

    const tlsEnabled = p.tls === true || (p['reality-opts'] && Object.keys(p['reality-opts']).length > 0);
    const reality = p['reality-opts'] || {};
    const security: ParsedConfig['security'] =
      reality['public-key'] ? 'reality' : tlsEnabled ? 'tls' : 'none';
    const network = asNetwork(p.network);
    const wsOpts = p['ws-opts'] || {};
    const grpcOpts = p['grpc-opts'] || {};
    const host = wsOpts?.headers?.Host || wsOpts?.headers?.host || p.servername || '';
    const sni = p.servername || p.sni || host || '';
    const path = wsOpts?.path || '';
    const fp = p['client-fingerprint'] || 'chrome';
    const alpn = asAlpn(p.alpn);

    if (type === 'vless') {
      if (security === 'none') continue; // Xray refuses unencrypted VLESS
      const parsed = build(
        'vless',
        address,
        port,
        security,
        network,
        {
          uuid: p.uuid,
          encryption: 'none',
          flow: p.flow || '',
          sni,
          host,
          path,
          serviceName: grpcOpts['grpc-service-name'] || path,
          pbk: reality['public-key'] || '',
          sid: reality['short-id'] || '',
          fp,
          alpn
        },
        p.name
      );
      if (parsed) out.push(parsed);
    } else if (type === 'vmess') {
      const parsed = build(
        'vmess',
        address,
        port,
        security,
        network,
        {
          uuid: p.uuid,
          alterId: parseInt(p.alterId ?? 0, 10) || 0,
          securityType: p.cipher || 'auto',
          sni,
          host,
          path,
          serviceName: grpcOpts['grpc-service-name'] || path,
          type: 'none',
          alpn
        },
        p.name
      );
      if (parsed) out.push(parsed);
    } else if (type === 'trojan') {
      const parsed = build(
        'trojan',
        address,
        port,
        'tls',
        network,
        {
          password: p.password,
          sni: sni || address,
          host,
          path,
          serviceName: grpcOpts['grpc-service-name'] || path,
          alpn
        },
        p.name
      );
      if (parsed) out.push(parsed);
    } else if (type === 'ss') {
      const parsed = build(
        'ss',
        address,
        port,
        'none',
        'tcp',
        { method: p.cipher, password: p.password },
        p.name
      );
      if (parsed) out.push(parsed);
    }
  }

  return out;
}

/**
 * sing-box JSON importer (`outbounds` with `type` instead of `protocol`).
 */
export function parseSingbox(text: string): ParsedConfig[] {
  let doc: any;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }

  const docs = Array.isArray(doc) ? doc : [doc];
  const out: ParsedConfig[] = [];

  for (const d of docs) {
    const outbounds = Array.isArray(d?.outbounds) ? d.outbounds : [];
    for (const o of outbounds) {
      if (!o || typeof o !== 'object') continue;
      const type = String(o.type || '').toLowerCase();
      if (!['vless', 'vmess', 'trojan', 'shadowsocks', 'shadowsocksr', 'ss'].includes(type)) continue;

      const address = o.server;
      const port = parseInt(o.server_port, 10);
      if (!address || !Number.isInteger(port)) continue;

      const tls = o.tls || {};
      const reality = tls.reality || {};
      const utls = tls.utls || {};
      const transport = o.transport || {};
      const headers = transport.headers || {};

      const security: ParsedConfig['security'] = reality.enabled
        ? 'reality'
        : tls.enabled
          ? 'tls'
          : 'none';
      const network = asNetwork(transport.type);
      const sni = tls.server_name || headers.Host || headers.host || '';
      const host = headers.Host || headers.host || '';
      const path = transport.path || '';
      const fp = utls.fingerprint || 'chrome';

      if (type === 'vless') {
        if (security === 'none') continue;
        const parsed = build(
          'vless',
          address,
          port,
          security,
          network,
          {
            uuid: o.uuid,
            encryption: 'none',
            flow: o.flow || '',
            sni,
            host,
            path,
            serviceName: transport.service_name || path,
            pbk: reality.public_key || '',
            sid: reality.short_id || '',
            fp,
            alpn: asAlpn(tls.alpn)
          },
          o.tag
        );
        if (parsed) out.push(parsed);
      } else if (type === 'vmess') {
        const parsed = build(
          'vmess',
          address,
          port,
          security,
          network,
          {
            uuid: o.uuid,
            alterId: parseInt(o.alter_id ?? 0, 10) || 0,
            securityType: o.security || 'auto',
            sni,
            host,
            path,
            serviceName: transport.service_name || path,
            type: 'none',
            alpn: asAlpn(tls.alpn)
          },
          o.tag
        );
        if (parsed) out.push(parsed);
      } else if (type === 'trojan') {
        const parsed = build(
          'trojan',
          address,
          port,
          'tls',
          network,
          {
            password: o.password,
            sni: sni || address,
            host,
            path,
            serviceName: transport.service_name || path,
            alpn: asAlpn(tls.alpn)
          },
          o.tag
        );
        if (parsed) out.push(parsed);
      } else {
        const parsed = build(
          'ss',
          address,
          port,
          'none',
          'tcp',
          { method: o.method, password: o.password },
          o.tag
        );
        if (parsed) out.push(parsed);
      }
    }
  }

  return out;
}

export type StructuredFormat = 'xray' | 'singbox' | 'clash' | 'unknown';

/** Best-effort format sniffing for pasted subscription content. */
export function detectStructuredFormat(text: string): StructuredFormat {
  const trimmed = text.trim();
  if (!trimmed) return 'unknown';

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const doc = JSON.parse(trimmed);
      const first = Array.isArray(doc) ? doc[0] : doc;
      const outbounds = Array.isArray(first?.outbounds) ? first.outbounds : [];
      if (outbounds.some((o: any) => o && (o.type || o.protocol === 'shadowsocks'))) {
        // sing-box uses `type`, Xray uses `protocol`
        return outbounds.some((o: any) => o?.type) ? 'singbox' : 'xray';
      }
      return 'xray';
    } catch {
      return 'unknown';
    }
  }

  if (/^\s*proxies\s*:/m.test(trimmed) || /^\s*socks5\s*:/m.test(trimmed) || /^\s*mixed-port\s*:/m.test(trimmed)) {
    return 'clash';
  }

  return 'unknown';
}
