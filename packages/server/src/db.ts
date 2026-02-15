import { PrismaClient } from "@prisma/client";
import { logger } from "./logger.js";

export const prisma = new PrismaClient({
  log: [
    { emit: "event", level: "error" },
  ],
});

prisma.$on("error" as never, (e: any) => {
  logger.error(e, "Prisma error");
});
