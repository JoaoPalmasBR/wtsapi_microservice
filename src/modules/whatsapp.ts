import axios from "axios";
import { Socket } from "socket.io-client";
import { io as WebSocket } from "socket.io-client";
import { Connection, ConsumerProps, Publisher } from "rabbitmq-client";

import fs from "fs";
import p from "child_process";
import open from "open";
import pino from "pino";

import { Boom } from "@hapi/boom";
import Readline from "readline";
import NodeCache from "@cacheable/node-cache";

import makeWASocket, {
  delay,
  Browsers,
  DisconnectReason,
  AnyMessageContent,
  downloadMediaMessage,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from "baileys";

import { SendMessageDto } from "../dtos/whatsapp";
import { DESTRUCTION } from "dns";
import { ContactDto } from "../dtos/contact";
import { send } from "process";

const rabbitConfig: ConsumerProps = {
  queue: "wtsapi:session.start",
  queueOptions: { durable: true },
  qos: { prefetchCount: 2 },
  // exchanges: [{ exchange: "emails-events", type: "topic" }],
  // queueBindings: [{ exchange: "my-events", routingKey: "users.*" }],
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
  private socket: Socket = WebSocket(
    `ws://localhost:${Number(process.env.WEBSOCKET_PORT || "3007")}`,
    { transports: ["websocket"] }
  );

  constructor() {
    this.rabbit = new Connection(
      process.env.RABBITMQ_HOST ?? "amqp://guest:guest@localhost:5672"
    );

    this.rabbit.on("connection", () => {
      console.log(
        "WTS_SERVICE: WhatsApp Worker connection successfully (re)established"
      );
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
      console.log(
        "WTS_SERVICE: WhatsApp provider Socket connected:",
        this.socket.id
      );
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
      let sessionWebhookEnabled: boolean = false;
      console.log("WTS_SERVICE: Starting session:", data.token);

      const logger = pino(
        { timestamp: () => `,"time":"${new Date().toJSON()}"` },
        pino.destination(`./${data.token}-wa-logs.txt`)
      );
      logger.level = "error";

      const msgRetryCounterCache = new NodeCache({
        // stdTTL: 0, // No expiration
        // checkperiod: 0, // No periodic checks
      });

      const rl = Readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const { state, saveCreds } = await useMultiFileAuthState(
        `./.sessions/${data.token}`
      );
      const { version, isLatest } = await fetchLatestBaileysVersion();

      console.log(
        `WTS_SERVICE: Using WA version ${version.join(
          "."
        )} | Latest: ${isLatest}`
      );

      const whatsapp = makeWASocket({
        logger,
        browser: Browsers.appropriate("Desktop"),
        auth: state,
        msgRetryCounterCache,
        generateHighQualityLinkPreview: true,
        // getMessage: async (key: WAMessageKey) => {
        //   console.log("get message", key);
        //   return proto.Message.fromObject({});
        // },
      });

      const sendMessageWTyping = async (
        jid: string,
        msg: AnyMessageContent
      ) => {
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
          const { connection, lastDisconnect, qr } =
            events["connection.update"];

          switch (connection) {
            case "open": {
              console.log(`WTS_SERVICE: Session ${data.token} is now open`);

              this.socket.emit("INTERNAL:notification-web", {
                clientId: data.clientId,
                data: {
                  type: "sucess",
                  title: "WhatsApp Session",
                  description: "Sessão do whatsapp iniciada com sucesso!",
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
                    const message: SendMessageDto = JSON.parse(
                      msg.body.toString()
                    );

                    if (message.to instanceof Array) {
                      console.log(
                        `WTS_SERVICE: Sending message to multiple recipients in session ${data.token}`
                      );
                      for (const recipient of message.to) {
                        console.log(
                          `WTS_SERVICE: Sending message to ${recipient} in session ${data.token}`
                        );

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
                    const errorMessage =
                      err instanceof Error ? err.message : "Unknown error";

                    console.log(
                      `WTS_SERVICE: Error sending message in session ${data.token}`,
                      errorMessage
                    );
                  }
                }
              );

              subMessage.on("error", (err) => {
                console.log(
                  "WTS_SERVICE: Consumer rabbit error (send-message)",
                  err
                );
              });

              break;
            }
            case "close": {
              const status = (lastDisconnect?.error as Boom)?.output
                ?.statusCode;

              console.log(
                `WTS_SERVICE: Session ${data.token} closed with status: ${status}`
              );

              if (status === DisconnectReason.badSession) {
              } else if (status === DisconnectReason.connectionClosed) {
                console.log(
                  `WTS_SERVICE: Bad session file, please delete session: ${data.token}`
                );
                this.onSessionStart(data);
              } else if (status === DisconnectReason.connectionLost) {
                console.log(
                  `WTS_SERVICE: Connection lost, restarting session: ${data.token}`
                );
                this.onSessionStart(data);
              } else if (status === DisconnectReason.connectionReplaced) {
                console.log(
                  `WTS_SERVICE: Connection replaced, another session opened using the same session: ${data.token}`
                );

                this.socket.emit("INTERNAL:notification-web", {
                  clientId: data.clientId,
                  data: {
                    type: "destructive",
                    title: "WhatsApp Session",
                    description:
                      "Sessão desconectada porque foi aberta em outro dispositivo!",
                  },
                });

                await this.rabbitPublisher.send("wtsapi:session_disconnected", {
                  token: data.token,
                });
              } else if (status === DisconnectReason.loggedOut) {
                await new Promise((resolve, reject) => {
                  p.exec(
                    `rm -rf ./.sessions/${data.token}`,
                    (error, stdout, stderr) => {
                      if (error) {
                        console.error(
                          `WTS_SERVICE: Error deleting session: ${error}`
                        );

                        reject(error);
                        return;
                      }
                      if (stderr) {
                        console.error(`WTS_SERVICE: Error: ${stderr}`);
                        reject(new Error(stderr));
                        return;
                      }
                      console.log(`WTS_SERVICE: Session deleted`);
                      resolve(stdout);
                    }
                  );
                });

                console.log(
                  `WTS_SERVICE: Device logged out, session invalid: ${data.token}`
                );

                await this.rabbitPublisher.send("wtsapi:session_disconnected", {
                  token: data.token,
                });
              } else if (status === DisconnectReason.restartRequired) {
                console.log(
                  `WTS_SERVICE: Restart required, restarting session: ${data.token}`
                );
                this.onSessionStart(data);
              } else if (status === DisconnectReason.timedOut) {
                console.log(
                  `WTS_SERVICE: Connection timed out, restarting session: ${data.token}`
                );
                this.onSessionStart(data);
              } else {
                console.log(
                  `WTS_SERVICE: Unknown disconnect reason: ${status} | ${lastDisconnect?.error} - Restarting session: ${data.token}`
                );
              }
              break;
            }
            default: {
              console.log(
                `WTS_SERVICE: Connection update | Session: ${data.token}`
              );
              break;
            }
          }

          if (qr) {
            console.log(
              `WTS_SERVICE: QR Code generated for ${
                data.token
              } - ${new Date().toLocaleTimeString()}`
            );

            this.socket.emit("INTERNAL:qr_code", {
              clientId: data.clientId,
              data: { qr: qr },
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

                const photoUrl = await whatsapp.profilePictureUrl(
                  msg.key.remoteJid,
                  "image"
                );

                const contactData: ContactDto = {
                  name: msg.pushName || "Unknown_Contact",
                  number: msg.key.remoteJid.split("@")[0],
                  contactId: msg.key.remoteJid,
                  photo: photoUrl || "",
                };

                const messageId = await whatsapp.requestPlaceholderResend(
                  msg.key
                );

                if (sessionWebhookEnabled) {
                  if (msg.message?.audioMessage) {
                    // Handle audio message
                    const audioMessage = msg.message.audioMessage;

                    if (audioMessage.mimetype === "audio/ogg; codecs=opus") {
                      const media = await downloadMediaMessage(
                        msg,
                        "buffer",
                        {}
                      );

                      console.log(
                        `WTS_SERVICE: Send voice message to webhook for ${data.token}`
                      );

                      let countTry: number = 0;

                      while (countTry < 5) {
                        try {
                          countTry++;
                          console.log(
                            `WTS_SERVICE: Attempt ${countTry} to send webhook`
                          );

                          await axios.post(
                            data.webhook,
                            {
                              wts_session_token: data.token.trim(),
                              contact: contactData,
                              message: {
                                id: messageId,
                                body: media.toString("base64"),
                                type: "voice",
                                mymetype: msg.message.audioMessage.mimetype,
                                timestamp: msg.messageTimestamp,
                              },
                            },
                            {
                              headers: {
                                "Content-Type": "application/json",
                                "User-Agent": "WTSAPI-Webhook-Client",
                              },
                              timeout: 5000, // Timeout after 5 seconds
                            }
                          );
                          console.log(`WTS_SERVICE: Webhook sent successfully`);
                          break; // Exit loop if successful
                        } catch (error) {
                          const errorMessage =
                            error instanceof Error
                              ? error.message
                              : "Unknown error";

                          console.error(
                            `WTS_SERVICE: Error sending webhook: ${errorMessage}`
                          );

                          if (countTry >= 5) {
                            console.error(
                              `WTS_SERVICE: Failed to send webhook after 5 attempts`
                            );
                            break; // Exit loop
                          }

                          console.log(`WTS_SERVICE: Retrying in 2 seconds...`);
                          await new Promise((resolve) =>
                            setTimeout(resolve, 4000)
                          ); // Wait 4 seconds before retrying
                        }
                      }
                    }

                    continue;
                  }

                  if (msg.message?.extendedTextMessage?.text) {
                    const text =
                      msg.message?.conversation ||
                      msg.message?.extendedTextMessage?.text;

                    console.log(
                      `WTS_SERVICE: Send message to webhook: ${data.webhook} |> ${data.token}`
                    );
                    
                    let countTry: number = 0;
                    // Retry logic in case of failure
                    while (countTry < 5) {
                      try {
                        countTry++;
                        console.log(
                          `WTS_SERVICE: Attempt ${countTry} to send webhook`
                        );

                        await axios.post(
                          data.webhook,
                          {
                            wts_session_token: data.token.trim(),
                            contact: contactData,
                            message: {
                              id: messageId,
                              body: text,
                              type: "chat",
                              timestamp: msg.messageTimestamp,
                            },
                          },
                          {
                            headers: {
                              "Content-Type": "application/json",
                              "User-Agent": "WTSAPI-Webhook-Client",
                            },
                            timeout: 5000, // Timeout after 5 seconds
                          }
                        );
                        console.log(`WTS_SERVICE: Webhook sent successfully`);
                        break; // Exit loop if successful
                      } catch (error) {
                        const errorMessage =
                          error instanceof Error
                            ? error.message
                            : "Unknown error";

                        console.error(
                          `WTS_SERVICE: Error sending webhook: ${errorMessage}`
                        );

                        if (countTry >= 5) {
                          console.error(
                            `WTS_SERVICE: Failed to send webhook after 5 attempts`
                          );
                          break; // Exit loop
                        }

                        console.log(`WTS_SERVICE: Retrying in 2 seconds...`);
                        await new Promise((resolve) =>
                          setTimeout(resolve, 4000)
                        ); // Wait 4 seconds before retrying
                      }
                    }
                  }
                }

                continue;
              }
            }
          } catch (err) {
            const errorMessage =
              err instanceof Error ? err.message : "Unknown error";

            console.error(
              `WTS_SERVICE: Error in send message to webhook in session ${data.token}`,
              errorMessage
            );
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
                console.log(
                  `WTS_SERVICE: Disconnecting session: ${data.token}`
                );

                await whatsapp.logout();

                console.log(`WTS_SERVICE: Session destroyed: ${data.token}`);

                await this.rabbitPublisher.send("wtsapi:session_disconnected", {
                  token: data.token,
                });
              } catch (err) {
                const errorMessage =
                  err instanceof Error ? err.message : "Unknown error";

                console.log(
                  `WTS_SERVICE: Error disconnecting session ${data.token}`,
                  errorMessage
                );
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
                  `WTS_SERVICE: Webhook state updated to ${!sessionWebhookEnabled} for session ${
                    data.token
                  }`
                );

                this.socket.emit("INTERNAL:notification-web", {
                  clientId: data.clientId,
                  data: {
                    type: "default",
                    title: "WhatsApp Session",
                    description: `Webhook atualizado de ${sessionWebhookEnabled} para ${!sessionWebhookEnabled}!`,
                  },
                });

                sessionWebhookEnabled = !sessionWebhookEnabled;
              } catch (err) {
                const errorMessage =
                  err instanceof Error ? err.message : "Unknown error";

                console.log(
                  `WTS_SERVICE: Error updating webhook state in session ${data.token}`,
                  errorMessage
                );
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

      whatsapp.ev.on("creds.update", saveCreds);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";

      console.log(
        `WTS_SERVICE: Error starting session ${data.token}`,
        errorMessage
      );

      await this.rabbitPublisher.send("wtsapi:session_auth_failure", {
        token: data.token,
      });

      return;
    }
  }
}

new WtsAPISessionManager();
