export interface SendMessageDto {
  type: "text" | "image" | "document" | "video" | "audio" | "sticker";
  metadata: {
    to: string | string[];
    body: string;
    title?: string;
  };
}
