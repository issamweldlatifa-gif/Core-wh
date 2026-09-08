-- Push registrations for the native Worker App.
-- Additive only: no existing table or column is altered.
CREATE TABLE "push_tokens" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'ANDROID',
    "userId" TEXT NOT NULL,
    "deviceId" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "push_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "push_tokens_token_key" ON "push_tokens"("token");
CREATE INDEX "push_tokens_userId_idx" ON "push_tokens"("userId");

ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
