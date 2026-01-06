import Sentry from "@sentry/node";
import { Server } from "socket.io";

(function () {
  try {
    const io = new Server({ cors: { origin: "*" } });

    io.on("connection", (socket) => {
      console.info("WTSAPI: Socket started:", socket.id);

      socket.on("INTERNAL:session:socket", (payload) => {
        console.info("WTSAPI: Received session:socket event, re-emitting to all clients");

        // io.emit("WTSAPI:session:socket", payload);
        io.emit(`${payload.clientId}:session:socket`, payload);
      });

      socket.on("INTERNAL:notification-web", (payload) => {
        console.info("WTSAPI: Received notification-web event, re-emitting to all clients");

        io.emit(`${payload.clientId}:notification-web`, payload);
      });

      socket.on("connect", () => {
        console.info("WTSAPI: Socket connected:", socket.id);
      });

      socket.on("disconnect", () => {
        console.warn("WTSAPI: Socket disconnected:", socket.id);
      });
    });

    console.info(`WTSAPI: Socket server listening on port ${process.env.WEBSOCKET_PORT ?? 3007}`);

    io.listen(Number(process.env.WEBSOCKET_PORT) ?? 3007);
  } catch (e) {
    console.error("WTSAPI: Error starting WebSocket server", e);
    Sentry.captureException(e);
  }
})();
