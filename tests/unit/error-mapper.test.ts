// Covers error-mapper: classifyHttp status mapping and retry/retryAfter
// handling (2xx ok, 429 rate_limit, 401/403 auth, 5xx server, other 4xx
// client), classifyNetwork rotatability per error code, and the shape of
// openAiError. Rotation flags that depend on the gateway settings table are
// only asserted as booleans so the test does not depend on stored settings.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { classifyHttp, classifyNetwork, openAiError } from '../../src/backend/gateway/error-mapper';

describe('classifyHttp: 2xx responses', () => {
  test('200/201/204/299 are ok and never rotate or retry', () => {
    for (const status of [200, 201, 204, 299]) {
      const c = classifyHttp(status);
      assert.equal(c.class, 'ok');
      assert.equal(c.rotate, false);
      assert.equal(c.retry, false);
      assert.equal(c.retryAfterMs, undefined);
    }
  });
});

describe('classifyHttp: 429 rate limit', () => {
  test('is class rate_limit and retryable', () => {
    const c = classifyHttp(429);
    assert.equal(c.class, 'rate_limit');
    assert.equal(c.retry, true);
    assert.equal(typeof c.rotate, 'boolean');
    assert.equal(c.retryAfterMs, undefined);
  });

  test('parses Retry-After seconds into milliseconds', () => {
    assert.equal(classifyHttp(429, '2').retryAfterMs, 2000);
    assert.equal(classifyHttp(429, '0').retryAfterMs, 0);
    assert.equal(classifyHttp(429, '1.5').retryAfterMs, 1000);
  });

  test('accepts an array header and uses its first value', () => {
    assert.equal(classifyHttp(429, ['5']).retryAfterMs, 5000);
    assert.equal(classifyHttp(429, ['7', '9']).retryAfterMs, 7000);
  });

  test('invalid or negative Retry-After yields undefined / zero, never NaN', () => {
    assert.equal(classifyHttp(429, 'soon').retryAfterMs, undefined);
    assert.equal(classifyHttp(429, '-3').retryAfterMs, 0);
    assert.equal(classifyHttp(429, '').retryAfterMs, undefined);
  });
});

describe('classifyHttp: auth and client errors', () => {
  test('401 and 403 are auth errors with neither rotate nor retry', () => {
    for (const status of [401, 403]) {
      const c = classifyHttp(status);
      assert.equal(c.class, 'auth');
      assert.equal(c.rotate, false);
      assert.equal(c.retry, false);
    }
  });

  test('other 4xx are client errors and are not retried', () => {
    for (const status of [400, 404, 418, 499]) {
      const c = classifyHttp(status);
      assert.equal(c.class, 'client');
      assert.equal(c.rotate, false);
      assert.equal(c.retry, false);
    }
  });
});

describe('classifyHttp: server errors', () => {
  test('500/503/599 are server errors and retryable', () => {
    for (const status of [500, 503, 599]) {
      const c = classifyHttp(status);
      assert.equal(c.class, 'server');
      assert.equal(c.retry, true);
      assert.equal(typeof c.rotate, 'boolean');
    }
  });
});

describe('classifyNetwork: rotatable codes', () => {
  test('UPSTREAM_TIMEOUT, ECONNRESET, ETIMEDOUT and undici socket codes rotate', () => {
    for (const code of ['UPSTREAM_TIMEOUT', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'ECONNREFUSED', 'EAI_AGAIN']) {
      const c = classifyNetwork(code);
      assert.equal(c.class, 'network');
      assert.equal(c.rotate, true);
      assert.equal(c.retry, true);
    }
  });
});

describe('classifyNetwork: non-rotatable codes', () => {
  test('UPSTREAM_NOT_CONFIGURED and unknown codes must not rotate', () => {
    for (const code of ['UPSTREAM_NOT_CONFIGURED', 'SOME_UNKNOWN_CODE', 'EACCES']) {
      const c = classifyNetwork(code);
      assert.equal(c.class, 'network');
      assert.equal(c.rotate, false);
      assert.equal(c.retry, false);
    }
  });

  test('undefined and empty codes are not rotatable', () => {
    assert.equal(classifyNetwork(undefined).rotate, false);
    assert.equal(classifyNetwork('').rotate, false);
    assert.equal(classifyNetwork(undefined).class, 'network');
  });

  test('code matching is case-sensitive', () => {
    assert.equal(classifyNetwork('econnreset').rotate, false);
  });
});

describe('openAiError', () => {
  test('produces the OpenAI-compatible envelope', () => {
    assert.deepEqual(openAiError('bad request', 'invalid_request_error', 'invalid_value'), {
      error: {
        message: 'bad request',
        type: 'invalid_request_error',
        param: null,
        code: 'invalid_value'
      }
    });
  });

  test('accepts an explicit param', () => {
    const out = openAiError('missing', 'invalid_request_error', 'missing_param', 'model');
    assert.equal(out.error.param, 'model');
    assert.equal(out.error.message, 'missing');
    assert.deepEqual(Object.keys(out), ['error']);
  });
});
