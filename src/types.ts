/**
 * @file Shared Zod schemas and types for MCP notifications.
 */
import { z } from 'zod';

// Schema for the parameters of a logging message notification
export const LoggingMessageParamsSchema = z.object({
  level: z.string(), // Or z.enum(['error', 'warn', 'info', 'debug', 'trace']) if levels are fixed
  data: z.any(), // Can be more specific if the structure of 'data' is known
});

// Schema for the entire logging message notification
export const LoggingMessageNotificationSchema = z.object({
  method: z.literal('notifications/message'),
  params: LoggingMessageParamsSchema,
});
export type LoggingMessageNotification = z.infer<typeof LoggingMessageNotificationSchema>;

// Schema for tool list changed notification (params might be empty or structured)
export const ToolListChangedNotificationSchema = z.object({
  method: z.literal('notifications/tools/list_changed'),
  params: z.object({}).optional(), // Assuming params can be an empty object or not present
});
export type ToolListChangedNotification = z.infer<typeof ToolListChangedNotificationSchema>;

// Schema for resource list changed notification (params might be empty or structured)
export const ResourceListChangedNotificationSchema = z.object({
  method: z.literal('notifications/resources/list_changed'),
  params: z.object({}).optional(), // Assuming params can be an empty object or not present
});
export type ResourceListChangedNotification = z.infer<typeof ResourceListChangedNotificationSchema>;
