-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "userId" TEXT,
ALTER COLUMN "whatsappIdentityId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "Conversation_userId_lastMessageAt_idx" ON "Conversation"("userId", "lastMessageAt");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
