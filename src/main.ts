import "./libs/sentry";

import dotenv from "dotenv";

dotenv.config();

import { log } from "./services/logger.service";
import { pgBoss } from "./libs/pg-boss";
import { FileUtils } from "./utils/file.utils";
import { QUEUE_KEYS } from "./config/constants";

async function bootstrap(): Promise<void> {
  await pgBoss.start();

  const queues = Object.entries(QUEUE_KEYS).values();

  for await (const [, queueName] of queues) {
    log.info(`WTSAPI: Creating queue ${queueName}`);
    const queue_config = { retryLimit: 3, retryDelay: 30, expireInSeconds: 3600 };
    await pgBoss.createQueue(queueName, queue_config);
  }

  try {
    log.info("WTSAPI: Microservice started successfully");
    await FileUtils.createTempDirectory();

    log.info("WTSAPI: All directories initialized");
  } catch (error) {
    log.error("WTSAPI: Failed to start microservice", error);
    process.exit(1);
  }

  await import("./utils/session-cache");
  await import("./whatsapp");
}

bootstrap();
