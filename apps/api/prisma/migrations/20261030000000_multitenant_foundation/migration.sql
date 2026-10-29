-- CreateEnum
CREATE TYPE "OrganizationStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "ModuleStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "ModuleOrigin" AS ENUM ('MANUAL', 'PLAN', 'BILLING');

-- CreateEnum
CREATE TYPE "IntegrationKind" AS ENUM ('COMMERCE', 'WEB_ANALYTICS', 'APP_ANALYTICS', 'PLAY_STORE', 'APP_STORE', 'SPRINT_BOARD');

-- CreateEnum
CREATE TYPE "IntegrationProvider" AS ENUM ('UAPPI', 'GA4', 'GOOGLE_PLAY', 'APP_STORE_CONNECT', 'MONDAY');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('PENDING', 'OK', 'ERROR', 'DISABLED');

-- AlterEnum
-- Renomeia o valor em vez de recriar o tipo: preserva os usuários existentes.
ALTER TYPE "Role" RENAME VALUE 'VIEWER' TO 'MEMBER';
ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'MEMBER';

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "slug" TEXT,
ADD COLUMN     "status" "OrganizationStatus" NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "inputTokens" INTEGER,
ADD COLUMN     "model" TEXT,
ADD COLUMN     "outputTokens" INTEGER;

-- CreateTable
CREATE TABLE "PlatformOperator" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "totpSecret" TEXT,
    "totpEnabledAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformOperator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationModule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "moduleKey" TEXT NOT NULL,
    "status" "ModuleStatus" NOT NULL DEFAULT 'ACTIVE',
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3),
    "origin" "ModuleOrigin" NOT NULL DEFAULT 'MANUAL',
    "updatedByOperatorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationModule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserModuleAccess" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "moduleKey" TEXT NOT NULL,
    "grantedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserModuleAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Integration" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "IntegrationKind" NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "secrets" TEXT,
    "secretsUpdatedAt" TIMESTAMP(3),
    "status" "IntegrationStatus" NOT NULL DEFAULT 'PENDING',
    "lastCheckAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperatorAuditLog" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "organizationId" TEXT,
    "targetType" TEXT,
    "targetId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperatorAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlatformOperator_email_key" ON "PlatformOperator"("email");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationModule_organizationId_moduleKey_key" ON "OrganizationModule"("organizationId", "moduleKey");

-- CreateIndex
CREATE UNIQUE INDEX "UserModuleAccess_userId_moduleKey_key" ON "UserModuleAccess"("userId", "moduleKey");

-- CreateIndex
CREATE UNIQUE INDEX "Integration_organizationId_kind_key" ON "Integration"("organizationId", "kind");

-- CreateIndex
CREATE INDEX "OperatorAuditLog_organizationId_createdAt_idx" ON "OperatorAuditLog"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "OperatorAuditLog_operatorId_createdAt_idx" ON "OperatorAuditLog"("operatorId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- AddForeignKey
ALTER TABLE "OrganizationModule" ADD CONSTRAINT "OrganizationModule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserModuleAccess" ADD CONSTRAINT "UserModuleAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatorAuditLog" ADD CONSTRAINT "OperatorAuditLog_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "PlatformOperator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Auditoria de operador é somente inserção.
CREATE FUNCTION operator_audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'OperatorAuditLog é somente inserção';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER operator_audit_log_no_change
  BEFORE UPDATE OR DELETE ON "OperatorAuditLog"
  FOR EACH ROW EXECUTE FUNCTION operator_audit_log_append_only();
