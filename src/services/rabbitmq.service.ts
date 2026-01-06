import { Connection, Publisher } from "rabbitmq-client";
import Sentry from "@sentry/node";
import { 
  rabbitPublisherQueues, 
  rabbitPublisherExchanges, 
  rabbitQueueBindings 
} from "../config/rabbitmq.config";
import { RABBITMQ_QUEUES } from "../config/constants";
import { logger } from "./logger.service";

/**
 * Serviço para gerenciar conexões e publicações no RabbitMQ
 */
export class RabbitMQService {
  private connection: Connection;
  private publisher: Publisher;

  constructor(rabbitMQHost: string) {
    this.connection = new Connection(rabbitMQHost);
    this.setupConnectionListeners();
    this.publisher = this.createPublisher();
  }

  private setupConnectionListeners(): void {
    this.connection.on("connection", () => {
      logger.info("WhatsApp Worker connection successfully (re)established");
    });

    this.connection.on("error", (err) => {
      logger.error("RabbitMQ connection error", err);
      Sentry.captureException(err);
    });
  }

  private createPublisher(): Publisher {
    return this.connection.createPublisher({
      queues: rabbitPublisherQueues,
      confirm: true,
      maxAttempts: 2,
      exchanges: rabbitPublisherExchanges,
      queueBindings: rabbitQueueBindings,
    });
  }

  async publishSessionStarted(token: string): Promise<void> {
    await this.publisher.send(RABBITMQ_QUEUES.SESSION_STARTED, { token });
  }

  async publishSessionAuthFailure(token: string): Promise<void> {
    await this.publisher.send(RABBITMQ_QUEUES.SESSION_AUTH_FAILURE, { token });
  }

  async publishSessionDisconnected(token: string): Promise<void> {
    await this.publisher.send(RABBITMQ_QUEUES.SESSION_DISCONNECTED, { token });
  }

  async publishDisableAllSessions(): Promise<void> {
    await this.publisher.send(RABBITMQ_QUEUES.DISABLE_ALL_SESSIONS, {});
  }

  async publishMessageToWebhook(data: any): Promise<void> {
    await this.publisher.send(RABBITMQ_QUEUES.SEND_MESSAGE_TO_WEBHOOK, data);
  }

  getConnection(): Connection {
    return this.connection;
  }

  getPublisher(): Publisher {
    return this.publisher;
  }
}
