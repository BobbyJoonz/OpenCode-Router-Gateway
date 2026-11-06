// Covers ConfigParser.parse: valid vless (reality / tls / ws / grpc), vmess
// (base64 JSON), trojan and shadowsocks (both URI encodings); rejection of
// empty / comment / unknown / insecure VLESS / bad-port / missing-credential
// input; remark sanitisation (newlines, 70-char cap) and config_hash
// stability and uniqueness.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { ConfigParser } from '../../src/backend/parser/config-parser';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

const UUID = '6f0c1e2a-1111-4aaa-8bbb-123456789abc';
const UUID2 = '11111111-2222-4333-8444-555555555555';

const VLESS_REALITY =
  `vless://${UUID}@reality.example.com:443?type=tcp&security=reality&sni=reality.example.com` +
  '&pbk=PUBLIC_KEY&sid=ab12&fp=firefox&flow=xtls-rprx-vision#Reality%20Node';

const VLESS_TLS_WS =
  `vless://${UUID}@ws.example.org:8443?type=ws&security=tls&sni=ws.example.org` +
  '&host=cdn.example.org&path=%2Fws&alpn=h2%2Chttp%2F1.1#WS%20Node';

const VLESS_TLS_GRPC =
  `vless://${UUID}@grpc.example.org:443?type=grpc&security=tls&sni=grpc.example.org` +
  '&serviceName=my-svc#gRPC%20Node';

const VMBESS_OBJ = {
  v: '2',
  ps: 'VMess Node',
  add: 'vmess.example.com',
  port: '443',
  id: UUID,
  aid: '0',
  scy: 'auto',
  net: 'ws',
  type: 'none',
  host: 'cdn.example.com',
  path: '/vm',
  tls: 'tls',
  sni: 'cdn.example.com',
  alpn: 'h2,http/1.1'
};
const VMESS = `vmess://${b64(JSON.stringify(VMBESS_OBJ))}`;
const VMESS_PLAIN = `vmess://${b64(JSON.stringify({ add: 'plain.example.com', port: 80, id: UUID }))}`;
const VMESS_NO_ID = `vmess://${b64(JSON.stringify({ add: 'bad.example.com', port: 443 }))}`;
const VMESS_BAD_PORT = `vmess://${b64(JSON.stringify({ add: 'bad.example.com', port: 'abc', id: UUID }))}`;
const VMESS_JUNK = `vmess://${b64('this is not json')}`;

const TROJAN_WS =
  'trojan://secret-pass@trojan.example.net:443?type=ws&sni=trojan.example.net' +
  '&path=%2Ftj&alpn=h2%2Chttp%2F1.1#Trojan%20Node';
const TROJAN_GRPC = 'trojan://pw@trojan.example.net:8443?type=grpc&sni=trojan.example.net&serviceName=svc';
const TROJAN_NO_PASSWORD = 'trojan://@trojan.example.net:443?type=ws';

const SS_USERINFO_B64 = `ss://${b64('aes-256-gcm:secret pass')}@ss.example.com:8388#SS%20Node`;
const SS_WHOLE_B64 = `ss://${b64('chacha20-ietf-poly1305:pw@ss2.example.com:443')}#Full%20Base64`;
const SS_NO_REMARK = `ss://${b64('aes-128-gcm:pw')}@ss3.example.com:8389`;
const SS_BAD_PORT = `ss://${b64('aes-128-gcm:pw')}@ss3.example.com:notaport`;

