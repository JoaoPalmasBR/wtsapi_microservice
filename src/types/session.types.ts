import { AnyMessageContent } from "baileys";
import { Socket as SocketIOSocket } from "socket.io-client";

export interface SessionExternalProps {
  name: string;
  token: string;
  webhook: string;
  clientId: string;
}

export interface SessionManagerEventData {
  event: string;
  data: object;
}

export interface NotificationMetadata {
  type: string;
  title: string;
  description: string;
}

export interface SocketEmitData {
  clientId: string;
  data: {
    type: string;
    metadata: {
      notify?: NotificationMetadata;
      qrCode?: string;
    };
  };
}

export interface MessageSendResult {
  success: boolean;
  error?: string;
}

export interface WhatsAppSession {
  sendMessage(jid: string, content: AnyMessageContent): Promise<void>;
  sendPresenceUpdate(type: string, id: string): Promise<void>;
  presenceSubscribe(jid: string): Promise<void>;
  profilePictureUrl(jid: string, type?: "image" | "preview"): Promise<string | undefined>;
  requestPlaceholderResend(key: any): Promise<any>;
  logout(): Promise<void>;
  ev: any;
}

export interface RabbitMQService {
  publishSessionStarted(token: string): Promise<void>;
  publishSessionAuthFailure(token: string): Promise<void>;
  publishSessionDisconnected(token: string): Promise<void>;
  publishDisableAllSessions(): Promise<void>;
  publishMessageToWebhook(data: any): Promise<void>;
}

export interface SocketService {
  emit(event: string, data: SocketEmitData): void;
  on(event: string, callback: Function): void;
  readonly id: string;
}

export interface LoggerService {
  info(message: string, data?: any): void;
  error(message: string, error?: Error | string): void;
  warn(message: string, data?: any): void;
  debug(message: string, data?: any): void;
}
