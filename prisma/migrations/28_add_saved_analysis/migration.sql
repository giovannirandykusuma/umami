-- Additive only: new tables plus a defaulted board revision column.
ALTER TABLE "board" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "saved_analysis" (
    "analysis_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "team_id" UUID,
    "name" VARCHAR(200) NOT NULL,
    "description" VARCHAR(500),
    "schema_version" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL,
    "status" VARCHAR(20) NOT NULL CHECK ("status" IN ('draft', 'ready')),
    "definition" JSONB NOT NULL,
    "definition_hash" VARCHAR(64) NOT NULL,
    "created_by_task_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "saved_analysis_pkey" PRIMARY KEY ("analysis_id")
);
CREATE INDEX "saved_analysis_user_id_idx" ON "saved_analysis"("user_id");
CREATE INDEX "saved_analysis_team_id_idx" ON "saved_analysis"("team_id");
CREATE INDEX "saved_analysis_created_at_idx" ON "saved_analysis"("created_at");

CREATE TABLE "saved_analysis_revision" (
    "analysis_revision_id" UUID NOT NULL,
    "analysis_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" VARCHAR(500),
    "status" VARCHAR(20) NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "definition_hash" VARCHAR(64) NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "saved_analysis_revision_pkey" PRIMARY KEY ("analysis_revision_id")
);
CREATE UNIQUE INDEX "saved_analysis_revision_analysis_id_revision_key" ON "saved_analysis_revision"("analysis_id", "revision");

CREATE TABLE "analysis_operation" (
    "analysis_operation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "task_scope" VARCHAR(64) NOT NULL,
    "key" VARCHAR(200) NOT NULL,
    "request_hash" VARCHAR(64) NOT NULL,
    "result" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "analysis_operation_pkey" PRIMARY KEY ("analysis_operation_id")
);
CREATE UNIQUE INDEX "analysis_operation_user_id_task_scope_key_key" ON "analysis_operation"("user_id", "task_scope", "key");

CREATE TABLE "analysis_confirmation" (
    "analysis_confirmation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "task_scope" VARCHAR(64) NOT NULL,
    "board_id" UUID NOT NULL,
    "expected_revision" INTEGER NOT NULL,
    "diff_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "analysis_confirmation_pkey" PRIMARY KEY ("analysis_confirmation_id")
);
CREATE INDEX "analysis_confirmation_user_id_task_scope_idx" ON "analysis_confirmation"("user_id", "task_scope");
