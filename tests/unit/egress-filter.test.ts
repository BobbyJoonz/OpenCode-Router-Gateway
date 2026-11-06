// Covers isRoutableEgressAddress: rejects loopback (127.0.0.1, 127.x,
// localhost, ::1), unspecified 0.0.0.0, link-local (169.254.x, fe80::) and
// empty input; accepts public IPv4/IPv6, hostnames and private LAN ranges
// (10.x, 192.168.x, 172.16.x) which are legitimate self-hosted egress nodes.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { isRoutableEgressAddress } from '../../src/backend/gateway/egress-filter';

describe('isRoutableEgressAddress: rejected loopback and link-local addresses', () => {
  test('rejects loopback IPv4 including 127.0.0.0/8', () => {
    assert.equal(isRoutableEgressAddress('127.0.0.1'), false);
    assert.equal(isRoutableEgressAddress('127.0.0.2'), false);
    assert.equal(isRoutableEgressAddress('127.255.255.254'), false);
  });

  test('rejects localhost in any casing', () => {
    assert.equal(isRoutableEgressAddress('localhost'), false);
    assert.equal(isRoutableEgressAddress('LOCALHOST'), false);
    assert.equal(isRoutableEgressAddress('LocalHost'), false);
  });

  test('rejects IPv6 loopback, unspecified and link-local', () => {
    assert.equal(isRoutableEgressAddress('::1'), false);
    assert.equal(isRoutableEgressAddress('[::1]'), false);
    assert.equal(isRoutableEgressAddress('0.0.0.0'), false);
    assert.equal(isRoutableEgressAddress('fe80::1'), false);
    assert.equal(isRoutableEgressAddress('FE80::abcd'), false);
    assert.equal(isRoutableEgressAddress('[fe80::1]'), false);
  });

  test('rejects IPv4 link-local 169.254.0.0/16', () => {
    assert.equal(isRoutableEgressAddress('169.254.1.1'), false);
    assert.equal(isRoutableEgressAddress('169.254.169.254'), false);
  });

  test('rejects empty, whitespace and missing input', () => {
    assert.equal(isRoutableEgressAddress(''), false);
    assert.equal(isRoutableEgressAddress('   '), false);
    assert.equal(isRoutableEgressAddress(undefined as any), false);
    assert.equal(isRoutableEgressAddress(null as any), false);
  });
});

describe('isRoutableEgressAddress: accepted public addresses', () => {
  test('accepts public IPv4 addresses', () => {
    assert.equal(isRoutableEgressAddress('8.8.8.8'), true);
    assert.equal(isRoutableEgressAddress('1.1.1.1'), true);
    assert.equal(isRoutableEgressAddress('203.0.113.10'), true);
  });

  test('accepts public IPv6 addresses with and without brackets', () => {
    assert.equal(isRoutableEgressAddress('2001:db8::1'), true);
    assert.equal(isRoutableEgressAddress('[2001:db8::1]'), true);
    assert.equal(isRoutableEgressAddress('2606:4700:4700::1111'), true);
  });

  test('accepts hostnames and trims surrounding whitespace', () => {
    assert.equal(isRoutableEgressAddress('example.com'), true);
    assert.equal(isRoutableEgressAddress('proxy.node.example.net'), true);
    assert.equal(isRoutableEgressAddress('  example.com  '), true);
  });
});

describe('isRoutableEgressAddress: private LAN egress must stay selectable', () => {
  test('accepts 10.0.0.0/8', () => {
    assert.equal(isRoutableEgressAddress('10.0.0.1'), true);
    assert.equal(isRoutableEgressAddress('10.255.255.254'), true);
  });

  test('accepts 192.168.0.0/16', () => {
    assert.equal(isRoutableEgressAddress('192.168.1.10'), true);
    assert.equal(isRoutableEgressAddress('192.168.255.1'), true);
  });

  test('accepts 172.16.0.0/12', () => {
    assert.equal(isRoutableEgressAddress('172.16.0.1'), true);
    assert.equal(isRoutableEgressAddress('172.31.255.255'), true);
  });
});
