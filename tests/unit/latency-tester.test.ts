/**
 * Coverage: src/backend/tester/latency-tester.ts
 *
 * - testRemoteTcp: a real loopback TCP listener on an ephemeral port is
 *   reachable with a finite, non-negative latency; a closed localhost port and
 *   an invalid host resolve reachable:false with an error message (never hang).
 * - testProxyHttp: a local HTTP server acting as an explicit proxy returns
 *   success:true, a non-negative latency and the egress IP parsed from an
 *   `ip=` body field; a closed proxy port returns success:false.
 * - getNormalPublicIp: never throws (global fetch mocked to reject -> fallback
 *   string) and masks a reported IPv4/IPv6 address.
 *
 * All network traffic is loopback-only; servers are closed in after().
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { after, describe, it } from 'node:test';
import { LatencyTester } from '../../src/backend/tester/latency-tester';

const servers: Array<net.Server | http.Server> = [];
const originalFetch = globalThis.fetch;

after(async () => {
  (globalThis as any).fetch = originalFetch;
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) return resolve();
          server.close(() => resolve());
        })
    )
  );
});

function listen(server: net.Server | http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        servers.push(server);
        resolve(address.port);
      } else {
        reject(new Error('server did not report a bound port'));
      }
    });
  });
}

function close(server: net.Server | http.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
}

/** Reserve an ephemeral port and release it so the port is reliably closed. */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  const port = await listen(server);
  await close(server);
  servers.splice(servers.indexOf(server), 1);
  return port;
}

describe('testRemoteTcp', () => {
  it('reports a reachable loopback listener with a non-negative latency', async () => {
    const server = net.createServer((socket) => socket.destroy());
    const port = await listen(server);
    try {
      const result = await LatencyTester.testRemoteTcp('127.0.0.1', port, 1000);
      assert.equal(result.reachable, true);
      assert.ok(Number.isFinite(result.latencyMs), 'latency must be finite');
      assert.ok(result.latencyMs >= 0, `latency must be >= 0, got ${result.latencyMs}`);
      assert.equal(result.error, undefined);
    } finally {
      await close(server);
    }
  });

  it('reports a closed port as unreachable', async () => {
    const port = await closedPort();
    const result = await LatencyTester.testRemoteTcp('127.0.0.1', port, 1000);
    assert.equal(result.reachable, false);
    assert.equal(result.latencyMs, -1);
    assert.equal(typeof result.error, 'string');
    assert.ok((result.error as string).length > 0);
  });

  it('reports an invalid host as unreachable without throwing', async () => {
    const result = await LatencyTester.testRemoteTcp('invalid host name', 80, 1000);
    assert.equal(result.reachable, false);
    assert.equal(result.latencyMs, -1);
    assert.equal(typeof result.error, 'string');
    assert.ok((result.error as string).length > 0);
  });
});

describe('testProxyHttp', () => {
  it('succeeds through a local HTTP proxy and parses the egress ip from the body', async () => {
    let seenPath = '';
    const proxy = http.createServer((req, res) => {
      seenPath = String(req.url || '');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ip=203.0.113.42\nts=1700000000\n');
    });
    const port = await listen(proxy);
    try {
      const result = await LatencyTester.testProxyHttp(port, 2000);
      assert.equal(result.success, true);
      assert.ok(result.latencyMs >= 0, `latency must be >= 0, got ${result.latencyMs}`);
      assert.equal(result.egressIp, '203.0.113.42');
      assert.equal(result.error, undefined);
      // The tester must send an absolute-form proxy request.
      assert.match(seenPath, /^http:\/\/www\.google\.com:80\//);
    } finally {
      await close(proxy);
    }
  });

  it('fails when the proxy port is closed', async () => {
    const port = await closedPort();
    const result = await LatencyTester.testProxyHttp(port, 1000);
    assert.equal(result.success, false);
    assert.equal(result.latencyMs, -1);
    assert.equal(typeof result.error, 'string');
    assert.match(String(result.error), /verification failed/i);
  });
});

describe('getNormalPublicIp', () => {
  it('falls back to a string and never throws when fetch rejects', async () => {
    (globalThis as any).fetch = async () => {
      throw new Error('network unavailable');
    };
    let ip = '';
    await assert.doesNotReject(async () => {
      ip = await LatencyTester.getNormalPublicIp();
    });
    assert.equal(typeof ip, 'string');
    assert.ok(ip.length > 0);
    assert.equal(ip, 'Direct Network');
  });

  it('masks a reported IPv4 address', async () => {
    (globalThis as any).fetch = async () => ({
      ok: true,
      json: async () => ({ ip: '203.0.113.42' })
    });
    const ip = await LatencyTester.getNormalPublicIp();
    assert.equal(ip, '203.0.*.*');
    assert.ok(!ip.includes('113.42'), 'full address must not be exposed');
  });

  it('masks a reported IPv6 address', async () => {
    (globalThis as any).fetch = async () => ({
      ok: true,
      json: async () => ({ ip: '2001:db8:1234::1' })
    });
    const ip = await LatencyTester.getNormalPublicIp();
    assert.ok(ip.startsWith('2001:db8:'), `expected masked IPv6 prefix, got ${ip}`);
    assert.ok(ip.includes('*'), `expected masked groups, got ${ip}`);
    assert.ok(!ip.includes('1234'), 'later groups must not be exposed');
  });
});
