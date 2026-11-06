// Covers src/backend/lifecycle.ts: in-flight request tracking middleware,
// the 503 rejection path once shutdown starts, graceful shutdown ordering
// (pre hooks -> server.close -> drain -> post hooks -> exit), hook error
// isolation, idempotent shutdown and the _resetForTests seam.
//
// shutdown() ends with process.exit(), so every shutdown test temporarily
// replaces process.exit with a stub that records the code and throws, and
// silences the lifecycle logging. Global signal handlers are never installed
// here; private server/exitCode state is set directly instead of calling
// install(), which would leak process listeners into the test runner.

import assert from 'node:assert/strict';
import test, { afterEach, describe } from 'node:test';
import { db } from '../../src/backend/db/database';
import { lifecycle } from '../../src/backend/lifecycle';

// shutdown() ends with a `wal_checkpoint(TRUNCATE)` pragma. These are unit
// tests, so replace it with a no-op: the real database file must not be
// written to by this suite.
(db as any).pragma = () => undefined;

interface FakeRes {
  headers: Record<string, string>;
  statusCode: number;
  jsonBody: any;
  setHeader(key: string, value: string): FakeRes;
  status(code: number): FakeRes;
  json(body: any): FakeRes;
  once(event: string, fn: () => void): FakeRes;
  emit(event: string): void;
}

function fakeRes(): FakeRes {
  const listeners = new Map<string, Array<() => void>>();
  const res: FakeRes = {
    headers: {},
    statusCode: 0,
    jsonBody: undefined,
    setHeader(key: string, value: string) {
      this.headers[key] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: any) {
      this.jsonBody = body;
      return this;
    },
    once(event: string, fn: () => void) {
      const list = listeners.get(event) || [];
      list.push(fn);
      listeners.set(event, list);
      return this;
    },
    emit(event: string) {
      for (const fn of listeners.get(event) || []) fn();
    }
  };
  return res;
}

/**
 * Run `fn` while process.exit is a throwing stub; returns the recorded exit
 * code. Also silences the lifecycle's console output.
 */
async function withExitStub(fn: (seen: { code?: number }) => Promise<void>): Promise<{ code?: number }> {
  const seen: { code?: number } = {};
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  (process as any).exit = ((code?: number) => {
    seen.code = code;
    throw new Error('EXIT_STUB');
  }) as never;
  try {
    await fn(seen);
  } finally {
    (process as any).exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
  }
  return seen;
}

afterEach(() => {
  lifecycle._resetForTests();
  // _resetForTests does not restore the configured exit code, so reset it here
  // to keep tests independent of execution order.
  (lifecycle as any).exitCode = 0;
});

describe('lifecycle: state and in-flight tracking', () => {
  test('starts idle', () => {
    lifecycle._resetForTests();
    assert.equal(lifecycle.isShuttingDown(), false);
    assert.equal(lifecycle.getInFlight(), 0);
  });

  test('trackInFlight calls next and counts the request', () => {
    lifecycle._resetForTests();
    const res = fakeRes();
    let nextCalled = 0;
    lifecycle.trackInFlight({} as any, res as any, () => {
      nextCalled++;
    });
    assert.equal(nextCalled, 1);
    assert.equal(lifecycle.getInFlight(), 1);
  });

  test('finish releases the in-flight slot', () => {
    lifecycle._resetForTests();
    const res = fakeRes();
    lifecycle.trackInFlight({} as any, res as any, () => {});
    res.emit('finish');
    assert.equal(lifecycle.getInFlight(), 0);
  });

  test('close releases the in-flight slot', () => {
    lifecycle._resetForTests();
    const res = fakeRes();
    lifecycle.trackInFlight({} as any, res as any, () => {});
    res.emit('close');
    assert.equal(lifecycle.getInFlight(), 0);
  });

  test('finish followed by close only releases once', () => {
    lifecycle._resetForTests();
    const res = fakeRes();
    lifecycle.trackInFlight({} as any, res as any, () => {});
    res.emit('finish');
    res.emit('close');
    assert.equal(lifecycle.getInFlight(), 0);
  });

  test('concurrent requests are counted independently', () => {
    lifecycle._resetForTests();
    const r1 = fakeRes();
    const r2 = fakeRes();
    lifecycle.trackInFlight({} as any, r1 as any, () => {});
    lifecycle.trackInFlight({} as any, r2 as any, () => {});
    assert.equal(lifecycle.getInFlight(), 2);
    r1.emit('finish');
    assert.equal(lifecycle.getInFlight(), 1);
    r2.emit('finish');
    assert.equal(lifecycle.getInFlight(), 0);
  });
});

