import fs from "fs/promises";
import path from "path";
import Sentry from "@sentry/node";

import { Socket } from "socket.io-client";
import { io as WebSocket } from "socket.io-client";
import { Connection, ConsumerProps, Publisher } from "rabbitmq-client";

import { Boom } from "@hapi/boom";

import makeWASocket, {
  delay,
  DisconnectReason,
  AnyMessageContent,
  downloadMediaMessage,
  useMultiFileAuthState,
} from "baileys";

import { SendMessageDto } from "../dtos/whatsapp";
import { ContactDto } from "../dtos/contact";
import logger, { logError, logInfo } from "../libs/logger";
import redisClient from "../libs/redis";

const rabbitConfig: ConsumerProps = {
  queue: "wtsapi:session.start",
  queueOptions: { durable: true },
  qos: { prefetchCount: 5 },
  requeue: true,
  arguments: { "x-max-priority": 10 },
};

interface SessionExternalProps {
  name: string;
  token: string;
  webhook: string;
  clientId: string;
}

class WtsAPISessionManager {
  private rabbit: Connection;
  private rabbitPublisher: Publisher;
  private socket: Socket = WebSocket(`ws://localhost:${Number(process.env.WEBSOCKET_PORT || "3007")}`, {
    transports: ["websocket"],
  });

  constructor() {
    this.rabbit = new Connection(process.env.RABBITMQ_HOST ?? "amqp://guest:guest@localhost:5672");

    this.rabbit.on("connection", () => {
      logInfo("WTS_SERVICE: WhatsApp Worker connection successfully (re)established");
    });

    this.rabbitPublisher = this.rabbit.createPublisher({
      queues: [
        { queue: "wtsapi.events" },
        { queue: "wtsapi:session_started", durable: true },
        { queue: "wtsapi:session_auth_failure", durable: true },
        { queue: "wtsapi:session_disconnected", durable: true },
        { queue: "wtsapi:disable_all_sessions", durable: true },
        { queue: "wtsapi:send_message_to_webhook", durable: true },
      ],
      confirm: true,
      maxAttempts: 2,
      exchanges: [
        {
          exchange: "wtsapi-events",
          type: "topic",
          durable: false,
        },
      ],
      queueBindings: [{ exchange: "wtsapi-events", routingKey: "wtsapi.*" }],
    });

    this.socket.on("connect", () => {
      logInfo("WTS_SERVICE: WhatsApp provider Socket connected:", this.socket.id);
    });

    this.rabbit.on("error", (err) => {
      logError("WTS_SERVICE: RabbitMQ connection error", err);
    });

    this.onInit();
    this.startAllSessionRegistered();
  }

  private async onInit() {
    const sub = this.rabbit.createConsumer(rabbitConfig, async (msg) => {
      const data = JSON.parse(msg.body.toString()) as SessionExternalProps;

      logInfo(`WTS_SERVICE: Received session start request for token: ${data.token}`);

      this.onSessionStart(data);
    });

    await this.rabbitPublisher.send("wtsapi:disable_all_sessions", {});

    sub.on("error", (err) => {
      logError("WTS_SERVICE: consumer error (user-events)", err);
    });

    logInfo("WTS_SERVICE: WhatsApp Worker Session running...");
  }

