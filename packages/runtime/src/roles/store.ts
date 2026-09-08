import {
  LockedRubricDimensionSchema,
  RequirementIdSchema,
  RoleIdSchema,
  RubricDimensionIdSchema,
  RubricIdSchema,
  RubricProvenanceAssumptionIdSchema,
  RubricSchema,
  err,
  ok,
  type Result,
  type Rubric
} from "@recruitos/core";

import type { ImmediateTransactionContext } from "../commands/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import {
  RequirementDraftSchema,
  RequirementSchema,
  RoleDraftSchema,
  RoleSchema,
  RubricDimensionDraftSchema,
  RubricDraftSchema,
  RubricProvenanceAssumptionDraftSchema,
  StoredRubricDimensionSchema,
  StoredRubricProvenanceAssumptionSchema,
  StoredRubricSchema,
  type Requirement,
  type Role,
  type StoredRubric,
  type StoredRubricDimension,
  type StoredRubricProvenanceAssumption
} from "./schemas.js";

const preparedRoles = new WeakSet<object>();
const preparedRequirements = new WeakSet<object>();
const preparedRubrics = new WeakSet<object>();
const preparedRubricDimensions = new WeakSet<object>();
const preparedRubricProvenanceAssumptions = new WeakSet<object>();

function persistenceFailure(message: string): RuntimeError {
  return createRuntimeError("persistence_failed", message, false);
}

function validateContext(
  contextInput: unknown
): Result<ImmediateTransactionContext, RuntimeError> {
  if (typeof contextInput !== "object" || contextInput === null) {
    return err(
      persistenceFailure("Role and rubric rows require an active command transaction")
    );
  }
  const context = contextInput as Partial<ImmediateTransactionContext>;
  if (
    typeof context.nativeDatabase !== "object" ||
    context.nativeDatabase === null ||
    context.nativeDatabase.inTransaction !== true
  ) {
    return err(
      persistenceFailure("Role and rubric rows require an active command transaction")
    );
  }
  return ok(context as ImmediateTransactionContext);
}

function requirePrepared<TRecord>(
  registry: WeakSet<object>,
  preparedInput: unknown,
  message: string
): Result<TRecord, RuntimeError> {
  if (
    typeof preparedInput !== "object" ||
    preparedInput === null ||
    !registry.has(preparedInput)
  ) {
    return err(persistenceFailure(message));
  }
  return ok(preparedInput as TRecord);
}

function register<TRecord extends object>(
  registry: WeakSet<object>,
  record: TRecord
): TRecord {
  const frozen = Object.freeze(record);
  registry.add(frozen);
  return frozen;
}

function coreDimensionFromStored(dimension: StoredRubricDimension) {
  return {
    dimensionId: dimension.dimensionId,
    weight: dimension.weight,
    required: dimension.required,
    definition: dimension.definition,
    jobRelatedJustification: dimension.jobRelatedJustification,
    levelAnchors: dimension.levelAnchors
  };
}

function dimensionFromRow(
  row: Record<string, unknown>
): Result<StoredRubricDimension, RuntimeError> {
  const dimension = StoredRubricDimensionSchema.safeParse({
    ...row,
    required: row["required"] === 1,
    levelAnchors: {
      none: row["levelAnchorNone"],
      weak: row["levelAnchorWeak"],
      partial: row["levelAnchorPartial"],
      strong: row["levelAnchorStrong"]
    }
  });
  if (!dimension.success) {
    return err(persistenceFailure("Stored rubric dimension is invalid"));
  }
  return ok(dimension.data);
}

const rubricDimensionSelect = `SELECT
          rubric_dimension_id AS rubricDimensionId,
          rubric_id AS rubricId,
          dimension_id AS dimensionId,
          weight,
          required,
          definition,
          job_related_justification AS jobRelatedJustification,
          level_anchor_none AS levelAnchorNone,
          level_anchor_weak AS levelAnchorWeak,
          level_anchor_partial AS levelAnchorPartial,
          level_anchor_strong AS levelAnchorStrong,
          ordinal,
          created_at AS createdAt
        FROM rubric_dimension`;

