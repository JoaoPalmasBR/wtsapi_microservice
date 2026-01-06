import fs from "fs/promises";
import path from "path";
import Sentry from "@sentry/node";
import { Connection, Publisher } from "rabbitmq-client";
import { Socket, io as WebSocket } from "socket.io-client";

import redisClient from "../../libs/redis";
import { SessionExternalProps } from "./dtos";
// import { WhatsAppSession } from "./WhatsAppSession";
import { rabbitConfig } from "./rabbitmq";
import { WhatsAppSession } from "./WhatsAppSession";

new class WtsAPISessionManager {
  private rabbit: Connection;
  private rabbitPublisher!: Publisher;
  private socket: Socket;
  private sessions: Map<string, WhatsAppSession> = new Map();

  constructor() {
    this.rabbit = new Connection(process.env.RABBITMQ_HOST ?? "amqp://guest:guest@localhost:5672");

    this.socket = WebSocket(`ws://localhost:${Number(process.env.WEBSOCKET_PORT || "3007")}`, {
      transports: ["websocket"],
    });

    this.setupRabbitConnection();
    this.setupSocketConnection();
    this.setupPublisher();
    this.init();
  }

  private setupRabbitConnection() {
    this.rabbit.on("connection", () => {
      console.log("WTS_SERVICE: WhatsApp Worker connection successfully (re)established");
    });

    this.rabbit.on("error", (err) => {
      console.error("WTS_SERVICE: RabbitMQ connection error", err);
    });
  }

  private setupSocketConnection() {
    this.socket.on("connect", () => {
      console.log("WTS_SERVICE: WhatsApp provider Socket connected:", this.socket.id);
    });
  }

  private setupPublisher() {
    this.rabbitPublisher = this.rabbit.createPublisher({
      queues: [
        { queue: "wtsapi.events" },
        { queue: "wtsapi:session_started", durable: true },
        { queue: "wtsapi:session_auth_failure", durable: true },
        { queue: "wtsapi:session_disconnected", durable: true },
        { queue: "wtsapi:disable_all_sessions", durable: true },
        { queue: "wtsapi:send_message_to_webhook", durable: true },
      ],
      confirm: true,
      maxAttempts: 2,
      exchanges: [{ exchange: "wtsapi-events", type: "topic", durable: false }],
      queueBindings: [{ exchange: "wtsapi-events", routingKey: "wtsapi.*" }],
    });
  }

  private async init() {
    const sub = this.rabbit.createConsumer({ ...rabbitConfig }, async (msg) => {
      const data = JSON.parse(msg.body.toString()) as SessionExternalProps;
      console.log(`WTS_SERVICE: Received session start request for token: ${data.token}`);

      const isConnected = await redisClient.get(`wtsapi:${data.token}:connected`);
      if (isConnected) {
        console.log(`WTS_SERVICE: Session already running for token: ${data.token}`);
        return;
      }

      await this.startSession(data);
    });

    await this.rabbitPublisher.send("wtsapi:disable_all_sessions", {});

    sub.on("error", (err) => {
      console.error("WTS_SERVICE: consumer error (user-events)", err);
    });

    await this.startSessionsAlreadyRegistered();
    console.log("WTS_SERVICE: WhatsApp Worker Session running...");
  }

  private async startSessionsAlreadyRegistered() {
    const pathSessions = path.join(process.cwd(), "sessions");

    try {
      const sessionTokenPathName = await fs.readdir(pathSessions);

      for (const token of sessionTokenPathName) {
        const sessionData = await redisClient.get(`wtsapi:${token}`);

        if (sessionData) {
          const sessionExternal: SessionExternalProps = JSON.parse(sessionData);
          console.log(`WTS_SERVICE: Starting registered session for token: ${token}`);
          await this.startSession(sessionExternal);
        } else {
          console.log(`WTS_SERVICE: No session data found in Redis for token: ${token}`);
        }
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      Sentry.captureException(err);
      console.error("WTS_SERVICE: Error starting all registered sessions", errorMessage);
    }
  }

  async startSession(data: SessionExternalProps) {
    try {
      // Salva dados da sessão no Redis
      await redisClient.set(`wtsapi:${data.token}`, JSON.stringify(data));
      console.log(`WTS_SERVICE: Session data saved to Redis for token: ${data.token}`);

      // Cria nova sessão WhatsApp
      const session = new WhatsAppSession(
        data,
        this.rabbit,
        this.rabbitPublisher,
        this.socket
      );

      this.sessions.set(data.token, session);
      await session.start();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      console.error(`WTS_SERVICE: Error starting session ${data.token}`, errorMessage);
      Sentry.captureException(err);

      await this.rabbitPublisher.send("wtsapi:session_auth_failure", {
        token: data.token,
      });
    }
  }

  async destroySession(token: string) {
    const session = this.sessions.get(token);
    if (session) {
      await session.destroy();
      this.sessions.delete(token);
    }
  }
}