import { Server } from "socket.io";

interface PayloadProps {
  event: string;
  data: {};
}

const io = new Server({
  cors: { origin: "*" },
});

io.on("connection", (socket) => {
  console.log("WTSAPI: Socket started:", socket.id);

  socket.on("INTERNAL:qr_code", (payload: PayloadProps) => {
    console.log("WTSAPI: Received qrcode event, re-emitting to all clients");

    io.emit("WTSAPI:wts_qrcode", payload);
  });

  socket.on("connect", () => {
    console.log("WTSAPI: Socket connected:", socket.id);
  });

  socket.on("disconnect", () => {
    console.log("WTSAPI: Socket disconnected:", socket.id);
  });
});

console.log("WTSAPI: Socket server listening on port 8080");

io.listen(3007);
