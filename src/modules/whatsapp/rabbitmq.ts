import { ConsumerProps } from "rabbitmq-client";

export const rabbitConfig: ConsumerProps = {
  queue: "wtsapi:session.start",
  queueOptions: { durable: true },
  qos: { prefetchCount: 5 },
  requeue: true,
  arguments: { "x-max-priority": 10, "x-cancel-on-ha-failover": true },
};
