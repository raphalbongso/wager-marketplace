import type { FastifyInstance } from "fastify";
import bcrypt from "bcrypt";
import { prisma } from "../db.js";
import { RegisterSchema, LoginSchema } from "../schemas/index.js";

const SALT_ROUNDS = 12;

export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/register", async (request, reply) => {
    const body = RegisterSchema.parse(request.body);

    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) {
      return reply.code(409).send({ error: "Email already registered" });
    }

    const passwordHash = await bcrypt.hash(body.password, SALT_ROUNDS);

    const user = await prisma.user.create({
      data: {
        email: body.email,
        passwordHash,
        wallet: { create: { balanceCents: 0, lockedCents: 0 } },
      },
      include: { wallet: true },
    });

    const token = app.jwt.sign({ sub: user.id, role: user.role });

    return reply.code(201).send({
      token,
      user: { id: user.id, email: user.email, role: user.role },
    });
  });

  app.post("/auth/login", async (request, reply) => {
    const body = LoginSchema.parse(request.body);

    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user) {
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    const valid = await bcrypt.compare(body.password, user.passwordHash);
    if (!valid) {
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    const token = app.jwt.sign({ sub: user.id, role: user.role });

    return { token, user: { id: user.id, email: user.email, role: user.role } };
  });
}
