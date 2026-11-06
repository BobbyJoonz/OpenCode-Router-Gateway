import crypto from 'crypto';
import { ParsedConfig } from './config-parser';

/**
 * Importer for FULL Xray/V2Ray client configuration documents (`config.json`).
 *
 * The share-link parser (`ConfigParser`) only understands vless://, vmess://,
 * trojan:// and ss:// URIs. Users migrating from v2rayN / v2rayA / Nekoray usually
 * have a complete JSON client config instead, so this module converts the proxy
 * outbound(s) of such a document into the internal `ParsedConfig` shape, which the
 * `XrayConfigBuilder` can then turn back into a runnable client config.
 *
 * Supported outbound protocols: vless, vmess, trojan, shadowsocks.
 * `freedom` / `blackhole` / `dns` outbounds are ignored.
 */
export class XrayJsonImporter {
  public static parse(raw: string): ParsedConfig[] {
    let doc: any;
    try {
      doc = JSON.parse(raw);
    } catch {
      return [];
    }

    // Accept either a single config object or an array of config objects.
    const docs = Array.isArray(doc) ? doc : [doc];
    const out: ParsedConfig[] = [];

    for (const d of docs) {
      const outbounds = Array.isArray(d?.outbounds) ? d.outbounds : [];
      for (const ob of outbounds) {
        const parsed = this.fromOutbound(ob);
        if (parsed) out.push(parsed);
      }
    }

    return out;
  }

  private static fromOutbound(ob: any): ParsedConfig | null {
    if (!ob || typeof ob !== 'object') return null;

    const protocol = String(ob.protocol || '').toLowerCase();
    if (!['vless', 'vmess', 'trojan', 'shadowsocks', 'ss'].includes(protocol)) {
      return null;
    }

    const ss = ob.streamSettings || {};
    const rawNetwork = String(ss.network || 'tcp').toLowerCase();
    // XHTTP is transported like tcp for our purposes; keep the known set only.
    const network = (['ws', 'grpc', 'h2', 'tcp'].includes(rawNetwork) ? rawNetwork : 'tcp') as
      | 'tcp'
      | 'ws'
      | 'grpc'
      | 'h2';

    const rawSecurity = String(ss.security || 'none').toLowerCase();
    let security: 'tls' | 'reality' | 'none' = ['tls', 'reality'].includes(rawSecurity)
      ? (rawSecurity as 'tls' | 'reality')
      : 'none';

    const tls = ss.tlsSettings || {};
    const reality = ss.realitySettings || {};
    const ws = ss.wsSettings || {};
    const grpc = ss.grpcSettings || {};
    const httpSettings = ss.httpSettings || {};

    const host = ws.headers?.Host || ws.host || httpSettings.host?.[0] || '';
    const sni = tls.serverName || reality.serverName || host || '';
    const path = ws.path || httpSettings.path || '';
    const fp = tls.fingerprint || reality.fingerprint || 'chrome';
    const alpn = tls.alpn || reality.alpn;

    const settings = ob.settings || {};

    if (protocol === 'vless' || protocol === 'vmess') {
      const vnext = Array.isArray(settings.vnext) ? settings.vnext[0] : null;
      if (!vnext || !vnext.address || !vnext.port) return null;
      const user = Array.isArray(vnext.users) ? vnext.users[0] : null;
      if (!user || !user.id) return null;

      const address = String(vnext.address);
      const port = parseInt(vnext.port, 10);
      if (!address || isNaN(port)) return null;

      // VLESS without transport encryption is refused by Xray on public networks.
      if (protocol === 'vless' && security === 'none') return null;

      const details =
        protocol === 'vless'
          ? {
              uuid: user.id,
              encryption: user.encryption || 'none',
              flow: user.flow || '',
              sni,
              host,
              path,
              serviceName: grpc.serviceName || path,
              pbk: reality.publicKey || '',
              sid: reality.shortId || '',
              fp,
              alpn
            }
          : {
              uuid: user.id,
              alterId: user.alterId ?? 0,
              securityType: user.security || 'auto',
              sni,
              host,
              path,
              serviceName: grpc.serviceName || path,
              type: 'none',
              alpn
            };

      return this.build(protocol, address, port, security, network, details, ob.tag);
    }

    if (protocol === 'trojan') {
      const server = Array.isArray(settings.servers) ? settings.servers[0] : null;
      if (!server || !server.address || !server.port || !server.password) return null;
      const address = String(server.address);
      const port = parseInt(server.port, 10);
      if (isNaN(port)) return null;
      // Trojan is always TLS.
      security = 'tls';

      return this.build(
        'trojan',
        address,
        port,
        security,
        network,
        {
          password: server.password,
          sni: sni || address,
          host,
          path,
          serviceName: grpc.serviceName || path,
          alpn
        },
        ob.tag
      );
    }

    // shadowsocks
    const server = Array.isArray(settings.servers) ? settings.servers[0] : null;
    if (!server || !server.address || !server.port || !server.method || !server.password) return null;
    const address = String(server.address);
    const port = parseInt(server.port, 10);
    if (isNaN(port)) return null;

    return this.build(
      'ss',
      address,
      port,
      'none',
      'tcp',
      { method: server.method, password: server.password },
      ob.tag
    );
  }

  private static build(
    protocol: ParsedConfig['protocol'],
    address: string,
    port: number,
    security: ParsedConfig['security'],
    network: ParsedConfig['network'],
    details: Record<string, any>,
    tag?: string
  ): ParsedConfig {
    const auth = String(
      details.uuid || details.password || details.method || ''
    );
    const config_hash = crypto
      .createHash('sha256')
      .update(`${protocol}:${address.toLowerCase()}:${port}:${auth}`)
      .digest('hex');

    const remark = (tag && String(tag).trim()) || `${address}:${port}`;

    return {
      protocol,
      address,
      port,
      remark: remark.replace(/[\r\n\t]/g, ' ').slice(0, 70),
      security,
      network,
      raw_url: `json://${protocol}/${address}:${port}`,
      config_hash,
      details
    };
  }
}
