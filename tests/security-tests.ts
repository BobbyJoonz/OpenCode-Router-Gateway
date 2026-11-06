import assert from 'assert';
import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import {
  isLoopbackHost,
  resolveBindHost,
  getAllowedOrigins,
  isAllowedOrigin,
  isAllowedHost,
  maskAddress,
  sanitizeSubscriptionUrl,
  validateRemoteBindingConfig,
  constantTimeCompare,
  setActiveBindHost,
  SecurityConfigurationError,
  DEFAULT_BIND_HOST
} from '../src/backend/security/api-guard';
import { safeWriteSensitiveFile, ensureSecureDirectory } from '../src/backend/security/file-guard';
import { ConfigFetcher } from '../src/backend/discovery/config-fetcher';
import { app, startServer } from '../src/backend/server';

export async function runSecurityTests() {
  console.log('====================================================');
  console.log('🔒 Starting Security & Exposure Verification Tests');
  console.log('====================================================\n');

  // 1. Loopback and Bind Host Resolution
  console.log('▶ Security Test 1: Loopback Resolution and Default Host Binding');
  {
    assert.strictEqual(DEFAULT_BIND_HOST, '127.0.0.1', 'Default bind host must be 127.0.0.1');
    assert.strictEqual(isLoopbackHost('127.0.0.1'), true);
    assert.strictEqual(isLoopbackHost('localhost'), true);
    assert.strictEqual(isLoopbackHost('::1'), true);
    assert.strictEqual(isLoopbackHost('127.0.0.2'), true);
    assert.strictEqual(isLoopbackHost('0.0.0.0'), false);
    assert.strictEqual(isLoopbackHost('192.168.1.5'), false);

    // Default with no env
    const resDefault = resolveBindHost(undefined, false);
    assert.strictEqual(resDefault.host, '127.0.0.1', 'Default must be 127.0.0.1');
    assert.strictEqual(resDefault.isRemoteAllowed, false);

    // Requested 0.0.0.0 without opt-in falls back to 127.0.0.1
    const resUnpermitted = resolveBindHost('0.0.0.0', false);
    assert.strictEqual(resUnpermitted.host, '127.0.0.1', 'Non-loopback without opt-in must fallback to 127.0.0.1');
    assert.strictEqual(resUnpermitted.isRemoteAllowed, false);
    assert(resUnpermitted.warning?.includes('SECURITY WARNING'), 'Warning must be generated');

    // Requested 0.0.0.0 with explicit opt-in
    const resPermitted = resolveBindHost('0.0.0.0', true);
    assert.strictEqual(resPermitted.host, '0.0.0.0');
    assert.strictEqual(resPermitted.isRemoteAllowed, true);
    assert(resPermitted.warning?.includes('CRITICAL SECURITY WARNING'), 'Critical warning must be generated');

    console.log('  ✔ Non-loopback exposure is strictly disabled by default with fallback to 127.0.0.1.\n');
  }

  // 2. Allowed Origins & CORS Allowlist
  console.log('▶ Security Test 2: Origin Allowlist Evaluation');
  {
    const origins = getAllowedOrigins(3000, '127.0.0.1');
    assert(origins.has('http://localhost:3000'));
    assert(origins.has('http://127.0.0.1:3000'));
    assert(origins.has('http://localhost:5173'));
    assert(origins.has('http://127.0.0.1:5173'));

    assert.strictEqual(isAllowedOrigin('http://localhost:3000', origins), true);
    assert.strictEqual(isAllowedOrigin('http://localhost:5173', origins), true);
    assert.strictEqual(isAllowedOrigin('http://evil.com', origins), false);
    assert.strictEqual(isAllowedOrigin('http://attacker.local:3000', origins), false);
    assert.strictEqual(isAllowedOrigin('null', origins), false);

    console.log('  ✔ Origin allowlist correctly accepts local dev origins and rejects external origins.\n');
  }

  // 3. DNS Rebinding / Host Header Validation
  console.log('▶ Security Test 3: Host Header Validation');
  {
    assert.strictEqual(isAllowedHost('localhost:3000', 3000, '127.0.0.1'), true);
    assert.strictEqual(isAllowedHost('127.0.0.1:3000', 3000, '127.0.0.1'), true);
    assert.strictEqual(isAllowedHost('[::1]:3000', 3000, '127.0.0.1'), true);
    assert.strictEqual(isAllowedHost('evil-rebind.com:3000', 3000, '127.0.0.1'), false);
    assert.strictEqual(isAllowedHost('192.168.1.100:3000', 3000, '127.0.0.1'), false);

    console.log('  ✔ Host header validation blocks DNS rebinding domains.\n');
  }

  // 4. Data Sanitization & Credential Masking
  console.log('▶ Security Test 4: Credential and Address Sanitization');
  {
    // IPv4 masking
    assert.strictEqual(maskAddress('198.51.100.42'), '198.51.*.*');
    assert.strictEqual(maskAddress('1.2.3.4'), '1.2.*.*');

    // IPv6 masking
    assert.strictEqual(maskAddress('2001:0db8:85a3:0000:0000:8a2e:0370:7334'), '2001:0db8:*:*:*:*:*:*');

    // Subscription URL sensitive token redaction
    const sensitiveUrl1 = 'https://provider.example.com/api/v1/sub?token=secret998877&flag=1';
    const sanitized1 = sanitizeSubscriptionUrl(sensitiveUrl1);
    assert(!sanitized1.includes('secret998877'), 'Token value must not appear in sanitized URL');
    assert(sanitized1.includes('token=***'), 'Token must be replaced with ***');
    assert(sanitized1.includes('flag=1'), 'Non-sensitive parameters must be preserved');

    const sensitiveUrl2 = 'https://user:password123@sub.domain.com/feed';
    const sanitized2 = sanitizeSubscriptionUrl(sensitiveUrl2);
    assert(!sanitized2.includes('password123'), 'URL password must be redacted');
    assert(sanitized2.includes('***'), 'Password must be replaced with ***');

    const publicUrl = 'https://raw.githubusercontent.com/ermaozi/get_subscribe/main/subscribe/v2ray.txt';
    assert.strictEqual(sanitizeSubscriptionUrl(publicUrl), publicUrl, 'Clean public URLs remain unchanged');

    console.log('  ✔ Sensitive subscription tokens and IPv4/IPv6 addresses are properly masked.\n');
  }

  // 5. Live Server Network Tests (Actual Socket, CORS Headers, & CSRF Rejection)
  console.log('▶ Security Test 5: Live Server Listening Address, CORS Headers, and CSRF Guard');
  {
    const TEST_PORT = 31987;
    const server = startServer(TEST_PORT, '127.0.0.1');

    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.once('listening', () => resolve());
    });

    const addr = server.address() as any;
    assert(addr !== null, 'Server address must be available');
    assert.strictEqual(addr.address, '127.0.0.1', 'Server must strictly listen on 127.0.0.1');
    assert.strictEqual(addr.port, TEST_PORT);
    console.log(`  ✔ Confirmed listening socket: ${addr.address}:${addr.port} (IPv4 Loopback only).`);

    // Helper for HTTP requests
    const makeRequest = (options: http.RequestOptions, bodyData?: string): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> => {
      return new Promise((resolve, reject) => {
        const req = http.request({ port: TEST_PORT, host: '127.0.0.1', ...options }, (res) => {
          let body = '';
          res.on('data', (d) => (body += d.toString()));
          res.on('end', () => resolve({ statusCode: res.statusCode || 0, headers: res.headers, body }));
        });
        req.on('error', reject);
        if (bodyData) req.write(bodyData);
        req.end();
      });
    };

    // Subtest 5A: Allowed Origin receives Access-Control-Allow-Origin
    const allowedRes = await makeRequest({
      path: '/api/status',
      method: 'GET',
      headers: {
        'Origin': 'http://localhost:5173',
        'Host': `127.0.0.1:${TEST_PORT}`
      }
    });
    assert.strictEqual(allowedRes.statusCode, 200);
    assert.strictEqual(allowedRes.headers['access-control-allow-origin'], 'http://localhost:5173', 'Allowed origin must receive matching CORS header');
    console.log('  ✔ Allowed origin (http://localhost:5173) received Access-Control-Allow-Origin header.');

    // Subtest 5B: Disallowed Origin does NOT receive Access-Control-Allow-Origin
    const disallowedRes = await makeRequest({
      path: '/api/status',
      method: 'GET',
      headers: {
        'Origin': 'http://evil.com',
        'Host': `127.0.0.1:${TEST_PORT}`
      }
    });
    assert.strictEqual(disallowedRes.headers['access-control-allow-origin'], undefined, 'Disallowed origin must NOT receive Access-Control-Allow-Origin');
    console.log('  ✔ Disallowed origin (http://evil.com) denied CORS header.');

    // Subtest 5C: State-changing request from untrusted origin is blocked with 403 Forbidden
    const csrfPostRes = await makeRequest({
      path: '/api/workflow/start',
      method: 'POST',
      headers: {
        'Origin': 'http://evil.com',
        'Host': `127.0.0.1:${TEST_PORT}`,
        'Content-Type': 'application/json'
      }
    }, JSON.stringify({}));
    assert.strictEqual(csrfPostRes.statusCode, 403, 'Cross-origin state-changing request must be blocked with 403 Forbidden');
    const csrfJson = JSON.parse(csrfPostRes.body);
    assert.strictEqual(csrfJson.code, 'UNTRUSTED_ORIGIN');
    console.log('  ✔ State-changing POST from untrusted origin blocked with 403 (UNTRUSTED_ORIGIN).');

    // Subtest 5D: Request with forged/external Host header is blocked with 403 Forbidden
    const rebindRes = await makeRequest({
      path: '/api/status',
      method: 'GET',
      headers: {
        'Host': 'attacker-controlled-dns-rebind.com'
      }
    });
    assert.strictEqual(rebindRes.statusCode, 403, 'DNS rebinding Host header must be blocked with 403 Forbidden');
    const rebindJson = JSON.parse(rebindRes.body);
    assert.strictEqual(rebindJson.code, 'INVALID_HOST');
    console.log('  ✔ DNS rebinding attempt blocked with 403 (INVALID_HOST).');

    // Subtest 5E: Legitimate local CLI request (no origin, loopback host) succeeds
    const cliRes = await makeRequest({
      path: '/api/status',
      method: 'GET',
      headers: {
        'Host': `127.0.0.1:${TEST_PORT}`
      }
    });
    assert.strictEqual(cliRes.statusCode, 200, 'Legitimate local CLI request must succeed');
    console.log('  ✔ Legitimate local CLI request succeeded with 200 OK.');

    // Close test server
    await new Promise<void>((resolve) => server.close(() => resolve()));
    console.log('  ✔ Test HTTP server closed cleanly.\n');
  }

  // 6. Remote Binding & API Key Validation (Mandatory API Key)
  console.log('▶ Security Test 6: Remote Binding Enforcement and API Key Validation');
  {
    // Non-loopback binding without API key throws SecurityConfigurationError
    assert.throws(
      () => validateRemoteBindingConfig('0.0.0.0', undefined),
      SecurityConfigurationError,
      'Binding to 0.0.0.0 without API key must throw SecurityConfigurationError'
    );
    assert.throws(
      () => validateRemoteBindingConfig('0.0.0.0', ''),
      SecurityConfigurationError,
      'Binding to 0.0.0.0 with empty API key must throw SecurityConfigurationError'
    );
    assert.throws(
      () => validateRemoteBindingConfig('0.0.0.0', '   '),
      SecurityConfigurationError,
      'Binding to 0.0.0.0 with whitespace API key must throw SecurityConfigurationError'
    );
    assert.throws(
      () => validateRemoteBindingConfig('192.168.1.50', undefined),
      SecurityConfigurationError,
      'Binding to LAN IP without API key must throw SecurityConfigurationError'
    );

    // Non-loopback binding WITH API key succeeds
    assert.doesNotThrow(
      () => validateRemoteBindingConfig('0.0.0.0', 'secret-key-12345'),
      'Binding to 0.0.0.0 with valid API key must succeed'
    );

    // Loopback binding does not require API key (frictionless local usage)
    assert.doesNotThrow(
      () => validateRemoteBindingConfig('127.0.0.1', undefined),
      'Loopback binding must not require API key'
    );
    assert.doesNotThrow(
      () => validateRemoteBindingConfig('localhost', undefined),
      'Localhost binding must not require API key'
    );

    // Constant-time comparison verification
    assert.strictEqual(constantTimeCompare('secret-token', 'secret-token'), true);
    assert.strictEqual(constantTimeCompare('secret-token', 'wrong-token'), false);
    assert.strictEqual(constantTimeCompare('secret-token', 'secret-token-longer'), false);
    assert.strictEqual(constantTimeCompare('', 'secret-token'), false);

    console.log('  ✔ Non-loopback binding strictly requires non-empty OPENCODE_ROUTER_API_KEY.');
    console.log('  ✔ Constant-time comparison prevents timing side-channel attacks.\n');
  }

  // 7. Live Server Remote Access Authentication (Bearer Token Enforcement)
  console.log('▶ Security Test 7: Live Server Remote Authentication (Bearer Tokens & Endpoint Protection)');
  {
    const TEST_REMOTE_PORT = 31988;
    const TEST_KEY = 'test-token-remote-98765';

    process.env.ALLOW_REMOTE_ACCESS = 'true';
    process.env.OPENCODE_ROUTER_API_KEY = TEST_KEY;

    const server = startServer(TEST_REMOTE_PORT, '0.0.0.0');
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.once('listening', () => resolve());
    });

    const makeRemoteRequest = (options: http.RequestOptions, bodyData?: string): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> => {
      return new Promise((resolve, reject) => {
        const req = http.request({ port: TEST_REMOTE_PORT, host: '127.0.0.1', ...options }, (res) => {
          let body = '';
          res.on('data', (d) => (body += d.toString()));
          res.on('end', () => resolve({ statusCode: res.statusCode || 0, headers: res.headers, body }));
        });
        req.on('error', reject);
        if (bodyData) req.write(bodyData);
        req.end();
      });
    };

    // Subtest 7A: Unauthenticated GET request to /api/status returns 401 Unauthorized
    const unauthRes = await makeRemoteRequest({
      path: '/api/status',
      method: 'GET'
    });
    assert.strictEqual(unauthRes.statusCode, 401, 'Unauthenticated request to /api/status must return 401');
    assert.strictEqual(unauthRes.headers['www-authenticate'], 'Bearer realm="OpenCode Router"');
    const unauthJson = JSON.parse(unauthRes.body);
    assert.strictEqual(unauthJson.code, 'UNAUTHORIZED');
    console.log('  ✔ Unauthenticated GET /api/status rejected with 401 and WWW-Authenticate.');

    // Subtest 7B: Unauthenticated POST request to /api/workflow/start returns 401 Unauthorized
    const unauthPostRes = await makeRemoteRequest({
      path: '/api/workflow/start',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, JSON.stringify({}));
    assert.strictEqual(unauthPostRes.statusCode, 401, 'Unauthenticated state-changing POST must return 401');
    console.log('  ✔ Unauthenticated POST /api/workflow/start rejected with 401.');

    // Subtest 7C: API key provided via URL query parameter is rejected (query parameters prohibited)
    const queryKeyRes = await makeRemoteRequest({
      path: `/api/status?api_key=${TEST_KEY}`,
      method: 'GET'
    });
    assert.strictEqual(queryKeyRes.statusCode, 401, 'API key via query parameter must NOT authenticate');
    console.log('  ✔ API key passed via query parameter (?api_key=...) rejected with 401.');

    // Subtest 7D: Invalid Bearer token is rejected with 401
    const invalidTokenRes = await makeRemoteRequest({
      path: '/api/status',
      method: 'GET',
      headers: { 'Authorization': 'Bearer completely-invalid-token' }
    });
    assert.strictEqual(invalidTokenRes.statusCode, 401, 'Invalid Bearer token must return 401');
    const invalidJson = JSON.parse(invalidTokenRes.body);
    assert.strictEqual(invalidJson.code, 'INVALID_API_KEY');
    // Ensure key is never reflected in error body
    assert(!invalidTokenRes.body.includes(TEST_KEY), 'Configured secret must never appear in response');
    assert(!invalidTokenRes.body.includes('completely-invalid-token'), 'Invalid token must not be echoed in response');
    console.log('  ✔ Invalid Bearer token rejected with 401 (token values never reflected).');

    // Subtest 7E: Valid Bearer token succeeds with 200 OK
    const validRes = await makeRemoteRequest({
      path: '/api/status',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${TEST_KEY}` }
    });
    assert.strictEqual(validRes.statusCode, 200, 'Valid Bearer token must return 200 OK');
    const validJson = JSON.parse(validRes.body);
    assert(validJson.normalIp !== undefined, 'Response must contain status data');
    console.log('  ✔ Valid Bearer token successfully authenticated (200 OK).');

    // Subtest 7F: OPTIONS preflight requests bypass auth for CORS compatibility
    const optionsRes = await makeRemoteRequest({
      path: '/api/status',
      method: 'OPTIONS',
      headers: {
        'Origin': 'http://localhost:5173',
        'Access-Control-Request-Method': 'GET'
      }
    });
    assert(optionsRes.statusCode === 200 || optionsRes.statusCode === 204, 'CORS OPTIONS preflight must not be blocked by auth');
    console.log('  ✔ CORS preflight OPTIONS request bypassed auth correctly.');

    // Clean up test server and restore env
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.ALLOW_REMOTE_ACCESS;
    delete process.env.OPENCODE_ROUTER_API_KEY;
    setActiveBindHost('127.0.0.1');
    console.log('  ✔ Remote test server closed cleanly and environment restored.\n');
  }

  // 8. Sensitive File Permissions & Symlink Overwrite Guard
  console.log('▶ Security Test 8: Sensitive File Permissions (0600), Directory Mode (0700), and Symlink Overwrite Guard');
  {
    const tempDir = path.join(os.tmpdir(), `opencode-sec-test-${Date.now()}`);
    ensureSecureDirectory(tempDir);

    // NTFS has no POSIX permission bits (chmod only toggles the read-only flag),
    // so mode assertions are meaningful on POSIX filesystems only.
    const isPosix = process.platform !== 'win32';

    const dirStat = fs.statSync(tempDir);
    if (isPosix) {
      assert.strictEqual(dirStat.mode & 0o777, 0o700, 'Parent directory must have restricted permissions (0700)');
    } else {
      console.log('  ℹ Skipping POSIX 0700 directory mode assertion (NTFS).');
    }

    // Subtest 8A: Newly created sensitive file has mode 0600
    const sensitiveFile = path.join(tempDir, 'active-xray-config.json');
    safeWriteSensitiveFile(sensitiveFile, JSON.stringify({ secret: 'password123' }));
    const fileStat = fs.statSync(sensitiveFile);
    if (isPosix) {
      assert.strictEqual(fileStat.mode & 0o777, 0o600, 'Newly created sensitive file must have mode 0600');
    }
    assert.strictEqual(fs.readFileSync(sensitiveFile, 'utf-8'), JSON.stringify({ secret: 'password123' }));
    console.log('  ✔ Newly created sensitive file enforced mode 0600.');

    // Subtest 8B: Overwriting pre-existing file with permissive mode (0664) is corrected to 0600
    fs.chmodSync(sensitiveFile, 0o664);
    if (isPosix) {
      assert.strictEqual(fs.statSync(sensitiveFile).mode & 0o777, 0o664, 'Setup: file made permissive 0664');
    }
    safeWriteSensitiveFile(sensitiveFile, JSON.stringify({ secret: 'updatedPassword' }));
    const updatedStat = fs.statSync(sensitiveFile);
    if (isPosix) {
      assert.strictEqual(updatedStat.mode & 0o777, 0o600, 'Overwritten file must have permissions corrected to 0600');
    }
    console.log('  ✔ Overwrite of pre-existing permissive file explicitly corrected to 0600.');

    // Subtest 8C: Symlink overwrite attack blocked
    const targetFile = path.join(tempDir, 'critical-target.txt');
    fs.writeFileSync(targetFile, 'PROTECTED_SYSTEM_DATA', { mode: 0o600 });
    const symlinkPath = path.join(tempDir, 'symlink-attack-file.json');
    let symlinkCreated = true;
    try {
      fs.symlinkSync(targetFile, symlinkPath);
    } catch (e: any) {
      // Windows requires SeCreateSymbolicLinkPrivilege (admin / Developer Mode).
      symlinkCreated = false;
      console.log(`  ℹ Skipping symlink subtest: cannot create symlink here (${e.code}).`);
    }

    if (symlinkCreated) {
      assert.throws(
        () => safeWriteSensitiveFile(symlinkPath, 'MALICIOUS_OVERWRITE'),
        /Refusing to write through symbolic link/,
        'Attempt to write through symlink must throw security error'
      );
      assert.strictEqual(fs.readFileSync(targetFile, 'utf-8'), 'PROTECTED_SYSTEM_DATA', 'Target file must not be modified through symlink');
      console.log('  ✔ Symlink overwrite attack strictly blocked; target preserved.');
    }

    // Cleanup
    try {
      fs.unlinkSync(symlinkPath);
      fs.unlinkSync(sensitiveFile);
      fs.unlinkSync(targetFile);
      fs.rmdirSync(tempDir);
    } catch {}
    console.log('  ✔ Temporary test files and directory cleaned up.\n');
  }

  // 9. Case-Insensitive URL Redaction, Userinfo Credentials, and Fetcher Error Masking
  console.log('▶ Security Test 9: Case-Insensitive URL Redaction, Userinfo Credentials, and Error Sanitization');
  {
    // Case-insensitive query parameters
    assert.strictEqual(
      sanitizeSubscriptionUrl('https://example.com/sub?token=secret123&other=val'),
      'https://example.com/sub?token=***&other=val'
    );
    assert.strictEqual(
      sanitizeSubscriptionUrl('https://example.com/sub?Token=secret123&other=val'),
      'https://example.com/sub?Token=***&other=val'
    );
    assert.strictEqual(
      sanitizeSubscriptionUrl('https://example.com/sub?TOKEN=secret123&other=val'),
      'https://example.com/sub?TOKEN=***&other=val'
    );
    assert.strictEqual(
      sanitizeSubscriptionUrl('https://example.com/sub?Key=myKey&auth=userPass'),
      'https://example.com/sub?Key=***&auth=***'
    );
    assert.strictEqual(
      sanitizeSubscriptionUrl('https://example.com/sub?api_key=privKey&access_token=jwtToken'),
      'https://example.com/sub?api_key=***&access_token=***'
    );

    // URL userinfo credentials (username & password)
    const userinfoUrl = 'https://alice:supersecret@my-sub.net/profile';
    const userinfoSanitized = sanitizeSubscriptionUrl(userinfoUrl);
    assert(!userinfoSanitized.includes('supersecret'), 'Password must not appear');
    assert(!userinfoSanitized.includes('alice'), 'Username must not appear');
    assert(userinfoSanitized.includes('***:***@'), 'Userinfo must be replaced with ***:***@');

    // URLs embedded in freeform error messages
    const errorMsg = 'Failed to fetch from https://user:pass123@api.sub.com/sub?token=secret99: Connection refused';
    const sanitizedError = sanitizeSubscriptionUrl(errorMsg);
    assert(!sanitizedError.includes('pass123'), 'Error message must not leak password');
    assert(!sanitizedError.includes('secret99'), 'Error message must not leak query token');
    assert(!sanitizedError.includes('user:'), 'Error message must not leak user info');

    // ConfigFetcher error sanitization integration
    const fetchSummary = await ConfigFetcher.fetchFromSource({
      id: 99999,
      name: 'TestBadSource',
      url: 'https://leakuser:leakpass@nonexistent-fake-domain-999.xyz/feed?token=leakedTokenValue',
      enabled: 1,
      last_fetched_at: null,
      fetch_status: null,
      config_count: 0
    });
    assert(fetchSummary.error !== undefined, 'Summary must record fetch error');
    assert(!fetchSummary.error.includes('leakpass'), 'Fetcher summary must not contain password');
    assert(!fetchSummary.error.includes('leakedTokenValue'), 'Fetcher summary must not contain token');
    assert(!fetchSummary.error.includes('leakuser'), 'Fetcher summary must not contain username');

    console.log('  ✔ Case-insensitive token variations properly redacted (?token, ?Token, ?TOKEN, ?Key, etc.).');
    console.log('  ✔ URL userinfo credentials (username:password) sanitized.');
    console.log('  ✔ ConfigFetcher error message boundaries sanitized against URL leakage.\n');
  }

  console.log('====================================================');
  console.log('🛡️ ALL SECURITY TESTS PASSED SUCCESSFULLY!');
  console.log('====================================================\n');
}

if (require.main === module) {
  runSecurityTests().catch((err) => {
    console.error('❌ Security tests failed:', err);
    process.exit(1);
  });
}
