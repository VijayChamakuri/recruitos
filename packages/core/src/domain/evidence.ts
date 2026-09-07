import { z } from "zod";

/**
 * Evidence polarity: whether a located span supports or contradicts a rubric
 * dimension level. Hue encodes exactly this and nothing else (DESIGN.md
 * Part 4, Rule 1): it never carries pass or fail meaning.
 */
export const EVIDENCE_POLARITIES = ["supporting", "contradicting"] as const;

export const EvidencePolaritySchema = z.enum(EVIDENCE_POLARITIES);
export type EvidencePolarity = z.infer<typeof EvidencePolaritySchema>;

/**
 * How a located quote was matched against normalized source text: an exact
 * substring, a case and punctuation-folded normalized match, or a fuzzy
 * sliding-window match above the committed similarity cutoff.
 */
export const MATCH_QUALITIES = ["exact", "normalized", "fuzzy"] as const;

export const MatchQualitySchema = z.enum(MATCH_QUALITIES);
export type MatchQuality = z.infer<typeof MatchQualitySchema>;

/**
 * Whether a span or assessment was written by the extractor or by a human
 * during resolution. Humans and models write to the same typed structure
 * through the same validation, so a score is a pure function of that
 * structure regardless of who wrote it.
 */
export const EVIDENCE_SOURCES = ["extracted", "human"] as const;

export const EvidenceSourceSchema = z.enum(EVIDENCE_SOURCES);
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;
