// Covers XrayConfigBuilder.buildClientConfig: loopback SOCKS/HTTP inbounds,
// routing rule to the 'proxy' outbound, protocol-specific outbounds for
// vless/vmess/trojan/shadowsocks, per-transport ALPN, reality vs tls settings,
// absence of the Xray v26-removed `allowInsecure` key, rejection of unknown
// protocols and tolerance of null/undefined details.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { XrayConfigBuilder } from '../../src/backend/vpn/xray-config-builder';

const UUID = '6f0c1e2a-1111-4aaa-8bbb-123456789abc';

/** Build an input config with sane defaults; callers override fields. */
function cfg(over: Record<string, any> = {}): any {
  return {
    protocol: 'vless',
    address: 'node.example.com',
    port: 443,
    security: 'tls',
    network: 'tcp',
    details: { uuid: UUID },
    ...over
  };
}

function build(over: Record<string, any> = {}, socksPort = 10808, httpPort = 10809) {
  return XrayConfigBuilder.buildClientConfig(cfg(over), socksPort, httpPort);
}

function proxyOutbound(config: any): any {
  const outbound = config.outbounds.find((o: any) => o.tag === 'proxy');
  assert.ok(outbound, 'expected an outbound tagged proxy');
  return outbound;
}

describe('XrayConfigBuilder: inbounds, routing and defaults', () => {
  test('creates loopback socks and http inbounds on the requested ports', () => {
    const config = build({}, 20000, 20001);
    assert.equal(config.inbounds.length, 2);
    assert.equal(config.inbounds[0].tag, 'socks-in');
    assert.equal(config.inbounds[0].protocol, 'socks');
    assert.equal(config.inbounds[0].listen, '127.0.0.1');
    assert.equal(config.inbounds[0].port, 20000);
    assert.equal(config.inbounds[1].tag, 'http-in');
    assert.equal(config.inbounds[1].protocol, 'http');
    assert.equal(config.inbounds[1].listen, '127.0.0.1');
    assert.equal(config.inbounds[1].port, 20001);
  });

  test('uses 10808/10809 by default and routes both inbounds to proxy', () => {
    const config = build();
    assert.equal(config.inbounds[0].port, 10808);
    assert.equal(config.inbounds[1].port, 10809);
    assert.equal(config.routing.domainStrategy, 'IPIfNonMatch');
    assert.equal(config.routing.rules.length, 1);
    assert.equal(config.routing.rules[0].outboundTag, 'proxy');
    assert.deepEqual(config.routing.rules[0].inboundTag, ['socks-in', 'http-in']);
    assert.equal(config.outbounds[0].tag, 'proxy');
    assert.ok(config.outbounds.some((o: any) => o.tag === 'direct'));
    assert.ok(config.outbounds.some((o: any) => o.tag === 'block'));
    assert.equal(config.log.loglevel, 'warning');
  });
});

describe('XrayConfigBuilder: vless', () => {
  test('reality outbound uses realitySettings (no tlsSettings)', () => {
    const config = build({
      protocol: 'vless',
      security: 'reality',
      network: 'tcp',
      details: {
        uuid: UUID,
        sni: 'reality.example.com',
        pbk: 'PUB',
        sid: 'sid1',
        fp: 'firefox',
        flow: 'xtls-rprx-vision'
      }
    });
    const outbound = proxyOutbound(config);
    assert.equal(outbound.protocol, 'vless');
    assert.equal(outbound.settings.vnext[0].address, 'node.example.com');
    assert.equal(outbound.settings.vnext[0].port, 443);
    assert.equal(outbound.settings.vnext[0].users[0].id, UUID);
    assert.equal(outbound.settings.vnext[0].users[0].flow, 'xtls-rprx-vision');
    const stream = outbound.streamSettings;
    assert.equal(stream.security, 'reality');
    assert.equal(stream.network, 'tcp');
    assert.ok(stream.realitySettings);
    assert.equal(stream.tlsSettings, undefined);
    assert.equal(stream.realitySettings.serverName, 'reality.example.com');
    assert.equal(stream.realitySettings.publicKey, 'PUB');
    assert.equal(stream.realitySettings.shortId, 'sid1');
    assert.equal(stream.realitySettings.fingerprint, 'firefox');
    assert.equal(stream.realitySettings.show, false);
  });

  test('tls+ws ALPN is http/1.1 only and wsSettings carry path + Host', () => {
    const config = build({
      protocol: 'vless',
      security: 'tls',
      network: 'ws',
      details: { uuid: UUID, sni: 'cdn.example.com', host: 'cdn.example.com', path: '/ws', flow: 'xtls-rprx-vision' }
    });
    const outbound = proxyOutbound(config);
    const stream = outbound.streamSettings;
    assert.equal(stream.security, 'tls');
    assert.equal(stream.network, 'ws');
    assert.equal(stream.realitySettings, undefined);
    assert.deepEqual(stream.tlsSettings.alpn, ['http/1.1']);
    assert.equal(stream.tlsSettings.serverName, 'cdn.example.com');
    assert.equal(stream.wsSettings.path, '/ws');
    assert.deepEqual(stream.wsSettings.headers, { Host: 'cdn.example.com' });
    // flow only makes sense for tcp + tls/reality
    assert.equal(outbound.settings.vnext[0].users[0].flow, '');
  });

  test('tls+tcp ALPN is h2, http/1.1', () => {
    const config = build({ protocol: 'vless', security: 'tls', network: 'tcp', details: { uuid: UUID } });
    const stream = proxyOutbound(config).streamSettings;
    assert.deepEqual(stream.tlsSettings.alpn, ['h2', 'http/1.1']);
    assert.equal(stream.wsSettings, undefined);
    assert.equal(stream.realitySettings, undefined);
  });

  test('tls+grpc uses grpcSettings serviceName and default ALPN', () => {
    const config = build({
      protocol: 'vless',
      security: 'tls',
      network: 'grpc',
      details: { uuid: UUID, path: '/ignored', serviceName: 'svc' }
    });
    const stream = proxyOutbound(config).streamSettings;
    assert.equal(stream.network, 'grpc');
    assert.equal(stream.grpcSettings.serviceName, 'svc');
    assert.equal(stream.grpcSettings.multiMode, false);
    assert.deepEqual(stream.tlsSettings.alpn, ['h2', 'http/1.1']);
  });
});

