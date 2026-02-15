import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken, type JwtPayload } from './jwt.js';
import { globalLimiter } from '../lib/rate-limiter.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: JwtPayload;
    rid?: string;
  }
}

export async function authenticate(req: FastifyRequest, reply: FastifyReply) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Missing or invalid Authorization header' });
  }
  try {
    req.user = verifyToken(header.slice(7));
  } catch {
    return reply.status(401).send({ error: 'Invalid or expired token' });
  }
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  await authenticate(req, reply);
  if (reply.sent) return;
  if (req.user?.role !== 'ADMIN') {
    return reply.status(403).send({ error: 'Admin access required' });
  }
}

export async function rateLimit(req: FastifyRequest, reply: FastifyReply) {
  const key = req.user?.sub ?? req.ip;
  if (!globalLimiter.consume(key)) {
    return reply.status(429).send({ error: 'Rate limit exceeded' });
  }
}
