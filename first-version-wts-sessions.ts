import fs from "fs/promises";
import path from "path";
import Sentry from "@sentry/node";

import { Boom } from "@hapi/boom";

import makeWASocket, {
  delay,
  DisconnectReason,
  AnyMessageContent,
  downloadMediaMessage,
  useMultiFileAuthState,
} from "baileys";
import { PRODUCER_QUEUES_KEYS, QUEUE_KEYS } from "./config/constants";

import { SendMessageDto } from "./dtos/whatsapp";
import { ContactDto } from "./types/contact.types";
import { log } from "./services/logger.service";
import logger from "./libs/logger";
import { publishEvent } from "./libs/pq";
import { pgBoss } from "./libs/pg-boss";

interface JobData {
  id: string;
  data: string;
}

interface SessionExternalProps {
  name: string;
  token: string;
  webhook: string;
  clientId: string;
}

// const sessions: Map<string, typeof makeWASocket> = {};

new (class WtsMainService {
  constructor() {
    this.onInit();
    // this.startSessionsAlreadyRegistered();
  }

  private async onInit() {
    log.info("WTS_SERVICE: Initializing WTS Main Service...");

    await publishEvent("sessions", QUEUE_KEYS.DISABLE_ALL_SESSIONS, {});

    await pgBoss.work(QUEUE_KEYS.SESSION_START, async (job: JobData[]) => {
      if (!job) {
        log.warn("Received empty message in session start consumer, ignoring...");
        return;
      }
      const jobObjString = job[0];
      const jobObj: SessionExternalProps = JSON.parse(jobObjString.data);

      log.info(`WTS_SERVICE: Received session start request for token: ${jobObj.token}`);

      this.onSessionStart(jobObj);
    });
  }

  private async onSessionStart(data: SessionExternalProps) {
    try {
      let countRetryConnect = 0;
      log.info(`WTS_SERVICE: Starting WhatsApp session for token: ${data.token}`);

      logger.level = "silent";

      if (countRetryConnect > 5) {
        log.error(`WTS_SERVICE: Max retry connection reached for session ${data.token}`, {});
        return;
      }

      const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${data.token}`);

      const whatsapp = makeWASocket({ auth: state, logger: logger, browser: ["Windows", "Chrome", "10.0"] });

      const sendMessageWTyping = async (jid: string, msg: string) => {
        try {
          if (whatsapp.ws.isClosed) {
            whatsapp.ws.connect();

            await delay(2000);
          }

          await whatsapp.presenceSubscribe(jid);
          await delay(500);

          await whatsapp.sendPresenceUpdate("composing", jid);
          await delay(4000);

          await whatsapp.sendMessage(jid, { text: msg });

          await delay(1000);
          await whatsapp.sendPresenceUpdate("paused", jid);
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : "Unknown error";

          Sentry.captureException(err);

          log.error(`WTS_SERVICE: Error sending typing message in session ${data.token}`, errorMessage);
        }
      };

      const sendMessageImage = async (jid: string, message: SendMessageDto) => {
        try {
          if (whatsapp.ws.isClosed) {
            whatsapp.ws.connect();

            await delay(2000);
          }

          await whatsapp.presenceSubscribe(jid);
          await delay(3000);

          const base64Data = message.metadata.body.replace(/^data:image\/\w+;base64,/, "");
          const imageBuffer = Buffer.from(base64Data, "base64");

          const matches = message.metadata.body.match(/^data:image\/(\w+);base64,/);
          const extension = matches?.[1] || "jpg";

          const tempDir = path.join(process.cwd(), "temp");
          await fs.mkdir(tempDir, { recursive: true });

          const fileName = `${Date.now()}_${data.token}.${extension}`;
          const tempPath = path.join(tempDir, fileName);

          await fs.writeFile(tempPath, imageBuffer);

          await whatsapp.sendMessage(jid, {
            image: { url: tempPath },
            caption: message.metadata.title || "",
          });

          await fs.unlink(tempPath);
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : "Unknown error";

          Sentry.captureException(err);
          log.error(`WTS_SERVICE: Error sending image message in session ${data.token}`, errorMessage);
        }
      };

      whatsapp.ev.process(async (events) => {
        if (events["connection.update"]) {
          const { connection, lastDisconnect, qr } = events["connection.update"];

          const status = (lastDisconnect?.error as Boom)?.output?.statusCode;

          switch (connection) {
            case "open": {
              countRetryConnect = 0;
              log.info(`WTS_SERVICE: WhatsApp connected successfully | Session: ${data.token}`);

              await publishEvent("sessions", QUEUE_KEYS.SESSION_STARTED, { token: data.token });

              // await redis.set(`wtsapi:${data.token}`, JSON.stringify(data));

              const sendQueue = PRODUCER_QUEUES_KEYS.SEND_MESSAGE(data.token);

              await pgBoss.createQueue(sendQueue);

              await pgBoss.work(sendQueue, async (job: JobData[]) => {
                if (!job) return;

                const jobObjString = job[0];
                const jobObj: SendMessageDto = JSON.parse(jobObjString.data);

                console.log(`WTS_SERVICE: Sending message to ${jobObj.metadata.to} | Session: ${data.token}`);
                const recipients = Array.isArray(jobObj.metadata.to) ? jobObj.metadata.to : [jobObj.metadata.to];

                for (const recipient of recipients) {
                  const jid = `${recipient}@c.us`;

                  if (jobObj.type === "image") {
                    await sendMessageImage(jid, jobObj);
                  } else {
                    await sendMessageWTyping(jid, jobObj.metadata.body);
                  }
                }
              });

              break;
            }
            case "close": {
              switch (status) {
                case DisconnectReason.badSession:
                  log.info(
                    `WTS_SERVICE: Bad session file, please delete session and scan again | Session: ${data.token}`,
                  );
                  countRetryConnect += 1;

                  this.onSessionStart(data);
                  break;
                case DisconnectReason.connectionClosed:
                  log.info(`WTS_SERVICE: Connection closed, reconnecting... | Session: ${data.token}`);
                  countRetryConnect += 1;

                  this.onSessionStart(data);
                  break;
                case DisconnectReason.connectionLost:
                  log.info(`WTS_SERVICE: Connection lost from WhatsApp, reconnecting... | Session: ${data.token}`);
                  countRetryConnect += 1;

                  this.onSessionStart(data);
                  break;
                case DisconnectReason.connectionReplaced:
                  log.info(
                    `WTS_SERVICE: Connection replaced by another session, logging out... | Session: ${data.token}`,
                  );
                  break;
                case DisconnectReason.loggedOut:
                  log.info(`WTS_SERVICE: Device logged out, please scan again | Session: ${data.token}`);
                  await publishEvent("sessions", QUEUE_KEYS.SESSION_DISCONNECTED, { token: data.token });
                  break;
                case DisconnectReason.restartRequired:
                  log.info(`WTS_SERVICE: Restart required, restarting... | Session: ${data.token}`);
                  countRetryConnect += 1;

                  this.onSessionStart(data);
                  break;
                case DisconnectReason.multideviceMismatch:
                  log.info(`WTS_SERVICE: Connection timeout, reconnecting... | Session: ${data.token}`);
                  countRetryConnect += 1;

                  this.onSessionStart(data);
                  break;
                default:
                  log.info(
                    `WTS_SERVICE: Unknown disconnect reason: ${status}| Session: ${data.token}, reconnecting...`,
                  );
                  countRetryConnect += 1;

                  this.onSessionStart(data);
                  break;
              }

              break;
            }
            default: {
              log.info(
                `WTS_SERVICE: Connection update | Session: ${data.token} | Status: ${connection} | Reason: ${status}`,
              );
              break;
            }
          }

          if (qr) {
            log.info(`WTS_SERVICE: QR Code generated for ${data.token} - ${new Date().toLocaleTimeString()}`);

            await publishEvent("sessions", QUEUE_KEYS.SESSION_QRCODE, {
              token: data.token,
              qrCode: qr,
            });
          }
        }

        if (events["messages.upsert"]) {
          try {
            const upsert = events["messages.upsert"];
            const time = new Date().toLocaleTimeString();

            if (upsert.type === "notify") {
              for (const msg of upsert.messages) {
                if (msg.key.fromMe || !msg.key.remoteJid || !msg.message) {
                  log.info(
                    `WTS_SERVICE: Ignoring message (from self, missing remoteJid, or missing content)... | Session: ${data.token}`,
                  );
                  continue;
                }

                // Verifica se a mensagem é de um contato individual
                const remoteJid = msg.key.remoteJid || "";
                if (
                  remoteJid.endsWith("@g.us") || // grupo
                  remoteJid.endsWith("@broadcast") || // status
                  remoteJid === "status@broadcast" // status
                ) {
                  log.info(
                    `WTS_SERVICE: Mensagem recebida não é de contato individual, ignorando... | Session: ${data.token}`,
                  );
                  continue;
                }

                const photoUrl = await whatsapp.profilePictureUrl(msg.key.remoteJid, "image");

                const contactData: ContactDto = {
                  name: msg.pushName || "Unknown_Contact",
                  number: msg.key.remoteJid.split("@")[0],
                  contactId: msg.key.remoteJid,
                  photo: photoUrl || "",
                };

                const messageId = await whatsapp.requestPlaceholderResend(msg.key);

                if (msg.message?.audioMessage) {
                  const audioMessage = msg.message.audioMessage;

                  if (audioMessage.mimetype === "audio/ogg; codecs=opus") {
                    const media = await downloadMediaMessage(msg, "buffer", {});

                    log.info(`WTS_SERVICE: Send voice message to webhook for ${data.token}`);

                    await publishEvent("sessions", QUEUE_KEYS.SEND_MESSAGE_TO_WEBHOOK, {
                      type: "voice",
                      token: data.token.trim(),
                      messageData: {
                        contact: contactData,
                        message: {
                          id: messageId,
                          body: media.toString("base64"),
                          type: "voice",
                          mymetype: msg.message.audioMessage.mimetype,
                          timestamp: msg.messageTimestamp,
                        },
                      },
                    });
                  }

                  continue;
                }

                if (msg.message?.conversation || msg.message?.extendedTextMessage?.text) {
                  const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;

                  log.info(`WTS_SERVICE: Send message to webhook |> ${data.token}`);

                  await publishEvent("sessions", QUEUE_KEYS.SEND_MESSAGE_TO_WEBHOOK, {
                    type: "text",
                    token: data.token.trim(),
                    messageData: {
                      contact: contactData,
                      message: {
                        id: messageId,
                        body: text,
                        type: "chat",
                        timestamp: msg.messageTimestamp,
                      },
                    },
                  });
                }

                continue;
              }
            }
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : "Unknown error";

            log.error(`WTS_SERVICE: Error in send message to webhook in session ${data.token}`, errorMessage);
          }
        }
      });

      const managerQueue = PRODUCER_QUEUES_KEYS.SESSION_MANAGER(data.token);

      await pgBoss.createQueue(managerQueue);

      await pgBoss.work(managerQueue, async (job: JobData[]) => {
        if (!job) return;
        interface MsgProps {
          event: string;
          data: object;
        }

        const jobObjString = job[0];
        const jobObj: MsgProps = JSON.parse(jobObjString.data);
        const { event } = jobObj;

        if (event === "disconnect_session") {
          try {
            log.info(`WTS_SERVICE: Disconnecting session: ${data.token}`);

            await whatsapp.logout();

            log.info(`WTS_SERVICE: Session destroyed: ${data.token}`);

            await publishEvent("sessions", QUEUE_KEYS.SESSION_DISCONNECTED, { token: data.token });

            const sessionsDir = path.resolve(process.cwd(), "sessions");
            const sessionPath = path.join(sessionsDir, data.token);

            fs.rm(sessionPath, { recursive: true, force: true })
              .then(() => {
                log.info(`WTS_SERVICE: Session files removed for ${data.token}`);
              })
              .catch((err) => {
                Sentry.captureException(err);
                log.error(`WTS_SERVICE: Error removing session files for ${data.token}`, err);
              });

            // await redis.del(`wtsapi:${data.token}`);

            log.info(`WTS_SERVICE: Removing session files for ${data.token}`);
            await whatsapp.logout();
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : "Unknown error";

            Sentry.captureException(err);

            log.error(`WTS_SERVICE: Error disconnecting session ${data.token}`, errorMessage);
          }
        }
      });

      whatsapp.ev.on("creds.update", saveCreds);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";

      log.error(`WTS_SERVICE: Error starting session ${data.token}`, errorMessage);

      Sentry.captureException(err);

      await publishEvent("sessions", QUEUE_KEYS.SESSION_DISCONNECTED, { token: data.token });
      return;
    }
  }
})();
