import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const FIXTURES = resolve(__dirname, "fixtures");
const DEPLOY_SCRIPT = resolve(__dirname, "../../scripts/deploy.sh");

function sh(
  cmd: string,
  opts: { cwd?: string; env?: Partial<NodeJS.ProcessEnv>; allowFail?: boolean } = {},
) {
  const result = spawnSync("bash", ["-c", cmd], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0 && !opts.allowFail) {
    console.error("CMD:", cmd);
    console.error("STDOUT:", result.stdout);
    console.error("STDERR:", result.stderr);
    throw new Error(`Command failed (${result.status}): ${cmd}`);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("deploy.sh dry-run", () => {
  let deployRoot: string;

  beforeAll(() => {
    // Build fake images
    sh(`docker build -t fake-app-good ${FIXTURES}/fake-app-good`);
    sh(`docker build -t fake-app-bad ${FIXTURES}/fake-app-bad`);

    deployRoot = mkdtempSync(join(tmpdir(), "arbitrage-deploy-test-"));
    mkdirSync(join(deployRoot, "backups"));
    mkdirSync(join(deployRoot, "scripts"));

    sh(`cp ${FIXTURES}/docker-compose.test.yml ${deployRoot}/docker-compose.prod.yml`);

    writeFileSync(
      join(deployRoot, ".env.production"),
      ["DB_PASSWORD=test", "TELEGRAM_BOT_TOKEN=", "TELEGRAM_CHAT_ID="].join("\n"),
    );

    sh(`cp ${DEPLOY_SCRIPT} ${deployRoot}/deploy.sh && chmod +x ${deployRoot}/deploy.sh`);

    // Start postgres + redis (deploy.sh expects them running)
    sh(
      `docker compose --env-file .env.production -f docker-compose.prod.yml up -d postgres redis`,
      { cwd: deployRoot },
    );

    // Wait for postgres health (max ~30s)
    for (let i = 0; i < 30; i++) {
      const r = sh(
        `docker compose --env-file .env.production -f docker-compose.prod.yml ps --format json postgres`,
        { cwd: deployRoot, allowFail: true },
      );
      if (r.stdout.includes('"healthy"')) break;
      execSync("sleep 1");
    }
  }, 180_000);

  afterAll(() => {
    if (deployRoot) {
      sh(
        `docker compose --env-file .env.production -f docker-compose.prod.yml down -v`,
        { cwd: deployRoot, allowFail: true },
      );
      sh(`rm -rf ${deployRoot}`, { allowFail: true });
    }
  });

  it("success path: good image + healthcheck pass → .current-tag updated, backup exists", () => {
    // Start with good image as "previous"
    sh(
      `TAG=fake-app-good docker compose --env-file .env.production -f docker-compose.prod.yml up -d app`,
      { cwd: deployRoot },
    );
    execSync("sleep 3");
    writeFileSync(join(deployRoot, ".current-tag"), "fake-app-good");

    // Tag the same image as a "new version" so deploy.sh can switch to it
    sh(`docker tag fake-app-good fake-app-v2`);

    const result = sh(`./deploy.sh fake-app-v2`, {
      cwd: deployRoot,
      env: {
        DEPLOY_ROOT: deployRoot,
        HEALTH_ATTEMPTS: "2",
        HEALTH_INTERVAL: "2",
        NOTIFY_CMD: "/bin/true",
        SKIP_PULL: "1",
        SKIP_MIGRATE: "1",
        HEALTH_URL: "http://127.0.0.1:33000/api/health",
      },
    });

    expect(result.status).toBe(0);

    const currentTag = readFileSync(join(deployRoot, ".current-tag"), "utf8").trim();
    expect(currentTag).toBe("fake-app-v2");

    // Backup file should exist
    const backups = sh(`ls ${deployRoot}/backups/`).stdout.trim();
    expect(backups).toMatch(/pre-deploy-\d+/);

    // .failed-tag should NOT exist
    expect(existsSync(join(deployRoot, ".failed-tag"))).toBe(false);
  }, 180_000);

  it("rollback path: bad image triggers rollback to previous tag", () => {
    // Ensure baseline state: good image is running and .current-tag points to it
    sh(
      `TAG=fake-app-good docker compose --env-file .env.production -f docker-compose.prod.yml up -d app`,
      { cwd: deployRoot },
    );
    execSync("sleep 3");
    writeFileSync(join(deployRoot, ".current-tag"), "fake-app-good");

    const result = sh(`./deploy.sh fake-app-bad`, {
      cwd: deployRoot,
      env: {
        DEPLOY_ROOT: deployRoot,
        HEALTH_ATTEMPTS: "2",
        HEALTH_INTERVAL: "2",
        NOTIFY_CMD: "/bin/true",
        SKIP_PULL: "1",
        SKIP_MIGRATE: "1",
        HEALTH_URL: "http://127.0.0.1:33000/api/health",
      },
      allowFail: true,
    });

    expect(result.status).toBe(4); // deploy.sh exits 4 on health check failure

    // .failed-tag captures the failed deploy
    expect(existsSync(join(deployRoot, ".failed-tag"))).toBe(true);
    const failedTag = readFileSync(join(deployRoot, ".failed-tag"), "utf8").trim();
    expect(failedTag).toBe("fake-app-bad");

    // .current-tag is unchanged — still the good one
    const currentTag = readFileSync(join(deployRoot, ".current-tag"), "utf8").trim();
    expect(currentTag).toBe("fake-app-good");

    // Running app container should be the good image
    const psOut = sh(
      `docker compose --env-file .env.production -f docker-compose.prod.yml ps --format json app`,
      { cwd: deployRoot },
    ).stdout;
    expect(psOut).toContain("fake-app-good");
  }, 240_000);
});
