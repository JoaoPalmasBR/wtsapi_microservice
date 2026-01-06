import { Socket } from "socket.io-client";
import { io as WebSocket } from "socket.io-client";
import { SOCKET_EVENTS } from "../config/constants";
import { SocketEmitData } from "../types/session.types";
import { logger } from "./logger.service";

/**
 * Serviço para gerenciar comunicação via Socket.IO
 */
export class SocketService {
  private socket: Socket;

  constructor(port: number) {
    this.socket = WebSocket(`ws://localhost:${port}`, {
      transports: ["websocket"],
    });

    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    this.socket.on("connect", () => {
      logger.info(`WhatsApp provider Socket connected: ${this.socket.id}`);
    });

    this.socket.on("disconnect", () => {
      logger.warn("Socket disconnected");
    });

    this.socket.on("error", (error) => {
      logger.error("Socket error", error);
    });
  }

  emitSessionUpdate(data: SocketEmitData): void {
    this.socket.emit(SOCKET_EVENTS.INTERNAL_SESSION_SOCKET, data);
  }

  emitNotificationWeb(data: SocketEmitData): void {
    this.socket.emit(SOCKET_EVENTS.INTERNAL_NOTIFICATION_WEB, data);
  }

  on(event: string, callback: (...args: any[]) => void): void {
    this.socket.on(event, callback);
  }

  get id(): string | undefined {
    return this.socket.id;
  }

  getSocket(): Socket {
    return this.socket;
  }
}
