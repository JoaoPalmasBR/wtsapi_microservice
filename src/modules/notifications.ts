import Sentry from "@sentry/node";

import { Socket } from "socket.io-client";
import { io as WebSocket } from "socket.io-client";
import { ConsumerProps, Connection } from "rabbitmq-client";

const rabbitConfig: ConsumerProps = {
  queue: "wtsapi:notifications-web",
  queueOptions: { durable: true },
  qos: { prefetchCount: 2 },
};

interface NotificationMsgProps {
  clientId: string;
  type: "destructive" | "default";
  title: string;
  description: string;
  duration: number;
}

new (class NotificationService {
  private rabbit: Connection;

  private socket: Socket = WebSocket(`ws://localhost:${Number(process.env.WEBSOCKET_PORT || "3007")}`, {
    transports: ["websocket"],
  });

  constructor() {
    this.rabbit = new Connection(process.env.RABBITMQ_HOST ?? "amqp://guest:guest@localhost:5672");

    this.rabbit.on("connection", () => {
      console.log("WTS_SERVICE: WhatsApp Worker connection successfully (re)established");
    });

    this.rabbit.on("error", (err) => {
      console.log("WTS_SERVICE: RabbitMQ connection error", err);

      Sentry.captureException(err);
    });

    this.onInit();
  }

  async onInit() {
    const sub = this.rabbit.createConsumer(rabbitConfig, async (msg) => {
      const data: NotificationMsgProps = JSON.parse(msg.body.toString());

      this.socket.on("connect", () => {
        console.log("WTS_SERVICE: Notification provider Socket connected:", this.socket.id);
      });

      this.socket.emit("INTERNAL:notification-web", {
        clientId: data.clientId,
        msg: {
          type: data.type,
          title: data.title,
          description: data.description,
          duration: data.duration,
        },
      });
    });

    sub.on("error", (err) => {
      console.log("WTS_SERVICE: consumer error (notification-events)", err);

      Sentry.captureException(err);
    });

    console.log("WTS_SERVICE: Notification Worker running...");
  }
})();
