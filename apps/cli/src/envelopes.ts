export type CliMeta = Readonly<{
  command: string;
  durationMs: number;
  timestamp: number;
}>;

export type CliSuccessEnvelope<TData> = Readonly<{
  ok: true;
  command: string;
  data: TData;
  meta: CliMeta;
}>;

export type CliErrorEnvelope = Readonly<{
  ok: false;
  command: string;
  error: Readonly<{
    code: string;
    message: string;
    exitCode: number;
    details?: unknown;
  }>;
  meta: CliMeta;
}>;

export type CliEnvelope<TData> = CliSuccessEnvelope<TData> | CliErrorEnvelope;

export function createSuccessEnvelope<TData>(
  command: string,
  data: TData,
  durationMs: number
): CliSuccessEnvelope<TData> {
  return {
    ok: true,
    command,
    data,
    meta: {
      command,
      durationMs,
      timestamp: Date.now()
    }
  };
}

export function createErrorEnvelope(
  command: string,
  code: string,
  message: string,
  exitCode: number,
  durationMs: number,
  details?: unknown
): CliErrorEnvelope {
  return {
    ok: false,
    command,
    error: {
      code,
      message,
      exitCode,
      ...(details !== undefined ? { details } : {})
    },
    meta: {
      command,
      durationMs,
      timestamp: Date.now()
    }
  };
}

export function formatEnvelopeJson(envelope: CliEnvelope<unknown>): string {
  return JSON.stringify(envelope, null, 2);
}

/** Formats a tabular view for terminal output without external dependencies */
export function formatTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[]
): string {
  if (rows.length === 0) {
    return headers.join(" | ") + "\n(no records)";
  }

  const colWidths = headers.map((header, colIdx) => {
    let max = header.length;
    for (const row of rows) {
      const cell = row[colIdx] ?? "";
      if (cell.length > max) {
        max = cell.length;
      }
    }
    return max;
  });

  const headerLine = headers
    .map((h, i) => h.padEnd(colWidths[i] ?? h.length))
    .join("   ");
  const separatorLine = colWidths
    .map((w) => "-".repeat(w))
    .join("   ");

  const rowLines = rows.map((row) =>
    headers
      .map((_, i) => (row[i] ?? "").padEnd(colWidths[i] ?? 0))
      .join("   ")
  );

  return [headerLine, separatorLine, ...rowLines].join("\n");
}
