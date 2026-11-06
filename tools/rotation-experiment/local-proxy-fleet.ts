import http from 'http';
import net from 'net';

/**
 * A fleet of tiny forward proxies whose *outbound* sockets bind to distinct
 * loopback addresses (127.0.0.x). The mock provider therefore observes a
 * different source IP per proxy — which is exactly the variable the experiment
 * needs to isolate.
 *
 * In `sharedExit` mode every proxy binds the same address, modelling a public
 * subscription where many "nodes" share one exit IP.
 */
export interface FleetOptions {
  count: number;
  /** When true, all proxies bind the same outbound address (models public configs). */
  sharedExit?: boolean;
  /** First 127.0.0.x address to use. */
  firstIp?: number;
}

export interface Fleet {
  proxies: string[];
  exitIps: string[];
  close: () => Promise<void>;
}

function createProxy(localAddress: string): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer();

  server.on('request', (req, res) => {
    // Absolute-form request: GET http://host:port/path
    let target: URL;
    try {
      target = new URL(req.url || '');
    } catch {
      res.writeHead(400);
      res.end('bad proxy request');
      return;
    }
    const headers = { ...req.headers };
    delete (headers as any)['proxy-connection'];

    const upstream = http.request(
      {
        host: target.hostname,
        port: target.port ? Number(target.port) : 80,
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers,
        localAddress
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      }
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });

  server.on('connect', (req, clientSocket, head) => {
    const [host, portRaw] = (req.url || '').split(':');
    const port = Number(portRaw);
    if (!host || !Number.isInteger(port)) {
      clientSocket.destroy();
      return;
    }
    const upstream = net.connect({ host, port, localAddress });
    upstream.on('connect', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, port });
    });
  });
}

export async function startFleet(options: FleetOptions): Promise<Fleet> {
  const count = Math.max(1, Math.min(options.count, 200));
  const firstIp = options.firstIp ?? 2;
  const servers: http.Server[] = [];
  const proxies: string[] = [];
  const exitIps: string[] = [];

  for (let i = 0; i < count; i++) {
    const exitIp = options.sharedExit ? `127.0.0.${firstIp}` : `127.0.0.${firstIp + i}`;
    const { server, port } = await createProxy(exitIp);
    servers.push(server);
    proxies.push(`http://127.0.0.1:${port}`);
    exitIps.push(exitIp);
  }

  return {
    proxies,
    exitIps,
    close: async () => {
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => {
              server.closeAllConnections?.();
              server.close(() => resolve());
            })
        )
      );
    }
  };
}
