-- AlterTable
ALTER TABLE "OAuthState" ADD COLUMN     "replaceAccountId" TEXT;

-- CreateTable
CREATE TABLE "PlatformCredential" (
    "id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "clientId" TEXT,
    "clientSecretEnc" TEXT,
    "webhookVerifyTokenEnc" TEXT,
    "configId" TEXT,
    "options" JSONB NOT NULL DEFAULT '{}',
    "checkedAt" TIMESTAMP(3),
    "checkOk" BOOLEAN,
    "checkMessage" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlatformCredential_platform_key" ON "PlatformCredential"("platform");
