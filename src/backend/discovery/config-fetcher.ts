import { db } from '../db/database';
import { ConfigParser, type ParsedConfig } from '../parser/config-parser';
import { XrayJsonImporter } from '../parser/xray-json-importer';
import { sanitizeSubscriptionUrl } from '../security/api-guard';

export interface SourceRow {
  id: number;
  name: string;
  url: string;
  enabled: number;
  last_fetched_at: string | null;
  fetch_status: string | null;
  config_count: number;
}

export interface FetchSummary {
  sourceId: number;
  sourceName: string;
  totalFetched: number;
  newImported: number;
  duplicates: number;
  invalid: number;
  error?: string;
}

export class ConfigFetcher {
  private static readonly MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024; // 15MB
  private static readonly TIMEOUT_MS = 12000; // 12 seconds

  /**
   * Fetch configurations from all enabled sources or a specific source
   */
  public static async fetchAllSources(sourceId?: number): Promise<FetchSummary[]> {
    let query = 'SELECT * FROM sources WHERE enabled = 1';
    let params: any[] = [];
    if (sourceId) {
      query = 'SELECT * FROM sources WHERE id = ?';
      params = [sourceId];
    }

    const sources = db.prepare(query).all(...params) as SourceRow[];
    const summaries: FetchSummary[] = [];

    for (const source of sources) {
      const summary = await this.fetchFromSource(source);
      summaries.push(summary);
    }

    return summaries;
  }

  /**
   * Fetch from a single source row
   */
  public static async fetchFromSource(source: SourceRow): Promise<FetchSummary> {
    const summary: FetchSummary = {
      sourceId: source.id,
      sourceName: source.name,
      totalFetched: 0,
      newImported: 0,
      duplicates: 0,
      invalid: 0
    };

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.TIMEOUT_MS);

      const resp = await fetch(source.url, {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/plain, text/html, application/octet-stream, */*'
        }
      });
      clearTimeout(timeoutId);

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      }

      const rawText = await resp.text();
      if (rawText.length > this.MAX_DOWNLOAD_BYTES) {
        throw new Error(`Content length exceeds maximum limit (${rawText.length} bytes)`);
      }

      // Check if text is base64 encoded subscription
      let content = rawText.trim();
      if (!content.includes('://') && content.length > 30) {
        try {
          const decoded = Buffer.from(content, 'base64').toString('utf-8');
          if (decoded.includes('://')) {
            content = decoded;
          }
        } catch {
          // not base64
        }
      }

      const lines = content.split(/[\r\n]+/);
      summary.totalFetched = lines.length;

      const insertStmt = db.prepare(`
        INSERT INTO configs (
          protocol, address, port, remark, security, network,
          raw_url, config_hash, source_id, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(config_hash) DO NOTHING
      `);

      let imported = 0;
      let duplicates = 0;
      let invalid = 0;

      const tx = db.transaction(() => {
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;

          const parsed = ConfigParser.parse(trimmed);
          if (!parsed) {
            invalid++;
            continue;
          }

          const result = insertStmt.run(
            parsed.protocol,
            parsed.address,
            parsed.port,
            parsed.remark,
            parsed.security,
            parsed.network,
            parsed.raw_url,
            parsed.config_hash,
            source.id,
            JSON.stringify(parsed.details)
          );

          if (result.changes > 0) {
            imported++;
          } else {
            duplicates++;
          }
        }

        // Update source stats
        db.prepare(`
          UPDATE sources SET
            last_fetched_at = datetime('now'),
            fetch_status = 'success',
            config_count = (SELECT COUNT(*) FROM configs WHERE source_id = ?)
          WHERE id = ?
        `).run(source.id, source.id);
      });

      tx();

      summary.newImported = imported;
      summary.duplicates = duplicates;
      summary.invalid = invalid;
    } catch (err: any) {
      const rawError = err?.message || 'Unknown fetch error';
      summary.error = sanitizeSubscriptionUrl(rawError);
      db.prepare(`
        UPDATE sources SET
          last_fetched_at = datetime('now'),
          fetch_status = ?
        WHERE id = ?
      `).run(`error: ${summary.error}`, source.id);
    }

    return summary;
  }

  /**
   * Import custom raw text or single URLs directly
   */
  public static importRawText(
    rawText: string,
    customName: string = 'Manual Import'
  ): { imported: number; duplicates: number; invalid: number } {
    let content = rawText.trim();
    if (!content.includes('://') && content.length > 30) {
      try {
        const decoded = Buffer.from(content, 'base64').toString('utf-8');
        if (decoded.includes('://')) content = decoded;
      } catch {
        // ignore
      }
    }

    // A complete Xray/V2Ray client config.json is accepted alongside share links.
    const trimmedContent = content.trim();
    const isJsonConfig = trimmedContent.startsWith('{') || trimmedContent.startsWith('[');
    const parsedItems: (ParsedConfig | null)[] = isJsonConfig
      ? XrayJsonImporter.parse(trimmedContent)
      : content
          .split(/[\r\n]+/)
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#'))
          .map((l) => ConfigParser.parse(l));

    const insertStmt = db.prepare(`
      INSERT INTO configs (
        protocol, address, port, remark, security, network,
        raw_url, config_hash, details_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(config_hash) DO NOTHING
    `);

    let imported = 0;
    let duplicates = 0;
    let invalid = 0;

    const tx = db.transaction(() => {
      for (const parsed of parsedItems) {
        if (!parsed) {
          invalid++;
          continue;
        }

        const result = insertStmt.run(
          parsed.protocol,
          parsed.address,
          parsed.port,
          parsed.remark,
          parsed.security,
          parsed.network,
          parsed.raw_url,
          parsed.config_hash,
          JSON.stringify(parsed.details)
        );

        if (result.changes > 0) imported++;
        else duplicates++;
      }
    });

    tx();
    return { imported, duplicates, invalid };
  }
}
