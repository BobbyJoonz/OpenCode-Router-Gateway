// Covers ErrorClassifier.classify: SUCCESS detection on exit 0, provider
// account rate limits vs IP-tied free-tier limits, auth errors, network
// failures (ECONNRESET/ETIMEDOUT/ENOTFOUND/timeout exit 124) and the generic
// non-zero exit fallback, plus CONFIG_ERROR and UNKNOWN outcomes.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { ErrorClassifier } from '../../src/backend/opencode/error-classifier';

describe('ErrorClassifier: success', () => {
  test('exit 0 with connection_ok is SUCCESS and not recoverable', () => {
    const r = ErrorClassifier.classify(0, 'connection_ok', '');
    assert.equal(r.category, 'SUCCESS');
    assert.equal(r.isRecoverableBySwitchingVpn, false);
    assert.match(r.userMessage, /established successfully/i);
  });

  test('exit 0 with a text event is SUCCESS', () => {
    const r = ErrorClassifier.classify(0, '{"type":"text","text":"hi"}', '');
    assert.equal(r.category, 'SUCCESS');
  });

  test('step_finish in stderr still counts as SUCCESS', () => {
    const r = ErrorClassifier.classify(0, '', 'step_finish');
    assert.equal(r.category, 'SUCCESS');
  });

  test('session.created without error is SUCCESS', () => {
    const r = ErrorClassifier.classify(0, 'session.created', '');
    assert.equal(r.category, 'SUCCESS');
  });

  test('success markers are checked before rate-limit text', () => {
    const r = ErrorClassifier.classify(0, '{"type":"text"} rate limit mentioned', '');
    assert.equal(r.category, 'SUCCESS');
  });

  test('session.created together with error is not SUCCESS', () => {
    const r = ErrorClassifier.classify(0, 'session.created error', '');
    assert.equal(r.category, 'UNKNOWN');
    assert.equal(r.isRecoverableBySwitchingVpn, false);
  });

  test('exit 0 with no known markers is UNKNOWN', () => {
    const r = ErrorClassifier.classify(0, 'nothing useful here', '');
    assert.equal(r.category, 'UNKNOWN');
    assert.equal(r.isRecoverableBySwitchingVpn, false);
    assert.equal(r.rawDetails, undefined);
  });
});

describe('ErrorClassifier: rate limits', () => {
  test('HTTP 429 insufficient_quota is an account limit and not recoverable', () => {
    const r = ErrorClassifier.classify(1, '', 'HTTP 429 {"error":{"code":"insufficient_quota"}}');
    assert.equal(r.category, 'RATE_LIMIT');
    assert.equal(r.isRecoverableBySwitchingVpn, false);
    assert.match(r.userMessage, /account rate limit/i);
  });

  test('429 Too Many Requests is RATE_LIMIT and not recoverable', () => {
    const r = ErrorClassifier.classify(1, '', 'Error: Too Many Requests (429)');
    assert.equal(r.category, 'RATE_LIMIT');
    assert.equal(r.isRecoverableBySwitchingVpn, false);
  });

  test('free usage limit is IP-tied and recoverable', () => {
    const r = ErrorClassifier.classify(1, '', 'free usage limit reached for this account');
    assert.equal(r.category, 'RATE_LIMIT');
    assert.equal(r.isRecoverableBySwitchingVpn, true);
    assert.match(r.userMessage, /Rotating VPN endpoint/i);
  });

  test('quota exceeded / resource exhausted text is RATE_LIMIT', () => {
    assert.equal(ErrorClassifier.classify(1, 'quota exceeded', '').category, 'RATE_LIMIT');
    assert.equal(ErrorClassifier.classify(1, 'resource has been exhausted', '').category, 'RATE_LIMIT');
  });
});

