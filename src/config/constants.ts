/**
 * Constantes da aplicação
 */
export const APP_CONFIG = {
  SERVICE_NAME: "WTS_SERVICE",
  DEFAULT_WEBSOCKET_PORT: 3007,
  DEFAULT_BROWSER: ["Windows", "Chrome", "10.0"] as [string, string, string],
  MAX_RETRY_CONNECTIONS: 5,
  TYPING_DELAY: 500,
  COMPOSING_DELAY: 4000,
} as const;

export const QUEUE_KEYS = {
  EVENTS: "wtsapi.events",
  SESSION: (token: string) => `wtsapi.${token}`,
  SESSION_START: "wtsapi.session.start.main",
  SESSION_QRCODE: "BlibsendBackend.Queues.Sessions.QueueQrCodeReceived",
  SESSION_STARTED: "BlibsendBackend.Queues.Sessions.QueueStatusConnected",
  SEND_NOTIFICATION: "wtsapi.send.notification",
  SESSION_AUTH_FAILURE: "wtsapi.session.auth_failure",
  SESSION_DISCONNECTED: "BlibsendBackend.Queues.Sessions.QueueStatusDisconnected",
  DISABLE_ALL_SESSIONS: "BlibsendBackend.Queues.Sessions.QueueDisableAllSessions",
  SEND_MESSAGE_TO_WEBHOOK: "BlibsendBackend.Queues.Sessions.QueueSendMessageToWebhook",
  SEND_MESSAGE: (token: string) => `wtsapi.${token}.send.message`,
  SESSION_MANAGER: (token: string) => `wtsapi.${token}.session.manager`,
} as const;

export const WHATSAPP_JID = {
  CONTACT: (number: string) => `${number}@c.us`,
  GROUP_SUFFIX: "@g.us",
  BROADCAST_SUFFIX: "@broadcast",
  STATUS_BROADCAST: "status@broadcast",
} as const;

export const MESSAGE_TYPES = {
  IMAGE: "image",
  TEXT: "text",
  VOICE: "voice",
  CHAT: "chat",
} as const;

export const SESSION_EVENTS = {
  DISCONNECT_SESSION: "disconnect_session",
  SEND_TYPING_EVENT: "send_typing_event",
} as const;

export const PATHS = {
  SESSIONS: "sessions",
  TEMP: "temp",
  LOGS: "logs",
} as const;
