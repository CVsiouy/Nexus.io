import { config } from './config.js';

/**
 * Logging.
 *
 * In development: readable lines for a human watching a terminal.
 * In production: one JSON object per line, because log collectors parse those
 * into searchable fields. Being able to ask "show me every error from room X"
 * matters far more at 3am than the text looking nice.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[(config.logLevel as Level)] ?? LEVELS.info;

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (LEVELS[level] < threshold) return;

  if (config.logFormat === 'json') {
    process.stdout.write(JSON.stringify({
      ts: new Date().toISOString(),
      level,
      node: config.nodeName,
      region: config.region,
      msg,
      ...fields,
    }) + '\n');
  } else {
    const extra = fields && Object.keys(fields).length
      ? ' ' + Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ')
      : '';
    process.stdout.write(`[${level}] ${msg}${extra}\n`);
  }
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info:  (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn:  (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};
