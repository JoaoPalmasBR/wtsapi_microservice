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

export const REDIS_KEYS = {
  SESSION: (token: string) => `wtsapi:${token}`,
} as const;

export const RABBITMQ_QUEUES = {
  SESSION_START: "wtsapi:session.start",
  EVENTS: "wtsapi.events",
  SESSION_STARTED: "wtsapi:session_started",
  SESSION_AUTH_FAILURE: "wtsapi:session_auth_failure",
  SESSION_DISCONNECTED: "wtsapi:session_disconnected",
  DISABLE_ALL_SESSIONS: "wtsapi:disable_all_sessions",
  SEND_MESSAGE_TO_WEBHOOK: "wtsapi:send_message_to_webhook",
  SEND_MESSAGE: (token: string) => `wtsapi:${token}:send.message`,
  SESSION_MANAGER: (token: string) => `wtsapi:${token}:session.manager`,
} as const;

export const RABBITMQ_EXCHANGES = {
  EVENTS: "wtsapi-events",
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

export const SOCKET_EVENTS = {
  INTERNAL_SESSION_SOCKET: "INTERNAL:session:socket",
  INTERNAL_NOTIFICATION_WEB: "INTERNAL:notification-web",
} as const;

export const NOTIFICATION_TYPES = {
  SUCCESS: "success",
  WARNING: "warning",
  ERROR: "error",
  INFO: "info",
} as const;

export const PATHS = {
  SESSIONS: "sessions",
  TEMP: "temp",
  LOGS: "logs",
} as const;
