-- CreateTable
CREATE TABLE "OrganizationAiSettings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "fastModel" TEXT,
    "apiKeyEnc" TEXT,
    "baseUrl" TEXT,
    "embeddingProvider" TEXT,
    "embeddingModel" TEXT,
    "embeddingApiKeyEnc" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationAiSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationAiSettings_organizationId_key" ON "OrganizationAiSettings"("organizationId");

-- AddForeignKey
ALTER TABLE "OrganizationAiSettings" ADD CONSTRAINT "OrganizationAiSettings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
