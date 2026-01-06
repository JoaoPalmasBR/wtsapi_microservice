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
  data: {
    type: "notification_web";
    metadata: {
      notify: {
        type: "info" | "success" | "warning" | "error";
        title: string;
        description: string;
      };
    };
  };
}

new (class NotificationService {
  private rabbit: Connection;

  private socket: Socket = WebSocket(`ws://localhost:${Number(process.env.WEBSOCKET_PORT || "3007")}`, {
    transports: ["websocket"],
  });

  constructor() {
    this.rabbit = new Connection(process.env.RABBITMQ_HOST ?? "amqp://guest:guest@localhost:5672");

    this.rabbit.on("connection", () => {
      console.info("WTS_SERVICE: WhatsApp Worker connection successfully (re)established");
    });

    this.rabbit.on("error", (err) => {
      console.error("WTS_SERVICE: RabbitMQ connection error", err);
      Sentry.captureException(err);
    });

    this.onInit();
  }

  async onInit() {
    const sub = this.rabbit.createConsumer(rabbitConfig, async (msg) => {
      const data: NotificationMsgProps = JSON.parse(msg.body.toString());

      this.socket.on("connect", () => {
        console.info("WTS_SERVICE: Notification provider Socket connected:", this.socket.id);
      });

      this.socket.emit("INTERNAL:notification-web", {
        clientId: data.clientId,
        data: {
          type: data.data.type,
          metadata: {
            notify: {
              type: data.data.metadata.notify.type,
              title: data.data.metadata.notify.title,
              description: data.data.metadata.notify.description,
              duration: 5000,
            },
          },
        },
      });
    });

    sub.on("error", (err) => {
      console.info("WTS_SERVICE: consumer error (notification-events)", err);

      Sentry.captureException(err);
    });

    console.info("WTS_SERVICE: Notification Worker running...");
  }
})();
