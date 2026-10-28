CREATE TABLE "ai_chat" (
    "chat_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "pi_session" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_chat_pkey" PRIMARY KEY ("chat_id"),
    CONSTRAINT "ai_chat_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ai_chat_user_id_updated_at_idx" ON "ai_chat"("user_id", "updated_at");
CREATE TABLE "ai_chat_message" (
    "message_id" UUID NOT NULL,
    "chat_id" UUID NOT NULL,
    "role" VARCHAR(20) NOT NULL CHECK ("role" IN ('user', 'assistant')),
    "content" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_chat_message_pkey" PRIMARY KEY ("message_id"),
    CONSTRAINT "ai_chat_message_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "ai_chat"("chat_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ai_chat_message_chat_id_created_at_idx" ON "ai_chat_message"("chat_id", "created_at");
