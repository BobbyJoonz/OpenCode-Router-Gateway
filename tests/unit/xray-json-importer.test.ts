// Covers XrayJsonImporter.parse: v2rayN-style multi-outbound documents,
// vmess/vless/trojan/shadowsocks conversion, ignoring freedom/blackhole/dns
// outbounds, single-object and array-of-documents input, malformed JSON and
// malformed outbounds returning [], VLESS-without-TLS skipping, hashes and
// remark sanitisaion.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { XrayJsonImporter } from '../../src/backend/parser/xray-json-importer';

const UUID = '6f0c1e2a-1111-4aaa-8bbb-123456789abc';

const freedom = { protocol: 'freedom', tag: 'direct' };
const blackhole = { protocol: 'blackhole', tag: 'block' };
const dnsOut = { protocol: 'dns', tag: 'dns-out' };

const vmessOut = {
  protocol: 'vmess',
  tag: 'vmess-node',
  settings: {
    vnext: [{ address: 'vmess.example.com', port: 443, users: [{ id: UUID, alterId: 0, security: 'auto' }] }]
  },
  streamSettings: {
    network: 'ws',
    security: 'tls',
    wsSettings: { path: '/vm', headers: { Host: 'cdn.example.com' } },
    tlsSettings: { serverName: 'cdn.example.com', alpn: ['h2', 'http/1.1'] }
  }
};

const trojanOut = {
  protocol: 'trojan',
  tag: 'trojan-node',
  settings: { servers: [{ address: 'trojan.example.com', port: 8443, password: 'secret' }] },
  streamSettings: { network: 'grpc', security: 'tls', grpcSettings: { serviceName: 'svc' } }
};

const ssOut = {
  protocol: 'shadowsocks',
  tag: 'ss-node',
  settings: { servers: [{ address: 'ss.example.com', port: 8388, method: 'aes-256-gcm', password: 'sspass' }] }
};

const vlessRealityOut = {
  protocol: 'vless',
  tag: 'reality-node',
  settings: { vnext: [{ address: 'reality.example.com', port: 443, users: [{ id: UUID, flow: 'xtls-rprx-vision' }] }] },
  streamSettings: {
    network: 'tcp',
    security: 'reality',
    realitySettings: { serverName: 'reality.example.com', publicKey: 'PUB', shortId: 'sid1', fingerprint: 'firefox' }
  }
};

const vlessPlainOut = {
  protocol: 'vless',
  tag: 'plain-vless',
  settings: { vnext: [{ address: 'plain.example.com', port: 80, users: [{ id: UUID }] }] },
  streamSettings: { network: 'tcp', security: 'none' }
};

function doc(outbounds: any[]): string {
  return JSON.stringify({ outbounds });
}

describe('XrayJsonImporter: multi-outbound documents', () => {
  const parsed = XrayJsonImporter.parse(doc([vmessOut, trojanOut, freedom, blackhole, ssOut]));

  test('imports exactly the proxy outbounds and ignores freedom/blackhole', () => {
    assert.equal(parsed.length, 3);
    assert.deepEqual(
      parsed.map((p) => p.protocol),
      ['vmess', 'trojan', 'ss']
    );
    assert.deepEqual(
      parsed.map((p) => p.remark),
      ['vmess-node', 'trojan-node', 'ss-node']
    );
  });

  test('vmess fields, tls/ws transport and details are mapped', () => {
    const vmess = parsed[0];
    assert.equal(vmess.address, 'vmess.example.com');
    assert.equal(vmess.port, 443);
    assert.equal(vmess.security, 'tls');
    assert.equal(vmess.network, 'ws');
    assert.equal(vmess.details.uuid, UUID);
    assert.equal(vmess.details.alterId, 0);
    assert.equal(vmess.details.securityType, 'auto');
    assert.equal(vmess.details.sni, 'cdn.example.com');
    assert.equal(vmess.details.host, 'cdn.example.com');
    assert.equal(vmess.details.path, '/vm');
    assert.deepEqual(vmess.details.alpn, ['h2', 'http/1.1']);
    assert.equal(vmess.raw_url, 'json://vmess/vmess.example.com:443');
    assert.match(vmess.config_hash, /^[0-9a-f]{64}$/);
  });

  test('trojan is forced to tls and keeps grpc serviceName/password', () => {
    const trojan = parsed[1];
    assert.equal(trojan.security, 'tls');
    assert.equal(trojan.network, 'grpc');
    assert.equal(trojan.details.password, 'secret');
    assert.equal(trojan.details.serviceName, 'svc');
    assert.equal(trojan.details.sni, 'trojan.example.com');
  });

  test('shadowsocks keeps method/password, security none and tcp', () => {
    const ss = parsed[2];
    assert.equal(ss.security, 'none');
    assert.equal(ss.network, 'tcp');
    assert.equal(ss.details.method, 'aes-256-gcm');
    assert.equal(ss.details.password, 'sspass');
    assert.equal(ss.raw_url, 'json://ss/ss.example.com:8388');
  });
});

