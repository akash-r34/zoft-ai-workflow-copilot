// POST/GET /api/conversations, GET /api/conversations/:id/messages.
// Mirrors apps/frontend/mock/server.ts's conversation routes exactly.
import type { FastifyInstance } from "fastify";
import type { ConversationDto, CreateRunResponseDto, MessageDto } from "@zoft/contract";
import { CreateConversationBodySchema, CreateRunBodySchema } from "@zoft/contract";
import { prisma } from "../db/prisma.js";
import { toConversationDto, toMessageDto } from "../dto/mappers.js";
import { startRun } from "../runs/run-service.js";
import { ApiErrorException } from "./errors.js";

export function registerConversationRoutes(app: FastifyInstance): void {
  app.post("/api/conversations", async (request): Promise<ConversationDto> => {
    const body = CreateConversationBodySchema.parse(request.body ?? {});
    const title = body.title?.trim();
    const conversation = await prisma.conversation.create({
      data: title && title.length > 0 ? { title } : {},
    });
    return toConversationDto(conversation);
  });

  app.get("/api/conversations", async (): Promise<ConversationDto[]> => {
    const conversations = await prisma.conversation.findMany({ orderBy: { updatedAt: "desc" } });
    return conversations.map(toConversationDto);
  });

  app.get("/api/conversations/:id/messages", async (request): Promise<MessageDto[]> => {
    const { id } = request.params as { id: string };
    const conversation = await prisma.conversation.findUnique({ where: { id } });
    if (!conversation) {
      throw new ApiErrorException("CONVERSATION_NOT_FOUND", `conversation ${id} not found`, 404);
    }
    const messages = await prisma.message.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: "asc" },
    });
    return messages.map(toMessageDto);
  });

  app.post("/api/conversations/:id/runs", async (request): Promise<CreateRunResponseDto> => {
    const { id } = request.params as { id: string };
    const conversation = await prisma.conversation.findUnique({ where: { id } });
    if (!conversation) {
      throw new ApiErrorException("CONVERSATION_NOT_FOUND", `conversation ${id} not found`, 404);
    }
    const body = CreateRunBodySchema.parse(request.body);
    return startRun(prisma, id, body.content);
  });
}
