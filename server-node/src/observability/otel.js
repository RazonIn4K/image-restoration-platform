import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

const OTEL_ENABLED = process.env.OTEL_ENABLED !== 'false';

let sdk;

async function startSdk() {
  if (!OTEL_ENABLED) {
    return;
  }

  const logLevel = (process.env.OTEL_DIAGNOSTIC_LOG_LEVEL || '').toLowerCase();
  if (logLevel && DiagLogLevel[logLevel.toUpperCase()]) {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel[logLevel.toUpperCase()]);
  }

  const resource = Resource.default().merge(
    new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'image-restoration-api',
      [SemanticResourceAttributes.SERVICE_NAMESPACE]: process.env.OTEL_SERVICE_NAMESPACE ?? 'image-restoration',
      [SemanticResourceAttributes.SERVICE_VERSION]: process.env.npm_package_version ?? '0.0.0',
      [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV ?? 'development',
    })
  );

  const traceExporter = new OTLPTraceExporter();
  const metricExporter = new OTLPMetricExporter();

  sdk = new NodeSDK({
    resource,
    traceExporter,
    metricExporter,
    instrumentations: getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  });

  await sdk.start();

  const shutdown = async () => {
    try {
      await sdk.shutdown();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[otel] Failed to shutdown SDK', error);
    }
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

startSdk().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('[otel] Failed to start SDK', error);
});

export function getOtelSdk() {
  return sdk;
}
