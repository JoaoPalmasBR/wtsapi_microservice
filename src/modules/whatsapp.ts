import { Socket } from "socket.io-client";
import { io as WebSocket } from "socket.io-client";

import { Connection, ConsumerProps, Publisher } from "rabbitmq-client";
import { LocalAuth, Client as WhatsApp } from "whatsapp-web.js";

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
  client_id: string;
}

interface WtsAPISession extends WhatsApp, SessionExternalProps {}

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
        clientId: data.client_id,
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
          const message = JSON.parse(msg.body.toString());

          await whatsapp.sendMessage(`${message.to}@c.us`, message.body);
        }
      );

      subMessage.on("error", (err) => {
        console.log("WTS_SERVICE: consumer error (send-message)", err);
      });

      console.log("WTS_SERVICE: Message consumer started:", data.token);
    });

    whatsapp.on("authenticated", async (_session) => {
      console.log("WTS_SERVICE: Session authenticated:", data.token);

      const _newSession: WtsAPISession = Object.assign(whatsapp, {
        name: data.name,
        token: data.token,
        webhook: data.webhook,
        client_id: data.client_id,
      });

      this.socket.emit("INTERNAL:notification-web", {
        clientId: data.client_id,
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

    await whatsapp.initialize();

    console.log("WTS_SERVICE: Session initialized:", data.token);
  }
}

new WtsAPISessionManager();
