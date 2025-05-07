// This module manages user conversation history using the database.

import type { PrismaClient, Prisma } from '@prisma/client';
// Interfaces ChatHistoryRow and LastMessageRow might not be strictly needed
// if relying on Prisma's generated types, but kept if used for casting or clarity.
// interface ChatHistoryRow {
//   role: string;
//   contentJson: Prisma.JsonValue; // Prisma's JsonValue type
// }
// interface LastMessageRow {
//   message_index: number; // Prisma schema uses messageIndex
// }
export class ConversationManager {
  private db: PrismaClient;

  constructor(db: PrismaClient) {
    this.db = db;
  }

    async getHistory(chatId: number): Promise<any[]> {
        try {
            const rows = await this.db.chatHistory.findMany({
                where: { chatId },
                orderBy: { messageIndex: 'asc' },
                select: { role: true, contentJson: true },
            });
            return rows.map((row) => {
                // contentJson is already an object if Prisma's Json type is used correctly
                // and the data in DB is valid JSON.
                return {
                    role: row.role,
                    parts: row.contentJson, // Prisma's JsonValue
                };
            });
        } catch (error) {
            console.error(`Error loading chat history for chat ${chatId}:`, error);
            throw error;
        }
    }

    async addMessage(chatId: number, message: any): Promise<void> {
        try {
            const lastMessage = await this.db.chatHistory.findFirst({
                where: { chatId },
                orderBy: { messageIndex: 'desc' },
                select: { messageIndex: true },
            });
            const nextIndex = lastMessage ? lastMessage.messageIndex + 1 : 0;

            await this.db.chatHistory.create({
                data: {
                    chatId,
                    messageIndex: nextIndex,
                    role: message.role,
                    contentJson: message.parts as Prisma.InputJsonValue, // Prisma handles JSON serialization
                },
            });
            console.log(`Added message to chat history for chat ${chatId}, index ${nextIndex}.`);
        } catch (error) {
            console.error(`Error adding message to chat history for chat ${chatId}:`, error);
            throw error;
        }
    }

    async clearHistory(chatId: number): Promise<void> {
        try {
            await this.db.chatHistory.deleteMany({ where: { chatId } });
            console.log(`Cleared chat history for chat ${chatId}.`);
        } catch (error) {
            console.error(`Error clearing chat history for chat ${chatId}:`, error);
            throw error;
        }
    }
}