describe('ConfigParser: valid vless', () => {
  test('reality/tcp parses all details', () => {
    const cfg = ConfigParser.parse(VLESS_REALITY);
    assert.ok(cfg);
    assert.equal(cfg!.protocol, 'vless');
    assert.equal(cfg!.address, 'reality.example.com');
    assert.equal(cfg!.port, 443);
    assert.equal(cfg!.security, 'reality');
    assert.equal(cfg!.network, 'tcp');
    assert.equal(cfg!.remark, 'Reality Node');
    assert.equal(cfg!.details.uuid, UUID);
    assert.equal(cfg!.details.sni, 'reality.example.com');
    assert.equal(cfg!.details.pbk, 'PUBLIC_KEY');
    assert.equal(cfg!.details.sid, 'ab12');
    assert.equal(cfg!.details.fp, 'firefox');
    assert.equal(cfg!.details.flow, 'xtls-rprx-vision');
    assert.equal(cfg!.details.allowInsecure, false);
    assert.match(cfg!.config_hash, /^[0-9a-f]{64}$/);
  });

  test('tls + ws exposes host/path/alpn and network', () => {
    const cfg = ConfigParser.parse(VLESS_TLS_WS);
    assert.ok(cfg);
    assert.equal(cfg!.security, 'tls');
    assert.equal(cfg!.network, 'ws');
    assert.equal(cfg!.details.host, 'cdn.example.org');
    assert.equal(cfg!.details.path, '/ws');
    assert.deepEqual(cfg!.details.alpn, ['h2', 'http/1.1']);
    assert.equal(cfg!.remark, 'WS Node');
  });

  test('tls + grpc exposes serviceName', () => {
    const cfg = ConfigParser.parse(VLESS_TLS_GRPC);
    assert.ok(cfg);
    assert.equal(cfg!.network, 'grpc');
    assert.equal(cfg!.details.serviceName, 'my-svc');
    assert.equal(cfg!.security, 'tls');
  });

  test('unknown transport type falls back to tcp and missing sni falls back to host', () => {
    const url = `vless://${UUID}@h.example.com:443?type=quic&security=tls&host=host.example.com#x`;
    const cfg = ConfigParser.parse(url);
    assert.ok(cfg);
    assert.equal(cfg!.network, 'tcp');
    assert.equal(cfg!.details.sni, 'host.example.com');
  });

  test('encryption/flow defaults and leading whitespace are tolerated', () => {
    const cfg = ConfigParser.parse(`   vless://${UUID}@d.example.com:443?type=tcp&security=tls#  trimmed  `);
    assert.ok(cfg);
    assert.equal(cfg!.details.encryption, 'none');
    assert.equal(cfg!.details.flow, '');
    assert.equal(cfg!.remark, 'trimmed');
  });
});

describe('ConfigParser: invalid vless', () => {
  test('security=none is rejected', () => {
    assert.equal(ConfigParser.parse(`vless://${UUID}@plain.example.com:80?type=tcp#NoTLS`), null);
  });

  test('no security parameter is treated as none and rejected', () => {
    assert.equal(ConfigParser.parse(`vless://${UUID}@plain.example.com:80`), null);
  });

  test('missing uuid is rejected', () => {
    assert.equal(ConfigParser.parse('vless://@plain.example.com:443?security=tls'), null);
  });

  test('missing port and port 0 are rejected', () => {
    assert.equal(ConfigParser.parse(`vless://${UUID}@plain.example.com?security=tls`), null);
    assert.equal(ConfigParser.parse(`vless://${UUID}@plain.example.com:0?security=tls`), null);
  });

  test('out-of-range port is rejected (URL parser throws)', () => {
    assert.equal(ConfigParser.parse(`vless://${UUID}@plain.example.com:99999?security=tls`), null);
  });

  test('truncated vless URI is rejected', () => {
    assert.equal(ConfigParser.parse('vless://'), null);
  });
});

describe('ConfigParser: vmess', () => {
  test('base64 JSON is decoded', () => {
    const cfg = ConfigParser.parse(VMESS);
    assert.ok(cfg);
    assert.equal(cfg!.protocol, 'vmess');
    assert.equal(cfg!.address, 'vmess.example.com');
    assert.equal(cfg!.port, 443);
    assert.equal(cfg!.security, 'tls');
    assert.equal(cfg!.network, 'ws');
    assert.equal(cfg!.remark, 'VMess Node');
    assert.equal(cfg!.details.uuid, UUID);
    assert.equal(cfg!.details.alterId, 0);
    assert.equal(cfg!.details.securityType, 'auto');
    assert.equal(cfg!.details.sni, 'cdn.example.com');
    assert.equal(cfg!.details.host, 'cdn.example.com');
    assert.equal(cfg!.details.path, '/vm');
    assert.equal(cfg!.details.allowInsecure, false);
    assert.deepEqual(cfg!.details.alpn, ['h2', 'http/1.1']);
  });

  test('without tls stays security=none and network defaults to tcp', () => {
    const cfg = ConfigParser.parse(VMESS_PLAIN);
    assert.ok(cfg);
    assert.equal(cfg!.security, 'none');
    assert.equal(cfg!.network, 'tcp');
    assert.equal(cfg!.remark, 'plain.example.com:80');
  });

  test('missing id / bad port / junk JSON are rejected', () => {
    assert.equal(ConfigParser.parse(VMESS_NO_ID), null);
    assert.equal(ConfigParser.parse(VMESS_BAD_PORT), null);
    assert.equal(ConfigParser.parse(VMESS_JUNK), null);
    assert.equal(ConfigParser.parse('vmess://'), null);
  });
});

