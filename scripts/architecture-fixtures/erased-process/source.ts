declare const process: { env: Readonly<Record<string, string | undefined>> };

export const environment = process.env;
