import { type Span, SpanStatusCode, type Tracer, trace } from '@opentelemetry/api';

/**
 * OpenTelemetry tracing.
 *
 * Disabled unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set, so the default install
 * pays zero cost and needs no collector. The SDK is imported lazily so a missing
 * optional dependency can never break startup.
 */
let started = false;

export async function initTracing(): Promise<void> {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint || started) return;

  try {
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');

    const sdk = new NodeSDK({
      traceExporter: new OTLPTraceExporter({ url: endpoint }),
      serviceName: process.env.OTEL_SERVICE_NAME || 'opencode-router-gateway'
    });
    await sdk.start();
    started = true;

    const { lifecycle } = await import('../lifecycle.js');
    lifecycle.onShutdown('otel', async () => {
      await sdk.shutdown();
    });
    // eslint-disable-next-line no-console
    console.log(`[tracing] OTLP exporter enabled -> ${endpoint}`);
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.error('[tracing] failed to initialise, continuing without traces:', err?.message || err);
  }
}

export function isTracingEnabled(): boolean {
  return started;
}

export function getTracer(name = 'orgw'): Tracer {
  return trace.getTracer(name);
}

/**
 * Run `fn` inside a span. Never throws because of tracing.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean | undefined>,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, async (span) => {
    try {
      for (const [key, value] of Object.entries(attributes)) {
        if (value !== undefined) span.setAttribute(key, value);
      }
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err: any) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message || String(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}
