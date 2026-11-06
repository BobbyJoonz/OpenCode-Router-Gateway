import { ParsedConfig } from '../parser/config-parser';

/**
 * NOTE (Xray-core >= v26): the `tlsSettings.allowInsecure` field was removed upstream
 * ("has been removed and migrated to pinnedPeerCertSha256 (pcs) and verifyPeerCertByName (vcn)").
 * Emitting it makes Xray refuse the whole config, so it is intentionally omitted here.
 * Nodes that relied on skipping certificate verification will now fail the TLS handshake.
 */
export class XrayConfigBuilder {
  public static buildClientConfig(
    config: {
      protocol: string;
      address: string;
      port: number;
      security: string;
      network: string;
      details: Record<string, any>;
    },
    socksPort: number = 10808,
    httpPort: number = 10809
  ): Record<string, any> {
    // Defensive: callers may hand us `null`/`undefined`/a non-object when a row
    // has a corrupt details_json. Never crash on that.
    const safeConfig = {
      ...config,
      details:
        config.details && typeof config.details === 'object' && !Array.isArray(config.details) ? config.details : {}
    };
    const outbound = this.buildOutbound(safeConfig);

    return {
      log: {
        loglevel: 'warning'
      },
      inbounds: [
        {
          tag: 'socks-in',
          port: socksPort,
          listen: '127.0.0.1',
          protocol: 'socks',
          settings: {
            auth: 'noauth',
            udp: true
          }
        },
        {
          tag: 'http-in',
          port: httpPort,
          listen: '127.0.0.1',
          protocol: 'http',
          settings: {
            allowTransparent: false
          }
        }
      ],
      outbounds: [
        outbound,
        {
          tag: 'direct',
          protocol: 'freedom',
          settings: {
            domainStrategy: 'UseIP'
          }
        },
        {
          tag: 'block',
          protocol: 'blackhole',
          settings: {
            response: {
              type: 'http'
            }
          }
        }
      ],
      routing: {
        domainStrategy: 'IPIfNonMatch',
        rules: [
          {
            type: 'field',
            inboundTag: ['socks-in', 'http-in'],
            outboundTag: 'proxy'
          }
        ]
      }
    };
  }

  /**
   * Default ALPN per transport.
   *
   * WebSocket rides on HTTP/1.1. Advertising `h2` first makes CDN front-ends
   * (Cloudflare and friends) negotiate HTTP/2, after which the WebSocket
   * upgrade fails and the node looks dead even though TCP is fine.
   */
  private static defaultAlpn(network: string): string[] {
    return network === 'ws' ? ['http/1.1'] : ['h2', 'http/1.1'];
  }

  private static buildOutbound(config: {
    protocol: string;
    address: string;
    port: number;
    security: string;
    network: string;
    details: Record<string, any>;
  }): Record<string, any> {
    const { protocol, address, port, security, network, details } = config;

    switch (protocol) {
      case 'vless':
        return this.buildVlessOutbound(address, port, security, network, details);
      case 'vmess':
        return this.buildVmessOutbound(address, port, security, network, details);
      case 'trojan':
        return this.buildTrojanOutbound(address, port, security, network, details);
      case 'ss':
        return this.buildShadowsocksOutbound(address, port, details);
      default:
        throw new Error(`Unsupported protocol: ${protocol}`);
    }
  }

  private static buildVlessOutbound(
    address: string,
    port: number,
    security: string,
    network: string,
    details: Record<string, any>
  ): Record<string, any> {
    const streamSettings: Record<string, any> = {
      network: network || 'tcp',
      security: security || 'none'
    };

    if (security === 'reality') {
      streamSettings.realitySettings = {
        show: false,
        serverName: details.sni || address,
        fingerprint: details.fp || 'chrome',
        publicKey: details.pbk || '',
        shortId: details.sid || '',
        spiderX: ''
      };
    } else if (security === 'tls') {
      streamSettings.tlsSettings = {
        serverName: details.sni || address,
        fingerprint: details.fp || 'chrome',
        alpn: details.alpn || this.defaultAlpn(network)
      };
    }

    if (network === 'ws') {
      streamSettings.wsSettings = {
        path: details.path || '/',
        headers: details.host ? { Host: details.host } : {}
      };
    } else if (network === 'grpc') {
      streamSettings.grpcSettings = {
        serviceName: details.serviceName || details.path || '',
        multiMode: false
      };
    }

    // flow is only supported for tcp + (tls or reality)
    const validFlow = network === 'tcp' && (security === 'tls' || security === 'reality') ? details.flow || '' : '';

    return {
      tag: 'proxy',
      protocol: 'vless',
      settings: {
        vnext: [
          {
            address,
            port,
            users: [
              {
                id: details.uuid,
                encryption: details.encryption || 'none',
                flow: validFlow
              }
            ]
          }
        ]
      },
      streamSettings
    };
  }

  private static buildVmessOutbound(
    address: string,
    port: number,
    security: string,
    network: string,
    details: Record<string, any>
  ): Record<string, any> {
    const streamSettings: Record<string, any> = {
      network: network || 'tcp',
      security: security || 'none'
    };

    if (security === 'tls') {
      streamSettings.tlsSettings = {
        serverName: details.sni || details.host || address,
        alpn: details.alpn || this.defaultAlpn(network)
      };
    }

    if (network === 'ws') {
      streamSettings.wsSettings = {
        path: details.path || '/',
        headers: details.host ? { Host: details.host } : {}
      };
    } else if (network === 'grpc') {
      streamSettings.grpcSettings = {
        serviceName: details.serviceName || details.path || '',
        multiMode: false
      };
    }

    return {
      tag: 'proxy',
      protocol: 'vmess',
      settings: {
        vnext: [
          {
            address,
            port,
            users: [
              {
                id: details.uuid,
                alterId: details.alterId || 0,
                security: details.securityType || 'auto'
              }
            ]
          }
        ]
      },
      streamSettings
    };
  }

  private static buildTrojanOutbound(
    address: string,
    port: number,
    security: string,
    network: string,
    details: Record<string, any>
  ): Record<string, any> {
    const streamSettings: Record<string, any> = {
      network: network || 'tcp',
      security: 'tls',
      tlsSettings: {
        serverName: details.sni || address,
        alpn: details.alpn || this.defaultAlpn(network)
      }
    };

    if (network === 'ws') {
      streamSettings.wsSettings = {
        path: details.path || '/',
        headers: details.host ? { Host: details.host } : {}
      };
    } else if (network === 'grpc') {
      streamSettings.grpcSettings = {
        serviceName: details.serviceName || details.path || '',
        multiMode: false
      };
    }

    return {
      tag: 'proxy',
      protocol: 'trojan',
      settings: {
        servers: [
          {
            address,
            port,
            password: details.password
          }
        ]
      },
      streamSettings
    };
  }

  private static buildShadowsocksOutbound(
    address: string,
    port: number,
    details: Record<string, any>
  ): Record<string, any> {
    return {
      tag: 'proxy',
      protocol: 'shadowsocks',
      settings: {
        servers: [
          {
            address,
            port,
            method: details.method,
            password: details.password
          }
        ]
      }
    };
  }
}
