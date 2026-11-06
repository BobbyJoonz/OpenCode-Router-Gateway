/**
 * Coverage: src/backend/tester/candidate-ranker.ts
 *
 * Uses a throw-away SQLite database (DATA_DIR redirected to a unique temp
 * directory at the top of this file, DB modules imported dynamically) so the
 * repository ./data database is never opened or modified.
 *
 * - getRankedCandidates returns verified 'working' configs first, then
 *   'untested', then previously failed ones, scored in descending order.
 * - Nodes with consecutive_failures >= 4 are excluded entirely.
 * - Higher success_count and lower latency produce a higher score.
 * - The limit argument caps the returned list without changing the order.
 * - Returned rows expose the documented shape, including a numeric score.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const TMP = path.join(os.tmpdir(), `orgw-ranker-${process.pid}-${Date.now()}`);
process.env.DATA_DIR = TMP;

let db: any;
let CandidateRanker: any;

interface TestConfig {
  protocol?: string;
  security?: string;
  last_status: string;
  last_latency_ms: number | null;
  consecutive_failures: number;
  success_count: number;
  remark: string;
}

const insertedIds: number[] = [];

function insertConfig(config: TestConfig): number {
  const index = insertedIds.length + 1;
  const result = db
    .prepare(
      `INSERT INTO configs
         (protocol, address, port, remark, security, network, raw_url, config_hash,
          details_json, last_status, last_latency_ms, consecutive_failures, success_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      config.protocol ?? 'vmess',
      '127.0.0.1',
      10000 + index,
      config.remark,
      config.security ?? 'none',
      'tcp',
      `vmess://unit-test-${index}`,
      `unit-test-hash-${index}`,
      '{}',
      config.last_status,
      config.last_latency_ms,
      config.consecutive_failures,
      config.success_count
    );
  const id = Number(result.lastInsertRowid);
  insertedIds.push(id);
  return id;
}

before(async () => {
  const database = await import('../../src/backend/db/database.js');
  database.initDatabase();
  db = database.db;
  const ranker = await import('../../src/backend/tester/candidate-ranker.js');
  CandidateRanker = ranker.CandidateRanker;
});

after(() => {
  try {
    db?.close();
  } catch {
    // already closed
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('CandidateRanker.getRankedCandidates', () => {
  it('starts from an empty table', () => {
    const count = db.prepare('SELECT COUNT(*) AS n FROM configs').get().n;
    assert.equal(count, 0);
  });

  it('orders working first, untested next and failures last, excluding cf >= 4', () => {
    // Scores (base 100, vmess/none => no protocol bonus):
    //   workingA: 100 + 50 (working) + 50 (1 success) + 25 (<150ms) = 225
    //   workingB: 100 + 50 (working) + 50 (1 success)            = 200
    //   untested: 100                                            = 100
    //   failed:   100 - 60 (cf 2)                                =  40
    const workingA = insertConfig({
      last_status: 'working',
      last_latency_ms: 120,
      consecutive_failures: 0,
      success_count: 1,
      remark: 'working-fast'
    });
    const workingB = insertConfig({
      last_status: 'working',
      last_latency_ms: 700,
      consecutive_failures: 0,
      success_count: 1,
      remark: 'working-slow'
    });
    const untested = insertConfig({
      last_status: 'untested',
      last_latency_ms: null,
      consecutive_failures: 0,
      success_count: 0,
      remark: 'never-tested'
    });
    const failed = insertConfig({
      last_status: 'failed',
      last_latency_ms: 300,
      consecutive_failures: 2,
      success_count: 0,
      remark: 'failed-twice'
    });
    const excluded = insertConfig({
      last_status: 'failed',
      last_latency_ms: 200,
      consecutive_failures: 4,
      success_count: 0,
      remark: 'too-many-failures'
    });

    const ranked = CandidateRanker.getRankedCandidates();
    const ids = ranked.map((row: any) => row.id);

    assert.deepEqual(ids, [workingA, workingB, untested, failed]);
    assert.ok(!ids.includes(excluded), 'configs with consecutive_failures >= 4 must be excluded');

    // Status groups appear in the documented order.
    assert.deepEqual(
      ranked.map((row: any) => row.last_status),
      ['working', 'working', 'untested', 'failed']
    );

    // Scores are non-increasing.
    for (let i = 1; i < ranked.length; i++) {
      assert.ok(
        ranked[i - 1].score >= ranked[i].score,
        `scores must be descending: ${ranked[i - 1].score} < ${ranked[i].score}`
      );
    }

    // Faster working node outranks the slower one.
    assert.ok(ranked[0].last_latency_ms < ranked[1].last_latency_ms);
    assert.ok(ranked[0].score > ranked[1].score);
  });

  it('exposes the documented row shape', () => {
    const rows = CandidateRanker.getRankedCandidates();
    assert.ok(rows.length > 0);
    const row = rows[0];
    for (const key of [
      'id',
      'protocol',
      'address',
      'port',
      'remark',
      'security',
      'network',
      'details_json',
      'last_status',
      'last_latency_ms',
      'consecutive_failures',
      'success_count',
      'score'
    ]) {
      assert.ok(key in row, `missing field ${key}`);
    }
    assert.equal(typeof row.id, 'number');
    assert.equal(typeof row.score, 'number');
    assert.ok(Number.isFinite(row.score));
    assert.equal(row.protocol, 'vmess');
    assert.equal(row.port, 10001);
  });

  it('honours the limit argument without reordering', () => {
    const all = CandidateRanker.getRankedCandidates();
    const limited = CandidateRanker.getRankedCandidates(2);
    assert.equal(limited.length, 2);
    assert.deepEqual(
      limited.map((row: any) => row.id),
      all.slice(0, 2).map((row: any) => row.id)
    );
  });

  it('gives higher success_count a higher score at equal latency', () => {
    insertedIds.length = 0; // clear index bookkeeping only; rows stay in the DB
    db.prepare('DELETE FROM configs').run();

    const low = insertConfig({
      last_status: 'working',
      last_latency_ms: 120,
      consecutive_failures: 0,
      success_count: 0,
      remark: 'no-past-success'
    });
    const high = insertConfig({
      last_status: 'working',
      last_latency_ms: 120,
      consecutive_failures: 0,
      success_count: 3,
      remark: 'three-successes'
    });

    const ranked = CandidateRanker.getRankedCandidates();
    assert.deepEqual(
      ranked.map((row: any) => row.id),
      [high, low]
    );
    assert.equal(ranked[0].score - ranked[1].score, 150);
  });
});
