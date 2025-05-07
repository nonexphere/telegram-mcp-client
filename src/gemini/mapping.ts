/**
 * @file Maps Model Context Protocol (MCP) Tool schemas to Google Gemini FunctionDeclarations.
 */

import { FunctionDeclaration, Type } from '@google/genai/node'; // Changed from '@google/genai'
// TODO: Consider using zod-to-json-schema for more robust conversion if MCP SDK exposes zod schemas directly.
// Assuming MCP Tool is correctly imported if needed, or its structure is known.
// For this mapping, we only need the structure of MCP's Tool, which we assume is similar to:
interface McpTool {
    name: string;
    description?: string;
    inputSchema: any; // JSONSchema7 structure
    // annotations?: any; // MCP specific, not directly mapped
}
import type { JSONSchema7 } from 'json-schema'; // Assuming MCP uses JSON Schema Draft 7

/**
 * Maps a JSONSchema7 type string to the corresponding Gemini API Type enum.
 * Falls back to STRING for unsupported types.
 * @param schemaType - The JSONSchema7 type string (e.g., 'string', 'number', 'object').
 * @returns The corresponding Gemini Type enum value.
 */
function mapJsonSchemaTypeToGeminiType(schemaType: JSONSchema7['type']): Type {
  switch (schemaType) {
    case 'string':
      return Type.STRING;
    case 'number':
      return Type.NUMBER;
    case 'integer':
      return Type.INTEGER;
    case 'boolean':
      return Type.BOOLEAN;
    case 'array':
      return Type.ARRAY;
    case 'object':
      return Type.OBJECT;
    // Add other types if needed (e.g. 'null' if used, but often mapped to nullable union)
    // Gemini doesn't have a direct 'null' type, map to STRING or relevant type
    default:
      // Fallback or throw error for unsupported types
      console.warn(`Unsupported JSON Schema type: ${schemaType}. Mapping to STRING.`);
      return Type.STRING;
  }
}

/**
 * Maps JSONSchema7 properties object to the Gemini FunctionDeclaration parameter properties structure.
 * Recursively maps nested properties if needed (though Gemini schema depth is limited).
 * @param properties - The JSONSchema7 properties object.
 * @returns The Gemini parameter properties object or undefined.
 */
function mapJsonSchemaPropertiesToGeminiParameterProps(
  properties: { [key: string]: JSONSchema7 } | undefined
): { [key: string]: { type: Type; description?: string; enum?: string[] } } | undefined { // Simplified type for Gemini props
  if (!properties) return undefined;

  const geminiProperties: { [key: string]: { type: Type; description?: string; enum?: string[] } } = {};

  for (const key in properties) {
    if (Object.prototype.hasOwnProperty.call(properties, key)) {
      const propSchema = properties[key];

      geminiProperties[key] = {
        type: mapJsonSchemaTypeToGeminiType(propSchema.type as JSONSchema7['type']),
        description: propSchema.description,
        enum: Array.isArray(propSchema.enum) ? propSchema.enum.map(String) : undefined, // Enum values are strings in Gemini
      };
    }
  }
  return geminiProperties;
}

/**
 * Maps a JSONSchema7 'items' definition (for arrays) to the Gemini FunctionDeclaration parameter items structure.
 * Assumes 'items' is a single schema object, not an array of schemas.
 * @param items - The JSONSchema7 items definition.
 * @returns The Gemini parameter items object or undefined.
 */
function mapJsonSchemaItemsToGeminiParameterItems(
  items: JSONSchema7 | JSONSchema7[] | undefined
): { type: Type; description?: string; enum?: string[] } | undefined { // Simplified type for Gemini items value
  if (!items) return undefined;

  // Assuming items is a single schema object as per common JSON Schema practice for arrays
  const itemSchema = items as JSONSchema7;
  return {
    type: mapJsonSchemaTypeToGeminiType(itemSchema.type as JSONSchema7['type']),
    description: itemSchema.description,
    enum: Array.isArray(itemSchema.enum) ? itemSchema.enum.map(String) : undefined,
  };
}

/**
 * Maps an MCP Tool object (containing a JSONSchema7 input schema) to a Gemini FunctionDeclaration object.
 * Handles mapping of type, description, properties, items, required fields, and enums.
 * Appends the serverName to the tool name for routing purposes.
 * @param tool - The MCP Tool object.
 * @param serverName - The name of the MCP server providing the tool.
 * @returns A Gemini FunctionDeclaration object.
 */
export function mapMcpToolToGeminiFunctionDeclaration(tool: McpTool, serverName: string): FunctionDeclaration {
  try {
    // Ensure inputSchema is treated as a JSONSchema7 object
    const inputSchema = tool.inputSchema as JSONSchema7;

    // The Gemini FunctionDeclaration has 'name', 'description', and 'parameters'.
    // The MCP Tool has 'name', 'description', and 'inputSchema'.
    // We need to map MCP Tool.inputSchema to Gemini FunctionDeclaration.parameters.

    // Gemini's 'parameters' field is a single ParameterSpec.
    // ParameterSpec has 'type', 'description', 'properties', 'items', 'enum', 'required'.
    // The 'properties' field within ParameterSpec is used when the parameter type is 'OBJECT'.
    // The 'items' field within ParameterSpec is used when the parameter type is 'ARRAY'.
    // 'required' is an array of string keys that should be present if 'type' is 'OBJECT'.
    // 'enum' is an array of strings for string/number/integer types.

    const geminiParameters: FunctionDeclaration['parameters'] = { // Use the specific type from GenAI SDK
        type: mapJsonSchemaTypeToGeminiType(inputSchema.type as JSONSchema7['type']),
        description: inputSchema.description, // Description can be on inputSchema too
        required: inputSchema.required || [], // Required array at the top level of ParameterSpec
        enum: Array.isArray(inputSchema.enum) ? inputSchema.enum.map(String) : undefined, // Enum at top level

        // Map nested properties if the top-level type is 'object'
        properties: inputSchema.type === 'object' && inputSchema.properties
            ? mapJsonSchemaPropertiesToGeminiParameterProps(inputSchema.properties as { [key: string]: JSONSchema7 })
            : undefined,

         // Map nested items if the top-level type is 'array'
        items: inputSchema.type === 'array' && inputSchema.items
           ? mapJsonSchemaItemsToGeminiParameterItems(inputSchema.items as JSONSchema7 | JSONSchema7[]) // Assuming single item schema
           : undefined,

    };

    // Remove empty required array if it exists, as Gemini expects undefined if not present
    if (geminiParameters.required && geminiParameters.required.length === 0) {
        delete geminiParameters.required;
    }
    if (geminiParameters.enum && geminiParameters.enum.length === 0) {
        delete geminiParameters.enum;
    }


    const geminiTool: FunctionDeclaration = {
      name: `${tool.name}_${serverName}`, // Map tool name to include server name for routing
      description: tool.description || 'No description provided.',
      parameters: geminiParameters, // Use the correctly mapped parameters
    };

    return geminiTool;
  } catch (error) {
     console.error(`Error mapping tool "${tool.name}" from server "${serverName}" to Gemini format:`, error);
     // Return a minimal tool definition indicating an error, or just skip it (skipping might lose capability)
     // Returning an error tool lets Gemini know something is wrong with this specific tool
     return {
         name: `${tool.name}_${serverName}_mapping_error`, // Indicate error in name
         description: `Error mapping tool: ${tool.name}. Please check the server's tool definition. Details: ${error instanceof Error ? error.message : String(error)}`,
         parameters: { type: Type.OBJECT, properties: {} } // Minimal valid parameters for error tool
     };
  }
}
