import path from "path";
import fs from "fs/promises";
import Sentry from "@sentry/node";
import { AnyMessageContent, delay } from "baileys";
import { SendMessageDto } from "../dtos/whatsapp";
import { APP_CONFIG, MESSAGE_TYPES, WHATSAPP_JID } from "../config/constants";
import { WhatsAppSession } from "../types/session.types";
import { logger } from "../services/logger.service";

/**
 * Handler para envio de mensagens do WhatsApp
 */
export class MessageSenderHandler {
  constructor(
    private readonly whatsapp: WhatsAppSession,
    private readonly sessionToken: string
  ) {}

  /**
   * Envia mensagem com simulação de digitação
   */
  async sendMessageWithTyping(jid: string, content: AnyMessageContent): Promise<void> {
    try {
      await this.whatsapp.presenceSubscribe(jid);
      await delay(APP_CONFIG.TYPING_DELAY);

      await this.whatsapp.sendPresenceUpdate("composing", jid);
      await delay(APP_CONFIG.COMPOSING_DELAY);

      await this.whatsapp.sendMessage(jid, content);

      await this.whatsapp.sendPresenceUpdate("paused", jid);
    } catch (err) {
      logger.error(`Error sending typing message in session ${this.sessionToken}`, err);
      Sentry.captureException(err);
      throw err;
    }
  }

  /**
   * Envia mensagem de imagem
   */
  async sendImageMessage(jid: string, message: SendMessageDto): Promise<void> {
    try {
      const imageBuffer = this.decodeBase64Image(message.body);
      const extension = this.extractImageExtension(message.body);
      const tempFilePath = await this.saveTemporaryImage(imageBuffer, extension);

      await this.whatsapp.sendMessage(jid, {
        image: { url: tempFilePath },
        caption: message.title || "",
      });

      await this.cleanupTemporaryFile(tempFilePath);
    } catch (err) {
      logger.error(`Error sending image message in session ${this.sessionToken}`, err);
      Sentry.captureException(err);
      throw err;
    }
  }

  /**
   * Processa e envia mensagens baseado no tipo
   */
  async processAndSendMessage(message: SendMessageDto): Promise<void> {
    const recipients = Array.isArray(message.to) ? message.to : [message.to];

    for (const recipient of recipients) {
      const jid = WHATSAPP_JID.CONTACT(recipient);

      switch (message.type) {
        case MESSAGE_TYPES.IMAGE:
          logger.info(`Sending image message to ${recipient} in session ${this.sessionToken}`);
          await this.sendImageMessage(jid, message);
          break;

        case MESSAGE_TYPES.TEXT:
        default:
          logger.info(`Sending message to ${recipient} in session ${this.sessionToken}`);
          await this.sendMessageWithTyping(jid, { text: message.body });
          break;
      }
    }
  }

  /**
   * Decodifica imagem base64
   */
  private decodeBase64Image(base64String: string): Buffer {
    const base64Data = base64String.replace(/^data:image\/\w+;base64,/, "");
    return Buffer.from(base64Data, "base64");
  }

  /**
   * Extrai extensão da imagem do base64
   */
  private extractImageExtension(base64String: string): string {
    const matches = base64String.match(/^data:image\/(\w+);base64,/);
    return matches?.[1] || "jpg";
  }

  /**
   * Salva imagem temporária
   */
  private async saveTemporaryImage(imageBuffer: Buffer, extension: string): Promise<string> {
    const tempDir = path.join(process.cwd(), "temp");
    await fs.mkdir(tempDir, { recursive: true });

    const fileName = `${Date.now()}_${this.sessionToken}.${extension}`;
    const tempPath = path.join(tempDir, fileName);

    await fs.writeFile(tempPath, imageBuffer);
    return tempPath;
  }

  /**
   * Remove arquivo temporário
   */
  private async cleanupTemporaryFile(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch (err) {
      logger.warn(`Failed to cleanup temporary file: ${filePath}`, err);
    }
  }
}
