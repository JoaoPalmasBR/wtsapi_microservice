export interface SendMessageDto {
  to: string | string[];
  type: "text" | "image" | "document" | "video" | "audio" | "sticker";
  body: string;
  title?: string;
}
