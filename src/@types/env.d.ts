export {};

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      WEBSOCKET_PORT?: number;
      RABBITMQ_HOST: string;
    }
  }
}
