import { err, ok, type Result } from "@recruitos/core";

export type WebServerOptions = Readonly<{
  databasePath: string;
  port: number;
  host: string;
  correctionFixture: boolean;
}>;

function readFlag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = argv[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("-")) {
    return undefined;
  }
  return value;
}

function hasBareFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(name);
}

function correctionFixtureEnabled(argv: readonly string[], env: NodeJS.ProcessEnv): boolean {
  if (hasBareFlag(argv, "--correction")) {
    return true;
  }
  const fromEnv = env["CORRECTION_FIXTURE"];
  return fromEnv === "1" || fromEnv === "true";
}

export function parseWebServerOptions(
  argv: readonly string[],
  env: NodeJS.ProcessEnv
): Result<WebServerOptions, string> {
  const fromFlag = readFlag(argv, "--db");
  const fromEnv = env["DATABASE_PATH"];
  const databasePath = fromFlag ?? (fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : undefined);
  if (databasePath === undefined) {
    return err(
      "DATABASE_PATH or --db is required. The web server does not start against an implicit stub."
    );
  }

  const portFlag = readFlag(argv, "--port");
  const portRaw = portFlag ?? env["PORT"] ?? "3000";
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return err(`Invalid port: ${portRaw}`);
  }

  return ok({
    databasePath,
    port,
    host: "127.0.0.1",
    correctionFixture: correctionFixtureEnabled(argv, env)
  });
}
