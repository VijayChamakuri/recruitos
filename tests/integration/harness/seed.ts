import { ok } from "../../../packages/core/src/index.js";
import {
  appendAuditEvent,
  prepareAuditEvent
} from "../../../packages/runtime/src/audit/index.js";
import {
  runImmediateTransaction,
  type ImmediateTransactionContext
} from "../../../packages/runtime/src/commands/index.js";
import type { RuntimeDatabaseConnection } from "../../../packages/runtime/src/db/index.js";
import {
  insertCandidate,
  insertCandidateDocument,
  insertSourceDocument,
  prepareCandidate,
  prepareCandidateDocument,
  prepareSourceDocument
} from "../../../packages/runtime/src/entities/index.js";
import {
  insertRequirement,
  insertRole,
  insertRubric,
  insertRubricDimension,
  insertRubricProvenanceAssumption,
  prepareRequirement,
  prepareRole,
  prepareRubric,
  prepareRubricDimension,
  prepareRubricProvenanceAssumption
} from "../../../packages/runtime/src/roles/index.js";
import { unwrap } from "./results.js";

/**
 * Rows the DDL trigger tests need to have something to try to mutate. Seeding
 * runs through the real stores rather than raw SQL so the fixtures cannot drift
 * away from what the runtime actually writes.
 *
 * The rubric here is deliberately not the product locked snapshot. Integration
 * trigger tests only need a persistable header, one provenance assumption, and
 * one dimension with four level anchors.
 */

const SEED_TIMESTAMP = 1_788_700_000_000;

export function seedImmutableEntities(connection: RuntimeDatabaseConnection): void {
  unwrap(
    runImmediateTransaction(connection, (context: ImmediateTransactionContext) => {
      unwrap(
        insertCandidate(
          context,
          unwrap(
            prepareCandidate({
              candidateId: "candidate-1",
              sourceSystem: "synthetic_corpus",
              sourceKey: "tier-one/0001",
              channel: "inbound",
              corpusTag: "main",
              createdAt: SEED_TIMESTAMP
            })
          )
        )
      );
      unwrap(
        insertSourceDocument(
          context,
          unwrap(
            prepareSourceDocument({
              sourceDocumentId: "source-document-1",
              rawText: "Senior  Engineer\r\n\r\nBuilt   evidence pipelines.",
              normalizedText: "Senior Engineer\nBuilt evidence pipelines.",
              createdAt: SEED_TIMESTAMP
            })
          )
        )
      );
      unwrap(
        insertCandidateDocument(
          context,
          unwrap(
            prepareCandidateDocument({
              candidateDocumentId: "candidate-document-1",
              candidateId: "candidate-1",
              sourceDocumentId: "source-document-1",
              documentKind: "resume",
              label: "Resume",
              documentOrdinal: 0,
              createdAt: SEED_TIMESTAMP
            })
          )
        )
      );
      return ok(undefined);
    })
  );
}

export function seedRoleAndRubric(connection: RuntimeDatabaseConnection): void {
  unwrap(
    runImmediateTransaction(connection, (context: ImmediateTransactionContext) => {
      unwrap(
        insertRole(
          context,
          unwrap(
            prepareRole({
              roleId: "role-applied-ai-engineer",
              title: "Applied AI Engineer",
              createdAt: SEED_TIMESTAMP
            })
          )
        )
      );
      unwrap(
        insertRequirement(
          context,
          unwrap(
            prepareRequirement({
              requirementId: "requirement-work-authorization",
              roleId: "role-applied-ai-engineer",
              kind: "hard",
              description: "Must be authorized to work in the United States.",
              createdAt: SEED_TIMESTAMP
            })
          )
        )
      );
      unwrap(
        insertRubric(
          context,
          unwrap(
            prepareRubric({
              rubricId: "rubric-sample",
              roleId: "role-applied-ai-engineer",
              version: 1,
              provenanceAuthorship: "product-authored",
              createdAt: SEED_TIMESTAMP
            })
          )
        )
      );
      unwrap(
        insertRubricProvenanceAssumption(
          context,
          unwrap(
            prepareRubricProvenanceAssumption({
              rubricProvenanceAssumptionId: "rubric-provenance-assumption-sample",
              rubricId: "rubric-sample",
              workflowAssumptionId: "WA-05",
              ordinal: 0,
              createdAt: SEED_TIMESTAMP
            })
          )
        )
      );
      unwrap(
        insertRubricDimension(
          context,
          unwrap(
            prepareRubricDimension({
              rubricDimensionId: "rubric-dimension-sample",
              rubricId: "rubric-sample",
              dimensionId: "sample_dimension",
              weight: 2,
              required: true,
              definition: "A sample dimension definition.",
              jobRelatedJustification: "It is job related for the sample role.",
              levelAnchors: {
                none: "None anchor for the sample dimension.",
                weak: "Weak anchor for the sample dimension.",
                partial: "Partial anchor for the sample dimension.",
                strong: "Strong anchor for the sample dimension."
              },
              ordinal: 0,
              createdAt: SEED_TIMESTAMP
            })
          )
        )
      );
      return ok(undefined);
    })
  );
}

export function seedAuditEvent(connection: RuntimeDatabaseConnection): void {
  const prepared = unwrap(
    prepareAuditEvent(
      { now: () => SEED_TIMESTAMP + 100 },
      {
        auditEventId: "integration-audit-event-1",
        commandId: null,
        eventOrdinal: null,
        actorId: "integration-actor-1",
        actorDisplayName: "Integration Operator",
        eventName: "test.event_recorded",
        eventVersion: 1,
        payload: { alpha: 1 },
        occurredAt: SEED_TIMESTAMP
      }
    )
  );

  unwrap(
    runImmediateTransaction(connection, (context: ImmediateTransactionContext) =>
      appendAuditEvent(context, prepared)
    )
  );
}
