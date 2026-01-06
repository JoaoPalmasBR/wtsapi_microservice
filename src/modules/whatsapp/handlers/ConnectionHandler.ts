import { Boom } from "@hapi/boom";
import { DisconnectReason, WASocket } from "baileys";
import { Connection, Publisher } from "rabbitmq-client";
import { Socket } from "socket.io-client";

import redisClient from "../../../libs/redis";
import { SessionExternalProps } from "../dtos";
import { MessageSenderHandler } from "./MessageSenderHandler";
import { SessionManagerHandler } from "./SessionManagerHandler";

export class ConnectionHandler {
  constructor(
    private data: SessionExternalProps,
    private rabbit: Connection,
    private rabbitPublisher: Publisher,
    private socket: Socket,
    private getRetryCount: () => number,
    private setRetryCount: (count: number) => void,
    private restartSession: () => void,
    private messageSenderHandler: MessageSenderHandler,
    private sessionManagerHandler: SessionManagerHandler
  ) {}

  async handle(connectionUpdate: any, whatsapp: WASocket) {
    const { connection, lastDisconnect, qr } = connectionUpdate;
    const status = (lastDisconnect?.error as Boom)?.output?.statusCode;

    switch (connection) {
      case "open":
        await this.handleOpen(whatsapp);
        break;

      case "close":
        await this.handleClose(status);
        break;

      default:
        console.log(
          `WTS_SERVICE: Connection update | Session: ${this.data.token} | Status: ${connection} | Reason: ${status}`
        );
        break;
    }

    if (qr) {
      console.log(`WTS_SERVICE: QR Code generated for ${this.data.token} - ${new Date().toLocaleTimeString()}`);

      this.socket.emit("INTERNAL:session:socket", {
        clientId: this.data.clientId,
        data: { type: "qr_code", metadata: { qrCode: qr } },
      });
    }
  }

  private async handleOpen(whatsapp: WASocket) {
    this.setRetryCount(0);
    console.log(`WTS_SERVICE: WhatsApp connected successfully | Session: ${this.data.token}`);

    await redisClient.set(`wtsapi:${this.data.token}:connected`, "true", "EX", 240); // 4 minutes expiration

    // Notificações
    this.socket.emit("INTERNAL:session:socket", {
      clientId: this.data.clientId,
      data: {
        type: "session_updated",
        metadata: {
          notify: {
            type: "success",
            title: "WhatsApp Session",
            description: "WhatsApp session started successfully!",
          },
        },
      },
    });

    this.socket.emit("INTERNAL:notification-web", {
      clientId: this.data.clientId,
      data: {
        type: "notification_web",
        metadata: {
          notify: {
            type: "success",
            title: "WhatsApp Session",
            description: "WhatsApp session started successfully!",
          },
        },
      },
    });

    await this.rabbitPublisher.send("wtsapi:session_started", {
      token: this.data.token,
    });

    // Inicia consumers para esta sessão
    this.messageSenderHandler.setWhatsApp(whatsapp);
    await this.messageSenderHandler.startConsumer(this.rabbit);

    this.sessionManagerHandler.setWhatsApp(whatsapp);
    await this.sessionManagerHandler.startConsumer(this.rabbit);
  }

  private async handleClose(status: number | undefined) {
    const retryCount = this.getRetryCount();

    switch (status) {
      case DisconnectReason.badSession:
        console.log(
          `WTS_SERVICE: Bad session file, please delete session and scan again | Session: ${this.data.token}`
        );
        this.setRetryCount(retryCount + 1);
        this.restartSession();
        break;

      case DisconnectReason.connectionClosed:
        console.log(`WTS_SERVICE: Connection closed, reconnecting... | Session: ${this.data.token}`);
        this.setRetryCount(retryCount + 1);
        this.restartSession();
        break;

      case DisconnectReason.connectionLost:
        console.log(`WTS_SERVICE: Connection lost from WhatsApp, reconnecting... | Session: ${this.data.token}`);
        this.setRetryCount(retryCount + 1);
        this.restartSession();
        break;

      case DisconnectReason.connectionReplaced:
        console.log(
          `WTS_SERVICE: Connection replaced by another session, logging out... | Session: ${this.data.token}`
        );
        break;

      case DisconnectReason.loggedOut:
        console.log(`WTS_SERVICE: Device logged out, please scan again | Session: ${this.data.token}`);
        await redisClient.del(`wtsapi:${this.data.token}:connected`);
        break;

      case DisconnectReason.restartRequired:
        console.log(`WTS_SERVICE: Restart required, restarting... | Session: ${this.data.token}`);
        this.setRetryCount(retryCount + 1);
        this.restartSession();
        break;

      case DisconnectReason.multideviceMismatch:
        console.log(`WTS_SERVICE: Connection timeout, reconnecting... | Session: ${this.data.token}`);
        this.setRetryCount(retryCount + 1);
        this.restartSession();
        break;

      default:
        console.log(`WTS_SERVICE: Unknown disconnect reason: ${status}| Session: ${this.data.token}, reconnecting...`);
        this.setRetryCount(retryCount + 1);
        this.restartSession();
        break;
    }
  }
}
