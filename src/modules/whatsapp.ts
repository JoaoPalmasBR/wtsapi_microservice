import axios from "axios";
import qrcode from "qrcode-terminal";
import { Socket } from "socket.io-client";
import { io as WebSocket } from "socket.io-client";

import { Connection, ConsumerProps } from "rabbitmq-client";
import { LocalAuth, Client as WhatsApp } from "whatsapp-web.js";

const rabbitConfig: ConsumerProps = {
  queue: "wtsapi:session.start",
  queueOptions: { durable: true },
  qos: { prefetchCount: 2 },
  // exchanges: [{ exchange: "my-events", type: "topic" }],
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
  private sessions: WtsAPISession[] = [];
  private socket: Socket = WebSocket("ws://localhost:3007", {
    transports: ["websocket"],
  });

  constructor() {
    this.rabbit = new Connection(
      process.env.RABBITMQ_HOST ?? "amqp://guest:guest@localhost:5672"
    );

    this.rabbit.on("connection", () => {
      console.log(
        "WTSAPI: WhatsApp Worker connection successfully (re)established"
      );
    });

    this.socket.on("connect", () => {
      console.log(
        "WTSAPI: WhatsApp provider Socket connected:",
        this.socket.id
      );
    });

    this.rabbit.on("error", (err) => {
      console.log("WTSAPI: RabbitMQ connection error", err);
    });

    this.onInit();
  }

  private async onInit() {
    const sub = this.rabbit.createConsumer(rabbitConfig, async (msg) => {
      const data = JSON.parse(msg.body.toString()) as SessionExternalProps;

      this.onSessionStart(data);
    });

    sub.on("error", (err) => {
      console.log("WTSAPI: consumer error (user-events)", err);
    });

    console.log("WTSAPI: WhatsApp Worker Session running...");
  }

  private async onSessionStart(data: SessionExternalProps) {
    console.log("WTSAPI: Starting session:", data.token);

    const whatsapp = new WhatsApp({
      authStrategy: new LocalAuth({ clientId: data.token }),
      qrMaxRetries: 4,
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
      // qrcode.generate(qr, { small: true });

      console.log(
        `WTSAPI: QR Code generated for ${
          data.token
        } - ${new Date().toLocaleTimeString()}`
      );

      this.socket.emit("INTERNAL:qr_code", {
        clientId: data.client_id,
        data: {
          qr: qr,
        },
      });
    });

    whatsapp.on("ready", async () => {
      console.log("WTSAPI: Session ready:", data.token);

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
        console.log("WTSAPI: consumer error (send-message)", err);
      });

      console.log("WTSAPI: Message consumer started:", data.token);
    });

    whatsapp.on("authenticated", async (session) => {
      console.log("WTSAPI: Session authenticated:", data.token);

      const _newSession: WtsAPISession = Object.assign(whatsapp, {
        name: data.name,
        token: data.token,
        webhook: data.webhook,
        client_id: data.client_id,
      });

      this.sessions.push(_newSession);

      // await axios.post(data.webhook, {
      //   status: "authenticated",
      //   token: data.token,
      // });
    });

    whatsapp.on("auth_failure", async (msg) => {
      console.log("WTSAPI: Auth failure:", msg);

      // await axios.post(data.webhook, {
      //   status: "auth_failure",
      //   token: data.token,
      // });
    });

    whatsapp.on("disconnected", async (reason) => {
      console.log("WTSAPI: Session disconnected:", reason);

      // await axios.post(data.webhook, {
      //   status: "disconnected",
      //   token: data.token,
      // });

      const index = this.sessions.findIndex((s) => s.token === data.token);
      if (index !== -1) {
        this.sessions.splice(index, 1);
      }
    });

    await whatsapp.initialize();

    console.log("WTSAPI: Session initialized:", data.token);
  }
}

new WtsAPISessionManager();
