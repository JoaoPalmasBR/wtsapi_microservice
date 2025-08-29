import Sentry from "@sentry/node";
import { Server } from "socket.io";

(function (){
  try {
    const io = new Server({ cors: { origin: "*" } });

    io.on("connection", (socket) => {
      console.log("WTSAPI: Socket started:", socket.id);

      socket.on("INTERNAL:qr_code", (payload) => {
        console.log("WTSAPI: Received qrcode event, re-emitting to all clients");

        io.emit("WTSAPI:wts_qrcode", payload);
      });

      socket.on("INTERNAL:notification-web", (payload) => {
        console.log("WTSAPI: Received notification-web event, re-emitting to all clients");

        io.emit("WTSAPI:notification-to-front", payload);
      });

      socket.on("connect", () => {
        console.log("WTSAPI: Socket connected:", socket.id);
      });

      socket.on("disconnect", () => {
        console.log("WTSAPI: Socket disconnected:", socket.id);
      });
    });

    console.log(`WTSAPI: Socket server listening on port ${process.env.WEBSOCKET_PORT ?? 3007}`);

    io.listen(Number(process.env.WEBSOCKET_PORT) ?? 3007);
  } catch (e) {
    Sentry.captureException(e);
  }
})()
