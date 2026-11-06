import { request as undiciRequest, ProxyAgent } from 'undici';
import { getSetting } from '../db/database';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface AlertResult {
  sent: boolean;
  channels: string[];
  skippedReason?: string;
  error?: string;
}

interface AlertConfig {
  enabled: boolean;
  webhookUrl: string;
  telegramToken: string;
  telegramChatId: string;
  proxyUrl: string;
  cooldownSeconds: number;
}

function config(): AlertConfig {
  return {
    enabled: getSetting('alerts_enabled', 'false') === 'true',
    webhookUrl: (process.env.ALERT_WEBHOOK_URL || getSetting('alert_webhook_url', '')).trim(),
    telegramToken: (process.env.ALERT_TELEGRAM_BOT_TOKEN || '').trim(),
    telegramChatId: (process.env.ALERT_TELEGRAM_CHAT_ID || getSetting('alert_telegram_chat_id', '')).trim(),
    proxyUrl: (process.env.ALERT_PROXY_URL || '').trim(),
    cooldownSeconds: Math.max(0, parseInt(getSetting('alert_cooldown_seconds', '900'), 10))
  };
}

/**
 * Out-of-band notifications.
 *
 * The gateway is meant to run unattended, so a full disk or a dead egress pool
 * must reach a human. Two channels are supported without extra dependencies:
 * a generic JSON webhook and the Telegram Bot API. Every send is time-boxed and
 * failures are swallowed (an alerting outage must never break the service), and
 * identical alerts are de-duplicated by a cooldown window.
 */
export class Notifier {
  private static lastSent = new Map<string, number>();
  private static history: Array<{ at: string; key: string; severity: AlertSeverity; message: string; result: AlertResult }> = [];

  public static isConfigured(): boolean {
    const cfg = config();
    return !!(cfg.webhookUrl || (cfg.telegramToken && cfg.telegramChatId));
  }

  public static getHistory(): typeof Notifier.history {
    return this.history.slice(-50);
  }

  public static resetCooldowns(): void {
    this.lastSent.clear();
  }

  /**
   * @param key stable identifier used for de-duplication (e.g. "storage")
   */
  public static async send(key: string, message: string, severity: AlertSeverity = 'warning'): Promise<AlertResult> {
    const cfg = config();
    if (!cfg.enabled) return { sent: false, channels: [], skippedReason: 'alerts disabled' };
    if (!this.isConfigured()) return { sent: false, channels: [], skippedReason: 'no channel configured' };

    const now = Date.now();
    const last = this.lastSent.get(key) || 0;
    if (cfg.cooldownSeconds > 0 && now - last < cfg.cooldownSeconds * 1000) {
      return { sent: false, channels: [], skippedReason: `cooldown (${Math.ceil((cfg.cooldownSeconds * 1000 - (now - last)) / 1000)}s left)` };
    }

    const channels: string[] = [];
    const errors: string[] = [];

    if (cfg.webhookUrl) {
      const ok = await this.postJson(cfg.webhookUrl, { text: message, key, severity, at: new Date().toISOString() }, cfg.proxyUrl);
      if (ok) channels.push('webhook');
      else errors.push('webhook failed');
    }

    if (cfg.telegramToken && cfg.telegramChatId) {
      const url = `https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`;
      const ok = await this.postJson(
        url,
        { chat_id: cfg.telegramChatId, text: `[${severity.toUpperCase()}] ${message}`, disable_web_page_preview: true },
        cfg.proxyUrl
      );
      if (ok) channels.push('telegram');
      else errors.push('telegram failed');
    }

    const result: AlertResult = {
      sent: channels.length > 0,
      channels,
      error: errors.length > 0 ? errors.join('; ') : undefined
    };
    if (result.sent) this.lastSent.set(key, now);
    this.history.push({ at: new Date().toISOString(), key, severity, message, result });
    if (this.history.length > 200) this.history.splice(0, this.history.length - 200);
    return result;
  }

  /** Time-boxed POST; never throws. */
  private static async postJson(url: string, body: any, proxyUrl: string): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
      const response = await undiciRequest(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
        ...(dispatcher ? { dispatcher } : {})
      });
      // Drain so the connection is released.
      try {
        for await (const _ of response.body) {
          /* discard */
        }
      } catch {
        /* ignore */
      }
      return response.statusCode >= 200 && response.statusCode < 300;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