describe('ConfigParser: trojan', () => {
  test('trojan is always tls and keeps ws details', () => {
    const cfg = ConfigParser.parse(TROJAN_WS);
    assert.ok(cfg);
    assert.equal(cfg!.protocol, 'trojan');
    assert.equal(cfg!.security, 'tls');
    assert.equal(cfg!.network, 'ws');
    assert.equal(cfg!.remark, 'Trojan Node');
    assert.equal(cfg!.details.password, 'secret-pass');
    assert.equal(cfg!.details.path, '/tj');
    assert.equal(cfg!.details.sni, 'trojan.example.net');
    assert.deepEqual(cfg!.details.alpn, ['h2', 'http/1.1']);
  });

  test('grpc trojan defaults alpn and uses sni for server name', () => {
    const cfg = ConfigParser.parse(TROJAN_GRPC);
    assert.ok(cfg);
    assert.equal(cfg!.network, 'grpc');
    assert.deepEqual(cfg!.details.alpn, ['h2', 'http/1.1']);
    assert.equal(cfg!.details.sni, 'trojan.example.net');
    assert.equal(cfg!.remark, 'trojan.example.net:8443');
  });

  test('missing password is rejected', () => {
    assert.equal(ConfigParser.parse(TROJAN_NO_PASSWORD), null);
  });
});

describe('ConfigParser: shadowsocks', () => {
  test('base64 userinfo form is decoded', () => {
    const cfg = ConfigParser.parse(SS_USERINFO_B64);
    assert.ok(cfg);
    assert.equal(cfg!.protocol, 'ss');
    assert.equal(cfg!.address, 'ss.example.com');
    assert.equal(cfg!.port, 8388);
    assert.equal(cfg!.security, 'none');
    assert.equal(cfg!.network, 'tcp');
    assert.equal(cfg!.remark, 'SS Node');
    assert.equal(cfg!.details.method, 'aes-256-gcm');
    assert.equal(cfg!.details.password, 'secret pass');
  });

  test('fully base64 encoded form is decoded', () => {
    const cfg = ConfigParser.parse(SS_WHOLE_B64);
    assert.ok(cfg);
    assert.equal(cfg!.address, 'ss2.example.com');
    assert.equal(cfg!.port, 443);
    assert.equal(cfg!.details.method, 'chacha20-ietf-poly1305');
    assert.equal(cfg!.details.password, 'pw');
    assert.equal(cfg!.remark, 'Full Base64');
  });

  test('missing remark falls back to address:port', () => {
    const cfg = ConfigParser.parse(SS_NO_REMARK);
    assert.ok(cfg);
    assert.equal(cfg!.remark, 'ss3.example.com:8389');
  });

  test('bad port and non-decodable payloads are rejected', () => {
    assert.equal(ConfigParser.parse(SS_BAD_PORT), null);
    assert.equal(ConfigParser.parse('ss://%%%notbase64'), null);
  });
});

describe('ConfigParser: rejections and remark hygiene', () => {
  test('empty, whitespace and comment lines return null', () => {
    assert.equal(ConfigParser.parse(''), null);
    assert.equal(ConfigParser.parse('    '), null);
    assert.equal(ConfigParser.parse('# comment line'), null);
  });

  test('unknown scheme returns null', () => {
    assert.equal(ConfigParser.parse('http://example.com/sub'), null);
    assert.equal(ConfigParser.parse('trojan-garbage'), null);
  });

  test('newlines and tabs in remark become single spaces', () => {
    const url = `vless://${UUID}@r.example.com:443?type=tcp&security=tls#line1%0Aline2%09x`;
    const cfg = ConfigParser.parse(url);
    assert.ok(cfg);
    assert.equal(cfg!.remark, 'line1 line2 x');
    assert.equal(cfg!.remark.includes('\n'), false);
    assert.equal(cfg!.remark.includes('\t'), false);
  });

  test('remark is capped at 70 characters', () => {
    const long = 'a'.repeat(100);
    const url = `vless://${UUID}@r.example.com:443?type=tcp&security=tls#${long}`;
    const cfg = ConfigParser.parse(url);
    assert.ok(cfg);
    assert.equal(cfg!.remark.length, 70);
    assert.equal(cfg!.remark, 'a'.repeat(70));
  });
});

describe('ConfigParser: config_hash', () => {
  test('is stable for identical input and 64 hex chars', () => {
    const a = ConfigParser.parse(VLESS_TLS_WS);
    const b = ConfigParser.parse(VLESS_TLS_WS);
    assert.ok(a && b);
    assert.equal(a!.config_hash, b!.config_hash);
    assert.match(a!.config_hash, /^[0-9a-f]{64}$/);
  });

  test('differs when the port changes', () => {
    const a = ConfigParser.parse(VLESS_TLS_WS);
    const b = ConfigParser.parse(VLESS_TLS_WS.replace(':8443', ':9443'));
    assert.ok(a && b);
    assert.notEqual(a!.config_hash, b!.config_hash);
  });

  test('differs when the uuid changes', () => {
    const a = ConfigParser.parse(VLESS_TLS_WS);
    const b = ConfigParser.parse(VLESS_TLS_WS.split(UUID).join(UUID2));
    assert.ok(a && b);
    assert.notEqual(a!.config_hash, b!.config_hash);
  });
});
