// Covers UpstreamClient.joinUrl URL assembly (trailing slashes, missing or
// extra slashes, '/v1' + '/models') and the pure readAll buffer helper
// (concatenation and size cap). forward() is never called: these tests must
// not hit the network.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { UpstreamClient } from '../../src/backend/gateway/upstream-client';

describe('UpstreamClient.joinUrl', () => {
  test('joins a base without trailing slash and a path with leading slash', () => {
    assert.equal(UpstreamClient.joinUrl('https://api.example.com', '/v1/models'), 'https://api.example.com/v1/models');
  });

  test('strips one or many trailing slashes from the base', () => {
    assert.equal(UpstreamClient.joinUrl('https://api.example.com/', '/models'), 'https://api.example.com/models');
    assert.equal(UpstreamClient.joinUrl('https://api.example.com///', '/models'), 'https://api.example.com/models');
    assert.equal(UpstreamClient.joinUrl('https://api.example.com/v1/', '/models'), 'https://api.example.com/v1/models');
  });

  test('adds the missing leading slash on the path', () => {
    assert.equal(UpstreamClient.joinUrl('https://api.example.com', 'v1/models'), 'https://api.example.com/v1/models');
    assert.equal(UpstreamClient.joinUrl('https://api.example.com/', 'models'), 'https://api.example.com/models');
  });

  test("does not double the slash for '/v1' + '/models'", () => {
    assert.equal(UpstreamClient.joinUrl('https://api.example.com/v1', '/models'), 'https://api.example.com/v1/models');
  });

  test('keeps ports and base paths intact', () => {
    assert.equal(
      UpstreamClient.joinUrl('http://127.0.0.1:19099/v1', '/chat/completions'),
      'http://127.0.0.1:19099/v1/chat/completions'
    );
  });

  test('keeps query strings on the path', () => {
    assert.equal(
      UpstreamClient.joinUrl('https://api.example.com/v1', '/models?limit=3'),
      'https://api.example.com/v1/models?limit=3'
    );
  });

  test('empty path yields just the base plus slash', () => {
    assert.equal(UpstreamClient.joinUrl('https://api.example.com', ''), 'https://api.example.com/');
  });

  test('an empty base leaves the path as-is', () => {
    assert.equal(UpstreamClient.joinUrl('', '/v1/models'), '/v1/models');
    assert.equal(UpstreamClient.joinUrl('', 'v1'), '/v1');
  });

  test('does not collapse internal duplicated slashes in the path (documented behaviour)', () => {
    assert.equal(UpstreamClient.joinUrl('https://api.example.com', '//v1'), 'https://api.example.com//v1');
  });
});

async function* bodyChunks(...chunks: Array<string | Buffer>): AsyncGenerator<string | Buffer> {
  for (const chunk of chunks) yield chunk;
}

describe('UpstreamClient.readAll', () => {
  test('concatenates buffer and string chunks as utf8', async () => {
    const text = await UpstreamClient.readAll(bodyChunks(Buffer.from('he'), 'llo ', Buffer.from('world')));
    assert.equal(text, 'hello world');
  });

  test('returns an empty string for an empty body', async () => {
    assert.equal(await UpstreamClient.readAll(bodyChunks()), '');
  });

  test('rejects bodies larger than the size cap with UPSTREAM_RESPONSE_TOO_LARGE', async () => {
    await assert.rejects(UpstreamClient.readAll(bodyChunks('abcdef'), 4), (err: any) => {
      assert.match(String(err.message), /size cap/i);
      assert.equal(err.code, 'UPSTREAM_RESPONSE_TOO_LARGE');
      return true;
    });
  });

  test('accepts a body exactly at the size cap', async () => {
    assert.equal(await UpstreamClient.readAll(bodyChunks('abcd'), 4), 'abcd');
  });
});

describe('UpstreamClient.resetAgents', () => {
  test('is safe when no agents are cached', () => {
    assert.doesNotThrow(() => UpstreamClient.resetAgents());
  });
});
