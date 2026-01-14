import IORedis from "ioredis";

export const redis = new IORedis({
  host: process.env.REDIS_HOST,
  username: process.env.REDIS_USERNAME,
  port: Number(process.env.REDIS_PORT),
  password: process.env.REDIS_PASSWORD,
  maxRetriesPerRequest: null,
});

export async function publishEvent(stream: string, data: object) {
  const payload = JSON.stringify(data);
  // await redis.publish(channel, payload);
  await redis.xadd(stream, "*", "payload", JSON.stringify(data));
  console.log(`SIMPLIX_QUEUE_SERVICE: Publish event to ${stream}`);
}
