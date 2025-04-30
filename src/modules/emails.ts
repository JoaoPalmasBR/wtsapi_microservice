import Connection, { ConsumerProps } from "rabbitmq-client";

import { emailTransporter } from "../libs/nodemailer";

import { emailCredentials } from "../emails-templates/email-credentials";
import { loginWithEmailTemplate } from "../emails-templates/login-with-email";
import { templateConfirmationAccount } from "../emails-templates/confirmation-account";

import {
  LoginUrlEmailProps,
  CredentialsEmailProps,
  ConfirmationAccountEmailProps,
} from "../dtos/emails";

const rabbitConfig: ConsumerProps = {
  queue: "wtsapi:email-queues",
  queueOptions: { durable: true },
  qos: { prefetchCount: 5 },
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
};

class EmailsProcessor {
  private rabbit: Connection;

  constructor() {
    this.rabbit = new Connection(
      process.env.RABBITMQ_HOST ?? "amqp://guest:guest@localhost:5672"
    );

    this.rabbit.on("error", (err) => {
      console.log("WTSAPI: RabbitMQ connection error", err);
    });

    this.rabbit.on("connection", () => {
      console.log(
        "WTSAPI: Emails Worker connection successfully (re)established"
      );
    });

    this.onInit();
  }

  private async onInit() {
    const sub = this.rabbit.createConsumer(rabbitConfig, async (msg) => {
      switch (msg.routingKey) {
        case "email.confirmation":
          const data: ConfirmationAccountEmailProps = JSON.parse(
            msg.body.toString()
          );

          if (!data.to || !data.verification_code) {
            console.log("WTSAPI: Email confirmation data is invalid");
            return;
          }

          console.log(`WTSAPI: Sending email confirmation to ${data.to}`);

          await emailTransporter
            .sendMail({
              to: data.to,
              subject: "Rocketsend - Confirmação de conta",
              from: `Cube <${process.env.EMAIL_HOST_USER}>`,
              html: templateConfirmationAccount(
                data.to,
                data.verification_code
              ),
            })
            .catch((err) => {
              console.log("WTSAPI: Error sending email", err.message);
            });
          break;
        case "email.login-url":
          const dataLoginUrl: LoginUrlEmailProps = JSON.parse(
            msg.body.toString()
          );

          if (!dataLoginUrl.to || !dataLoginUrl.url) {
            console.log("WTSAPI: Email login url data is invalid");
            return;
          }

          console.log(`WTSAPI: Sending email login url to ${dataLoginUrl.to}`);

          await emailTransporter
            .sendMail({
              to: dataLoginUrl.to,
              subject: "Rocketsend - Link de acesso",
              from: `Cube <${process.env.EMAIL_HOST_USER}>`,
              html: loginWithEmailTemplate(dataLoginUrl.url, dataLoginUrl.to),
            })
            .catch((err) => {
              console.log("WTSAPI: Error sending email", err.message);
            });
          break;
        case "email.credentials":
          const dataCredentials: CredentialsEmailProps = JSON.parse(
            msg.body.toString()
          );

          if (!dataCredentials.to || !dataCredentials.client_id) {
            console.log("WTSAPI: Email credentials data is invalid");
            return;
          }
          console.log(
            `WTSAPI: Sending email credentials to ${dataCredentials.to}`
          );

          await emailTransporter
            .sendMail({
              to: dataCredentials.to,
              subject: "Rocketsend - Credenciais de acesso",
              from: `Cube <${process.env.EMAIL_HOST_USER}>`,
              html: emailCredentials(
                dataCredentials.name,
                dataCredentials.client_id,
                dataCredentials.client_secret
              ),
            })
            .catch((err) => {
              console.log("WTSAPI: Error sending email", err.message);
            });
          break;
        default:
          console.log("WTSAPI: Received unknown email type");
          break;
      }
    });

    sub.on("error", (err) => {
      console.log("WTSAPI: consumer error (emails-events)", err);
    });

    console.log("WTSAPI: Emails queues processor is working...");
  }
}

new EmailsProcessor();
