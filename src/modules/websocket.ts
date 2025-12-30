import Sentry from "@sentry/node";
import { Server } from "socket.io";
import { logError, logInfo, logWarn } from "../libs/logger";

(function () {
  try {
    const io = new Server({ cors: { origin: "*" } });

    io.on("connection", (socket) => {
      logInfo("WTSAPI: Socket started:", socket.id);

      socket.on("INTERNAL:session:socket", (payload) => {
        logInfo("WTSAPI: Received session:socket event, re-emitting to all clients");

        // io.emit("WTSAPI:session:socket", payload);
        io.emit(`${payload.clientId}:session:socket`, payload);
      });

      socket.on("INTERNAL:notification-web", (payload) => {
        logInfo("WTSAPI: Received notification-web event, re-emitting to all clients");

        io.emit(`${payload.clientId}:notification-web`, payload);
      });

      socket.on("connect", () => {
        logInfo("WTSAPI: Socket connected:", socket.id);
      });

      socket.on("disconnect", () => {
        logWarn("WTSAPI: Socket disconnected:", socket.id);
      });
    });

    logInfo(`WTSAPI: Socket server listening on port ${process.env.WEBSOCKET_PORT ?? 3007}`);

    io.listen(Number(process.env.WEBSOCKET_PORT) ?? 3007);
  } catch (e) {
    logError("WTSAPI: Error starting WebSocket server", e);
    Sentry.captureException(e);
  }
})();
