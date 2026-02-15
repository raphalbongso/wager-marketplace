import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticate, requireAdmin } from '../auth/middleware.js';

const depositSchema = z.object({
  userId: z.string().uuid(),
  amountCents: z.number().int().min(1).max(10_000_000), // max 100k USD
});

export async function walletRoutes(app: FastifyInstance) {
  // Get current user profile + wallet
  app.get('/me', { preHandler: authenticate }, async (req, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.sub },
      include: { wallet: true },
    });
    if (!user) return reply.status(404).send({ error: 'User not found' });

    return reply.send({
      id: user.id,
      email: user.email,
      role: user.role,
      wallet: user.wallet
        ? {
            balanceCents: user.wallet.balanceCents,
            lockedCents: user.wallet.lockedCents,
            availableCents: user.wallet.balanceCents - user.wallet.lockedCents,
          }
        : null,
    });
  });

  // Get wallet details
  app.get('/wallet', { preHandler: authenticate }, async (req, reply) => {
    const wallet = await prisma.wallet.findUnique({ where: { userId: req.user!.sub } });
    if (!wallet) return reply.status(404).send({ error: 'Wallet not found' });

    return reply.send({
      balanceCents: wallet.balanceCents,
      lockedCents: wallet.lockedCents,
      availableCents: wallet.balanceCents - wallet.lockedCents,
    });
  });

  // Admin deposit (for testing)
  app.post('/wallet/deposit', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = depositSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    }
    const { userId, amountCents } = parsed.data;

    const wallet = await prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) {
      return reply.status(404).send({ error: 'User wallet not found' });
    }

    const updated = await prisma.wallet.update({
      where: { userId },
      data: { balanceCents: { increment: amountCents } },
    });

    await prisma.eventLog.create({
      data: {
        type: 'Deposit',
        payload: {
          userId,
          amountCents,
          adminUserId: req.user!.sub,
          newBalance: updated.balanceCents,
        },
      },
    });

    return reply.send({
      balanceCents: updated.balanceCents,
      lockedCents: updated.lockedCents,
      availableCents: updated.balanceCents - updated.lockedCents,
    });
  });
}
