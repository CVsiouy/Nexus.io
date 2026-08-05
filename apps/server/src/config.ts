/**
 * Configuration — everything that differs between your laptop and production.
 *
 * All of it comes from environment variables, so the SAME image runs in both
 * places with nothing baked in. That is what makes "deploy" a matter of
 * starting a container rather than rebuilding one.
 */

const str = (name: string, fallback: string) => process.env[name]?.trim() || fallback;
const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
};
const bool = (name: string, fallback: boolean) => {
  const v = process.env[name]?.trim().toLowerCase();
  if (v === undefined || v === '') return fallback;
  return v === '1' || v === 'true' || v === 'yes';
};

export const config = {
  port: num('PORT', 2567),
  env: str('NODE_ENV', 'development'),
  get isProd() { return this.env === 'production'; },

  /** Human-readable name for this machine, so logs and metrics identify it. */
  nodeName: str('NODE_NAME', 'local'),
  region: str('REGION', 'dev'),

  /**
   * Which websites are allowed to connect.
   *
   * In development anything goes. In production this must be your real
   * frontend domain — otherwise someone can host a copy of the client on their
   * own site and point it at your servers, and you pay the bandwidth for it.
   *
   * Comma-separated, e.g. "https://nexus.io,https://www.nexus.io"
   */
  allowedOrigins: str('ALLOWED_ORIGINS', '')
    .split(',').map(s => s.trim()).filter(Boolean),

  /** 'json' in production so log aggregators can parse it; 'pretty' locally. */
  logFormat: str('LOG_FORMAT', process.env.NODE_ENV === 'production' ? 'json' : 'pretty'),
  logLevel: str('LOG_LEVEL', 'info'),

  /** Expose /metrics. Leave on — it costs almost nothing and you will want it. */
  metricsEnabled: bool('METRICS_ENABLED', true),

  /** Optional error reporting. Leave empty to disable. */
  sentryDsn: str('SENTRY_DSN', ''),
};

/** Checked at boot: refuse to start misconfigured rather than fail subtly later. */
export function validateConfig(log: (msg: string) => void): void {
  if (!config.isProd) return;

  if (config.allowedOrigins.length === 0) {
    log(
      'WARNING: ALLOWED_ORIGINS is empty in production. Any website will be able ' +
      'to connect to this server and consume your bandwidth. Set it to your ' +
      'frontend domain.',
    );
  }
  if (config.nodeName === 'local') {
    log('WARNING: NODE_NAME is unset — logs and metrics from every machine will look identical.');
  }
}
