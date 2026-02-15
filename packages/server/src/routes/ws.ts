import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { BookLevel } from "../engine/types.js";
import { logger } from "../logger.js";

interface WsClient {
  socket: WebSocket;
  marketId: string;
  userId?: string;
}

export class WsHub {
  private clients = new Set<WsClient>();

  addClient(client: WsClient): void {
    this.clients.add(client);
  }

  removeClient(client: WsClient): void {
    this.clients.delete(client);
  }

  broadcastBookUpdate(marketId: string, snapshot: { bids: BookLevel[]; asks: BookLevel[] }): void {
    this.broadcast(marketId, { type: "book_snapshot", data: snapshot });
  }

  broadcastTrade(marketId: string, trade: { priceCents: number; qty: number; takerSide: string }): void {
    this.broadcast(marketId, { type: "trade", data: trade });
  }

  broadcastMarketResolved(marketId: string, resolvesTo: string): void {
    this.broadcast(marketId, { type: "market_resolved", data: { resolvesTo } });
  }

  broadcastOrderUpdate(marketId: string, userId: string, data: unknown): void {
    for (const client of this.clients) {
      if (client.marketId === marketId && client.userId === userId) {
        this.send(client, { type: "order_update", data });
      }
    }
  }

  private broadcast(marketId: string, message: unknown): void {
    const payload = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.marketId === marketId && client.socket.readyState === 1) {
        client.socket.send(payload);
      }
    }
  }

  private send(client: WsClient, message: unknown): void {
    if (client.socket.readyState === 1) {
      client.socket.send(JSON.stringify(message));
    }
  }
}

export async function wsRoutes(app: FastifyInstance, wsHub: WsHub) {
  app.get("/ws", { websocket: true }, (socket: WebSocket, request) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const marketId = url.searchParams.get("market_id");

    if (!marketId) {
      socket.close(4000, "market_id query param required");
      return;
    }

    // Optional auth via token query param
    let userId: string | undefined;
    const token = url.searchParams.get("token");
    if (token) {
      try {
        const decoded = app.jwt.verify<{ sub: string }>(token);
        userId = decoded.sub;
      } catch {
        // Anonymous connection
      }
    }

    const client: WsClient = { socket, marketId, userId };
    wsHub.addClient(client);

    logger.debug({ marketId, userId }, "WS client connected");

    socket.on("close", () => {
      wsHub.removeClient(client);
      logger.debug({ marketId, userId }, "WS client disconnected");
    });

    socket.on("error", (err) => {
      logger.error(err, "WS error");
      wsHub.removeClient(client);
    });
  });
}
