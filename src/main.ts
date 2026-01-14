import "./libs/sentry";

import dotenv from "dotenv";

dotenv.config();

import "./whatsapp";

import { FileUtils } from "./utils/file.utils";
import { log } from "./services/logger.service";

async function bootstrap(): Promise<void> {
  try {
    log.info("WTSAPI: Microservice started successfully");
    await FileUtils.createTempDirectory();

    log.info("WTSAPI: All directories initialized");
  } catch (error) {
    log.error("WTSAPI: Failed to start microservice", error);
    process.exit(1);
  }
}

bootstrap();
