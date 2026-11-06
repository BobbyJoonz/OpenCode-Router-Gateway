import crypto from 'crypto';

export interface ParsedConfig {
  protocol: 'vless' | 'vmess' | 'trojan' | 'ss';
  address: string;
  port: number;
  remark: string;
  security: 'tls' | 'reality' | 'none';
  network: 'tcp' | 'ws' | 'grpc' | 'h2';
  raw_url: string;
  config_hash: string;
  details: Record<string, any>;
}

export class ConfigParser {
  /**
   * Parse a single configuration URL (vless, vmess, trojan, ss)
   * Returns ParsedConfig or null if invalid.
   */
  public static parse(rawLine: string): ParsedConfig | null {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) return null;

    try {
      if (trimmed.startsWith('vless://')) {
        return this.parseVless(trimmed);
      } else if (trimmed.startsWith('vmess://')) {
        return this.parseVmess(trimmed);
      } else if (trimmed.startsWith('trojan://')) {
        return this.parseTrojan(trimmed);
      } else if (trimmed.startsWith('ss://')) {
        return this.parseShadowsocks(trimmed);
      }
    } catch {
      return null;
    }

    return null;
  }

  private static parseVless(rawUrl: string): ParsedConfig | null {
    const u = new URL(rawUrl);
    const address = u.hostname;
    const port = parseInt(u.port, 10);
    const uuid = u.username;

    if (!address || isNaN(port) || port <= 0 || port > 65535 || !uuid) {
      return null;
    }

    const search = Object.fromEntries(u.searchParams);
    const security = (search.security === 'reality' ? 'reality' : (search.security === 'tls' ? 'tls' : 'none')) as 'tls' | 'reality' | 'none';
    
    // Xray-core strictly prohibits unencrypted VLESS over public networks
    if (security === 'none') {
      return null;
    }

    const network = (['ws', 'grpc', 'h2', 'tcp'].includes(search.type) ? search.type : 'tcp') as 'tcp' | 'ws' | 'grpc' | 'h2';
    
    let remark = u.hash ? decodeURIComponent(u.hash.replace(/^#/, '')) : `${address}:${port}`;
    remark = this.sanitizeRemark(remark);

    const details = {
      uuid,
      encryption: search.encryption || 'none',
      flow: search.flow || '',
      sni: search.sni || search.host || '',
      host: search.host || '',
      path: search.path ? decodeURIComponent(search.path) : '',
      serviceName: search.serviceName || search.path || '',
      pbk: search.pbk || '',
      sid: search.sid || '',
      fp: search.fp || 'chrome',
      allowInsecure: search.insecure === '1' || search.allowInsecure === '1' || search.allowInsecure === 'true',
      alpn: search.alpn ? search.alpn.split(',') : undefined
    };

    const config_hash = this.createHash('vless', address, port, uuid);

    return {
      protocol: 'vless',
      address,
      port,
      remark,
      security,
      network,
      raw_url: rawUrl,
      config_hash,
      details
    };
  }

  private static parseVmess(rawUrl: string): ParsedConfig | null {
    const b64 = rawUrl.slice(8).trim();
    let jsonStr: string;
    try {
      jsonStr = Buffer.from(b64, 'base64').toString('utf-8');
    } catch {
      return null;
    }

    let obj: any;
    try {
      obj = JSON.parse(jsonStr);
    } catch {
      return null;
    }

    const address = obj.add;
    const port = parseInt(obj.port, 10);
    const uuid = obj.id;

    if (!address || isNaN(port) || port <= 0 || port > 65535 || !uuid) {
      return null;
    }

    const security = (obj.tls === 'tls' ? 'tls' : 'none') as 'tls' | 'none';
    const network = (['ws', 'grpc', 'h2', 'tcp'].includes(obj.net) ? obj.net : 'tcp') as 'tcp' | 'ws' | 'grpc' | 'h2';

    let remark = obj.ps ? String(obj.ps) : `${address}:${port}`;
    remark = this.sanitizeRemark(remark);

    const details = {
      uuid,
      alterId: parseInt(obj.aid, 10) || 0,
      securityType: obj.scy || 'auto',
      sni: obj.sni || obj.host || '',
      host: obj.host || '',
      path: obj.path || '',
      type: obj.type || 'none',
      allowInsecure: obj['zkip-cert-evrify'] === true || obj.insecure === 1 || obj.allowInsecure === true,
      alpn: obj.alpn ? String(obj.alpn).split(',') : undefined
    };

    const config_hash = this.createHash('vmess', address, port, uuid);

    return {
      protocol: 'vmess',
      address,
      port,
      remark,
      security,
      network,
      raw_url: rawUrl,
      config_hash,
      details
    };
  }

  private static parseTrojan(rawUrl: string): ParsedConfig | null {
    const u = new URL(rawUrl);
    const address = u.hostname;
    const port = parseInt(u.port, 10);
    const password = u.username;

    if (!address || isNaN(port) || port <= 0 || port > 65535 || !password) {
      return null;
    }

    const search = Object.fromEntries(u.searchParams);
    const security = 'tls';
    const network = (['ws', 'grpc', 'tcp'].includes(search.type) ? search.type : 'tcp') as 'tcp' | 'ws' | 'grpc' | 'h2';

    let remark = u.hash ? decodeURIComponent(u.hash.replace(/^#/, '')) : `${address}:${port}`;
    remark = this.sanitizeRemark(remark);

    const details = {
      password,
      sni: search.sni || search.peer || address,
      alpn: search.alpn ? search.alpn.split(',') : ['h2', 'http/1.1'],
      path: search.path ? decodeURIComponent(search.path) : '',
      host: search.host || '',
      allowInsecure: search.insecure === '1' || search.allowInsecure === '1' || search.allowInsecure === 'true'
    };

    const config_hash = this.createHash('trojan', address, port, password);

    return {
      protocol: 'trojan',
      address,
      port,
      remark,
      security,
      network,
      raw_url: rawUrl,
      config_hash,
      details
    };
  }

  private static parseShadowsocks(rawUrl: string): ParsedConfig | null {
    // ss://base64(method:password)@host:port#remark
    // or ss://base64(method:password@host:port)#remark
    const withoutPrefix = rawUrl.slice(5);
    const hashIndex = withoutPrefix.indexOf('#');
    let encodedPart = hashIndex !== -1 ? withoutPrefix.slice(0, hashIndex) : withoutPrefix;
    const hashPart = hashIndex !== -1 ? withoutPrefix.slice(hashIndex + 1) : '';

    let remark = hashPart ? decodeURIComponent(hashPart) : '';

    let method = '';
    let password = '';
    let address = '';
    let port = 0;

    if (encodedPart.includes('@')) {
      const atIdx = encodedPart.lastIndexOf('@');
      const userInfoB64 = encodedPart.slice(0, atIdx);
      const serverPart = encodedPart.slice(atIdx + 1);

      let userInfo = userInfoB64;
      try {
        userInfo = Buffer.from(userInfoB64, 'base64').toString('utf-8');
      } catch {
        // May not be base64
      }

      const colonIdx = userInfo.indexOf(':');
      if (colonIdx === -1) return null;
      method = userInfo.slice(0, colonIdx);
      password = userInfo.slice(colonIdx + 1);

      const serverColon = serverPart.lastIndexOf(':');
      if (serverColon === -1) return null;
      address = serverPart.slice(0, serverColon);
      port = parseInt(serverPart.slice(serverColon + 1), 10);
    } else {
      // Entire string is base64
      let decoded = '';
      try {
        decoded = Buffer.from(encodedPart, 'base64').toString('utf-8');
      } catch {
        return null;
      }
      const atIdx = decoded.lastIndexOf('@');
      if (atIdx === -1) return null;
      const userInfo = decoded.slice(0, atIdx);
      const serverPart = decoded.slice(atIdx + 1);

      const colonIdx = userInfo.indexOf(':');
      if (colonIdx === -1) return null;
      method = userInfo.slice(0, colonIdx);
      password = userInfo.slice(colonIdx + 1);

      const serverColon = serverPart.lastIndexOf(':');
      if (serverColon === -1) return null;
      address = serverPart.slice(0, serverColon);
      port = parseInt(serverPart.slice(serverColon + 1), 10);
    }

    if (!address || isNaN(port) || port <= 0 || port > 65535 || !method || !password) {
      return null;
    }

    remark = this.sanitizeRemark(remark || `${address}:${port}`);

    const details = {
      method,
      password
    };

    const config_hash = this.createHash('ss', address, port, password);

    return {
      protocol: 'ss',
      address,
      port,
      remark,
      security: 'none',
      network: 'tcp',
      raw_url: rawUrl,
      config_hash,
      details
    };
  }

  private static sanitizeRemark(remark: string): string {
    return remark
      .replace(/[\r\n\t]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 70);
  }

  private static createHash(protocol: string, address: string, port: number, auth: string): string {
    const data = `${protocol}:${address.toLowerCase()}:${port}:${auth}`;
    return crypto.createHash('sha256').update(data).digest('hex');
  }
}
