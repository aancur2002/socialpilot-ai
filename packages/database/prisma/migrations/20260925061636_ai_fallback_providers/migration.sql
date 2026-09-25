-- AlterTable
ALTER TABLE "OrganizationAiSettings" ADD COLUMN     "fallbacks" JSONB NOT NULL DEFAULT '[]';