  private async onSessionStart(data: SessionExternalProps) {
    try {
      await redisClient.set(`wtsapi:${data.token}`, JSON.stringify(data)).catch((err) => {
        Sentry.captureException(err);
        logError(`WTS_SERVICE: Error saving session data to Redis for ${data.token}`, err);
      });

      let countRetryConnect = 0;
      logInfo(`WTS_SERVICE: Starting WhatsApp session for token: ${data.token}`);

      logger.level = "error";

      if (countRetryConnect > 5) {
        logError(`WTS_SERVICE: Max retry connection reached for session ${data.token}`, {});
        return;
      }

      const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${data.token}`);

      const whatsapp = makeWASocket({ auth: state, logger: logger, browser: ["Windows", "Chrome", "10.0"] });

      const sendMessageWTyping = async (jid: string, msg: AnyMessageContent) => {
        try {
          await whatsapp.presenceSubscribe(jid);
          await delay(500);

          await whatsapp.sendPresenceUpdate("composing", jid);
          await delay(2000);

          await whatsapp.sendMessage(jid, msg);

          await whatsapp.sendPresenceUpdate("paused", jid);
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : "Unknown error";

          Sentry.captureException(err);

          logError(`WTS_SERVICE: Error sending typing message in session ${data.token}`, errorMessage);
        }
      };

      const sendMessageImage = async (jid: string, message: SendMessageDto) => {
        try {
          const base64Data = message.body.replace(/^data:image\/\w+;base64,/, "");
          const imageBuffer = Buffer.from(base64Data, "base64");

          const matches = message.body.match(/^data:image\/(\w+);base64,/);
          const extension = matches?.[1] || "jpg";

          const tempDir = path.join(process.cwd(), "temp");
          await fs.mkdir(tempDir, { recursive: true });

          const fileName = `${Date.now()}_${data.token}.${extension}`;
          const tempPath = path.join(tempDir, fileName);

          await fs.writeFile(tempPath, imageBuffer);

          await whatsapp.sendMessage(jid, {
            image: { url: tempPath },
            caption: message.title || "",
          });

          await fs.unlink(tempPath);
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : "Unknown error";

          Sentry.captureException(err);
          logError(`WTS_SERVICE: Error sending image message in session ${data.token}`, errorMessage);
        }
      };

      whatsapp.ev.process(async (events) => {
        logInfo(
          `Received events: ${Object.keys(events).join(", ")} | Session: ${
            data.token
          } | Time: ${new Date().toLocaleTimeString()}`
        );

        if (events["connection.update"]) {
          const { connection, lastDisconnect, qr } = events["connection.update"];

          const status = (lastDisconnect?.error as Boom)?.output?.statusCode;

          switch (connection) {
            case "open": {
              countRetryConnect = 0;
              logInfo(`WTS_SERVICE: WhatsApp connected successfully | Session: ${data.token}`);

              this.socket.emit("INTERNAL:session:socket", {
                clientId: data.clientId,
                data: {
                  type: "session_updated",
                  metadata: {
                    notify: {
                      type: "success",
                      title: "WhatsApp Session",
                      description: "Sessão do whatsapp iniciada com sucesso!",
                    },
                  },
                },
              });

              this.socket.emit("INTERNAL:notification-web", {
                clientId: data.clientId,
                data: {
                  type: "notification_web",
                  metadata: {
                    notify: {
                      type: "success",
                      title: "WhatsApp Session",
                      description: "Sessão do whatsapp iniciada com sucesso!",
                    },
                  },
                },
              });

              await this.rabbitPublisher.send("wtsapi:session_started", {
                token: data.token,
              });

              const subMessage = this.rabbit.createConsumer(
                {
                  queue: `wtsapi:${data.token}:send.message`,
                  queueOptions: { durable: true },
                  qos: { prefetchCount: 2 },
                },
                async (msg) => {
                  try {
                    if (!whatsapp.ws.isOpen) {
                      whatsapp.ws.connect();
                    }

                    const message: SendMessageDto = JSON.parse(msg.body.toString());

                    const recipients = Array.isArray(message.to) ? message.to : [message.to];

                    switch (message.type) {
                      case "image": {
                        logInfo(
                          `WTS_SERVICE: Sending image message to ${recipients.length} recipient(s) in session ${data.token}`
                        );

                        for (const recipient of recipients) {
                          const jid = `${recipient}@c.us`;

                          logInfo(`WTS_SERVICE: Sending image message to ${recipient} in session ${data.token}`);

                          await sendMessageImage(jid, message);
                        }
                        break;
                      }
                      case "text":
                      default: {
                        logInfo(
                          `WTS_SERVICE: Sending message to ${recipients.length} recipient(s) in session ${data.token}`
                        );

                        for (const recipient of recipients) {
                          const jid = `${recipient}@c.us`;

                          logInfo(`WTS_SERVICE: Sending message to ${recipient} in session ${data.token}`);

                          await sendMessageWTyping(jid, {
                            text: message.body,
                          });
                        }
                        break;
                      }
                    }
                  } catch (err) {
                    const errorMessage = err instanceof Error ? err.message : "Unknown error";

                    Sentry.captureException(err);

                    logError(`WTS_SERVICE: Error sending message in session ${data.token}`, errorMessage);
                  }
                }
              );

              subMessage.on("error", (err) => {
                logError("WTS_SERVICE: Consumer rabbit error (send-message)", err);
              });

              break;
            }
            case "close": {
              switch (status) {
                case DisconnectReason.badSession:
                  logInfo(
                    `WTS_SERVICE: Bad session file, please delete session and scan again | Session: ${data.token}`
                  );
                  countRetryConnect += 1;

                  this.onSessionStart(data);
                  break;
                case DisconnectReason.connectionClosed:
                  logInfo(`WTS_SERVICE: Connection closed, reconnecting... | Session: ${data.token}`);
                  countRetryConnect += 1;

                  this.onSessionStart(data);
                  break;
                case DisconnectReason.connectionLost:
                  logInfo(`WTS_SERVICE: Connection lost from WhatsApp, reconnecting... | Session: ${data.token}`);
                  countRetryConnect += 1;

                  this.onSessionStart(data);
                  break;
                case DisconnectReason.connectionReplaced:
                  logInfo(
                    `WTS_SERVICE: Connection replaced by another session, logging out... | Session: ${data.token}`
                  );
                  break;
                case DisconnectReason.loggedOut:
                  logInfo(`WTS_SERVICE: Device logged out, please scan again | Session: ${data.token}`);
                  break;
                case DisconnectReason.restartRequired:
                  logInfo(`WTS_SERVICE: Restart required, restarting... | Session: ${data.token}`);
                  countRetryConnect += 1;

                  this.onSessionStart(data);
                  break;
                case DisconnectReason.multideviceMismatch:
                  logInfo(`WTS_SERVICE: Connection timeout, reconnecting... | Session: ${data.token}`);
                  countRetryConnect += 1;

                  this.onSessionStart(data);
                  break;
                default:
                  logInfo(`WTS_SERVICE: Unknown disconnect reason: ${status}| Session: ${data.token}, reconnecting...`);
                  countRetryConnect += 1;

                  this.onSessionStart(data);
                  break;
              }

              break;
            }
            default: {
              logInfo(
                `WTS_SERVICE: Connection update | Session: ${data.token} | Status: ${connection} | Reason: ${status}`
              );
              break;
            }
          }

          if (qr) {
            logInfo(`WTS_SERVICE: QR Code generated for ${data.token} - ${new Date().toLocaleTimeString()}`);

            this.socket.emit("INTERNAL:session:socket", {
              clientId: data.clientId,
              data: { type: "qr_code", metadata: { qrCode: qr } },
            });
          }
        }

        if (events["messages.upsert"]) {
          try {
            const upsert = events["messages.upsert"];
            const time = new Date().toLocaleTimeString();

            if (upsert.type === "notify") {
              for (const msg of upsert.messages) {
                if (msg.key.fromMe || !msg.key.remoteJid || !msg.message) {
                  logInfo(
                    `WTS_SERVICE: Ignoring message (from self, missing remoteJid, or missing content)... | Session: ${data.token}`
                  );
                  continue;
                }

                // Verifica se a mensagem é de um contato individual
                const remoteJid = msg.key.remoteJid || "";
                if (
                  remoteJid.endsWith("@g.us") || // grupo
                  remoteJid.endsWith("@broadcast") || // status
                  remoteJid === "status@broadcast" // status
                ) {
                  logInfo(
                    `WTS_SERVICE: Mensagem recebida não é de contato individual, ignorando... | Session: ${data.token}`
                  );
                  continue;
                }

                const photoUrl = await whatsapp.profilePictureUrl(msg.key.remoteJid, "image");

                const contactData: ContactDto = {
                  name: msg.pushName || "Unknown_Contact",
                  number: msg.key.remoteJid.split("@")[0],
                  contactId: msg.key.remoteJid,
                  photo: photoUrl || "",
                };

                const messageId = await whatsapp.requestPlaceholderResend(msg.key);

                if (msg.message?.audioMessage) {
                  const audioMessage = msg.message.audioMessage;

                  if (audioMessage.mimetype === "audio/ogg; codecs=opus") {
                    const media = await downloadMediaMessage(msg, "buffer", {});

                    logInfo(`WTS_SERVICE: Send voice message to webhook for ${data.token}`);

                    await this.rabbitPublisher.send("wtsapi:send_message_to_webhook", {
                      type: "voice",
                      token: data.token.trim(),
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

                  continue;
                }

                if (msg.message?.conversation || msg.message?.extendedTextMessage?.text) {
                  const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;

                  logInfo(`WTS_SERVICE: Send message to webhook: ${data.webhook} |> ${data.token}`);

                  await this.rabbitPublisher.send("wtsapi:send_message_to_webhook", {
                    type: "chat",
                    token: data.token.trim(),
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

                continue;
              }
            }
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : "Unknown error";

            logError(`WTS_SERVICE: Error in send message to webhook in session ${data.token}`, errorMessage);
          }
        }
      });

      const sessionManager = this.rabbit.createConsumer(
        {
          queue: `wtsapi:${data.token}:session.manager`,
          queueOptions: { durable: true },
          qos: { prefetchCount: 2 },
        },
        async (msg) => {
          interface MsgProps {
            event: string;
            data: object;
          }

          const dataEvent: MsgProps = JSON.parse(msg.body.toString());

          switch (dataEvent.event) {
            case "disconnect_session": {
              try {
                logInfo(`WTS_SERVICE: Disconnecting session: ${data.token}`);

                await whatsapp.logout();

                logInfo(`WTS_SERVICE: Session destroyed: ${data.token}`);

                await this.rabbitPublisher.send("wtsapi:session_disconnected", {
                  token: data.token,
                });

                const sessionsDir = path.resolve(process.cwd(), "sessions");
                const sessionPath = path.join(sessionsDir, data.token);

                fs.rm(sessionPath, { recursive: true, force: true })
                  .then(() => {
                    logInfo(`WTS_SERVICE: Session files removed for ${data.token}`);
                  })
                  .catch((err) => {
                    Sentry.captureException(err);
                    logError(`WTS_SERVICE: Error removing session files for ${data.token}`, err);
                  });

                logInfo(`WTS_SERVICE: Removing session files for ${data.token}`);

                this.socket.emit("INTERNAL:notification-web", {
                  clientId: data.clientId,
                  data: {
                    type: "notification_web",
                    metadata: {
                      notify: {
                        type: "warning",
                        title: "WhatsApp Session",
                        description: "Sessão do whatsapp desconectada com sucesso!",
                      },
                    },
                  },
                });

                await whatsapp.logout();
              } catch (err) {
                const errorMessage = err instanceof Error ? err.message : "Unknown error";

                Sentry.captureException(err);

                logError(`WTS_SERVICE: Error disconnecting session ${data.token}`, errorMessage);
              }

              break;
            }
            case "send_typing_event": {
              // not used method typing, method is deprectated
              break;
            }
            default:
              logInfo(`WTS_SERVICE: Session manager event not found`);
          }
        }
      );

      sessionManager.on("error", (err) => {
        Sentry.captureException(err);
        logInfo("WTS_SERVICE: consumer error (session-manager)", err);
      });

      whatsapp.ev.on("creds.update", saveCreds);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";

      logError(`WTS_SERVICE: Error starting session ${data.token}`, errorMessage);

      Sentry.captureException(err);

      await this.rabbitPublisher.send("wtsapi:session_auth_failure", {
        token: data.token,
      });

      return;
    }
  }

  private async startAllSessionRegistered() {
    const pathSessions = path.join(process.cwd(), "sessions");

    try {
      const sessionTokenPathName = await fs.readdir(pathSessions);

      for (const token of sessionTokenPathName) {
        const sessionData = await redisClient.get(`wtsapi:${token}`);

        if (sessionData) {
          const sessionExternal: SessionExternalProps = JSON.parse(sessionData);

          logInfo(`WTS_SERVICE: Starting registered session for token: ${token}`);

          this.onSessionStart(sessionExternal);
        } else {
          logInfo(`WTS_SERVICE: No session data found in Redis for token: ${token}`);
        }
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";

      Sentry.captureException(err);

      logError("WTS_SERVICE: Error starting all registered sessions", errorMessage);
    }
  }
}

new WtsAPISessionManager();
