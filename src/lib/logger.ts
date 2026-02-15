import { randomUUID } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

export function requestId(): string {
  return randomUUID().slice(0, 8);
}

export function log(level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...data,
  };
  if (level === 'error') {
    console.error(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

export function requestLogger(req: FastifyRequest, _reply: FastifyReply, done: () => void) {
  const rid = requestId();
  (req as any).rid = rid;
  log('info', `${req.method} ${req.url}`, { rid, ip: req.ip });
  done();
}
