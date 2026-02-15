import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; role: string };
    user: { sub: string; role: string };
  }
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
  } catch {
    reply.code(401).send({ error: "Unauthorized" });
  }
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  await authenticate(request, reply);
  if (reply.sent) return;
  if (request.user.role !== "ADMIN") {
    reply.code(403).send({ error: "Admin access required" });
  }
}

export function authPlugin(app: FastifyInstance) {
  app.decorate("authenticate", authenticate);
  app.decorate("requireAdmin", requireAdmin);
}
