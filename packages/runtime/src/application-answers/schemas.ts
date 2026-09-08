import {
  CandidateApplicationAnswerIdSchema,
  CandidateIdSchema,
  NonnegativeIntegerSchema
} from "@recruitos/core";
import { z } from "zod";

export const MAXIMUM_APPLICATION_ANSWER_KEY_LENGTH = 200;
export const MAXIMUM_APPLICATION_ANSWER_IDENTIFIER_LENGTH = 128;
export const MAXIMUM_APPLICATION_ANSWER_FREE_TEXT_LENGTH = 2000;

export const ApplicationAnswerQuestionKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(MAXIMUM_APPLICATION_ANSWER_KEY_LENGTH);
const answerKey = ApplicationAnswerQuestionKeySchema;
const answerIdentifier = z
  .string()
  .trim()
  .min(1)
  .max(MAXIMUM_APPLICATION_ANSWER_IDENTIFIER_LENGTH);
const freeText = z
  .string()
  .trim()
  .min(1)
  .max(MAXIMUM_APPLICATION_ANSWER_FREE_TEXT_LENGTH)
  .nullable()
  .optional();

const candidateApplicationAnswerShape = {
  candidateApplicationAnswerId: CandidateApplicationAnswerIdSchema,
  candidateId: CandidateIdSchema,
  questionKey: answerKey,
  selectedOptionKey: answerKey,
  freeText,
  collectedBy: answerKey,
  formId: answerIdentifier,
  questionId: answerIdentifier,
  collectedAt: NonnegativeIntegerSchema,
  createdAt: NonnegativeIntegerSchema
};

export const CandidateApplicationAnswerDraftSchema = z
  .object(candidateApplicationAnswerShape)
  .strict();
export type CandidateApplicationAnswerDraft = z.infer<
  typeof CandidateApplicationAnswerDraftSchema
>;

export const CandidateApplicationAnswerSchema = z
  .object({
    ...candidateApplicationAnswerShape,
    freeText: z
      .string()
      .trim()
      .min(1)
      .max(MAXIMUM_APPLICATION_ANSWER_FREE_TEXT_LENGTH)
      .nullable()
  })
  .strict();
export type CandidateApplicationAnswer = z.infer<typeof CandidateApplicationAnswerSchema>;
