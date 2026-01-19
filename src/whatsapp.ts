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
    this.onInit();

    const INTERVAL_TIME = 5 * 60 * 1000; // 5 minutos

    setInterval(() => {
      this.logSessionsStatus();
      this.cleanupClosedSessions();
    }, INTERVAL_TIME);
  }

  private async onInit() {
    log.info("WTS_SERVICE: Initializing WTS Main Service...");

    await publishEvent("sessions", QUEUE_KEYS.DISABLE_ALL_SESSIONS, {});

    await this.startSessionsAlreadyRegistered();

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
        log.error(`WTS_SERVICE: Error logging out session ${token}`, err);
      }
      this.sessions.delete(token);
      log.info(`WTS_SERVICE: Session removed from memory: ${token}`);
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

    log.info(
      `WTS_SERVICE: Sessions Status - Total: ${total} | Open: ${open} | Connecting: ${connecting} | Closed: ${closed}`,
    );
  }

  private async cleanupClosedSessions(): Promise<void> {
    const closedSessions = this.getAllSessions().filter((s) => s.status === "closed");

    for (const session of closedSessions) {
      log.info(`WTS_SERVICE: Cleaning up closed session: ${session.token}`);
      await this.removeSession(session.token);
    }
  }

  private async sendMessageWTyping(token: string, jid: string, msg: string): Promise<void> {
    const session = this.getSession(token);
    if (!session) {
      log.error(`WTS_SERVICE: Session not found for token: ${token}`);
      throw new Error("Session not found");
    }

    try {
      if (session.socket.ws.isClosed) {
        log.warn(`WTS_SERVICE: WebSocket closed, attempting to reconnect... | Session: ${token}`);
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
      log.error(`WTS_SERVICE: Error sending typing message in session ${token}`, errorMessage);
      throw err;
    }
  }

  private async sendMessageImage(token: string, jid: string, message: SendMessageDto): Promise<void> {
    const session = this.getSession(token);
    if (!session) {
      log.error(`WTS_SERVICE: Session not found for token: ${token}`);
      throw new Error("Session not found");
    }

    try {
      if (session.socket.ws.isClosed) {
        log.warn(`WTS_SERVICE: WebSocket closed, attempting to reconnect... | Session: ${token}`);
        session.socket.ws.connect();
        await delay(2000);
      }

      await session.socket.presenceSubscribe(jid);
      await delay(3000);

      const base64Data = message.metadata.body.replace(/^data:image\/\w+;base64,/, "");
      const imageBuffer = Buffer.from(base64Data, "base64");

      const matches = message.metadata.body.match(/^data:image\/(\w+);base64,/);
      const extension = matches?.[1] || "jpg";

      const tempDir = path.join(process.cwd(), "temp");
      await fs.mkdir(tempDir, { recursive: true });

      const fileName = `${Date.now()}_${token}.${extension}`;
      const tempPath = path.join(tempDir, fileName);

      await fs.writeFile(tempPath, imageBuffer);

      await session.socket.sendMessage(jid, {
        image: { url: tempPath },
        caption: message.metadata.title || "",
      });

      await fs.unlink(tempPath);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      Sentry.captureException(err);
      log.error(`WTS_SERVICE: Error sending image message in session ${token}`, errorMessage);
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

          log.info(`WTS_SERVICE: Starting registered session for token: ${token}`);

          this.onSessionStart(sessionExternal);
        } else {
          log.info(`WTS_SERVICE: No session data found in sessions_cache for token: ${token}`);
        }
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";

      Sentry.captureException(err);
      log.error("WTS_SERVICE: Error starting already registered sessions", errorMessage);
    }
  }

  private async onSessionStart(data: SessionExternalProps) {
    try {
      const existingSession = this.getSession(data.token);

      if (existingSession && existingSession.status === "open") {
        await publishEvent("sessions", QUEUE_KEYS.SESSION_STARTED, { token: data.token });
        log.warn(`WTS_SERVICE: Session already exists and is open for token: ${data.token}`);
        return;
      }

      if (existingSession && existingSession.status === "closed") {
        log.info(`WTS_SERVICE: Removing closed session before creating new one: ${data.token}`);
        await this.removeSession(data.token);
      }

      const retryCount = existingSession?.retryCount || 0;
      if (retryCount > 5) {
        log.error(`WTS_SERVICE: Max retry connection reached for session ${data.token}`, {});
        await this.removeSession(data.token);
        return;
      }

      log.info(`WTS_SERVICE: Starting WhatsApp session for token: ${data.token}`);

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
      log.info(`WTS_SERVICE: Session stored in memory: ${data.token}`);

      whatsapp.ev.process(async (events) => {
        if (events["connection.update"]) {
          const { connection, lastDisconnect, qr } = events["connection.update"];
          const status = (lastDisconnect?.error as Boom)?.output?.statusCode;
          const session = this.getSession(data.token);

          if (!session) {
            log.error(`WTS_SERVICE: Session not found in memory during connection update: ${data.token}`);
            return;
          }

          switch (connection) {
            case "open": {
              session.status = "open";
              session.retryCount = 0;

              log.info(`WTS_SERVICE: WhatsApp connected successfully | Session: ${data.token}`);

              await publishEvent("sessions", QUEUE_KEYS.SESSION_STARTED, { token: data.token });
              await saveSessionCache(data.token, JSON.stringify(data));

              if (!session.queueInitialized) {
                const sendQueue = PRODUCER_QUEUES_KEYS.SEND_MESSAGE(data.token);
                await pgBoss.createQueue(sendQueue);

                await pgBoss.work(sendQueue, async (job: JobData[]) => {
                  if (!job) return;

                  const jobObjString = job[0];
                  const jobObj: SendMessageDto = JSON.parse(jobObjString.data);

                  if (!this.isSessionOpen(data.token)) {
                    log.warn(`WTS_SERVICE: Cannot send message, session is not open: ${data.token}`);
                    return;
                  }

                  console.log(`WTS_SERVICE: Sending message to ${jobObj.metadata.to} | Session: ${data.token}`);
                  const recipients = Array.isArray(jobObj.metadata.to) ? jobObj.metadata.to : [jobObj.metadata.to];

                  for (const recipient of recipients) {
                    const jid = `${recipient}@c.us`;

                    try {
                      if (jobObj.type === "image") {
                        await this.sendMessageImage(data.token, jid, jobObj);
                      } else {
                        await this.sendMessageWTyping(data.token, jid, jobObj.metadata.body);
                      }
                    } catch (err) {
                      log.error(`WTS_SERVICE: Failed to send message to ${recipient}`, err);
                    }
                  }
                });

                session.queueInitialized = true;
              }

              break;
            }
            case "close": {
              session.status = "closed";

              switch (status) {
                case DisconnectReason.badSession:
                  log.info(
                    `WTS_SERVICE: Bad session file, please delete session and scan again | Session: ${data.token}`,
                  );
                  session.retryCount += 1;
                  this.onSessionStart(data);
                  break;
                case DisconnectReason.connectionClosed:
                  log.info(`WTS_SERVICE: Connection closed, reconnecting... | Session: ${data.token}`);
                  session.retryCount += 1;
                  this.onSessionStart(data);
                  break;
                case DisconnectReason.connectionLost:
                  log.info(`WTS_SERVICE: Connection lost from WhatsApp, reconnecting... | Session: ${data.token}`);
                  session.retryCount += 1;
                  this.onSessionStart(data);
                  break;
                case DisconnectReason.connectionReplaced:
                  log.info(
                    `WTS_SERVICE: Connection replaced by another session, logging out... | Session: ${data.token}`,
                  );
                  await this.removeSession(data.token);
                  await publishEvent("sessions", QUEUE_KEYS.SESSION_DISCONNECTED, { token: data.token });
                  break;
                case DisconnectReason.loggedOut:
                  log.info(`WTS_SERVICE: Device logged out, please scan again | Session: ${data.token}`);
                  await this.removeSession(data.token);
                  await publishEvent("sessions", QUEUE_KEYS.SESSION_DISCONNECTED, { token: data.token });
                  break;
                case DisconnectReason.restartRequired:
                  log.info(`WTS_SERVICE: Restart required, restarting... | Session: ${data.token}`);
                  session.retryCount += 1;
                  this.onSessionStart(data);
                  break;
                case DisconnectReason.multideviceMismatch:
                  log.info(`WTS_SERVICE: Connection timeout, reconnecting... | Session: ${data.token}`);
                  session.retryCount += 1;
                  this.onSessionStart(data);
                  break;
                default:
                  log.info(
                    `WTS_SERVICE: Unknown disconnect reason: ${status}| Session: ${data.token}, reconnecting...`,
                  );
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
            log.info(`WTS_SERVICE: QR Code generated for ${data.token} - ${new Date().toLocaleTimeString()}`);

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
            log.info(`WTS_SERVICE: Disconnecting session: ${data.token}`);

            // Remover da memória e fazer logout
            await this.removeSession(data.token);

            log.info(`WTS_SERVICE: Session destroyed: ${data.token}`);

            await publishEvent("sessions", QUEUE_KEYS.SESSION_DISCONNECTED, { token: data.token });
            await deleteSessionCache(data.token);

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

      await this.removeSession(data.token);
      await publishEvent("sessions", QUEUE_KEYS.SESSION_DISCONNECTED, { token: data.token });
      return;
    }
  }
})();
