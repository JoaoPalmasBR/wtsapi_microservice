import { downloadMediaMessage } from "baileys";
import { ContactDto } from "../dtos/contact";
import { MESSAGE_TYPES, WHATSAPP_JID } from "../config/constants";
import { WhatsAppSession } from "../types/session.types";
import { RabbitMQService } from "../services/rabbitmq.service";
import { logger } from "../services/logger.service";

/**
 * Handler para processar mensagens recebidas do WhatsApp
 */
export class MessageReceiverHandler {
  constructor(
    private readonly whatsapp: WhatsAppSession,
    private readonly rabbitMQService: RabbitMQService,
    private readonly sessionToken: string
  ) {}

  /**
   * Processa mensagens recebidas
   */
  async processIncomingMessages(messages: any[]): Promise<void> {
    for (const msg of messages) {
      if (this.shouldIgnoreMessage(msg)) {
        logger.info(
          `Ignoring message (from self, missing remoteJid, or missing content)... | Session: ${this.sessionToken}`
        );
        continue;
      }

      if (this.isGroupOrBroadcastMessage(msg.key.remoteJid)) {
        logger.info(
          `Message is not from individual contact, ignoring... | Session: ${this.sessionToken}`
        );
        continue;
      }

      await this.handleMessage(msg);
    }
  }

  /**
   * Processa mensagem individual
   */
  private async handleMessage(msg: any): Promise<void> {
    try {
      const contactData = await this.extractContactData(msg);
      const messageId = await this.whatsapp.requestPlaceholderResend(msg.key);

      // Processa mensagem de áudio/voz
      if (msg.message?.audioMessage) {
        await this.handleAudioMessage(msg, contactData, messageId);
        return;
      }

      // Processa mensagem de texto
      if (msg.message?.conversation || msg.message?.extendedTextMessage?.text) {
        await this.handleTextMessage(msg, contactData, messageId);
        return;
      }
    } catch (err) {
      logger.error(`Error processing message in session ${this.sessionToken}`, err);
    }
  }

  /**
   * Processa mensagem de áudio
   */
  private async handleAudioMessage(
    msg: any,
    contactData: ContactDto,
    messageId: any
  ): Promise<void> {
    const audioMessage = msg.message.audioMessage;

    if (audioMessage.mimetype === "audio/ogg; codecs=opus") {
      const media = await downloadMediaMessage(msg, "buffer", {});

      logger.info(`Send voice message to webhook for ${this.sessionToken}`);

      await this.rabbitMQService.publishMessageToWebhook({
        type: MESSAGE_TYPES.VOICE,
        token: this.sessionToken.trim(),
        messageData: {
          contact: contactData,
          message: {
            id: messageId,
            body: media.toString("base64"),
            type: MESSAGE_TYPES.VOICE,
            mymetype: audioMessage.mimetype,
            timestamp: msg.messageTimestamp,
          },
        },
      });
    }
  }

  /**
   * Processa mensagem de texto
   */
  private async handleTextMessage(
    msg: any,
    contactData: ContactDto,
    messageId: any
  ): Promise<void> {
    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;

    logger.info(`Send message to webhook |> ${this.sessionToken}`);

    await this.rabbitMQService.publishMessageToWebhook({
      type: MESSAGE_TYPES.CHAT,
      token: this.sessionToken.trim(),
      messageData: {
        contact: contactData,
        message: {
          id: messageId,
          body: text,
          type: MESSAGE_TYPES.CHAT,
          timestamp: msg.messageTimestamp,
        },
      },
    });
  }

  /**
   * Extrai dados do contato
   */
  private async extractContactData(msg: any): Promise<ContactDto> {
    const photoUrl = await this.whatsapp.profilePictureUrl(msg.key.remoteJid, "image");

    return {
      name: msg.pushName || "Unknown_Contact",
      number: msg.key.remoteJid.split("@")[0],
      contactId: msg.key.remoteJid,
      photo: photoUrl || "",
    };
  }

  /**
   * Verifica se a mensagem deve ser ignorada
   */
  private shouldIgnoreMessage(msg: any): boolean {
    return msg.key.fromMe || !msg.key.remoteJid || !msg.message;
  }

  /**
   * Verifica se é mensagem de grupo ou broadcast
   */
  private isGroupOrBroadcastMessage(remoteJid: string): boolean {
    return (
      remoteJid.endsWith(WHATSAPP_JID.GROUP_SUFFIX) ||
      remoteJid.endsWith(WHATSAPP_JID.BROADCAST_SUFFIX) ||
      remoteJid === WHATSAPP_JID.STATUS_BROADCAST
    );
  }
}
