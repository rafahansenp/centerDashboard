-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'VIEWER');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('USER', 'ASSISTANT');

-- CreateEnum
CREATE TYPE "OrderStatusGroup" AS ENUM ('PAID', 'PENDING_PAYMENT', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'FAILED', 'OTHER');

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "uappiApiKey" TEXT,
    "uappiSecretKey" TEXT,
    "ga4PropertyId" TEXT,
    "ga4BigQueryDataset" TEXT,
    "statusMapping" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'VIEWER',
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppIdentity" (
    "id" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LinkCode" (
    "code" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LinkCode_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "whatsappIdentityId" TEXT NOT NULL,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" "MessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolCallLog" (
    "id" TEXT NOT NULL,
    "messageId" TEXT,
    "organizationId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "success" BOOLEAN NOT NULL,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ToolCallLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessedWebhookEvent" (
    "wamid" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedWebhookEvent_pkey" PRIMARY KEY ("wamid")
);

-- CreateTable
CREATE TABLE "CommerceOrder" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "numeroPedido" TEXT NOT NULL,
    "idPedido" TEXT NOT NULL,
    "statusLabel" TEXT NOT NULL,
    "statusId" INTEGER NOT NULL,
    "statusGroup" "OrderStatusGroup" NOT NULL,
    "canal" TEXT,
    "origem" TEXT,
    "tipoVenda" TEXT,
    "emittedAt" TIMESTAMP(3) NOT NULL,
    "subtotalCents" INTEGER NOT NULL,
    "freightCents" INTEGER NOT NULL,
    "discountCents" INTEGER NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BRL',
    "paymentMethod" TEXT,
    "customerId" TEXT,
    "attributionSource" TEXT,
    "attributionMedium" TEXT,
    "attributionCampaign" TEXT,
    "attributionDevice" TEXT,
    "visitorHash" TEXT,
    "rawPayload" JSONB NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommerceOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommerceOrderItem" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "categoryName" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitPriceCents" INTEGER NOT NULL,
    "totalPriceCents" INTEGER NOT NULL,
    "emittedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommerceOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommerceCustomer" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "emailHash" TEXT,
    "documentHash" TEXT,
    "firstOrderAt" TIMESTAMP(3),
    "lastOrderAt" TIMESTAMP(3),
    "ordersCount" INTEGER NOT NULL DEFAULT 0,
    "totalSpentCents" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CommerceCustomer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttributionTouch" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "visitorHash" TEXT NOT NULL,
    "emailHash" TEXT,
    "source" TEXT,
    "medium" TEXT,
    "campaign" TEXT,
    "device" TEXT,
    "landingPage" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttributionTouch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncState" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "cursorDate" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "backfillDoneAt" TIMESTAMP(3),
    "lastError" TEXT,
    "ordersSynced" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SyncState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_organizationId_idx" ON "User"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppIdentity_phoneE164_key" ON "WhatsAppIdentity"("phoneE164");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppIdentity_userId_key" ON "WhatsAppIdentity"("userId");

-- CreateIndex
CREATE INDEX "WhatsAppIdentity_organizationId_idx" ON "WhatsAppIdentity"("organizationId");

-- CreateIndex
CREATE INDEX "LinkCode_userId_idx" ON "LinkCode"("userId");

-- CreateIndex
CREATE INDEX "Conversation_whatsappIdentityId_lastMessageAt_idx" ON "Conversation"("whatsappIdentityId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "ToolCallLog_organizationId_createdAt_idx" ON "ToolCallLog"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "CommerceOrder_organizationId_emittedAt_idx" ON "CommerceOrder"("organizationId", "emittedAt");

-- CreateIndex
CREATE INDEX "CommerceOrder_organizationId_statusGroup_emittedAt_idx" ON "CommerceOrder"("organizationId", "statusGroup", "emittedAt");

-- CreateIndex
CREATE INDEX "CommerceOrder_organizationId_attributionCampaign_emittedAt_idx" ON "CommerceOrder"("organizationId", "attributionCampaign", "emittedAt");

-- CreateIndex
CREATE INDEX "CommerceOrder_organizationId_visitorHash_idx" ON "CommerceOrder"("organizationId", "visitorHash");

-- CreateIndex
CREATE UNIQUE INDEX "CommerceOrder_organizationId_numeroPedido_key" ON "CommerceOrder"("organizationId", "numeroPedido");

-- CreateIndex
CREATE INDEX "CommerceOrderItem_organizationId_sku_emittedAt_idx" ON "CommerceOrderItem"("organizationId", "sku", "emittedAt");

-- CreateIndex
CREATE INDEX "CommerceOrderItem_organizationId_categoryName_emittedAt_idx" ON "CommerceOrderItem"("organizationId", "categoryName", "emittedAt");

-- CreateIndex
CREATE INDEX "CommerceOrderItem_orderId_idx" ON "CommerceOrderItem"("orderId");

-- CreateIndex
CREATE INDEX "CommerceCustomer_organizationId_firstOrderAt_idx" ON "CommerceCustomer"("organizationId", "firstOrderAt");

-- CreateIndex
CREATE INDEX "CommerceCustomer_organizationId_emailHash_idx" ON "CommerceCustomer"("organizationId", "emailHash");

-- CreateIndex
CREATE UNIQUE INDEX "CommerceCustomer_organizationId_externalId_key" ON "CommerceCustomer"("organizationId", "externalId");

-- CreateIndex
CREATE INDEX "AttributionTouch_organizationId_visitorHash_occurredAt_idx" ON "AttributionTouch"("organizationId", "visitorHash", "occurredAt");

-- CreateIndex
CREATE INDEX "AttributionTouch_organizationId_emailHash_occurredAt_idx" ON "AttributionTouch"("organizationId", "emailHash", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "SyncState_organizationId_resource_key" ON "SyncState"("organizationId", "resource");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppIdentity" ADD CONSTRAINT "WhatsAppIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppIdentity" ADD CONSTRAINT "WhatsAppIdentity_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinkCode" ADD CONSTRAINT "LinkCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_whatsappIdentityId_fkey" FOREIGN KEY ("whatsappIdentityId") REFERENCES "WhatsAppIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolCallLog" ADD CONSTRAINT "ToolCallLog_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolCallLog" ADD CONSTRAINT "ToolCallLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceOrder" ADD CONSTRAINT "CommerceOrder_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceOrder" ADD CONSTRAINT "CommerceOrder_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "CommerceCustomer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceOrderItem" ADD CONSTRAINT "CommerceOrderItem_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceOrderItem" ADD CONSTRAINT "CommerceOrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "CommerceOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceCustomer" ADD CONSTRAINT "CommerceCustomer_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttributionTouch" ADD CONSTRAINT "AttributionTouch_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncState" ADD CONSTRAINT "SyncState_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
