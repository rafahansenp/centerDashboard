/*
  Warnings:

  - You are about to drop the column `sprintLabel` on the `SprintTask` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "BugfixEnvironment" AS ENUM ('TESTE', 'PRODUCAO');

-- DropIndex
DROP INDEX "SprintTask_organizationId_sprintLabel_status_idx";

-- AlterTable
ALTER TABLE "SprintTask" DROP COLUMN "sprintLabel",
ADD COLUMN     "bugfixEnvironment" "BugfixEnvironment",
ADD COLUMN     "sprintNumber" INTEGER;

-- CreateTable
CREATE TABLE "SprintCycle" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sprintNumber" INTEGER NOT NULL,
    "totalTasks" INTEGER NOT NULL,
    "planned" INTEGER NOT NULL,
    "carriedFromPrevious" INTEGER NOT NULL,
    "additionalTasks" INTEGER NOT NULL,
    "completed" INTEGER NOT NULL,
    "carriedToNext" INTEGER NOT NULL,
    "bugfixTest" INTEGER NOT NULL,
    "bugfixProduction" INTEGER NOT NULL,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "rawPayload" JSONB NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SprintCycle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SprintCycle_organizationId_sprintNumber_idx" ON "SprintCycle"("organizationId", "sprintNumber");

-- CreateIndex
CREATE UNIQUE INDEX "SprintCycle_organizationId_sprintNumber_key" ON "SprintCycle"("organizationId", "sprintNumber");

-- CreateIndex
CREATE INDEX "SprintTask_organizationId_sprintNumber_status_idx" ON "SprintTask"("organizationId", "sprintNumber", "status");

-- AddForeignKey
ALTER TABLE "SprintCycle" ADD CONSTRAINT "SprintCycle_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
