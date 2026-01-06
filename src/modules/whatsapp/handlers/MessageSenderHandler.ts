import fs from "fs/promises";
import path from "path";
import Sentry from "@sentry/node";
import { AnyMessageContent, delay, WASocket } from "baileys";
import { Connection } from "rabbitmq-client";

import redisClient from "../../../libs/redis";
import { SendMessageDto } from "../../../dtos/whatsapp";
import { SessionExternalProps } from "../dtos";

export class MessageSenderHandler {
  private whatsapp!: WASocket;

  constructor(private data: SessionExternalProps) {}

  setWhatsApp(whatsapp: WASocket) {
    this.whatsapp = whatsapp;
  }

  async startConsumer(rabbit: Connection) {
    console.log(`WTS_SERVICE: Starting send message consumer | Session: ${this.data.token}`);
    const subMessage = rabbit.createConsumer(
      {
        queue: `wtsapi:${this.data.token}:send.message`,
        queueOptions: { durable: true },
        qos: { prefetchCount: 2 },
      },
      async (msg) => {
        const messageHash = Buffer.from(msg.body.toString()).toString("base64url").slice(0, 30);

        console.log(
          `WTS_SERVICE: Received send message request | Session: ${this.data.token} | Message Hash: ${messageHash}`
        );

        try {
          const alreadyProcess = await redisClient.get(`wtsapi:msg:${messageHash}`);

          if (alreadyProcess) {
            console.warn(
              `WTS_SERVICE: Message already processed... | Session: ${this.data.token} | Message Hash: ${messageHash}`
            );
          }

          const message: SendMessageDto = JSON.parse(msg.body.toString());
          const recipients = Array.isArray(message.to) ? message.to : [message.to];

          switch (message.type) {
            case "image":
              await this.sendImageMessages(recipients, message);
              break;

            case "text":
            default:
              await this.sendTextMessages(recipients, message);
              break;
          }

          await redisClient.set(`wtsapi:msg:${messageHash}`, "processed", "EX", 3600);
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : "Unknown error";
          Sentry.captureException(err);
          console.error(`WTS_SERVICE: Error sending message in session ${this.data.token}`, errorMessage);
          await redisClient.del(`wtsapi:msg:${messageHash}`);
        }
      }
    );

    subMessage.on("error", (err) => {
      console.error("WTS_SERVICE: Consumer rabbit error (send-message)", err);
    });

    subMessage.start();
  }

  private async sendTextMessages(recipients: string[], message: SendMessageDto) {
    console.log(`WTS_SERVICE: Sending message to ${recipients.length} recipient(s) in session ${this.data.token}`);

    for (const recipient of recipients) {
      const jid = `${recipient}@c.us`;
      console.log(`WTS_SERVICE: Sending message to ${recipient} in session ${this.data.token}`);
      await this.sendMessageWithTyping(jid, { text: message.body });
    }
  }

  private async sendImageMessages(recipients: string[], message: SendMessageDto) {
    console.log(
      `WTS_SERVICE: Sending image message to ${recipients.length} recipient(s) in session ${this.data.token}`
    );

    for (const recipient of recipients) {
      const jid = `${recipient}@c.us`;
      console.log(`WTS_SERVICE: Sending image message to ${recipient} in session ${this.data.token}`);
      await this.sendImageMessage(jid, message);
    }
  }

  private async sendMessageWithTyping(jid: string, msg: AnyMessageContent) {
    try {
      await this.whatsapp.presenceSubscribe(jid);
      await delay(500);

      await this.whatsapp.sendPresenceUpdate("composing", jid);
      await delay(2000);

      await this.whatsapp.sendMessage(jid, msg);

      await this.whatsapp.sendPresenceUpdate("paused", jid);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      Sentry.captureException(err);
      console.error(`WTS_SERVICE: Error sending typing message in session ${this.data.token}`, errorMessage);
    }
  }

  private async sendImageMessage(jid: string, message: SendMessageDto) {
    try {
      const base64Data = message.body.replace(/^data:image\/\w+;base64,/, "");
      const imageBuffer = Buffer.from(base64Data, "base64");

      const matches = message.body.match(/^data:image\/(\w+);base64,/);
      const extension = matches?.[1] || "jpg";

      const tempDir = path.join(process.cwd(), "temp");
      await fs.mkdir(tempDir, { recursive: true });

      const fileName = `${Date.now()}_${this.data.token}.${extension}`;
      const tempPath = path.join(tempDir, fileName);

      await fs.writeFile(tempPath, imageBuffer);

      await this.whatsapp.sendMessage(jid, {
        image: { url: tempPath },
        caption: message.title || "",
      });

      await fs.unlink(tempPath);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      Sentry.captureException(err);
      console.error(`WTS_SERVICE: Error sending image message in session ${this.data.token}`, errorMessage);
    }
  }
}