describe('XrayJsonImporter: input shapes', () => {
  test('accepts a single config object', () => {
    const parsed = XrayJsonImporter.parse(doc([vmessOut]));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].protocol, 'vmess');
  });

  test('accepts an array of config documents', () => {
    const parsed = XrayJsonImporter.parse(
      JSON.stringify([{ outbounds: [vmessOut] }, { outbounds: [trojanOut, ssOut] }])
    );
    assert.equal(parsed.length, 3);
    assert.deepEqual(
      parsed.map((p) => p.protocol),
      ['vmess', 'trojan', 'ss']
    );
  });

  test('ignores documents with no outbounds array', () => {
    assert.deepEqual(XrayJsonImporter.parse('{}'), []);
    assert.deepEqual(XrayJsonImporter.parse('{"outbounds":"nope"}'), []);
    assert.deepEqual(XrayJsonImporter.parse('[]'), []);
  });

  test('malformed JSON returns []', () => {
    assert.deepEqual(XrayJsonImporter.parse('this is not json'), []);
    assert.deepEqual(XrayJsonImporter.parse(''), []);
    assert.deepEqual(XrayJsonImporter.parse('{"outbounds": ['), []);
  });
});

describe('XrayJsonImporter: protocol filtering', () => {
  test('VLESS without TLS is skipped', () => {
    assert.deepEqual(XrayJsonImporter.parse(doc([vlessPlainOut])), []);
  });

  test('VLESS reality is imported with reality details', () => {
    const parsed = XrayJsonImporter.parse(doc([vlessRealityOut]));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].protocol, 'vless');
    assert.equal(parsed[0].security, 'reality');
    assert.equal(parsed[0].details.pbk, 'PUB');
    assert.equal(parsed[0].details.sid, 'sid1');
    assert.equal(parsed[0].details.fp, 'firefox');
    assert.equal(parsed[0].details.flow, 'xtls-rprx-vision');
  });

  test('unknown protocols, null entries and missing settings are ignored', () => {
    const parsed = XrayJsonImporter.parse(
      doc([
        { protocol: 'wireguard', tag: 'wg' },
        null,
        { protocol: 'vmess', tag: 'no-settings' },
        {
          protocol: 'vless',
          settings: { vnext: [{ address: 'x.example.com', port: 443, users: [] }] },
          streamSettings: { security: 'tls' }
        },
        { protocol: 'trojan', settings: { servers: [{ address: 'x.example.com', port: 443 }] } },
        { protocol: 'ss', settings: { servers: [{ address: 'x.example.com', port: 8388, method: 'aes-128-gcm' }] } }
      ])
    );
    assert.deepEqual(parsed, []);
  });

  test('vless without streamSettings is skipped (security defaults to none)', () => {
    const out = {
      protocol: 'vless',
      tag: 'no-stream',
      settings: { vnext: [{ address: 'x.example.com', port: 443, users: [{ id: UUID }] }] }
    };
    assert.deepEqual(XrayJsonImporter.parse(doc([out])), []);
  });

  test('missing tag falls back to address:port and tag newlines are sanitised', () => {
    const noTag = XrayJsonImporter.parse(
      doc([
        { protocol: 'trojan', settings: { servers: [{ address: 'notag.example.com', port: 443, password: 'pw' }] } }
      ])
    );
    assert.equal(noTag[0].remark, 'notag.example.com:443');

    const withNewline = XrayJsonImporter.parse(
      doc([
        {
          protocol: 'trojan',
          tag: 'A\nB',
          settings: { servers: [{ address: 'n.example.com', port: 443, password: 'pw' }] }
        }
      ])
    );
    assert.equal(withNewline[0].remark, 'A B');
  });
});

describe('XrayJsonImporter: hashes and defaults', () => {
  test('config_hash is stable and differs per address', () => {
    const a = XrayJsonImporter.parse(doc([trojanOut]))[0];
    const b = XrayJsonImporter.parse(doc([trojanOut]))[0];
    assert.equal(a.config_hash, b.config_hash);
    const moved = {
      ...trojanOut,
      settings: { servers: [{ ...trojanOut.settings.servers[0], address: 'other.example.com' }] }
    };
    const c = XrayJsonImporter.parse(doc([moved]))[0];
    assert.notEqual(a.config_hash, c.config_hash);
  });

  test('unknown transport falls back to tcp and missing tls details default sensibly', () => {
    const parsed = XrayJsonImporter.parse(
      doc([
        {
          protocol: 'vmess',
          tag: 'fallback',
          settings: { vnext: [{ address: 'f.example.com', port: 8080, users: [{ id: UUID }] }] },
          streamSettings: { network: 'xhttp', security: 'tls' }
        }
      ])
    );
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].network, 'tcp');
    assert.equal(parsed[0].security, 'tls');
    assert.equal(parsed[0].remark, 'fallback');
    assert.equal(parsed[0].details.sni, '');
    assert.equal(parsed[0].details.path, '');
    assert.deepEqual(parsed[0].details.alpn, undefined);
  });
});
