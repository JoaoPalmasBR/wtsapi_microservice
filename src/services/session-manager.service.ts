import path from "path";
import fs from "fs/promises";
import Sentry from "@sentry/node";
import { rabbitConsumerConfig } from "../config/rabbitmq.config";
import { SessionExternalProps } from "../types/session.types";
import { RabbitMQService } from "../services/rabbitmq.service";
import { SocketService } from "../services/socket.service";
import { WhatsAppSessionService } from "../services/whatsapp-session.service";
import { logger } from "../services/logger.service";
import { APP_CONFIG, PATHS, REDIS_KEYS } from "../config/constants";
import redisClient from "../libs/redis";

export class WhatsAppSessionManager {
  private readonly rabbitMQService: RabbitMQService;
  private readonly socketService: SocketService;

  constructor() {
    const rabbitMQHost = process.env.RABBITMQ_HOST ?? "amqp://guest:guest@localhost:5672";
    const websocketPort = Number(process.env.WEBSOCKET_PORT || APP_CONFIG.DEFAULT_WEBSOCKET_PORT);

    this.rabbitMQService = new RabbitMQService(rabbitMQHost);
    this.socketService = new SocketService(websocketPort);

    this.initialize();
  }

  private async initialize(): Promise<void> {
    await this.setupSessionStartConsumer();
    await this.rabbitMQService.publishDisableAllSessions();
    await this.restoreExistingSessions();

    logger.info("WhatsApp Worker Session running...");
  }

  private async setupSessionStartConsumer(): Promise<void> {
    const consumer = this.rabbitMQService.getConnection().createConsumer(rabbitConsumerConfig, async (msg) => {
      const sessionData = JSON.parse(msg.body.toString()) as SessionExternalProps;
      logger.info(`Received session start request for token: ${sessionData.token}`);

      const existingSession = await this.getSessionFromRedis(sessionData.token);

      if (existingSession) {
        logger.info(`Session already running for token: ${sessionData.token}`);
        return;
      }

      await this.startSession(sessionData);
    });

    consumer.on("error", (err) => {
      logger.error("Consumer error (user-events)", err);
    });
  }

  private async restoreExistingSessions(): Promise<void> {
    try {
      const sessionsPath = path.join(process.cwd(), PATHS.SESSIONS);
      const sessionTokens = await fs.readdir(sessionsPath);

      for (const token of sessionTokens) {
        const sessionData = await this.getSessionFromRedis(token);

        if (sessionData) {
          logger.info(`Starting registered session for token: ${token}`);
          await this.startSession(sessionData);
        } else {
          logger.info(`No session data found in Redis for token: ${token}`);
        }
      }
    } catch (err) {
      logger.error("Error starting all registered sessions", err);
      Sentry.captureException(err);
    }
  }

  private async startSession(sessionData: SessionExternalProps): Promise<void> {
    const session = new WhatsAppSessionService(this.rabbitMQService, this.socketService, sessionData);

    await session.start();
  }

  private async getSessionFromRedis(token: string): Promise<SessionExternalProps | null> {
    try {
      const sessionDataString = await redisClient.get(REDIS_KEYS.SESSION(token));
      return sessionDataString ? JSON.parse(sessionDataString) : null;
    } catch (err) {
      logger.error(`Error getting session from Redis for token: ${token}`, err);
      return null;
    }
  }
}