export function prepareRole(draftInput: unknown): Result<Role, RuntimeError> {
  try {
    const draft = RoleDraftSchema.safeParse(draftInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid role input"));
    }
    return ok(register(preparedRoles, draft.data));
  } catch {
    return err(persistenceFailure("Role preparation failed"));
  }
}

export function prepareRequirement(
  draftInput: unknown
): Result<Requirement, RuntimeError> {
  try {
    const draft = RequirementDraftSchema.safeParse(draftInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid requirement input"));
    }
    return ok(register(preparedRequirements, draft.data));
  } catch {
    return err(persistenceFailure("Requirement preparation failed"));
  }
}

export function prepareRubric(
  draftInput: unknown
): Result<StoredRubric, RuntimeError> {
  try {
    const draft = RubricDraftSchema.safeParse(draftInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid rubric input"));
    }
    return ok(register(preparedRubrics, draft.data));
  } catch {
    return err(persistenceFailure("Rubric preparation failed"));
  }
}

/**
 * Validates dimension fields against the locked RubricDimension model before
 * the writer lock is taken, so a later assembled rubric can round-trip
 * including the four level anchors.
 */
export function prepareRubricDimension(
  draftInput: unknown
): Result<StoredRubricDimension, RuntimeError> {
  try {
    const draft = RubricDimensionDraftSchema.safeParse(draftInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid rubric dimension input"));
    }
    const coreDimension = LockedRubricDimensionSchema.safeParse(
      coreDimensionFromStored(draft.data)
    );
    if (!coreDimension.success) {
      return err(persistenceFailure("Invalid rubric dimension input"));
    }
    const stored: StoredRubricDimension = {
      rubricDimensionId: draft.data.rubricDimensionId,
      rubricId: draft.data.rubricId,
      dimensionId: coreDimension.data.dimensionId,
      weight: coreDimension.data.weight,
      required: coreDimension.data.required,
      definition: coreDimension.data.definition,
      jobRelatedJustification: coreDimension.data.jobRelatedJustification,
      levelAnchors: coreDimension.data.levelAnchors,
      ordinal: draft.data.ordinal,
      createdAt: draft.data.createdAt
    };
    return ok(register(preparedRubricDimensions, stored));
  } catch {
    return err(persistenceFailure("Rubric dimension preparation failed"));
  }
}

export function prepareRubricProvenanceAssumption(
  draftInput: unknown
): Result<StoredRubricProvenanceAssumption, RuntimeError> {
  try {
    const draft = RubricProvenanceAssumptionDraftSchema.safeParse(draftInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid rubric provenance assumption input"));
    }
    return ok(register(preparedRubricProvenanceAssumptions, draft.data));
  } catch {
    return err(persistenceFailure("Rubric provenance assumption preparation failed"));
  }
}

