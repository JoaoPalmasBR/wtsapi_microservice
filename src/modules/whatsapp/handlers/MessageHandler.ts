import Sentry from "@sentry/node";
import { downloadMediaMessage, WASocket } from "baileys";
import { Publisher } from "rabbitmq-client";

import { ContactDto } from "../../../dtos/contact";
import { SessionExternalProps } from "../dtos";

export class MessageHandler {
  private whatsapp!: WASocket;

  constructor(private data: SessionExternalProps, private rabbitPublisher: Publisher) {}

  setWhatsApp(whatsapp: WASocket) {
    this.whatsapp = whatsapp;
  }

  async handle(upsert: any) {
    try {
      if (upsert.type !== "notify") return;

      for (const msg of upsert.messages) {
        if (!this.shouldProcessMessage(msg)) continue;

        const remoteJid = msg.key.remoteJid || "";
        if (this.isGroupOrBroadcast(remoteJid)) continue;

        const photoUrl = await this.whatsapp.profilePictureUrl(msg.key.remoteJid, "image").catch(() => "");

        const contactData: ContactDto = {
          name: msg.pushName || "Unknown_Contact",
          number: msg.key.remoteJid.split("@")[0],
          contactId: msg.key.remoteJid,
          photo: photoUrl || "",
        };

        const messageId = await this.whatsapp.requestPlaceholderResend(msg.key);

        // Processa áudio/voz
        if (msg.message?.audioMessage) {
          await this.handleAudioMessage(msg, contactData, messageId);
          continue;
        }

        // Processa texto
        if (msg.message?.conversation || msg.message?.extendedTextMessage?.text) {
          await this.handleTextMessage(msg, contactData, messageId);
        }
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      console.error(`WTS_SERVICE: Error in send message to webhook in session ${this.data.token}`, errorMessage);
      Sentry.captureException(err);
    }
  }

  private shouldProcessMessage(msg: any): boolean {
    if (msg.key.fromMe || !msg.key.remoteJid || !msg.message) {
      console.log(
        `WTS_SERVICE: Ignoring message (from self, missing remoteJid, or missing content)... | Session: ${this.data.token}`
      );
      return false;
    }
    return true;
  }

  private isGroupOrBroadcast(remoteJid: string): boolean {
    if (remoteJid.endsWith("@g.us") || remoteJid.endsWith("@broadcast") || remoteJid === "status@broadcast") {
      console.log(
        `WTS_SERVICE: Mensagem recebida não é de contato individual, ignorando... | Session: ${this.data.token}`
      );
      return true;
    }
    return false;
  }

  private async handleAudioMessage(msg: any, contactData: ContactDto, messageId: any) {
    const audioMessage = msg.message.audioMessage;

    if (audioMessage.mimetype === "audio/ogg; codecs=opus") {
      const media = await downloadMediaMessage(msg, "buffer", {});

      console.log(`WTS_SERVICE: Send voice message to webhook for ${this.data.token}`);

      await this.rabbitPublisher.send("wtsapi:send_message_to_webhook", {
        type: "voice",
        token: this.data.token.trim(),
        messageData: {
          contact: contactData,
          message: {
            id: messageId,
            body: media.toString("base64"),
            type: "voice",
            mymetype: msg.message.audioMessage.mimetype,
            timestamp: msg.messageTimestamp,
          },
        },
      });
    }
  }

  private async handleTextMessage(msg: any, contactData: ContactDto, messageId: any) {
    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;

    console.log(`WTS_SERVICE: Send message to webhook: ${this.data.webhook} |> ${this.data.token}`);

    await this.rabbitPublisher.send("wtsapi:send_message_to_webhook", {
      type: "chat",
      token: this.data.token.trim(),
      messageData: {
        contact: contactData,
        message: {
          id: messageId,
          body: text,
          type: "chat",
          timestamp: msg.messageTimestamp,
        },
      },
    });
  }
}
