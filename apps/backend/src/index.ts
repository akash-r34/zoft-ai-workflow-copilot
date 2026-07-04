import { buildApp } from "./app.js";
import { env } from "./config/env.js";

const start = async (): Promise<void> => {
  const app = await buildApp();
  try {
    await app.listen({ port: env.PORT, host: env.HOST });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

void start();
