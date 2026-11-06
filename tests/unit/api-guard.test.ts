/**
 * Coverage: src/backend/security/api-guard.ts
 *
 * - isLoopbackHost: loopback literals (127.0.0.1 / 127.x.x.x / ::1 / [::1] /
 *   localhost, case- and whitespace-insensitive) vs. wildcard and public hosts.
 * - resolveBindHost: default loopback, explicit loopback, non-loopback refused
 *   without opt-in (falls back to 127.0.0.1), and allowed via the boolean
 *   argument or the ALLOW_REMOTE_ACCESS / OPENCODE_ROUTER_ALLOW_REMOTE env flags.
 * - validateRemoteBindingConfig: non-loopback binding throws SecurityConfigurationError
 *   without an API key (empty/whitespace keys included) and passes with one.
 * - maskAddress: IPv4 -> x.x.*.*, IPv6 -> first two groups + ***, empty -> ''.
 * - sanitizeSubscriptionUrl: redacts token/key/secret/password/auth/pass/
 *   api_key/access_token query values case-insensitively and strips userinfo
 *   credentials (with and without a password), inside plain URLs and free text.
 *
 * process.env is snapshotted/restored around every test so the suite cannot
 * leak configuration into other files.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  DEFAULT_BIND_HOST,
  SecurityConfigurationError,
  getActiveBindHost,
  isLoopbackHost,
  maskAddress,
  resolveBindHost,
  sanitizeSubscriptionUrl,
  validateRemoteBindingConfig
} from '../../src/backend/security/api-guard';

const ENV_KEYS = [
  'HOST',
  'OPENCODE_ROUTER_HOST',
  'ALLOW_REMOTE_ACCESS',
  'OPENCODE_ROUTER_ALLOW_REMOTE',
  'OPENCODE_ROUTER_API_KEY',
  'NODE_ENV',
  'ALLOWED_ORIGINS',
  'OPENCODE_ROUTER_ALLOWED_ORIGINS',
  'ENFORCE_LOCAL_AUTH',
  'OPENCODE_ROUTER_REQUIRE_LOCAL_AUTH'
] as const;

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe('isLoopbackHost', () => {
  it('accepts IPv4 loopback addresses', () => {
    for (const host of ['127.0.0.1', '127.0.0.2', '127.255.255.254', ' 127.0.0.1 ']) {
      assert.equal(isLoopbackHost(host), true, `${host} should be loopback`);
    }
  });

  it('accepts localhost and IPv6 loopback forms case-insensitively', () => {
    for (const host of ['localhost', 'LOCALHOST', 'LocalHost', '::1', '[::1]', '[::1] ']) {
      assert.equal(isLoopbackHost(host), true, `${host} should be loopback`);
    }
  });

  it('rejects wildcard, public and lookalike hosts', () => {
    for (const host of ['0.0.0.0', '1.2.3.4', '192.168.1.10', 'example.com', 'localhost.evil.com', '::', '']) {
      assert.equal(isLoopbackHost(host), false, `${host} should not be loopback`);
    }
  });
});

describe('resolveBindHost', () => {
  it('defaults to loopback when nothing is requested', () => {
    const result = resolveBindHost();
    assert.equal(result.host, DEFAULT_BIND_HOST);
    assert.equal(result.isRemoteAllowed, false);
    assert.equal(result.warning, undefined);
    assert.equal(getActiveBindHost(), DEFAULT_BIND_HOST);
  });

  it('keeps an explicitly requested loopback host as-is', () => {
    const result = resolveBindHost('127.0.0.1');
    assert.equal(result.host, '127.0.0.1');
    assert.equal(result.isRemoteAllowed, false);
    assert.equal(result.warning, undefined);
  });

  it('refuses a non-loopback host without opt-in and falls back to loopback', () => {
    const result = resolveBindHost('0.0.0.0');
    assert.equal(result.host, DEFAULT_BIND_HOST);
    assert.equal(result.isRemoteAllowed, false);
    assert.match(String(result.warning), /SECURITY WARNING/);
    assert.match(String(result.warning), /0\.0\.0\.0/);
  });

  it('honours the allowRemote argument', () => {
    const result = resolveBindHost('0.0.0.0', true);
    assert.equal(result.host, '0.0.0.0');
    assert.equal(result.isRemoteAllowed, true);
    assert.match(String(result.warning), /CRITICAL SECURITY WARNING/);
    assert.match(String(result.warning), /OPENCODE_ROUTER_API_KEY/);
  });

  it('honours the ALLOW_REMOTE_ACCESS env flag', () => {
    process.env.ALLOW_REMOTE_ACCESS = 'true';
    const result = resolveBindHost('0.0.0.0');
    assert.equal(result.host, '0.0.0.0');
    assert.equal(result.isRemoteAllowed, true);
  });

  it('honours the OPENCODE_ROUTER_ALLOW_REMOTE env flag', () => {
    process.env.OPENCODE_ROUTER_ALLOW_REMOTE = 'true';
    const result = resolveBindHost('1.2.3.4');
    assert.equal(result.host, '1.2.3.4');
    assert.equal(result.isRemoteAllowed, true);
  });

  it('reads a requested host from HOST but still refuses it without opt-in', () => {
    process.env.HOST = '0.0.0.0';
    const refused = resolveBindHost();
    assert.equal(refused.host, DEFAULT_BIND_HOST);
    assert.equal(refused.isRemoteAllowed, false);

    process.env.ALLOW_REMOTE_ACCESS = 'true';
    const allowed = resolveBindHost();
    assert.equal(allowed.host, '0.0.0.0');
    assert.equal(allowed.isRemoteAllowed, true);
  });

  it('reads a loopback host from OPENCODE_ROUTER_HOST', () => {
    process.env.OPENCODE_ROUTER_HOST = '127.0.0.1';
    const result = resolveBindHost();
    assert.equal(result.host, '127.0.0.1');
    assert.equal(result.isRemoteAllowed, false);
  });
});

describe('validateRemoteBindingConfig', () => {
  it('never throws for loopback bindings', () => {
    assert.doesNotThrow(() => validateRemoteBindingConfig('127.0.0.1'));
    assert.doesNotThrow(() => validateRemoteBindingConfig('localhost'));
    assert.doesNotThrow(() => validateRemoteBindingConfig('::1'));
  });

  it('throws SecurityConfigurationError for non-loopback without an API key', () => {
    assert.throws(
      () => validateRemoteBindingConfig('0.0.0.0'),
      (err: unknown) => {
        assert.ok(err instanceof SecurityConfigurationError, 'expected SecurityConfigurationError');
        assert.match((err as Error).message, /OPENCODE_ROUTER_API_KEY/);
        return true;
      }
    );
  });

  it('treats an empty or whitespace key as missing', () => {
    assert.throws(() => validateRemoteBindingConfig('0.0.0.0', ''), SecurityConfigurationError);
    assert.throws(() => validateRemoteBindingConfig('0.0.0.0', '   '), SecurityConfigurationError);
    process.env.OPENCODE_ROUTER_API_KEY = '   ';
    assert.throws(() => validateRemoteBindingConfig('0.0.0.0'), SecurityConfigurationError);
  });

  it('passes a non-loopback binding when an API key is supplied', () => {
    assert.doesNotThrow(() => validateRemoteBindingConfig('0.0.0.0', 'a-strong-secret'));
    process.env.OPENCODE_ROUTER_API_KEY = 'env-secret';
    assert.doesNotThrow(() => validateRemoteBindingConfig('1.2.3.4'));
  });
});

describe('maskAddress', () => {
  it('masks the last two octets of an IPv4 address', () => {
    assert.equal(maskAddress('203.0.113.42'), '203.0.*.*');
    assert.equal(maskAddress('8.8.4.4'), '8.8.*.*');
  });

  it('masks everything after the first two IPv6 groups', () => {
    assert.equal(maskAddress('2001:db8::1'), '2001:db8:*:*:*:*:*:*');
    assert.equal(maskAddress('2606:4700:4700::1111'), '2606:4700:*:*:*:*:*:*');
  });

  it('returns empty for missing input and passes non-IP strings through', () => {
    assert.equal(maskAddress(''), '');
    assert.equal(maskAddress(undefined), '');
    assert.equal(maskAddress('   '), '');
    assert.equal(maskAddress('Direct Network'), 'Direct Network');
  });
});

describe('sanitizeSubscriptionUrl', () => {
  function assertRedacted(output: string, secrets: string[]): void {
    for (const secret of secrets) {
      assert.ok(!output.includes(secret), `secret "${secret}" leaked in: ${output}`);
    }
  }

  it('redacts every sensitive query parameter value', () => {
    const input =
      'https://example.com/sub?token=abc123&key=xyz&password=pw&auth=a1&api_key=k1&access_token=at1';
    const output = sanitizeSubscriptionUrl(input);
    assertRedacted(output, ['abc123', 'xyz', 'pw', 'a1', 'k1', 'at1']);
    for (const param of ['token', 'key', 'password', 'auth', 'api_key', 'access_token']) {
      assert.ok(output.includes(`${param}=***`), `expected ${param}=*** in ${output}`);
    }
  });

  it('redacts sensitive names case-insensitively', () => {
    const output = sanitizeSubscriptionUrl('https://example.com/sub?TOKEN=abc&Api_Key=xyz&Access_Token=zzz');
    assertRedacted(output, ['abc', 'xyz', 'zzz']);
    assert.ok(output.includes('TOKEN=***'));
    assert.ok(output.includes('Api_Key=***'));
    assert.ok(output.includes('Access_Token=***'));
  });

  it('strips userinfo credentials with a password', () => {
    const output = sanitizeSubscriptionUrl('vless://uuid-123:secret@example.com:443?security=reality&pbk=xyz');
    assert.equal(output, 'vless://***:***@example.com:443?security=reality&pbk=xyz');
    assertRedacted(output, ['uuid-123', 'secret']);
  });

  it('strips a passwordless userinfo username', () => {
    const output = sanitizeSubscriptionUrl('https://proxy-user@example.com/sub?id=1');
    assert.ok(output.includes('://***@'), `expected masked userinfo in ${output}`);
    assertRedacted(output, ['proxy-user']);
  });

  it('redacts URLs embedded in free-form error text', () => {
    const output = sanitizeSubscriptionUrl(
      'Proxy request failed: https://provider.example/sub?token=SUPERSECRET&x=1 (timeout)'
    );
    assert.ok(output.includes('token=***'));
    assertRedacted(output, ['SUPERSECRET']);
  });

  it('leaves non-sensitive URLs untouched and handles empty input', () => {
    const clean = 'https://example.com/sub?foo=bar&mode=auto';
    assert.equal(sanitizeSubscriptionUrl(clean), clean);
    assert.equal(sanitizeSubscriptionUrl(''), '');
  });
});
