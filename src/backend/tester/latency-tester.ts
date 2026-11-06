import net from 'net';
import http from 'http';
import https from 'https';
import tls from 'tls';

export interface TcpTestResult {
  reachable: boolean;
  latencyMs: number;
  error?: string;
}

export interface ProxyTestResult {
  success: boolean;
  latencyMs: number;
  egressIp?: string;
  error?: string;
}

export class LatencyTester {
  /**
   * Fast TCP handshake test to remote candidate endpoint
   */
  public static async testRemoteTcp(host: string, port: number, timeoutMs: number = 1500): Promise<TcpTestResult> {
    const startTime = Date.now();
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(timeoutMs);

      socket.once('connect', () => {
        const latencyMs = Date.now() - startTime;
        socket.destroy();
        resolve({ reachable: true, latencyMs });
      });

      socket.once('timeout', () => {
        socket.destroy();
        resolve({ reachable: false, latencyMs: -1, error: 'TCP connection timeout' });
      });

      socket.once('error', (err) => {
        socket.destroy();
        resolve({ reachable: false, latencyMs: -1, error: err.message });
      });

      try {
        socket.connect(port, host);
      } catch (e: any) {
        resolve({ reachable: false, latencyMs: -1, error: e.message });
      }
    });
  }

  /**
   * Test HTTP request latency and verify egress connectivity through the local HTTP proxy
   */
  public static async testProxyHttp(httpProxyPort: number = 10809, timeoutMs: number = 4000): Promise<ProxyTestResult> {
    const startTime = Date.now();

    // Verification endpoints: quick 204 or IP reflect
    const targets = [
      { host: 'www.google.com', path: '/generate_204', secure: false, port: 80 },
      { host: 'cloudflare.com', path: '/cdn-cgi/trace', secure: false, port: 80 }
    ];

    for (const target of targets) {
      const result = await this.executeProxyRequest(target.host, target.port, target.path, httpProxyPort, timeoutMs);
      if (result.success) {
        return result;
      }
    }

    return {
      success: false,
      latencyMs: -1,
      error: 'Proxy connectivity verification failed on all endpoints'
    };
  }

  /**
   * Get direct normal public IP (without proxy)
   */
  public static async getNormalPublicIp(): Promise<string> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      const res = await fetch('https://api.ipify.org?format=json', { signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.ok) {
        const json = await res.json() as { ip: string };
        if (json.ip) {
          // Privacy protection: mask host IP to avoid exposing personal network details
          if (json.ip.includes('.')) {
            return json.ip.split('.').slice(0, 2).concat(['*.*']).join('.');
          } else if (json.ip.includes(':')) {
            return json.ip.split(':').slice(0, 2).concat(['*:*:*:*:*:*']).join(':');
          }
          return json.ip;
        }
        return json.ip || 'Direct Network';
      }
    } catch {
      // ignore
    }
    return 'Direct Network';
  }

  private static async executeProxyRequest(
    targetHost: string,
    targetPort: number,
    targetPath: string,
    proxyPort: number,
    timeoutMs: number
  ): Promise<ProxyTestResult> {
    const startTime = Date.now();

    return new Promise((resolve) => {
      let resolved = false;
      const req = http.request({
        host: '127.0.0.1',
        port: proxyPort,
        method: 'GET',
        path: `http://${targetHost}:${targetPort}${targetPath}`,
        headers: {
          'Host': targetHost,
          'User-Agent': 'OpenCode-Vpn-Probe/1.0',
          'Connection': 'close'
        },
        timeout: timeoutMs
      });

      req.on('response', (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (resolved) return;
          resolved = true;
          const latencyMs = Date.now() - startTime;

          // Extract IP if present in body (e.g. from cloudflare trace: ip=...)
          let egressIp: string | undefined;
          const ipMatch = body.match(/ip=([0-9a-fA-F.:]+)/);
          if (ipMatch) {
            egressIp = ipMatch[1];
          }

          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 400) {
            resolve({ success: true, latencyMs, egressIp });
          } else {
            resolve({ success: false, latencyMs, error: `HTTP ${res.statusCode}` });
          }
        });
      });

      req.on('timeout', () => {
        if (resolved) return;
        resolved = true;
        req.destroy();
        resolve({ success: false, latencyMs: -1, error: 'HTTP proxy request timeout' });
      });

      req.on('error', (err) => {
        if (resolved) return;
        resolved = true;
        resolve({ success: false, latencyMs: -1, error: err.message });
      });

      req.end();
    });
  }
}
