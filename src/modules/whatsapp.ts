import Sentry from "@sentry/node";

import { Socket } from "socket.io-client";
import { io as WebSocket } from "socket.io-client";
import { Connection, ConsumerProps, Publisher } from "rabbitmq-client";

import pino from "pino";

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

const rabbitConfig: ConsumerProps = {
  queue: "wtsapi:session.start",
  queueOptions: { durable: true },
  qos: { prefetchCount: 2 },
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
      console.log("WTS_SERVICE: WhatsApp Worker connection successfully (re)established");
    });

    this.rabbitPublisher = this.rabbit.createPublisher({
      queues: [
        { queue: "wtsapi.events" },
        { queue: "wtsapi:session_started", durable: true },
        { queue: "wtsapi:session_auth_failure", durable: true },
        { queue: "wtsapi:session_disconnected", durable: true },
        { queue: "wtsapi:disable_all_sessions", durable: true },
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
      console.log("WTS_SERVICE: WhatsApp provider Socket connected:", this.socket.id);
    });

    this.rabbit.on("error", (err) => {
      console.log("WTS_SERVICE: RabbitMQ connection error", err);
    });

    this.onInit();
  }

  private async onInit() {
    const sub = this.rabbit.createConsumer(rabbitConfig, async (msg) => {
      const data = JSON.parse(msg.body.toString()) as SessionExternalProps;

      this.onSessionStart(data);
    });

    await this.rabbitPublisher.send("wtsapi:disable_all_sessions", {});

    sub.on("error", (err) => {
      console.log("WTS_SERVICE: consumer error (user-events)", err);
    });

    console.log("WTS_SERVICE: WhatsApp Worker Session running...");
  }

  private async onSessionStart(data: SessionExternalProps) {
    try {
      let countRetryConnect = 0;
      let sessionWebhookEnabled: boolean = false;
      console.log("WTS_SERVICE: Starting session:", data.token);

      const logger = pino(
        { timestamp: () => `,"time":"${new Date().toJSON()}"` },
        pino.destination(`./logs/wts/${data.token}-wa-logs.txt`)
      );
      logger.level = "error";

      if (countRetryConnect > 5) {
        console.log(`WTS_SERVICE: Max retry connection reached for session ${data.token}`);
        return;
      }

      const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${data.token}`);

      const whatsapp = makeWASocket({ auth: state, logger: logger });

      whatsapp.ev.on("creds.update", saveCreds);

      const sendMessageWTyping = async (jid: string, msg: AnyMessageContent) => {
        await whatsapp.presenceSubscribe(jid);
        await delay(500);

        await whatsapp.sendPresenceUpdate("composing", jid);
        await delay(2000);

        await whatsapp.sendPresenceUpdate("paused", jid);

        await whatsapp.sendMessage(jid, msg);
      };

      whatsapp.ev.process(async (events) => {
        console.log(
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
              console.log(`WTS_SERVICE: Session ${data.token} is now open`);

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
                    const message: SendMessageDto = JSON.parse(msg.body.toString());

                    if (message.to instanceof Array) {
                      console.log(`WTS_SERVICE: Sending message to multiple recipients in session ${data.token}`);
                      for (const recipient of message.to) {
                        console.log(`WTS_SERVICE: Sending message to ${recipient} in session ${data.token}`);

                        await sendMessageWTyping(`${recipient}@c.us`, {
                          text: message.body,
                        });
                      }
                    } else {
                      await sendMessageWTyping(`${message.to}@c.us`, {
                        text: message.body,
                      });
                    }
                  } catch (err) {
                    const errorMessage = err instanceof Error ? err.message : "Unknown error";

                    console.log(`WTS_SERVICE: Error sending message in session ${data.token}`, errorMessage);
                  }
                }
              );

              subMessage.on("error", (err) => {
                console.log("WTS_SERVICE: Consumer rabbit error (send-message)", err);
              });

              break;
            }
            case "close": {
              if (status !== DisconnectReason.loggedOut) {
                countRetryConnect += 1;

                console.log(`WTS_SERVICE: Reconnecting session ${data.token} | Attempt: ${countRetryConnect}`);
                this.onSessionStart(data);
              }
              break;
            }
            default: {
              console.log(`WTS_SERVICE: Connection update | Session: ${data.token}`);
              break;
            }
          }

          if (qr) {
            console.log(`WTS_SERVICE: QR Code generated for ${data.token} - ${new Date().toLocaleTimeString()}`);

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
                console.log(
                  `WTS_SERVICE: New message received from ${msg.key.remoteJid} at ${time} | Session: ${data.token} `
                );

                if (msg.key.fromMe || !msg.key.remoteJid || !msg.message) {
                  console.log(
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
                  console.log(
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

                    console.log(`WTS_SERVICE: Send voice message to webhook for ${data.token}`);

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

                if (msg.message?.extendedTextMessage?.text) {
                  const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;

                  console.log(`WTS_SERVICE: Send message to webhook: ${data.webhook} |> ${data.token}`);

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

            console.error(`WTS_SERVICE: Error in send message to webhook in session ${data.token}`, errorMessage);
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
                console.log(`WTS_SERVICE: Disconnecting session: ${data.token}`);

                await whatsapp.logout();

                console.log(`WTS_SERVICE: Session destroyed: ${data.token}`);

                await this.rabbitPublisher.send("wtsapi:session_disconnected", {
                  token: data.token,
                });
              } catch (err) {
                const errorMessage = err instanceof Error ? err.message : "Unknown error";

                console.log(`WTS_SERVICE: Error disconnecting session ${data.token}`, errorMessage);
              }

              break;
            }
            case "send_typing_event": {
              // not used method typing, method is deprectated
              break;
            }
            case "update_webhook_state": {
              try {
                console.log(
                  `WTS_SERVICE: Webhook state updated to ${!sessionWebhookEnabled} for session ${data.token}`
                );


                this.socket.emit("INTERNAL:notification-web", {
                  clientId: data.clientId,
                  data: {
                    type: "notification_web",
                    metadata: {
                      notify: {
                        type: sessionWebhookEnabled ? "warning" : "success",
                        title: "WhatsApp Session",
                        description: `Webhook ${sessionWebhookEnabled ? "desativado" : "ativado"} com sucesso!`,
                      },
                    },
                  },
                });

                sessionWebhookEnabled = !sessionWebhookEnabled;
              } catch (err) {
                const errorMessage = err instanceof Error ? err.message : "Unknown error";

                console.log(`WTS_SERVICE: Error updating webhook state in session ${data.token}`, errorMessage);
              }
              break;
            }
            default:
              console.log(`WTS_SERVICE: Session manager event not found`);
          }
        }
      );

      sessionManager.on("error", (err) => {
        console.log("WTS_SERVICE: consumer error (session-manager)", err);
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";

      console.log(`WTS_SERVICE: Error starting session ${data.token}`, errorMessage);

      Sentry.captureException(err);

      await this.rabbitPublisher.send("wtsapi:session_auth_failure", {
        token: data.token,
      });

      return;
    }
  }
}

new WtsAPISessionManager();
