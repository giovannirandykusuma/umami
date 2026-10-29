CREATE TABLE "analyst_task" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "chat_id" UUID NOT NULL,
    "goal" VARCHAR(2000) NOT NULL,
    "status" VARCHAR(20) NOT NULL CHECK ("status" IN ('running', 'awaiting_user', 'blocked', 'complete', 'cancelled', 'expired')),
    "budgets" JSONB NOT NULL,
    "paused_at" TIMESTAMPTZ(6),
    "paused_ms" INTEGER NOT NULL DEFAULT 0 CHECK ("paused_ms" >= 0),
    "deadline_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "context" JSONB NOT NULL,
    "draft_ids" JSONB NOT NULL,
    "operation_keys" JSONB NOT NULL,
    "definition_versions" JSONB NOT NULL,
    "receipts" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "analyst_task_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "analyst_task_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "ai_chat"("chat_id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "analyst_task_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "analyst_task_user_id_chat_id_idx" ON "analyst_task"("user_id", "chat_id");
CREATE INDEX "analyst_task_expires_at_idx" ON "analyst_task"("expires_at");
