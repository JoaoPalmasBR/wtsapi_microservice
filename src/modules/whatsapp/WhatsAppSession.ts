import fs from "fs/promises";
import path from "path";
import Sentry from "@sentry/node";
import { Connection, Publisher } from "rabbitmq-client";
import { Socket } from "socket.io-client";
import makeWASocket, { useMultiFileAuthState, WASocket } from "baileys";

import logger from "../../libs/logger";
import redisClient from "../../libs/redis";
import { SessionExternalProps } from "./dtos";
import { ConnectionHandler } from "./handlers/ConnectionHandler";
import { MessageHandler } from "./handlers/MessageHandler";
import { SessionManagerHandler } from "./handlers/SessionManagerHandler";
import { MessageSenderHandler } from "./handlers/MessageSenderHandler";

export class WhatsAppSession {
  private whatsapp!: WASocket;
  private countRetryConnect = 0;
  private readonly maxRetries = 5;

  private connectionHandler: ConnectionHandler;
  private messageHandler: MessageHandler;
  private sessionManagerHandler: SessionManagerHandler;
  private messageSenderHandler: MessageSenderHandler;

  constructor(
    private data: SessionExternalProps,
    private rabbit: Connection,
    private rabbitPublisher: Publisher,
    private socket: Socket
  ) {
    this.connectionHandler = new ConnectionHandler(
      data,
      rabbit,
      rabbitPublisher,
      socket,
      () => this.countRetryConnect,
      (count) => {
        this.countRetryConnect = count;
      },
      () => this.start()
    );

    this.messageHandler = new MessageHandler(data, rabbitPublisher);
    this.sessionManagerHandler = new SessionManagerHandler(data, rabbitPublisher, socket);
    this.messageSenderHandler = new MessageSenderHandler(data);
  }

  async start() {
    try {
      console.log(`WTS_SERVICE: Starting WhatsApp session for token: ${this.data.token}`);

      if (this.countRetryConnect > this.maxRetries) {
        console.error(`WTS_SERVICE: Max retry connection reached for session ${this.data.token}`);
        return;
      }

      logger.level = "silent";

      const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${this.data.token}`);
      this.whatsapp = makeWASocket({
        auth: state,
        logger: logger,
        browser: ["Windows", "Chrome", "10.0"],
      });

      // Injeta o whatsapp nos handlers
      this.messageSenderHandler.setWhatsApp(this.whatsapp);
      this.messageHandler.setWhatsApp(this.whatsapp);
      this.sessionManagerHandler.setWhatsApp(this.whatsapp);

      this.setupEventListeners();
      this.whatsapp.ev.on("creds.update", saveCreds);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      console.error(`WTS_SERVICE: Error starting session ${this.data.token}`, errorMessage);
      Sentry.captureException(err);

      await redisClient.del(`wtsapi:${this.data.token}:connected`);

      await this.rabbitPublisher.send("wtsapi:session_auth_failure", {
        token: this.data.token,
      });
    }
  }

  private setupEventListeners() {
    this.whatsapp.ev.process(async (events) => {
      console.log(
        `Received events: ${Object.keys(events).join(", ")} | Session: ${
          this.data.token
        } | Time: ${new Date().toLocaleTimeString()}`
      );

      // Handler de conexão
      if (events["connection.update"]) {
        await this.connectionHandler.handle(events["connection.update"], this.whatsapp);
      }

      // Handler de mensagens
      if (events["messages.upsert"]) {
        await this.messageHandler.handle(events["messages.upsert"]);
      }
    });
  }

  async destroy() {
    try {
      console.log(`WTS_SERVICE: Destroying session: ${this.data.token}`);

      await redisClient.del(`wtsapi:${this.data.token}:connected`);

      const sessionsDir = path.resolve(process.cwd(), "sessions");
      const sessionPath = path.join(sessionsDir, this.data.token);
      await fs.rm(sessionPath, { recursive: true, force: true });

      try {
        this.whatsapp.end(undefined);
        await this.whatsapp.logout();
      } catch (err) {
        console.warn(`WTS_SERVICE: Logout warning for session ${this.data.token}`);
      }

      await this.rabbitPublisher.send("wtsapi:session_disconnected", {
        token: this.data.token,
      });

      console.log(`WTS_SERVICE: Session destroyed: ${this.data.token}`);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      Sentry.captureException(err);
      console.error(`WTS_SERVICE: Error destroying session ${this.data.token}`, errorMessage);
    }
  }
}
