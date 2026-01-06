import path from "path";
import fs from "fs/promises";
import Sentry from "@sentry/node";
import { SessionExternalProps, SessionManagerEventData } from "../types/session.types";
import { RabbitMQService } from "../services/rabbitmq.service";
import { SocketService } from "../services/socket.service";
import { SESSION_EVENTS, NOTIFICATION_TYPES, PATHS } from "../config/constants";
import { logger } from "../services/logger.service";
import redisClient from "../libs/redis";
import { REDIS_KEYS } from "../config/constants";

/**
 * Handler para gerenciar sessões do WhatsApp
 */
export class SessionManagerHandler {
  constructor(
    private readonly whatsapp: any,
    private readonly rabbitMQService: RabbitMQService,
    private readonly socketService: SocketService,
    private readonly sessionData: SessionExternalProps
  ) {}

  /**
   * Processa eventos de gerenciamento de sessão
   */
  async processEvent(eventData: SessionManagerEventData): Promise<void> {
    switch (eventData.event) {
      case SESSION_EVENTS.DISCONNECT_SESSION:
        await this.handleDisconnectSession();
        break;

      case SESSION_EVENTS.SEND_TYPING_EVENT:
        // Método depreciado, não usado
        logger.info("Typing event method is deprecated");
        break;

      default:
        logger.info("Session manager event not found");
    }
  }

  /**
   * Desconecta a sessão do WhatsApp
   */
  private async handleDisconnectSession(): Promise<void> {
    try {
      logger.info(`Disconnecting session: ${this.sessionData.token}`);

      await this.whatsapp.logout();
      logger.info(`Session destroyed: ${this.sessionData.token}`);

      await this.rabbitMQService.publishSessionDisconnected(this.sessionData.token);

      await this.removeSessionFiles();
      await this.removeSessionFromRedis();

      this.emitDisconnectionNotification();

      await this.whatsapp.logout();
    } catch (err) {
      logger.error(`Error disconnecting session ${this.sessionData.token}`, err);
      Sentry.captureException(err);
      throw err;
    }
  }

  /**
   * Remove arquivos da sessão
   */
  private async removeSessionFiles(): Promise<void> {
    try {
      const sessionsDir = path.resolve(process.cwd(), PATHS.SESSIONS);
      const sessionPath = path.join(sessionsDir, this.sessionData.token);

      await fs.rm(sessionPath, { recursive: true, force: true });
      logger.info(`Session files removed for ${this.sessionData.token}`);
    } catch (err) {
      logger.error(`Error removing session files for ${this.sessionData.token}`, err);
      Sentry.captureException(err);
    }
  }

  /**
   * Remove sessão do Redis
   */
  private async removeSessionFromRedis(): Promise<void> {
    try {
      await redisClient.del(REDIS_KEYS.SESSION(this.sessionData.token));
      logger.info(`Session removed from Redis for ${this.sessionData.token}`);
    } catch (err) {
      logger.error(`Error removing session from Redis for ${this.sessionData.token}`, err);
      Sentry.captureException(err);
    }
  }

  /**
   * Emite notificação de desconexão
   */
  private emitDisconnectionNotification(): void {
    this.socketService.emitNotificationWeb({
      clientId: this.sessionData.clientId,
      data: {
        type: "notification_web",
        metadata: {
          notify: {
            type: NOTIFICATION_TYPES.WARNING,
            title: "WhatsApp Session",
            description: "WhatsApp session disconnected successfully!",
          },
        },
      },
    });
  }
}
