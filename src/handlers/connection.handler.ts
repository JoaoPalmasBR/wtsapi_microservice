import { Boom } from "@hapi/boom";
import { DisconnectReason } from "baileys";
import Sentry from "@sentry/node";
import { SessionExternalProps } from "../types/session.types";
import { RabbitMQService } from "../services/rabbitmq.service";
import { SocketService } from "../services/socket.service";
import { NOTIFICATION_TYPES } from "../config/constants";
import { logger } from "../services/logger.service";

/**
 * Handler para eventos de conexão do WhatsApp
 */
export class ConnectionHandler {
  constructor(
    private readonly rabbitMQService: RabbitMQService,
    private readonly socketService: SocketService,
    private readonly sessionData: SessionExternalProps,
    private readonly onReconnect: () => void
  ) {}

  /**
   * Lida com conexão aberta (sucesso)
   */
  async handleConnectionOpen(countRetryConnect: { value: number }): Promise<void> {
    countRetryConnect.value = 0;
    logger.info(`WhatsApp connected successfully | Session: ${this.sessionData.token}`);

    this.emitSessionNotification(
      NOTIFICATION_TYPES.SUCCESS,
      "WhatsApp Session",
      "WhatsApp session started successfully!"
    );

    await this.rabbitMQService.publishSessionStarted(this.sessionData.token);
  }

  /**
   * Lida com conexão fechada
   */
  handleConnectionClose(
    status: number | undefined,
    countRetryConnect: { value: number },
    maxRetries: number
  ): void {
    if (countRetryConnect.value >= maxRetries) {
      logger.error(`Max retry connection reached for session ${this.sessionData.token}`, {});
      return;
    }

    const reconnectionMap: Record<number, string> = {
      [DisconnectReason.badSession]: "Bad session file, please delete session and scan again",
      [DisconnectReason.connectionClosed]: "Connection closed, reconnecting...",
      [DisconnectReason.connectionLost]: "Connection lost from WhatsApp, reconnecting...",
      [DisconnectReason.connectionReplaced]: "Connection replaced by another session, logging out...",
      [DisconnectReason.loggedOut]: "Device logged out, please scan again",
      [DisconnectReason.restartRequired]: "Restart required, restarting...",
      [DisconnectReason.multideviceMismatch]: "Connection timeout, reconnecting...",
    };

    const shouldReconnect = this.shouldAttemptReconnection(status);
    const message = reconnectionMap[status!] || `Unknown disconnect reason: ${status}, reconnecting...`;

    logger.info(`${message} | Session: ${this.sessionData.token}`);

    if (shouldReconnect) {
      countRetryConnect.value += 1;
      this.onReconnect();
    }
  }

  /**
   * Lida com QR Code gerado
   */
  handleQRCode(qrCode: string): void {
    logger.info(`QR Code generated for ${this.sessionData.token} - ${new Date().toLocaleTimeString()}`);

    this.socketService.emitSessionUpdate({
      clientId: this.sessionData.clientId,
      data: {
        type: "qr_code",
        metadata: { qrCode },
      },
    });
  }

  /**
   * Emite notificação de sessão
   */
  private emitSessionNotification(type: string, title: string, description: string): void {
    const notificationData = {
      clientId: this.sessionData.clientId,
      data: {
        type: "session_updated",
        metadata: {
          notify: { type, title, description },
        },
      },
    };

    this.socketService.emitSessionUpdate(notificationData);
    this.socketService.emitNotificationWeb({
      ...notificationData,
      data: { ...notificationData.data, type: "notification_web" },
    });
  }

  /**
   * Verifica se deve tentar reconexão baseado no status
   */
  private shouldAttemptReconnection(status: number | undefined): boolean {
    if (!status) return true;

    const reconnectableStatuses = [
      DisconnectReason.badSession,
      DisconnectReason.connectionClosed,
      DisconnectReason.connectionLost,
      DisconnectReason.restartRequired,
      DisconnectReason.multideviceMismatch,
    ];

    return reconnectableStatuses.includes(status) || status === undefined;
  }
}