describe('XrayConfigBuilder: vmess', () => {
  test('maps uuid, alterId, security type and ws transport', () => {
    const config = build({
      protocol: 'vmess',
      security: 'tls',
      network: 'ws',
      details: {
        uuid: UUID,
        alterId: 0,
        securityType: 'auto',
        sni: 'cdn.example.com',
        host: 'cdn.example.com',
        path: '/vm'
      }
    });
    const outbound = proxyOutbound(config);
    assert.equal(outbound.protocol, 'vmess');
    assert.equal(outbound.settings.vnext[0].users[0].id, UUID);
    assert.equal(outbound.settings.vnext[0].users[0].alterId, 0);
    assert.equal(outbound.settings.vnext[0].users[0].security, 'auto');
    assert.equal(outbound.streamSettings.network, 'ws');
    assert.deepEqual(outbound.streamSettings.tlsSettings.alpn, ['http/1.1']);
    assert.equal(outbound.streamSettings.wsSettings.path, '/vm');
  });

  test('non-tls vmess has no tlsSettings and grpc maps serviceName', () => {
    const config = build({
      protocol: 'vmess',
      security: 'none',
      network: 'grpc',
      details: { uuid: UUID, serviceName: 'g' }
    });
    const stream = proxyOutbound(config).streamSettings;
    assert.equal(stream.security, 'none');
    assert.equal(stream.tlsSettings, undefined);
    assert.equal(stream.grpcSettings.serviceName, 'g');
  });
});

describe('XrayConfigBuilder: trojan', () => {
  test('is always tls and carries the password', () => {
    const config = build({
      protocol: 'trojan',
      security: 'none',
      network: 'ws',
      details: { password: 'pw', sni: 's.example.com', path: '/tj' }
    });
    const outbound = proxyOutbound(config);
    assert.equal(outbound.protocol, 'trojan');
    assert.equal(outbound.settings.servers[0].address, 'node.example.com');
    assert.equal(outbound.settings.servers[0].port, 443);
    assert.equal(outbound.settings.servers[0].password, 'pw');
    assert.equal(outbound.streamSettings.security, 'tls');
    assert.equal(outbound.streamSettings.tlsSettings.serverName, 's.example.com');
    assert.deepEqual(outbound.streamSettings.tlsSettings.alpn, ['http/1.1']);
    assert.equal(outbound.streamSettings.wsSettings.path, '/tj');
  });

  test('explicit alpn wins over the transport default', () => {
    const config = build({
      protocol: 'vless',
      security: 'tls',
      network: 'tcp',
      details: { uuid: UUID, alpn: ['http/1.1'] }
    });
    assert.deepEqual(proxyOutbound(config).streamSettings.tlsSettings.alpn, ['http/1.1']);
  });
});

describe('XrayConfigBuilder: shadowsocks', () => {
  test('emits a shadowsocks outbound with method/password and no streamSettings', () => {
    const config = build({ protocol: 'ss', security: 'none', details: { method: 'aes-256-gcm', password: 'pw' } });
    const outbound = proxyOutbound(config);
    assert.equal(outbound.protocol, 'shadowsocks');
    assert.equal(outbound.settings.servers[0].method, 'aes-256-gcm');
    assert.equal(outbound.settings.servers[0].password, 'pw');
    assert.equal(outbound.streamSettings, undefined);
  });
});

describe('XrayConfigBuilder: guards and defensive behaviour', () => {
  test('unknown protocol throws', () => {
    assert.throws(() => build({ protocol: 'wireguard' }), /Unsupported protocol: wireguard/);
  });

  test('null or undefined details never throw', () => {
    assert.doesNotThrow(() => build({ protocol: 'vless', details: null }));
    assert.doesNotThrow(() => build({ protocol: 'vmess', details: undefined }));
    assert.doesNotThrow(() => build({ protocol: 'trojan', details: 'not-an-object' }));
    const outbound = proxyOutbound(build({ protocol: 'vless', details: null }));
    assert.equal(outbound.settings.vnext[0].users[0].id, undefined);
  });

  test('never emits the v26-removed allowInsecure key, even when the node requested it', () => {
    const configs = [
      build({ protocol: 'vless', security: 'tls', details: { uuid: UUID, allowInsecure: true } }),
      build({ protocol: 'vless', security: 'reality', details: { uuid: UUID, allowInsecure: true } }),
      build({ protocol: 'vmess', security: 'tls', details: { uuid: UUID, allowInsecure: true } }),
      build({ protocol: 'trojan', details: { password: 'pw', allowInsecure: true } })
    ];
    for (const config of configs) {
      assert.equal(JSON.stringify(config).includes('allowInsecure'), false);
    }
  });
});
