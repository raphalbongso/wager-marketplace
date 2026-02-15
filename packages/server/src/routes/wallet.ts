import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { authenticate } from "../middleware/auth.js";

export async function walletRoutes(app: FastifyInstance) {
  app.get("/me", { preHandler: [authenticate] }, async (request) => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: request.user.sub },
      select: { id: true, email: true, role: true, createdAt: true },
    });
    return user;
  });

  app.get("/wallet", { preHandler: [authenticate] }, async (request) => {
    const wallet = await prisma.wallet.findUnique({
      where: { userId: request.user.sub },
    });
    if (!wallet) {
      return { balanceCents: 0, lockedCents: 0, availableCents: 0 };
    }
    return {
      balanceCents: wallet.balanceCents,
      lockedCents: wallet.lockedCents,
      availableCents: wallet.balanceCents - wallet.lockedCents,
    };
  });
}
