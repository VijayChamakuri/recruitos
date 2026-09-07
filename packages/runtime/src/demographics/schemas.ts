import {
  CandidateDemographicsIdSchema,
  CandidateIdSchema,
  NonnegativeIntegerSchema
} from "@recruitos/core";
import { z } from "zod";

export const CANDIDATE_SEXES = ["female", "male", "not_specified"] as const;
export const CandidateSexSchema = z.enum(CANDIDATE_SEXES);
export type CandidateSex = z.infer<typeof CandidateSexSchema>;

export const CANDIDATE_RACE_ETHNICITIES = [
  "hispanic_or_latino",
  "white",
  "black_or_african_american",
  "asian",
  "native_hawaiian_or_other_pacific_islander",
  "american_indian_or_alaska_native",
  "two_or_more_races",
  "not_specified"
] as const;
export const CandidateRaceEthnicitySchema = z.enum(CANDIDATE_RACE_ETHNICITIES);
export type CandidateRaceEthnicity = z.infer<typeof CandidateRaceEthnicitySchema>;

const candidateDemographicsShape = {
  candidateDemographicsId: CandidateDemographicsIdSchema,
  candidateId: CandidateIdSchema,
  sex: CandidateSexSchema,
  raceEthnicity: CandidateRaceEthnicitySchema,
  createdAt: NonnegativeIntegerSchema
};

export const CandidateDemographicsDraftSchema = z.object(candidateDemographicsShape).strict();
export type CandidateDemographicsDraft = z.infer<typeof CandidateDemographicsDraftSchema>;

export const CandidateDemographicsSchema = z.object(candidateDemographicsShape).strict();
export type CandidateDemographics = z.infer<typeof CandidateDemographicsSchema>;
