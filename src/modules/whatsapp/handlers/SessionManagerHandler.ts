import fs from "fs/promises";
import path from "path";
import Sentry from "@sentry/node";
import { WASocket } from "baileys";
import { Connection, Publisher } from "rabbitmq-client";
import { Socket } from "socket.io-client";

import redisClient from "../../../libs/redis";
import { SessionExternalProps } from "../dtos";

interface SessionManagerEvent {
  event: string;
  data: object;
}

export class SessionManagerHandler {
  private whatsapp!: WASocket;

  constructor(private data: SessionExternalProps, private rabbitPublisher: Publisher, private socket: Socket) {}

  setWhatsApp(whatsapp: WASocket) {
    this.whatsapp = whatsapp;
  }

  async startConsumer(rabbit: Connection) {
    console.log(`WTS_SERVICE: Starting session manager consumer for session ${this.data.token}`);

    const sessionManager = rabbit.createConsumer(
      {
        queue: `wtsapi:${this.data.token}:session.manager`,
        queueOptions: { durable: true },
        qos: { prefetchCount: 2 },
      },
      async (msg) => {
        console.log(`WTS_SERVICE: Received session manager event for session ${this.data.token}`);
        const dataEvent: SessionManagerEvent = JSON.parse(msg.body.toString());
        console.log(dataEvent.event);

        switch (dataEvent.event) {
          case "disconnect_session":
            await this.handleDisconnectSession();
            break;

          case "send_typing_event":
            // método depreciado
            break;

          default:
            console.log(`WTS_SERVICE: Session manager event not found`);
        }
      }
    );

    sessionManager.on("error", (err) => {
      Sentry.captureException(err);
      console.error("WTS_SERVICE: consumer error (session-manager)", err);
    });

    console.log(`WTS_SERVICE: Session manager consumer started successfully for session ${this.data.token}`);
  }

  private async handleDisconnectSession() {
    try {
      console.log(`WTS_SERVICE: Disconnecting session: ${this.data.token}`);

      await redisClient.del(`wtsapi:${this.data.token}:connected`);

      console.log(`WTS_SERVICE: Session destroyed: ${this.data.token}`);

      await this.rabbitPublisher.send("wtsapi:session_disconnected", {
        token: this.data.token,
      });

      const sessionsDir = path.resolve(process.cwd(), "sessions");
      const sessionPath = path.join(sessionsDir, this.data.token);

      await fs.rm(sessionPath, { recursive: true, force: true });
      console.log(`WTS_SERVICE: Session folder and files removed for ${this.data.token}`);

      try {
        this.whatsapp.end(undefined);
        await this.whatsapp.logout();
      } catch (err) {
        if (err instanceof Error) {
          console.warn(`WTS_SERVICE: Logout warning for session ${this.data.token}`, err.message);
        } else {
          console.warn(`WTS_SERVICE: Logout warning for session ${this.data.token}`);
        }
      }

      console.log(`WTS_SERVICE: Removing session files for ${this.data.token}`);

      this.socket.emit("INTERNAL:notification-web", {
        clientId: this.data.clientId,
        data: {
          type: "notification_web",
          metadata: {
            notify: {
              type: "warning",
              title: "WhatsApp Session",
              description: "WhatsApp session disconnected successfully!",
            },
          },
        },
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      Sentry.captureException(err);
      console.error(`WTS_SERVICE: Error disconnecting session ${this.data.token}`, errorMessage);
    }
  }
}
