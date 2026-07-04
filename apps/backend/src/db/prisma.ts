// Single shared PrismaClient for the process. Routes, services, and the
// orchestrator all import this instead of constructing their own client —
// mirrors the pattern already established in prisma/seed.ts and the core
// test suite (which instead inject a fake or a fresh client per test).
import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();
