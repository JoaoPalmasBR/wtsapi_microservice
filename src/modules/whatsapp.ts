import { Socket } from "socket.io-client";
import { io as WebSocket } from "socket.io-client";

import { Connection, ConsumerProps, Publisher } from "rabbitmq-client";
import { LocalAuth, Client as WhatsApp } from "whatsapp-web.js";
import axios from "axios";

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
    console.log("WTS_SERVICE: Starting session:", data.token);

    const whatsapp = new WhatsApp({
      authStrategy: new LocalAuth({ clientId: data.token }),
      qrMaxRetries: 5,
      puppeteer: {
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--disable-gpu",
        ],
      },
    });

    whatsapp.on("qr", (qr) => {
      console.log(
        `WTS_SERVICE: QR Code generated for ${
          data.token
        } - ${new Date().toLocaleTimeString()}`
      );

      this.socket.emit("INTERNAL:qr_code", {
        clientId: data.clientId,
        data: { qr: qr },
      });
    });

    whatsapp.on("ready", async () => {
      console.log("WTS_SERVICE: Session ready:", data.token);

      const subMessage = this.rabbit.createConsumer(
        {
          queue: `wtsapi:${data.token}:send.message`,
          queueOptions: { durable: true },
          qos: { prefetchCount: 2 },
        },
        async (msg) => {
          try {
            const message = JSON.parse(msg.body.toString());

            await whatsapp.sendMessage(`${message.to}@c.us`, message.body);
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
        console.log("WTS_SERVICE: Consumer rabbit error (send-message)", err);
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

                this.socket.emit("INTERNAL:notification-web", {
                  clientId: data.clientId,
                  data: {
                    type: "destructive",
                    title: "WhatsApp Session",
                    description: "Sessão do whatsapp está sendo encerrada!",
                  },
                });

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
              try {
                const { to } = dataEvent.data as { to: string };

                console.log(
                  `WTS_SERVICE: Typing event sent to ${to} in session ${data.token}`
                );

                const chat = await whatsapp.getChatById(`${to}@c.us`);

                await chat.sendStateTyping();

                setTimeout(async () => {
                  await chat.clearState();
                }, 8000);
              } catch (err) {
                const errorMessage =
                  err instanceof Error ? err.message : "Unknown error";

                console.log(
                  `WTS_SERVICE: Error sending typing event in session ${data.token}`,
                  errorMessage
                );
              }
            }
            default:
              console.log(`WTS_SERVICE: Session manager event not found`);
          }
        }
      );

      sessionManager.on("error", (err) => {
        console.log("WTS_SERVICE: consumer error (session-manager)", err);
      });

      console.log("WTS_SERVICE: Message consumer started:", data.token);
    });

    whatsapp.on("message", async (message) => {
      console.log(
        `WTS_SERVICE: New message received from ${
          message.from
        } at ${new Date().toLocaleTimeString()} | Session: ${data.token}`
      );

      if (!message.isStatus && !message.fromMe) {
        const contact = await message.getContact();

        const contactData = {
          name: contact.pushname || "Unknown_Contact",
          number: contact.number,
          contactId: contact.id._serialized,
          photo: await contact.getProfilePicUrl(),
        };

        if (message.hasMedia) {
          // Handle message voice audio.
          const base64Media = await message.downloadMedia();

          if (base64Media.mimetype === "audio/ogg; codecs=opus") {
            console.log(
              `WTS_SERVICE: Send voice message to webhook for ${data.token}`
            );

            let countTry: number = 0;

            while (countTry < 5) {
              try {
                countTry++;
                console.log(`WTS_SERVICE: Attempt ${countTry} to send webhook`);

                await axios.post(
                  data.webhook,
                  {
                    wts_session_token: data.token,
                    contact: contactData,
                    message: {
                      id: message.id._serialized,
                      body: base64Media.data,
                      type: "voice",
                      mymetype: base64Media.mimetype,
                      timestamp: message.timestamp,
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
                  error instanceof Error ? error.message : "Unknown error";

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
                await new Promise((resolve) => setTimeout(resolve, 4000)); // Wait 4 seconds before retrying
              }
            }
          }
        } else if (message.type === "chat") {
          try {
            console.log(
              `WTS_SERVICE: Send message to webhook: ${data.webhook} |> ${data.token}`
            );
            let countTry: number = 0;
            // Retry logic in case of failure
            while (countTry < 5) {
              try {
                countTry++;
                console.log(`WTS_SERVICE: Attempt ${countTry} to send webhook`);

                await axios.post(
                  data.webhook,
                  {
                    wts_session_token: data.token,
                    contact: contactData,
                    message: {
                      id: message.id._serialized,
                      body: message.body,
                      type: message.type,
                      timestamp: message.timestamp,
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
                  error instanceof Error ? error.message : "Unknown error";

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
                await new Promise((resolve) => setTimeout(resolve, 4000)); // Wait 4 seconds before retrying
              }
            }
          } catch (err) {
            console.log(`WTS_SERVICE: Error in sent message to webhook`);
          }
        }
      }
    });

    whatsapp.on("authenticated", async (_session) => {
      console.log("WTS_SERVICE: Session authenticated:", data.token);

      this.socket.emit("INTERNAL:notification-web", {
        clientId: data.clientId,
        data: {
          type: "sucess",
          title: "WhatsApp Session",
          description: "Session started successfully",
        },
      });

      await this.rabbitPublisher.send("wtsapi:session_started", {
        token: data.token,
      });
    });

    whatsapp.on("auth_failure", async (msg) => {
      console.log("WTS_SERVICE: Auth failure:", msg);

      await this.rabbitPublisher.send("wtsapi:session_auth_failure", {
        token: data.token,
      });
    });

    whatsapp.on("disconnected", async (reason) => {
      console.log("WTS_SERVICE: Session disconnected:", reason);

      await this.rabbitPublisher.send("wtsapi:session_disconnected", {
        token: data.token,
      });
    });

    whatsapp.initialize();

    console.log("WTS_SERVICE: Session initialized:", data.token);
  }
}

new WtsAPISessionManager();
