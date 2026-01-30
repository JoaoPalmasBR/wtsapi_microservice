import fs from "fs/promises";
import path from "path";
import Sentry from "@sentry/node";

import { Boom } from "@hapi/boom";

import makeWASocket, {
  Browsers,
  delay,
  DisconnectReason,
  downloadMediaMessage,
  useMultiFileAuthState,
  WASocket,
} from "baileys";

import { PRODUCER_QUEUES_KEYS, QUEUE_KEYS } from "./config/constants";

import logger from "./libs/logger";

import { log } from "./services/logger.service";
import { pgBoss } from "./libs/pg-boss";
import { ContactDto } from "./types/contact.types";
import { deleteSessionCache, getSessionCache, publishEvent, saveSessionCache } from "./libs/pq";
import { SendMessageDto } from "./dtos/whatsapp";

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

interface SessionData {
  socket: WASocket;
  token: string;
  props: SessionExternalProps;
  status: "connecting" | "open" | "closed";
  retryCount: number;
  queueInitialized: boolean;
}

new (class WtsMainService {
  private sessions: Map<string, SessionData> = new Map();

  constructor() {
    this.main();

    const INTERVAL_TIME = 5 * 60 * 1000;

    setInterval(() => {
      this.logSessionsStatus();
      this.cleanupClosedSessions();
    }, INTERVAL_TIME);

    const RESTART_INTERVAL_TIME = 15 * 60 * 1000;

    setInterval(() => {
      this.reStartSessionClosed();
    }, RESTART_INTERVAL_TIME);
  }

  private async main() {
    log.info("Initializing WTS Main Service...");

    await publishEvent("sessions", QUEUE_KEYS.DISABLE_ALL_SESSIONS, {});

    await this.startSessionsAlreadyRegistered();

    await pgBoss.work(QUEUE_KEYS.SESSION_CREATE, async (job: JobData[]) => {
      if (!job) {
        log.warn("Received empty message in session create consumer, ignoring...");
        return;
      }

      try {
        const jobObjString = job[0];
        const jobObj: SessionExternalProps = JSON.parse(jobObjString.data);

        log.info(`Received session create request for token: ${jobObj.token}`);

        Object.keys(PRODUCER_QUEUES_KEYS).forEach(async (key) => {
          const queueName = (PRODUCER_QUEUES_KEYS as any)[key](jobObj.token);
          await pgBoss.createQueue(queueName);
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "Unknown error";

        log.error("Error parsing session create job data", errorMessage);
      }
    });

    await pgBoss.work(QUEUE_KEYS.SESSION_START, async (job: JobData[]) => {
      if (!job) {
        log.warn("Received empty message in session start consumer, ignoring...");
        return;
      }
      const jobObjString = job[0];
      const jobObj: SessionExternalProps = JSON.parse(jobObjString.data);

      log.info(`Received session start request for token: ${jobObj.token}`);

      this.onSessionStart(jobObj);
    });
  }

  private async reStartSessionClosed(): Promise<void> {
    const session_path = path.join(process.cwd(), "sessions");

    try {
      log.info("Restarting closed sessions...");
      const session_token_path_name = await fs.readdir(session_path);

      log.info(`Found ${session_token_path_name.length} sessions to check for restart.`);

      for (const token of session_token_path_name) {
        const session = this.getSession(token);

        if (!session || session.status !== "open") {
          const session_data = await getSessionCache(token);

          if (session_data) {
            const sessionExternal: SessionExternalProps = JSON.parse(session_data);

            log.info(`Restarting session for token: ${token}`);

            await this.onSessionStart(sessionExternal);
          } else {
            log.warn(`No session data found in cache for token: ${token}, skipping restart.`);
          }
        } else {
          log.info(`Session ${token} is already open, skipping restart.`);
        }
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";

      Sentry.captureException(err);
      log.error("Error in restarting closed sessions", errorMessage);
    }
  }

  private getSession(token: string): SessionData | undefined {
    return this.sessions.get(token);
  }

  private isSessionOpen(token: string): boolean {
    const session = this.getSession(token);
    return session?.status === "open" && !session.socket.ws.isClosed;
  }

  private async removeSession(token: string): Promise<void> {
    const session = this.sessions.get(token);
    if (session) {
      try {
        if (!session.socket.ws.isClosed) {
          await session.socket.logout();
        }
      } catch (err) {
        log.error(`Error logging out session ${token}`, err);
      }
      this.sessions.delete(token);
      log.info(`Session removed from memory: ${token}`);
    }
  }

  private getAllSessions(): SessionData[] {
    return Array.from(this.sessions.values());
  }

  private getSessionCount(): number {
    return this.sessions.size;
  }

  private getOpenSessions(): SessionData[] {
    return this.getAllSessions().filter((s) => s.status === "open");
  }

  private logSessionsStatus(): void {
    const total = this.getSessionCount();
    const open = this.getOpenSessions().length;
    const connecting = this.getAllSessions().filter((s) => s.status === "connecting").length;
    const closed = this.getAllSessions().filter((s) => s.status === "closed").length;

    log.info(`Sessions Status - Total: ${total} | Open: ${open} | Connecting: ${connecting} | Closed: ${closed}`);
  }

  private async cleanupClosedSessions(): Promise<void> {
    const closedSessions = this.getAllSessions().filter((s) => s.status === "closed");

    for (const session of closedSessions) {
      log.info(`Cleaning up closed session: ${session.token}`);
      await this.removeSession(session.token);
    }
  }

  private async sendMessageWTyping(token: string, jid: string, msg: string): Promise<void> {
    const session = this.getSession(token);
    if (!session) {
      log.error(`Session not found for token: ${token}`);
      throw new Error("Session not found");
    }

    try {
      if (session.socket.ws.isClosed) {
        log.warn(`WebSocket closed, attempting to reconnect... | Session: ${token}`);
        session.socket.ws.connect();
        await delay(2000);
      }

      await session.socket.presenceSubscribe(jid);
      await delay(500);

      await session.socket.sendPresenceUpdate("composing", jid);
      await delay(4000);

      await session.socket.sendMessage(jid, { text: msg });

      await delay(1000);
      await session.socket.sendPresenceUpdate("paused", jid);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      Sentry.captureException(err);
      log.error(`Error sending typing message in session ${token}`, errorMessage);
      throw err;
    }
  }

  private async sendMessageImage(token: string, jid: string, message: SendMessageDto): Promise<void> {
    const session = this.getSession(token);
    if (!session) {
      log.error(`Session not found for token: ${token}`);
      throw new Error("Session not found");
    }

    try {
      if (session.socket.ws.isClosed) {
        log.warn(`WebSocket closed, attempting to reconnect... | Session: ${token}`);
        session.socket.ws.connect();
        await delay(2000);
      }

      let imagesPath: string[] = [];

      if (typeof message.metadata.body === "string") {
        const base64Data = message.metadata.body.replace(/^data:image\/\w+;base64,/, "");
        const imageBuffer = Buffer.from(base64Data, "base64");

        const matches = message.metadata.body.match(/^data:image\/(\w+);base64,/);
        const extension = matches?.[1] || "jpg";

        const tempDir = path.join(process.cwd(), "temp");
        await fs.mkdir(tempDir, { recursive: true });

        const fileName = `${Date.now()}_${token}.${extension}`;
        const tempPath = path.join(tempDir, fileName);

        await fs.writeFile(tempPath, imageBuffer);

        imagesPath.push(tempPath);
      } else {
        for (const bodyPart of message.metadata.body) {
          const base64Data = bodyPart.replace(/^data:image\/\w+;base64,/, "");
          const imageBuffer = Buffer.from(base64Data, "base64");

          const matches = bodyPart.match(/^data:image\/(\w+);base64,/);
          const extension = matches?.[1] || "jpg";

          const tempDir = path.join(process.cwd(), "temp");
          await fs.mkdir(tempDir, { recursive: true });

          const fileName = `${Date.now()}_${token}_${Math.floor(Math.random() * 1000)}.${extension}`;
          const tempPath = path.join(tempDir, fileName);

          await fs.writeFile(tempPath, imageBuffer);

          imagesPath.push(tempPath);
        }
      }

      await session.socket.presenceSubscribe(jid);
      await delay(3000);

      for (let i = 0; i < imagesPath.length; i++) {
        const image = imagesPath[i];

        await session.socket.sendMessage(jid, {
          image: { url: image },
          caption: imagesPath.length === i + 1 ? message.metadata.title || "" : "",
        });
      }

      for (const imagePath of imagesPath) {
        await fs.unlink(imagePath);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      Sentry.captureException(err);
      log.error(`Error sending image message in session ${token}`, errorMessage);
      throw err;
    }
  }

  private async sendAudioMessage(token: string, jid: string, message: SendMessageDto): Promise<void> {
    const session = this.getSession(token);
    if (!session) {
      log.error(`Session not found for token: ${token}`);
      throw new Error("Session not found");
    }

    try {
      if (session.socket.ws.isClosed) {
        log.warn(`WebSocket closed, attempting to reconnect... | Session: ${token}`);
        session.socket.ws.connect();
        await delay(2000);
      }

      const body: string = message.metadata.body as string;

      await session.socket.presenceSubscribe(jid);
      await delay(3000);

      await session.socket.sendPresenceUpdate("recording", jid);

      const base64Data = body.replace(/^data:audio\/\w+;base64,/, "");
      const audioBuffer = Buffer.from(base64Data, "base64");

      const matches = body.match(/^data:audio\/(\w+);base64,/);
      const extension = matches?.[1] || "mp3";
      const tempDir = path.join(process.cwd(), "temp");
      await fs.mkdir(tempDir, { recursive: true });

      const audio_minutes = audioBuffer.length / (16_000 * 2 * 2);
      const audio_seconds = Math.ceil(audio_minutes * 60);

      await delay(Math.min(audio_seconds * 1000, 10_000));

      await session.socket.sendPresenceUpdate("paused", jid);

      const fileName = `${Date.now()}_${token}.${extension}`;
      const tempPath = path.join(tempDir, fileName);

      await fs.writeFile(tempPath, audioBuffer);

      await session.socket.sendMessage(jid, {
        audio: { url: tempPath },
        caption: message.metadata.title || "",
      });

      await fs.unlink(tempPath);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      Sentry.captureException(err);
      log.error(`Error sending image message in session ${token}`, errorMessage);
      throw err;
    }
  }

  private async sendStickerMessage(token: string, jid: string, message: SendMessageDto): Promise<void> {
    const session = this.getSession(token);
    if (!session) {
      log.error(`Session not found for token: ${token}`);
      throw new Error("Session not found");
    }

    try {
      if (session.socket.ws.isClosed) {
        log.warn(`WebSocket closed, attempting to reconnect... | Session: ${token}`);
        session.socket.ws.connect();
        await delay(2000);
      }

      await session.socket.presenceSubscribe(jid);
      await delay(3000);

      const body: string = message.metadata.body as string;

      const base64Data = body.replace(/^data:image\/\w+;base64,/, "");
      const imageBuffer = Buffer.from(base64Data, "base64");

      const matches = body.match(/^data:image\/(\w+);base64,/);
      const extension = matches?.[1] || "jpg";

      const tempDir = path.join(process.cwd(), "temp");
      await fs.mkdir(tempDir, { recursive: true });

      const fileName = `${Date.now()}_${token}.${extension}`;
      const tempPath = path.join(tempDir, fileName);

      await fs.writeFile(tempPath, imageBuffer);

      await session.socket.sendMessage(jid, {
        sticker: imageBuffer,
        caption: message.metadata.title || "",
      });

      await fs.unlink(tempPath);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      Sentry.captureException(err);
      log.error(`Error sending sticker message in session ${token}`, errorMessage);
      throw err;
    }
  }

  private async startSessionsAlreadyRegistered() {
    const session_path = path.join(process.cwd(), "sessions");

    try {
      const session_token_path_name = await fs.readdir(session_path);

      session_token_path_name.forEach(async (token) => {
        const sessionData = await getSessionCache(token);

        if (sessionData) {
          const sessionExternal: SessionExternalProps = JSON.parse(sessionData);

          log.info(`Starting registered session for token: ${token}`);

          this.onSessionStart(sessionExternal);
        } else {
          log.info(`No session data found in sessions_cache for token: ${token}`);
        }
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";

      Sentry.captureException(err);
      log.error("Error starting already registered sessions", errorMessage);
    }
  }

  private async onSessionStart(data: SessionExternalProps) {
    try {
      const existingSession = this.getSession(data.token);

      if (existingSession && existingSession.status === "open") {
        await publishEvent("sessions", QUEUE_KEYS.SESSION_STARTED, { token: data.token });
        log.warn(`Session already exists and is open for token: ${data.token}`);
        return;
      }

      if (existingSession && existingSession.status === "closed") {
        log.info(`Removing closed session before creating new one: ${data.token}`);
        await this.removeSession(data.token);
      }

      const retryCount = existingSession?.retryCount || 0;
      if (retryCount > 5) {
        log.error(`Max retry connection reached for session ${data.token}`, {});
        await this.removeSession(data.token);
        return;
      }

      log.info(`Starting WhatsApp session for token: ${data.token}`);

      logger.level = "silent";

      const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${data.token}`);

      const whatsapp = makeWASocket({
        auth: state,
        logger: logger,
        browser: Browsers.ubuntu("Chrome"),
        qrTimeout: 60_000,
      });

      const sessionData: SessionData = {
        socket: whatsapp,
        token: data.token,
        props: data,
        status: "connecting",
        retryCount: retryCount,
        queueInitialized: false,
      };

      this.sessions.set(data.token, sessionData);
      log.info(`Session stored in memory: ${data.token}`);

      whatsapp.ev.process(async (events) => {
        if (events["connection.update"]) {
          const { connection, lastDisconnect, qr } = events["connection.update"];
          const status = (lastDisconnect?.error as Boom)?.output?.statusCode;
          const session = this.getSession(data.token);

          if (!session) {
            log.error(`Session not found in memory during connection update: ${data.token}`);
            return;
          }

          switch (connection) {
            case "open": {
              session.status = "open";
              session.retryCount = 0;

              log.info(`WhatsApp connected successfully | Session: ${data.token}`);

              await publishEvent("sessions", QUEUE_KEYS.SESSION_STARTED, { token: data.token });
              await saveSessionCache(data.token, JSON.stringify(data));

              const allGroups = await whatsapp.groupFetchAllParticipating();
              const groupsArray = Object.values(allGroups);

              const BATCH_SIZE = 10;
              for (let i = 0; i < groupsArray.length; i += BATCH_SIZE) {
                const batch = groupsArray.slice(i, i + BATCH_SIZE);

                await publishEvent("sessions", QUEUE_KEYS.UPDATE_OR_CREATE_GROUP_INFO, {
                  metadata: {
                    token: data.token,
                    groups: batch.map((group) => {
                      return {
                        name: group.subject,
                        wts_group_id: group.id,
                        owner: group.owner,
                        last_updated_at: new Date(),
                      };
                    }),
                  },
                });
              }

              const sendMessage = async (toGroup: boolean = false, type: string, messageData: SendMessageDto) => {
                if (!this.isSessionOpen(data.token)) {
                  log.warn(`Cannot send message, session is not open: ${data.token}`);
                  return;
                }

                log.info(`Sending message | Type: ${type} to ${messageData.metadata.to} | Session: ${data.token}`);
                const recipients = Array.isArray(messageData.metadata.to)
                  ? messageData.metadata.to
                  : [messageData.metadata.to];

                for (const recipient of recipients) {
                  let destination = toGroup ? recipient : `${recipient}@s.whatsapp.net`;

                  try {
                    switch (type) {
                      case "audio":
                        await this.sendAudioMessage(data.token, destination, messageData);
                        break;
                      case "image":
                        await this.sendMessageImage(data.token, destination, messageData);
                        break;
                      case "sticker":
                        await this.sendStickerMessage(data.token, destination, messageData);
                        break;
                      default:
                        await this.sendMessageWTyping(data.token, destination, messageData.metadata.body as string);
                        break;
                    }
                  } catch (err) {
                    log.error(`Failed to send message to ${recipient}`, err);
                  }
                }
              };

              if (!session.queueInitialized) {
                const sendQueue = PRODUCER_QUEUES_KEYS.SEND_MESSAGE(data.token);
                await pgBoss.createQueue(sendQueue);

                await pgBoss.work(sendQueue, async (job: JobData[]) => {
                  if (!job) return;

                  const jobObjString = job[0];
                  const jobObj: SendMessageDto = JSON.parse(jobObjString.data);

                  sendMessage(false, jobObj.type, jobObj);
                });

                const groupSendQueue = PRODUCER_QUEUES_KEYS.GROUP_SEND_MESSAGE(data.token);
                await pgBoss.createQueue(groupSendQueue);

                await pgBoss.work(groupSendQueue, async (job: JobData[]) => {
                  if (!job) return;

                  const jobObjString = job[0];
                  const jobObj: SendMessageDto = JSON.parse(jobObjString.data);

                  sendMessage(true, jobObj.type, jobObj);
                });

                session.queueInitialized = true;
              }

              break;
            }
            case "close": {
              session.status = "closed";

              switch (status) {
                case DisconnectReason.badSession:
                  log.info(`Bad session file, please delete session and scan again | Session: ${data.token}`);
                  session.retryCount += 1;
                  this.onSessionStart(data);
                  break;
                case DisconnectReason.connectionClosed:
                  log.info(`Connection closed, reconnecting... | Session: ${data.token}`);
                  session.retryCount += 1;
                  this.onSessionStart(data);
                  break;
                case DisconnectReason.connectionLost:
                  log.info(`Connection lost from WhatsApp, reconnecting... | Session: ${data.token}`);
                  session.retryCount += 1;
                  this.onSessionStart(data);
                  break;
                case DisconnectReason.connectionReplaced:
                  log.info(`Connection replaced by another session, logging out... | Session: ${data.token}`);
                  await this.removeSession(data.token);
                  await publishEvent("sessions", QUEUE_KEYS.SESSION_DISCONNECTED, { token: data.token });
                  break;
                case DisconnectReason.loggedOut:
                  log.info(`Device logged out, please scan again | Session: ${data.token}`);
                  await this.removeSession(data.token);
                  await publishEvent("sessions", QUEUE_KEYS.SESSION_DISCONNECTED, { token: data.token });
                  break;
                case DisconnectReason.restartRequired:
                  log.info(`Restart required, restarting... | Session: ${data.token}`);
                  session.retryCount += 1;
                  this.onSessionStart(data);
                  break;
                case DisconnectReason.multideviceMismatch:
                  log.info(`Connection timeout, reconnecting... | Session: ${data.token}`);
                  session.retryCount += 1;
                  this.onSessionStart(data);
                  break;
                default:
                  log.info(`Unknown disconnect reason: ${status}| Session: ${data.token}, reconnecting...`);
                  session.retryCount += 1;
                  this.onSessionStart(data);
                  break;
              }

              break;
            }
            default: {
              break;
            }
          }

          if (qr) {
            log.info(`QR Code generated for ${data.token} - ${new Date().toLocaleTimeString()}`);

            await publishEvent("sessions", QUEUE_KEYS.SESSION_QRCODE, { token: data.token, qrCode: qr });
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
                    `Ignoring message (from self, missing remoteJid, or missing content)... | Session: ${data.token}`,
                  );
                  continue;
                }

                const remoteJid = msg.key.remoteJid || "";
                
                if (remoteJid.endsWith("@g.us") || remoteJid === "status@broadcast") {
                  continue;
                }

                if (remoteJid.includes("@newsletter")) {
                  const newsletterData = await whatsapp.newsletterMetadata("jid", msg.key.remoteJid);

                  const metadata = newsletterData?.thread_metadata || {};

                  if (msg.message?.conversation || msg.message?.extendedTextMessage?.text) {
                    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;

                    await publishEvent("sessions", QUEUE_KEYS.SEND_MESSAGE_TO_WEBHOOK, {
                      type: "newsletter",
                      token: data.token.trim(),
                      messageData: {
                        newsletter: metadata,
                        message: {
                          id: msg.key.id,
                          body: text,
                          type: "newsletter",
                          timestamp: msg.messageTimestamp,
                        },
                      },
                    });
                  }

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

                    log.info(`Send voice message to webhook for ${data.token}`);

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

                  log.info(`Send message to webhook |> ${data.token}`);

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

            log.error(`Error in send message to webhook in session ${data.token}`, errorMessage);
          }
        }

        if (events["groups.upsert"]) {
          try {
            const upsert = events["groups.upsert"];

            const BATCH_SIZE = 10;
            for (let i = 0; i < upsert.length; i += BATCH_SIZE) {
              const batch = upsert.slice(i, i + BATCH_SIZE);

              await publishEvent("sessions", QUEUE_KEYS.UPDATE_OR_CREATE_GROUP_INFO, {
                metadata: {
                  token: data.token,
                  groups: batch.map((group) => {
                    return {
                      name: group.subject,
                      wts_group_id: group.id,
                      owner: group.owner,
                      last_updated_at: new Date(),
                    };
                  }),
                },
              });
            }
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : "Unknown error";

            log.error(`Error in group upsert event in session ${data.token}`, errorMessage);
          }
        }
      });

      const MANAGER_QUEUE = PRODUCER_QUEUES_KEYS.SESSION_MANAGER(data.token);
      await pgBoss.createQueue(MANAGER_QUEUE);

      await pgBoss.work(MANAGER_QUEUE, async (job: JobData[]) => {
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
            log.info(`Disconnecting session: ${data.token}`);

            // Remover da memória e fazer logout
            await this.removeSession(data.token);

            log.info(`Session destroyed: ${data.token}`);

            await publishEvent("sessions", QUEUE_KEYS.SESSION_DISCONNECTED, { token: data.token });
            await deleteSessionCache(data.token);

            const sessionsDir = path.resolve(process.cwd(), "sessions");
            const sessionPath = path.join(sessionsDir, data.token);

            fs.rm(sessionPath, { recursive: true, force: true })
              .then(() => {
                log.info(`Session files removed for ${data.token}`);
              })
              .catch((err) => {
                Sentry.captureException(err);
                log.error(`Error removing session files for ${data.token}`, err);
              });
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : "Unknown error";

            Sentry.captureException(err);

            log.error(`Error disconnecting session ${data.token}`, errorMessage);
          }
        }
      });

      whatsapp.ev.on("creds.update", saveCreds);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";

      log.error(`Error starting session ${data.token}`, errorMessage);

      Sentry.captureException(err);

      await this.removeSession(data.token);
      return;
    }
  }
})();
