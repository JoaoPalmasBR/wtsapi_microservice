import Sentry from "@sentry/node";

import Connection, { ConsumerProps } from "rabbitmq-client";

import { resend } from "../libs/resend";
// import { emailTransporter } from "../libs/nodemailer";

import { emailCredentials } from "../emails-templates/email-credentials";
import { loginWithEmailTemplate } from "../emails-templates/login-with-email";
import { templateConfirmationAccount } from "../emails-templates/confirmation-account";

import { LoginUrlEmailProps, CredentialsEmailProps, ConfirmationAccountEmailProps } from "../dtos/emails";

const rabbitConfig: ConsumerProps = {
  qos: { prefetchCount: 5 },
  noAck: false,
  queue: "wtsapi:email-queues",
  queueOptions: { durable: true },
  exchanges: [
    {
      exchange: "email-events",
      type: "topic",
      durable: false,
    },
  ],
  queueBindings: [
    { exchange: "email-events", routingKey: "email.confirmation" },
    { exchange: "email-events", routingKey: "email.login-url" },
    { exchange: "email-events", routingKey: "email.credentials" },
    { exchange: "email-events", routingKey: "email.*" },
  ],
  requeue: true,
  arguments: { "x-max-priority": 10, "x-message-ttl": 30000, "x-dead-letter-exchange": "events.main" },
};

class EmailsProcessor {
  private rabbit: Connection;

  constructor() {
    this.rabbit = new Connection(process.env.RABBITMQ_HOST ?? "amqp://guest:guest@localhost:5672");

    this.rabbit.on("error", (err) => {
      console.info("WTSAPI: RabbitMQ connection error", err);
    });

    this.rabbit.on("connection", () => {
      console.info("WTSAPI: Emails Worker connection successfully (re)established");
    });

    this.onInit();
  }

  private async onInit() {
    const sub = this.rabbit.createConsumer(rabbitConfig, async (msg) => {
      switch (msg.routingKey) {
        case "email.confirmation": {
          const data: ConfirmationAccountEmailProps = JSON.parse(msg.body.toString());

          if (!data.to || !data.verificationCode) {
            console.info("WTSAPI: Email confirmation data is invalid");
            return;
          }

          console.info(`WTSAPI: Sending email confirmation to ${data.to}`);

          const { error } = await resend.emails.send({
            from: process.env.RESEND_EMAIL_FROM!,
            to: data.to,
            subject: "Blibsend - Confirmação de conta",
            html: templateConfirmationAccount(data.to, data.verificationCode),
          });

          if (error) {
            console.info("WTSAPI: Error sending email via Resend", error.message);
            Sentry.captureException(error);
          } else {
            console.info(`WTSAPI: Email confirmation sent to ${data.to} via Resend`);
          }

          break;
        }
        case "email.login-url": {
          const dataLoginUrl: LoginUrlEmailProps = JSON.parse(msg.body.toString());

          if (!dataLoginUrl.to || !dataLoginUrl.url) {
            console.info("WTSAPI: Email login url data is invalid");
            return;
          }

          console.info(`WTSAPI: Sending email login url to ${dataLoginUrl.to}`);

          const { error } = await resend.emails.send({
            from: process.env.RESEND_EMAIL_FROM!,
            to: dataLoginUrl.to,
            subject: "Blibsend - Link de acesso",
            html: loginWithEmailTemplate(dataLoginUrl.code, dataLoginUrl.url, dataLoginUrl.to),
          });

          if (error) {
            console.info("WTSAPI: Error sending email via Resend", error.message);
            Sentry.captureException(error);
          } else {
            console.info(`WTSAPI: Email login url sent to ${dataLoginUrl.to} via Resend`);
          }

          break;
        }
        case "email.credentials": {
          const dataCredentials: CredentialsEmailProps = JSON.parse(msg.body.toString());

          if (!dataCredentials.to || !dataCredentials.clientId) {
            console.info("WTSAPI: Email credentials data is invalid");
            return;
          }
          console.info(`WTSAPI: Sending email credentials to ${dataCredentials.to}`);

          const { error } = await resend.emails.send({
            from: process.env.RESEND_EMAIL_FROM!,
            to: dataCredentials.to,
            subject: "Blibsend - Credenciais de acesso",
            html: emailCredentials(dataCredentials.name, dataCredentials.clientId, dataCredentials.clientSecret),
          });

          if (error) {
            console.info("WTSAPI: Error sending email via Resend", error.message);
            Sentry.captureException(error);
          } else {
            console.info(`WTSAPI: Email credentials sent to ${dataCredentials.to} via Resend`);
          }

          break;
        }
        default:
          console.info("WTSAPI: Received unknown email type");
          break;
      }
    });

    sub.on("error", (err) => {
      console.info("WTSAPI: consumer error (emails-events)", err);

      Sentry.captureException(err);
    });

    console.info("WTSAPI: Emails queues processor is working...");
  }
}

new EmailsProcessor();
