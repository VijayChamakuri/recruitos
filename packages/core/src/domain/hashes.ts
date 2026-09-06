import { z } from "zod";

export const Sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/u, "Expected a lowercase SHA-256 hexadecimal digest")
  .brand<"Sha256Hex">();

export type Sha256Hex = z.infer<typeof Sha256HexSchema>;
