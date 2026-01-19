import "./libs/sentry";

import dotenv from "dotenv";

dotenv.config();

import { log } from "./services/logger.service";
import { pgBoss } from "./libs/pg-boss";
import { pool } from "./libs/pq";
import { FileUtils } from "./utils/file.utils";
import { QUEUE_KEYS } from "./config/constants";

async function bootstrap(): Promise<void> {
  await pgBoss.start();

  const queues = Object.entries(QUEUE_KEYS).values();

  for await (const [, queueName] of queues) {
    log.info(`Creating queue ${queueName}`);
    const queue_config = { retryLimit: 3, retryDelay: 30, expireInSeconds: 3600 };
    await pgBoss.createQueue(queueName, queue_config);
  }

  try {
    log.info("Microservice started successfully");
    await FileUtils.createTempDirectory();

    log.info("All directories initialized");
  } catch (error) {
    log.error("Failed to start microservice", error);
    process.exit(1);
  }

  await import("./utils/session-cache");
  await import("./whatsapp");
}

async function gracefulShutdown(signal: string): Promise<void> {
  log.info(`Recebido sinal ${signal}, encerrando graciosamente...`);
  
  try {
    await pgBoss.stop();
    log.info("pg-boss encerrado");
    
    await pool.end();
    log.info("Pool de conexões encerrado");
    
    log.info("Shutdown gracioso concluído");
    process.exit(0);
  } catch (error) {
    log.error("Erro durante shutdown gracioso", error);
    process.exit(1);
  }
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

process.on("unhandledRejection", (reason, promise) => {
  log.error("Unhandled Rejection em Promise:", { reason, promise });
});

process.on("uncaughtException", (error) => {
  log.error("Uncaught Exception:", error);
  gracefulShutdown("uncaughtException");
});

bootstrap();
