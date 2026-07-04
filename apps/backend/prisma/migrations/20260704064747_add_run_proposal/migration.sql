-- AlterTable
ALTER TABLE "run" ADD COLUMN     "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "proposalStatus" TEXT,
ADD COLUMN     "proposalSummary" TEXT,
ADD COLUMN     "proposedGraph" JSONB,
ADD COLUMN     "proposedOps" JSONB;