describe('lifecycle: shutdown', () => {
  test('rejects new work with 503 while shutting down', { timeout: 5000 }, async () => {
    lifecycle._resetForTests();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    lifecycle.onShutdown('slow-pre', () => gate, 'pre');

    await withExitStub(async () => {
      const shutdownPromise = lifecycle.shutdown({ timeoutMs: 50 });
      assert.equal(lifecycle.isShuttingDown(), true);

      const res = fakeRes();
      let nextCalled = false;
      lifecycle.trackInFlight({} as any, res as any, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 503);
      assert.equal(res.headers.Connection, 'close');
      assert.deepEqual(res.jsonBody, { error: 'Server is shutting down', code: 'shutting_down' });
      assert.equal(lifecycle.getInFlight(), 0);

      release();
      await assert.rejects(shutdownPromise, /EXIT_STUB/);
    });
  });

  test('runs pre hooks, closes the server, then post hooks and exits', { timeout: 5000 }, async () => {
    lifecycle._resetForTests();
    const order: string[] = [];
    lifecycle.onShutdown(
      'pre-a',
      () => {
        order.push('pre');
      },
      'pre'
    );
    lifecycle.onShutdown('post-a', () => {
      order.push('post');
    });

    const fakeServer = {
      close: () => {
        order.push('server.close');
      }
    };
    (lifecycle as any).server = fakeServer;
    (lifecycle as any).exitCode = 7;

    const seen = await withExitStub(async () => {
      await assert.rejects(lifecycle.shutdown({ timeoutMs: 50 }), /EXIT_STUB/);
    });
    assert.deepEqual(order, ['pre', 'server.close', 'post']);
    assert.equal(seen.code, 7);
    assert.equal(lifecycle.isShuttingDown(), true);
  });

  test('a throwing hook is swallowed and does not stop the remaining hooks', { timeout: 5000 }, async () => {
    lifecycle._resetForTests();
    const order: string[] = [];
    lifecycle.onShutdown(
      'boom',
      () => {
        throw new Error('hook failed');
      },
      'pre'
    );
    lifecycle.onShutdown(
      'after',
      () => {
        order.push('after');
      },
      'pre'
    );

    const seen = await withExitStub(async () => {
      await assert.rejects(lifecycle.shutdown({ timeoutMs: 50 }), /EXIT_STUB/);
    });
    assert.deepEqual(order, ['after']);
    assert.equal(seen.code, 0);
  });

  test('repeated shutdown calls share one promise and exit exactly once', { timeout: 5000 }, async () => {
    lifecycle._resetForTests();
    let exitCount = 0;
    const originalExit = process.exit;
    const originalLog = console.log;
    console.log = () => {};
    (process as any).exit = (() => {
      exitCount++;
      throw new Error('EXIT_STUB');
    }) as never;
    try {
      const first = lifecycle.shutdown({ timeoutMs: 50 });
      const second = lifecycle.shutdown({ timeoutMs: 50 });
      assert.equal(first, second);
      await assert.rejects(first, /EXIT_STUB/);
      assert.equal(exitCount, 1);
    } finally {
      (process as any).exit = originalExit;
      console.log = originalLog;
    }
  });

  test('drains in-flight requests before exiting', { timeout: 5000 }, async () => {
    lifecycle._resetForTests();
    const res = fakeRes();
    lifecycle.trackInFlight({} as any, res as any, () => {});
    assert.equal(lifecycle.getInFlight(), 1);

    const seen = await withExitStub(async () => {
      const shutdownPromise = lifecycle.shutdown({ timeoutMs: 50 });
      res.emit('finish');
      await assert.rejects(shutdownPromise, /EXIT_STUB/);
    });
    assert.equal(lifecycle.getInFlight(), 0);
    assert.equal(seen.code, 0);
  });

  test('_resetForTests restores idle state after a shutdown', { timeout: 5000 }, async () => {
    lifecycle._resetForTests();
    await withExitStub(async () => {
      await assert.rejects(lifecycle.shutdown({ timeoutMs: 50 }), /EXIT_STUB/);
    });
    assert.equal(lifecycle.isShuttingDown(), true);
    lifecycle._resetForTests();
    assert.equal(lifecycle.isShuttingDown(), false);
    assert.equal(lifecycle.getInFlight(), 0);
    const next = lifecycle.shutdown({ timeoutMs: 50 });
    // a fresh shutdown runs again rather than returning the old promise
    await withExitStub(async () => {
      await assert.rejects(next, /EXIT_STUB/);
    });
  });
});
