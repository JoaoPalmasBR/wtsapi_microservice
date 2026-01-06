/**
 * Ponto de entrada principal do microserviço WhatsApp API
 *
 * Este arquivo inicializa todos os módulos necessários:
 * - Sentry (monitoramento de erros)
 * - WebSocket (comunicação em tempo real)
 * - Email (envio de notificações)
 * - WhatsApp (gerenciamento de sessões)
 * - Notificações (sistema de alertas)
 */

import "./libs/sentry";

import dotenv from "dotenv";

dotenv.config();

import "./modules/websocket";
import "./modules/emails";
import "./modules/whatsapp";
import "./modules/notifications";

import { FileUtils } from "./utils/file.utils";
import { logger } from "./services/logger.service";

async function bootstrap(): Promise<void> {
  try {
    logger.info("WTSAPI: Microservice started successfully");

    await FileUtils.createTempDirectory();

    logger.info("WTSAPI: All directories initialized");
  } catch (error) {
    logger.error("WTSAPI: Failed to start microservice", error);
    process.exit(1);
  }
}

// Inicia a aplicação
bootstrap();