describe('ErrorClassifier: authentication', () => {
  test('HTTP 401 Unauthorized is AUTH_ERROR and not recoverable', () => {
    const r = ErrorClassifier.classify(1, '', 'provider returned HTTP 401 Unauthorized');
    assert.equal(r.category, 'AUTH_ERROR');
    assert.equal(r.isRecoverableBySwitchingVpn, false);
    assert.match(r.userMessage, /not a VPN connectivity issue/i);
  });

  test('HTTP 403 Forbidden is AUTH_ERROR', () => {
    assert.equal(ErrorClassifier.classify(1, '', 'HTTP 403 Forbidden').category, 'AUTH_ERROR');
  });

  test('invalid api key is AUTH_ERROR', () => {
    assert.equal(ErrorClassifier.classify(1, 'invalid api key provided', '').category, 'AUTH_ERROR');
  });

  test('0 credentials + auth error is AUTH_ERROR', () => {
    const r = ErrorClassifier.classify(1, 'found 0 credentials, auth error during login', '');
    assert.equal(r.category, 'AUTH_ERROR');
  });
});

describe('ErrorClassifier: network errors', () => {
  test('ECONNREFUSED is a recoverable NETWORK_ERROR', () => {
    const r = ErrorClassifier.classify(1, '', 'connect ECONNREFUSED 127.0.0.1:1080');
    assert.equal(r.category, 'NETWORK_ERROR');
    assert.equal(r.isRecoverableBySwitchingVpn, true);
    assert.match(r.userMessage, /Network connection failed/i);
  });

  test('ETIMEDOUT is a recoverable NETWORK_ERROR', () => {
    const r = ErrorClassifier.classify(1, '', 'Error: ETIMEDOUT');
    assert.equal(r.category, 'NETWORK_ERROR');
    assert.equal(r.isRecoverableBySwitchingVpn, true);
    assert.match(r.userMessage, /timed out through proxy/i);
  });

  test('ECONNRESET falls through to the generic-exit fallback and is still recoverable', () => {
    const r = ErrorClassifier.classify(1, '', 'Error: read ECONNRESET');
    assert.equal(r.category, 'NETWORK_ERROR');
    assert.equal(r.isRecoverableBySwitchingVpn, true);
    assert.match(r.userMessage, /code 1/i);
  });

  test('DNS failure and socket hang up are NETWORK_ERROR', () => {
    assert.equal(ErrorClassifier.classify(1, '', 'getaddrinfo ENOTFOUND api.example.com').category, 'NETWORK_ERROR');
    assert.equal(ErrorClassifier.classify(1, '', 'socket hang up').category, 'NETWORK_ERROR');
  });

  test('timeout exit code 124 is NETWORK_ERROR even without text', () => {
    const r = ErrorClassifier.classify(124, '', '');
    assert.equal(r.category, 'NETWORK_ERROR');
    assert.equal(r.isRecoverableBySwitchingVpn, true);
  });
});

describe('ErrorClassifier: config errors and fallbacks', () => {
  test('SyntaxError is CONFIG_ERROR and not recoverable', () => {
    const r = ErrorClassifier.classify(1, '', 'SyntaxError: Unexpected token } in JSON');
    assert.equal(r.category, 'CONFIG_ERROR');
    assert.equal(r.isRecoverableBySwitchingVpn, false);
  });

  test('model not found is CONFIG_ERROR', () => {
    assert.equal(ErrorClassifier.classify(1, 'model not found: foo', '').category, 'CONFIG_ERROR');
  });

  test('generic exit 1 without a known phrase is the NETWORK_ERROR fallback', () => {
    const r = ErrorClassifier.classify(1, '', 'something broke unexpectedly');
    assert.equal(r.category, 'NETWORK_ERROR');
    assert.equal(r.isRecoverableBySwitchingVpn, true);
    assert.match(r.userMessage, /exited with code 1/i);
  });

  test('null exit code is treated as non-zero', () => {
    const r = ErrorClassifier.classify(null, '', 'mystery');
    assert.equal(r.category, 'NETWORK_ERROR');
    assert.equal(r.isRecoverableBySwitchingVpn, true);
  });
});
