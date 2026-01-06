import { ConsumerProps } from "rabbitmq-client";
import { RABBITMQ_QUEUES } from "./constants";

export const rabbitConsumerConfig: ConsumerProps = {
  queue: RABBITMQ_QUEUES.SESSION_START,
  queueOptions: { durable: true },
  qos: { prefetchCount: 5 },
  requeue: true,
  arguments: { 
    "x-max-priority": 10, 
    "x-cancel-on-ha-failover": true 
  },
};

export const rabbitPublisherQueues = [
  { queue: RABBITMQ_QUEUES.EVENTS },
  { queue: RABBITMQ_QUEUES.SESSION_STARTED, durable: true },
  { queue: RABBITMQ_QUEUES.SESSION_AUTH_FAILURE, durable: true },
  { queue: RABBITMQ_QUEUES.SESSION_DISCONNECTED, durable: true },
  { queue: RABBITMQ_QUEUES.DISABLE_ALL_SESSIONS, durable: true },
  { queue: RABBITMQ_QUEUES.SEND_MESSAGE_TO_WEBHOOK, durable: true },
];

export const rabbitPublisherExchanges = [
  {
    exchange: "wtsapi-events",
    type: "topic" as const,
    durable: false,
  },
];

export const rabbitQueueBindings = [
  { 
    exchange: "wtsapi-events", 
    routingKey: "wtsapi.*" 
  },
];
