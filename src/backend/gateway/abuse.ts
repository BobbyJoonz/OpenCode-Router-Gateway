import crypto from 'crypto';
import { db, getSetting } from '../db/database';

interface KeyState {
  trust: number;
  lastUpdate: number;
  events: Array<{ at: number; weight: number; reason: string }>;
  recentHashes: Array<{ hash: string; at: number }>;
  rejectUntil: number;
}

const TRUST_MAX = 100;
const TRUST_MIN = 0;
const DECAY_PER_MINUTE = 5;
const REJECT_BELOW = 20;
const THROTTLE_BELOW = 60;

/**
 * Lightweight, conservative abuse detection (axis C4).
 *
 * Signals:
 *  - upstream 429 / network errors attributed to the key
 *  - many identical request bodies (retry storms, scraping, loops)
 *
 * Responses are progressive: a throttled key gets a small delay, and only a
 * badly degraded key is rejected. Everything is logged to `abuse_events` so a
 * human can review it later.
 */
export class AbuseDetector {
  private static states = new Map<number, KeyState>();

  private static enabled(): boolean {
    return getSetting('abuse_detection_enabled', 'true') === 'true';
  }

  private static windowMs(): number {
    return Math.max(10, parseInt(getSetting('abuse_window_seconds', '60'), 10)) * 1000;
  }

  private static state(keyId: number): KeyState {
    let s = this.states.get(keyId);
    if (!s) {
      s = { trust: TRUST_MAX, lastUpdate: Date.now(), events: [], recentHashes: [], rejectUntil: 0 };
      this.states.set(keyId, s);
    }
    return s;
  }

  private static decay(s: KeyState, now: number): void {
    const minutes = Math.floor((now - s.lastUpdate) / 60_000);
    if (minutes > 0) {
      s.trust = Math.min(TRUST_MAX, s.trust + minutes * DECAY_PER_MINUTE);
      s.lastUpdate = now;
    }
  }

  static check(keyId: number): { reject: boolean; retryAfterMs: number; delayMs: number; trust: number } {
    if (!this.enabled()) return { reject: false, retryAfterMs: 0, delayMs: 0, trust: TRUST_MAX };

    const now = Date.now();
    const s = this.state(keyId);
    this.decay(s, now);
    const windowMs = this.windowMs();
    s.events = s.events.filter((e) => now - e.at < windowMs);
    s.recentHashes = s.recentHashes.filter((h) => now - h.at < windowMs);

    if (s.rejectUntil > now) {
      return { reject: true, retryAfterMs: s.rejectUntil - now, delayMs: 0, trust: s.trust };
    }

    if (s.trust < REJECT_BELOW) {
      s.rejectUntil = now + 30_000;
      return { reject: true, retryAfterMs: 30_000, delayMs: 0, trust: s.trust };
    }

    const delayMs = s.trust < THROTTLE_BELOW ? 250 : 0;
    return { reject: false, retryAfterMs: 0, delayMs, trust: s.trust };
  }

  static record(keyId: number, ip: string | undefined, reason: string, weight = 5): void {
    if (!this.enabled()) return;
    const now = Date.now();
    const s = this.state(keyId);
    this.decay(s, now);

    s.events.push({ at: now, weight, reason });
    s.trust = Math.max(TRUST_MIN, s.trust - weight);
    if (s.trust < REJECT_BELOW) s.rejectUntil = now + 30_000;

    // Never let the in-memory window grow without bound.
    const windowMs = this.windowMs();
    s.events = s.events.filter((e) => now - e.at < windowMs);

    try {
      db.prepare('INSERT INTO abuse_events (key_id, ip, reason, score) VALUES (?, ?, ?, ?)').run(
        keyId,
        ip || null,
        reason,
        weight
      );
    } catch {
      /* best effort */
    }
  }

  /** Call for every request with a body fingerprint. Detects retry storms. */
  static noteRequestHash(keyId: number, body: any): { duplicated: boolean } {
    if (!this.enabled()) return { duplicated: false };
    const now = Date.now();
    const s = this.state(keyId);
    const hash = crypto.createHash('sha256').update(JSON.stringify(body || {})).digest('hex').slice(0, 16);
    const windowMs = this.windowMs();
    s.recentHashes = s.recentHashes.filter((h) => now - h.at < windowMs);
    s.recentHashes.push({ hash, at: now });

    const threshold = Math.max(3, parseInt(getSetting('abuse_duplicate_threshold', '15'), 10));
    const same = s.recentHashes.filter((h) => h.hash === hash).length;
    if (same >= threshold && same % threshold === 0) {
      this.record(keyId, undefined, `duplicate_body_x${same}`, 8);
      return { duplicated: true };
    }
    return { duplicated: false };
  }

  static getStatus(keyId: number): { trust: number; recent_events: number; reject_until: number } {
    const s = this.states.get(keyId);
    if (!s) return { trust: TRUST_MAX, recent_events: 0, reject_until: 0 };
    const now = Date.now();
    const windowMs = this.windowMs();
    return {
      trust: s.trust,
      recent_events: s.events.filter((e) => now - e.at < windowMs).length,
      reject_until: s.rejectUntil
    };
  }

  static reset(keyId: number): void {
    this.states.delete(keyId);
  }

  static listRecent(limit = 50): any[] {
    return db
      .prepare(
        `SELECT a.id, a.key_id, a.ip, a.reason, a.score, a.created_at, k.name AS key_name
           FROM abuse_events a LEFT JOIN api_keys k ON k.id = a.key_id
          ORDER BY a.id DESC LIMIT ?`
      )
      .all(Math.max(1, Math.min(limit, 500)));
  }
}
