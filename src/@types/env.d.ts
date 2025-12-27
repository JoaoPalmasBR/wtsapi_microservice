export {};

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      WEBSOCKET_PORT: number;
      RABBITMQ_HOST: string;
      EMAIL_HOST: string;
      EMAIL_PORT: number;
      EMAIL_USER: string;
      EMAIL_PASS: string;
      RESEND_API_KEY: string;
      RESEND_EMAIL_FROM: string;
    }
  }
}
