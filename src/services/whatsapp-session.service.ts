import Sentry from "@sentry/node";
import makeWASocket, { useMultiFileAuthState } from "baileys";

import { SendMessageDto } from "../dtos/whatsapp";
import { SessionExternalProps } from "../types/session.types";

import { SocketService } from "../services/socket.service";
import { RabbitMQService } from "../services/rabbitmq.service";

import { ConnectionHandler } from "../handlers/connection.handler";
import { MessageSenderHandler } from "../handlers/message-sender.handler";
import { MessageReceiverHandler } from "../handlers/message-receiver.handler";
import { SessionManagerHandler } from "../handlers/session-manager.handler";

import { logger } from "../services/logger.service";

import { APP_CONFIG, PATHS, RABBITMQ_QUEUES, REDIS_KEYS } from "../config/constants";

import redisClient from "../libs/redis";
import baileyLogger from "../libs/logger";

export class WhatsAppSessionService {
  private countRetryConnect = { value: 0 };

  constructor(
    private readonly rabbitMQService: RabbitMQService,
    private readonly socketService: SocketService,
    private readonly sessionData: SessionExternalProps
  ) {}

  async start(): Promise<void> {
    try {
      await this.saveSessionToRedis();

      if (this.countRetryConnect.value > APP_CONFIG.MAX_RETRY_CONNECTIONS) {
        logger.error(`Max retry connection reached for session ${this.sessionData.token}`, {});
        return;
      }

      baileyLogger.level = "fatal";

      const { state, saveCreds } = await useMultiFileAuthState(`./${PATHS.SESSIONS}/${this.sessionData.token}`);

      const whatsapp = makeWASocket({
        auth: state,
        logger: baileyLogger,
        browser: APP_CONFIG.DEFAULT_BROWSER,
      });

      const messageSender = new MessageSenderHandler(whatsapp as any, this.sessionData.token);
      const connectionHandler = new ConnectionHandler(this.rabbitMQService, this.socketService, this.sessionData, () =>
        this.start()
      );
      const messageReceiver = new MessageReceiverHandler(whatsapp as any, this.rabbitMQService, this.sessionData.token);
      const sessionManager = new SessionManagerHandler(
        whatsapp,
        this.rabbitMQService,
        this.socketService,
        this.sessionData
      );

      whatsapp.ev.process(async (events) => {
        if (events["connection.update"]) {
          await this.handleConnectionUpdate(events["connection.update"], connectionHandler);
        }

        if (events["messages.upsert"]) {
          await this.handleMessagesUpsert(events["messages.upsert"], messageReceiver);
        }
      });

      await this.setupMessageConsumer(messageSender);
      await this.setupSessionManagerConsumer(sessionManager);

      whatsapp.ev.on("creds.update", saveCreds);
    } catch (err) {
      await this.handleSessionStartError(err);
    }
  }

  private async saveSessionToRedis(): Promise<void> {
    try {
      await redisClient.set(REDIS_KEYS.SESSION(this.sessionData.token), JSON.stringify(this.sessionData));
    } catch (err) {
      logger.error(`Error saving session data to Redis for token: ${this.sessionData.token}`, err);
      Sentry.captureException(err);
    }
  }

  private logReceivedEvents(events: any): void {
    logger.info(
      `Received events: ${Object.keys(events).join(", ")} | Session: ${
        this.sessionData.token
      } | Time: ${new Date().toLocaleTimeString()}`
    );
  }

  private async handleConnectionUpdate(update: any, connectionHandler: ConnectionHandler): Promise<void> {
    const { connection, lastDisconnect, qr } = update;
    const status = (lastDisconnect?.error as any)?.output?.statusCode;

    switch (connection) {
      case "open":
        await connectionHandler.handleConnectionOpen(this.countRetryConnect);
        break;

      case "close":
        connectionHandler.handleConnectionClose(status, this.countRetryConnect, APP_CONFIG.MAX_RETRY_CONNECTIONS);
        break;

      default:
        logger.info(
          `Connection update | Session: ${this.sessionData.token} | Status: ${connection} | Reason: ${status}`
        );
    }

    if (qr) {
      connectionHandler.handleQRCode(qr);
    }
  }

  private async handleMessagesUpsert(upsert: any, messageReceiver: MessageReceiverHandler): Promise<void> {
    try {
      if (upsert.type === "notify") {
        await messageReceiver.processIncomingMessages(upsert.messages);
      }
    } catch (err) {
      logger.error(`Error in send message to webhook in session ${this.sessionData.token}`, err);
    }
  }

  private async setupMessageConsumer(messageSender: MessageSenderHandler): Promise<void> {
    const consumer = this.rabbitMQService.getConnection().createConsumer(
      {
        queue: RABBITMQ_QUEUES.SEND_MESSAGE(this.sessionData.token),
        queueOptions: { durable: true },
        qos: { prefetchCount: 2 },
      },
      async (msg) => {
        try {
          const message: SendMessageDto = JSON.parse(msg.body.toString());
          await messageSender.processAndSendMessage(message);
        } catch (err) {
          logger.error(`Error sending message in session ${this.sessionData.token}`, err);
          Sentry.captureException(err);
        }
      }
    );

    consumer.on("error", (err) => {
      logger.error("Consumer rabbit error (send-message)", err);
    });
  }

  private async setupSessionManagerConsumer(sessionManager: SessionManagerHandler): Promise<void> {
    const consumer = this.rabbitMQService.getConnection().createConsumer(
      {
        queue: RABBITMQ_QUEUES.SESSION_MANAGER(this.sessionData.token),
        queueOptions: { durable: true },
        qos: { prefetchCount: 2 },
      },
      async (msg) => {
        const eventData = JSON.parse(msg.body.toString());
        await sessionManager.processEvent(eventData);
      }
    );

    consumer.on("error", (err) => {
      logger.error("Consumer error (session-manager)", err);
      Sentry.captureException(err);
    });
  }

  private async handleSessionStartError(err: unknown): Promise<void> {
    logger.error(`Error starting session ${this.sessionData.token}`, err);
    Sentry.captureException(err);

    await this.rabbitMQService.publishSessionAuthFailure(this.sessionData.token);
  }
}
