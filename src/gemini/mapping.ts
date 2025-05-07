typescript
import { FunctionDeclaration, Type } from '@google/genai/node';
import { Tool } from '@modelcontextprotocol/sdk/client';
import { JSONSchema7 } from 'json-schema'; // Assuming MCP uses JSON Schema Draft 7

// Helper function to map JSONSchema7 types to Gemini FunctionDeclaration parameter types
// Now using the public Type enum
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

// Recursive helper to map JSONSchema7 properties to Gemini ParameterSpec properties structure
function mapJsonSchemaPropertiesToGeminiParameterProps(
  properties: { [key: string]: JSONSchema7 } | undefined
): { [key: string]: { type: Type; description?: string; enum?: string[] } } | undefined { // Simplified type for Gemini props

  if (!properties) return undefined;

  const geminiProperties: { [key: string]: { type: Type; description?: string; enum?: string[] } } = {};

  for (const key in properties) {
    if (Object.prototype.hasOwnProperty.call(properties, key)) {
      const propSchema = properties[key];

      // Map to the simplified Gemini ParameterSpec.properties value structure
      geminiProperties[key] = {
        type: mapJsonSchemaTypeToGeminiType(propSchema.type as JSONSchema7['type']), // Cast type
        description: propSchema.description,
        enum: Array.isArray(propSchema.enum) ? propSchema.enum.map(String) : undefined, // Enum values are strings in Gemini
        // Note: Nested properties/items are not supported recursively in this simplified mapping.
      };
    }
  }
  return geminiProperties;
}

// Helper to map JSONSchema7 items to Gemini ParameterSpec items structure (for arrays)
function mapJsonSchemaItemsToGeminiParameterItems(
  items: JSONSchema7 | JSONSchema7[] | undefined
): { type: Type; description?: string; enum?: string[] } | undefined { // Simplified type for Gemini items value

  if (!items) return undefined;

  // Assuming items is a single schema object as per common JSON Schema practice for arrays
  const itemSchema = items as JSONSchema7;

  // Map to the simplified Gemini ParameterSpec.items value structure
  const geminiItems: { type: Type; description?: string; enum?: string[] } = {
    type: mapJsonSchemaTypeToGeminiType(itemSchema.type as JSONSchema7['type']), // Cast type
    description: itemSchema.description,
    enum: Array.isArray(itemSchema.enum) ? itemSchema.enum.map(String) : undefined,
    // Note: Nested structures within items not supported recursively in this simplified mapping.
  };

  return geminiItems;
}


// Maps an MCP Tool object to a Gemini FunctionDeclaration object
export function mapMcpToolToGeminiFunctionDeclaration(tool: Tool, serverName: string): FunctionDeclaration {
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
        type: mapJsonSchemaTypeToGeminiType(inputSchema.type as JSONSchema7['type']), // Map the top-level type of the inputSchema
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


    const geminiTool: FunctionDeclaration = {
      name: `${tool.name}_${serverName}`, // Map tool name to include server name for routing
      description: tool.description || 'No description provided.',
      parameters: geminiParameters, // Use the correctly mapped parameters
       // Annotations are MCP specific, not directly mapped to Gemini FunctionDeclaration
       // but could potentially be included in the description if helpful for the model.
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
