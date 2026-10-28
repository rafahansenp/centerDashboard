-- CreateEnum
CREATE TYPE "StorePlatform" AS ENUM ('ANDROID', 'IOS');

-- CreateEnum
CREATE TYPE "FeedbackOrigin" AS ENUM ('STORE_ANDROID', 'STORE_IOS', 'MARKETPLACE');

-- CreateEnum
CREATE TYPE "FeedbackCategory" AS ENUM ('CRITICA', 'ERRO', 'SUGESTAO', 'ELOGIO', 'OUTRO');

-- CreateEnum
CREATE TYPE "SprintTaskArea" AS ENUM ('FRONT', 'BACK');

-- CreateEnum
CREATE TYPE "SprintTaskType" AS ENUM ('MELHORIA', 'CORRECAO', 'BUGFIX', 'MODULO');

-- CreateEnum
CREATE TYPE "SprintTaskStatus" AS ENUM ('PLANEJADO', 'ADICIONAL', 'ENTREGUE');

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "appStoreConnectKeyJson" TEXT,
ADD COLUMN     "ga4AppPropertyId" TEXT,
ADD COLUMN     "mondayApiToken" TEXT,
ADD COLUMN     "mondayBoardId" TEXT,
ADD COLUMN     "playConsoleCredsJson" TEXT;

-- CreateTable
CREATE TABLE "AppStoreSnapshot" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "platform" "StorePlatform" NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "averageRating" DOUBLE PRECISION NOT NULL,
    "ratingCount" INTEGER NOT NULL,
    "appVersion" TEXT,
    "rawPayload" JSONB NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppStoreSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppFeedback" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "origin" "FeedbackOrigin" NOT NULL,
    "category" "FeedbackCategory" NOT NULL,
    "rating" INTEGER,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "rawPayload" JSONB NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SprintTask" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "area" "SprintTaskArea" NOT NULL,
    "type" "SprintTaskType" NOT NULL,
    "status" "SprintTaskStatus" NOT NULL,
    "sprintLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "rawPayload" JSONB NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SprintTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AppStoreSnapshot_organizationId_platform_capturedAt_idx" ON "AppStoreSnapshot"("organizationId", "platform", "capturedAt");

-- CreateIndex
CREATE INDEX "AppFeedback_organizationId_occurredAt_idx" ON "AppFeedback"("organizationId", "occurredAt");

-- CreateIndex
CREATE INDEX "AppFeedback_organizationId_category_occurredAt_idx" ON "AppFeedback"("organizationId", "category", "occurredAt");

-- CreateIndex
CREATE INDEX "AppFeedback_organizationId_origin_occurredAt_idx" ON "AppFeedback"("organizationId", "origin", "occurredAt");

-- CreateIndex
CREATE INDEX "SprintTask_organizationId_sprintLabel_status_idx" ON "SprintTask"("organizationId", "sprintLabel", "status");

-- CreateIndex
CREATE INDEX "SprintTask_organizationId_createdAt_idx" ON "SprintTask"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SprintTask_organizationId_externalId_key" ON "SprintTask"("organizationId", "externalId");

-- AddForeignKey
ALTER TABLE "AppStoreSnapshot" ADD CONSTRAINT "AppStoreSnapshot_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppFeedback" ADD CONSTRAINT "AppFeedback_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SprintTask" ADD CONSTRAINT "SprintTask_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