export function insertRole(
  contextInput: unknown,
  preparedInput: unknown
): Result<Role, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<Role>(
      preparedRoles,
      preparedInput,
      "Invalid prepared role"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const role = prepared.value;

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO role (
          role_id,
          title,
          created_at
        ) VALUES (?, ?, ?)`
      )
      .run(role.roleId, role.title, role.createdAt);

    return ok(role);
  } catch {
    return err(persistenceFailure("Role insert failed"));
  }
}

export function insertRequirement(
  contextInput: unknown,
  preparedInput: unknown
): Result<Requirement, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<Requirement>(
      preparedRequirements,
      preparedInput,
      "Invalid prepared requirement"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const requirement = prepared.value;

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO requirement (
          requirement_id,
          role_id,
          kind,
          description,
          created_at
        ) VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        requirement.requirementId,
        requirement.roleId,
        requirement.kind,
        requirement.description,
        requirement.createdAt
      );

    return ok(requirement);
  } catch {
    return err(persistenceFailure("Requirement insert failed"));
  }
}

export function insertRubric(
  contextInput: unknown,
  preparedInput: unknown
): Result<StoredRubric, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<StoredRubric>(
      preparedRubrics,
      preparedInput,
      "Invalid prepared rubric"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const rubric = prepared.value;

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO rubric (
          rubric_id,
          role_id,
          version,
          provenance_authorship,
          created_at
        ) VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        rubric.rubricId,
        rubric.roleId,
        rubric.version,
        rubric.provenanceAuthorship,
        rubric.createdAt
      );

    return ok(rubric);
  } catch {
    return err(persistenceFailure("Rubric insert failed"));
  }
}

export function insertRubricDimension(
  contextInput: unknown,
  preparedInput: unknown
): Result<StoredRubricDimension, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<StoredRubricDimension>(
      preparedRubricDimensions,
      preparedInput,
      "Invalid prepared rubric dimension"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const dimension = prepared.value;

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO rubric_dimension (
          rubric_dimension_id,
          rubric_id,
          dimension_id,
          weight,
          required,
          definition,
          job_related_justification,
          level_anchor_none,
          level_anchor_weak,
          level_anchor_partial,
          level_anchor_strong,
          ordinal,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        dimension.rubricDimensionId,
        dimension.rubricId,
        dimension.dimensionId,
        dimension.weight,
        dimension.required ? 1 : 0,
        dimension.definition,
        dimension.jobRelatedJustification,
        dimension.levelAnchors.none,
        dimension.levelAnchors.weak,
        dimension.levelAnchors.partial,
        dimension.levelAnchors.strong,
        dimension.ordinal,
        dimension.createdAt
      );

    return ok(dimension);
  } catch {
    return err(persistenceFailure("Rubric dimension insert failed"));
  }
}

export function insertRubricProvenanceAssumption(
  contextInput: unknown,
  preparedInput: unknown
): Result<StoredRubricProvenanceAssumption, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<StoredRubricProvenanceAssumption>(
      preparedRubricProvenanceAssumptions,
      preparedInput,
      "Invalid prepared rubric provenance assumption"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const assumption = prepared.value;

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO rubric_provenance_assumption (
          rubric_provenance_assumption_id,
          rubric_id,
          workflow_assumption_id,
          ordinal,
          created_at
        ) VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        assumption.rubricProvenanceAssumptionId,
        assumption.rubricId,
        assumption.workflowAssumptionId,
        assumption.ordinal,
        assumption.createdAt
      );

    return ok(assumption);
  } catch {
    return err(persistenceFailure("Rubric provenance assumption insert failed"));
  }
}

export function readRole(
  contextInput: unknown,
  roleIdInput: unknown
): Result<Role | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const roleId = RoleIdSchema.safeParse(roleIdInput);
    if (!roleId.success) {
      return err(persistenceFailure("Invalid role ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(
        `SELECT
          role_id AS roleId,
          title,
          created_at AS createdAt
        FROM role
        WHERE role_id = ?`
      )
      .get(roleId.data);
    if (row === undefined) {
      return ok(undefined);
    }
    const role = RoleSchema.safeParse(row);
    if (!role.success) {
      return err(persistenceFailure("Stored role is invalid"));
    }
    return ok(Object.freeze(role.data));
  } catch {
    return err(persistenceFailure("Role read failed"));
  }
}

export function readRequirement(
  contextInput: unknown,
  requirementIdInput: unknown
): Result<Requirement | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const requirementId = RequirementIdSchema.safeParse(requirementIdInput);
    if (!requirementId.success) {
      return err(persistenceFailure("Invalid requirement ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(
        `SELECT
          requirement_id AS requirementId,
          role_id AS roleId,
          kind,
          description,
          created_at AS createdAt
        FROM requirement
        WHERE requirement_id = ?`
      )
      .get(requirementId.data);
    if (row === undefined) {
      return ok(undefined);
    }
    const requirement = RequirementSchema.safeParse(row);
    if (!requirement.success) {
      return err(persistenceFailure("Stored requirement is invalid"));
    }
    return ok(Object.freeze(requirement.data));
  } catch {
    return err(persistenceFailure("Requirement read failed"));
  }
}

export function readRubric(
  contextInput: unknown,
  rubricIdInput: unknown
): Result<StoredRubric | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const rubricId = RubricIdSchema.safeParse(rubricIdInput);
    if (!rubricId.success) {
      return err(persistenceFailure("Invalid rubric ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(
        `SELECT
          rubric_id AS rubricId,
          role_id AS roleId,
          version,
          provenance_authorship AS provenanceAuthorship,
          created_at AS createdAt
        FROM rubric
        WHERE rubric_id = ?`
      )
      .get(rubricId.data);
    if (row === undefined) {
      return ok(undefined);
    }
    const rubric = StoredRubricSchema.safeParse(row);
    if (!rubric.success) {
      return err(persistenceFailure("Stored rubric is invalid"));
    }
    return ok(Object.freeze(rubric.data));
  } catch {
    return err(persistenceFailure("Rubric read failed"));
  }
}

export function readRubricDimension(
  contextInput: unknown,
  rubricDimensionIdInput: unknown
): Result<StoredRubricDimension | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const rubricDimensionId = RubricDimensionIdSchema.safeParse(
      rubricDimensionIdInput
    );
    if (!rubricDimensionId.success) {
      return err(persistenceFailure("Invalid rubric dimension ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(`${rubricDimensionSelect}
        WHERE rubric_dimension_id = ?`)
      .get(rubricDimensionId.data) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return ok(undefined);
    }
    const dimension = dimensionFromRow(row);
    if (!dimension.ok) {
      return dimension;
    }
    return ok(Object.freeze(dimension.value));
  } catch {
    return err(persistenceFailure("Rubric dimension read failed"));
  }
}

export function readRubricProvenanceAssumption(
  contextInput: unknown,
  assumptionIdInput: unknown
): Result<StoredRubricProvenanceAssumption | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const assumptionId = RubricProvenanceAssumptionIdSchema.safeParse(
      assumptionIdInput
    );
    if (!assumptionId.success) {
      return err(persistenceFailure("Invalid rubric provenance assumption ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(
        `SELECT
          rubric_provenance_assumption_id AS rubricProvenanceAssumptionId,
          rubric_id AS rubricId,
          workflow_assumption_id AS workflowAssumptionId,
          ordinal,
          created_at AS createdAt
        FROM rubric_provenance_assumption
        WHERE rubric_provenance_assumption_id = ?`
      )
      .get(assumptionId.data);
    if (row === undefined) {
      return ok(undefined);
    }
    const assumption = StoredRubricProvenanceAssumptionSchema.safeParse(row);
    if (!assumption.success) {
      return err(persistenceFailure("Stored rubric provenance assumption is invalid"));
    }
    return ok(Object.freeze(assumption.data));
  } catch {
    return err(persistenceFailure("Rubric provenance assumption read failed"));
  }
}

function readStoredDimensions(
  context: ImmediateTransactionContext,
  rubricId: string
): Result<readonly StoredRubricDimension[], RuntimeError> {
  const rows = context.nativeDatabase
    .prepare(
      `${rubricDimensionSelect}
      WHERE rubric_id = ?
      ORDER BY ordinal ASC`
    )
    .all(rubricId) as ReadonlyArray<Record<string, unknown>>;

  const dimensions: StoredRubricDimension[] = [];
  for (const row of rows) {
    const dimension = dimensionFromRow(row);
    if (!dimension.ok) {
      return dimension;
    }
    dimensions.push(dimension.value);
  }
  return ok(dimensions);
}

function readStoredAssumptions(
  context: ImmediateTransactionContext,
  rubricId: string
): Result<readonly StoredRubricProvenanceAssumption[], RuntimeError> {
  const rows = context.nativeDatabase
    .prepare(
      `SELECT
        rubric_provenance_assumption_id AS rubricProvenanceAssumptionId,
        rubric_id AS rubricId,
        workflow_assumption_id AS workflowAssumptionId,
        ordinal,
        created_at AS createdAt
      FROM rubric_provenance_assumption
      WHERE rubric_id = ?
      ORDER BY ordinal ASC`
    )
    .all(rubricId);

  const assumptions: StoredRubricProvenanceAssumption[] = [];
  for (const row of rows) {
    const assumption = StoredRubricProvenanceAssumptionSchema.safeParse(row);
    if (!assumption.success) {
      return err(persistenceFailure("Stored rubric provenance assumption is invalid"));
    }
    assumptions.push(assumption.data);
  }
  return ok(assumptions);
}

function validateContiguousOrdinals(
  ordinals: readonly number[],
  emptyMessage: string
): Result<void, RuntimeError> {
  if (ordinals.length === 0) {
    return err(persistenceFailure(emptyMessage));
  }
  if (ordinals[0] !== 0) {
    return err(persistenceFailure("Rubric dimension ordinals must start at 0"));
  }
  for (let index = 0; index < ordinals.length; index += 1) {
    if (ordinals[index] !== index) {
      return err(persistenceFailure("Rubric dimension ordinals must be contiguous"));
    }
  }
  return ok(undefined);
}

function validateDimensionOrdinals(
  dimensions: readonly StoredRubricDimension[]
): Result<void, RuntimeError> {
  return validateContiguousOrdinals(
    dimensions.map((dimension) => dimension.ordinal),
    "Stored rubric has no dimensions"
  );
}

function validateAssumptionOrdinals(
  assumptions: readonly StoredRubricProvenanceAssumption[]
): Result<void, RuntimeError> {
  const ordinals = assumptions.map((assumption) => assumption.ordinal);
  if (ordinals.length === 0) {
    return err(persistenceFailure("Stored rubric has no provenance assumptions"));
  }
  if (ordinals[0] !== 0) {
    return err(
      persistenceFailure("Rubric provenance assumption ordinals must start at 0")
    );
  }
  for (let index = 0; index < ordinals.length; index += 1) {
    if (ordinals[index] !== index) {
      return err(
        persistenceFailure("Rubric provenance assumption ordinals must be contiguous")
      );
    }
  }
  return ok(undefined);
}

/**
 * Reconstructs a core Rubric from stored header, provenance assumption, and
 * dimension rows. Callers insert children separately; this is the round-trip
 * proof that the stored rows still satisfy RubricSchema, including provenance
 * and level anchors.
 */
export function readCoreRubric(
  contextInput: unknown,
  rubricIdInput: unknown
): Result<Rubric | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const header = readRubric(contextInput, rubricIdInput);
    if (!header.ok) {
      return header;
    }
    if (header.value === undefined) {
      return ok(undefined);
    }

    const storedDimensions = readStoredDimensions(
      context.value,
      header.value.rubricId
    );
    if (!storedDimensions.ok) {
      return storedDimensions;
    }
    const ordinals = validateDimensionOrdinals(storedDimensions.value);
    if (!ordinals.ok) {
      return ordinals;
    }

    const storedAssumptions = readStoredAssumptions(
      context.value,
      header.value.rubricId
    );
    if (!storedAssumptions.ok) {
      return storedAssumptions;
    }
    const assumptionOrdinals = validateAssumptionOrdinals(storedAssumptions.value);
    if (!assumptionOrdinals.ok) {
      return assumptionOrdinals;
    }

    const rubric = RubricSchema.safeParse({
      rubricId: header.value.rubricId,
      version: header.value.version,
      provenance: {
        authorship: header.value.provenanceAuthorship,
        restsOn: storedAssumptions.value.map(
          (assumption) => assumption.workflowAssumptionId
        )
      },
      dimensions: storedDimensions.value.map(coreDimensionFromStored)
    });
    if (!rubric.success) {
      return err(persistenceFailure("Stored rubric is invalid"));
    }
    return ok(Object.freeze(rubric.data));
  } catch {
    return err(persistenceFailure("Rubric read failed"));
  }
}
