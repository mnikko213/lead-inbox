import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach } from "vitest";

const testEnv = env as unknown as { DB: D1Database; TEST_MIGRATIONS: D1Migration[] };

beforeEach(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  await testEnv.DB.batch([
    testEnv.DB.prepare("DELETE FROM webhook_deliveries"),
    testEnv.DB.prepare("DELETE FROM leads"),
    testEnv.DB.prepare("DELETE FROM login_failures"),
  ]);
});
