import {
    GoogleGenAI,
    FunctionDeclaration,
    GenerationConfig,
    Tool,
} from '@google/genai/node';
import { UserConfiguration } from '../context/types.js'; // Import user config type

export class GeminiClient {
  private geminiShared?: GoogleGenAI; 
  private userGeminiInstances: Map<number, GoogleGenAI> = new Map();

  constructor(sharedApiKey?: string) {
    if (sharedApiKey) {
      this.geminiShared = new GoogleGenAI({ apiKey: sharedApiKey });
      console.log('GeminiClient initialized with a shared API key.');
    } else {
      console.warn(
        'GeminiClient initialized without a shared API key. Per-user keys must be provided via UI.',
      );
    }
  }

  private getGeminiInstance(userConfig?: UserConfiguration): GoogleGenAI {
    if (userConfig?.geminiApiKey) {
      if (!this.userGeminiInstances.has(userConfig.userId)) {
        console.log(`Creating new Gemini instance for user ${userConfig.userId}`);
        this.userGeminiInstances.set(
          userConfig.userId,
          new GoogleGenAI({ apiKey: userConfig.geminiApiKey }),
        );
      }
      return this.userGeminiInstances.get(userConfig.userId)!;
    } else if (this.geminiShared) {
      return this.geminiShared;
    } else {
      throw new Error(
        `No Gemini API key available. Please configure your key in settings or provide a SHARED_GEMINI_API_KEY. User ID: ${userConfig?.userId}`,
      );
    }
  }

  async generateContent(
    messages: any[], // History
    tools?: FunctionDeclaration[], 
    multimodalParts?: any[], // Current turn multimodal parts
    userConfig?: UserConfiguration // User-specific settings
  ): Promise<{ functionCalls?: any[]; text?: string }> { 
    let geminiInstance: GoogleGenAI;
    try {
      geminiInstance = this.getGeminiInstance(userConfig);
    } catch (e) {
      console.error('Error getting Gemini instance:', e);
      throw e; 
    }

    const modelName =
      userConfig?.generalSettings?.geminiModel || 'gemini-1.5-flash-latest'; 

    const model = geminiInstance.getGenerativeModel({ model: modelName });

    const contents = [...messages];
    if (multimodalParts && multimodalParts.length > 0) {
      let lastUserMessageIndex = -1;
      for (let i = contents.length - 1; i >= 0; i--) {
        if (contents[i].role === 'user') {
          lastUserMessageIndex = i;
          break;
        }
      }

      if (lastUserMessageIndex !== -1) {
        if (!contents[lastUserMessageIndex].parts) {
          contents[lastUserMessageIndex].parts = [];
        }
        contents[lastUserMessageIndex].parts.push(...multimodalParts);
      } else {
        contents.push({ role: 'user', parts: multimodalParts });
      }
    }

    const geminiTools: Tool[] = [];
    if (tools && tools.length > 0) {
      geminiTools.push({
        functionDeclarations: tools,
      });
    }

    const generationConfig: GenerationConfig = {
      temperature: userConfig?.generalSettings?.temperature ?? 0.7,
    };
    if (userConfig?.generalSettings?.maxOutputTokens) {
        generationConfig.maxOutputTokens = userConfig.generalSettings.maxOutputTokens;
    }

    const systemInstruction = userConfig?.promptSystemSettings?.systemInstruction;

    try {
      const result = await model.generateContent({
        contents: contents,
        tools: geminiTools.length > 0 ? geminiTools : undefined,
        generationConfig: generationConfig,
        systemInstruction: systemInstruction
          ? { role: 'system', parts: [{ text: systemInstruction }] } 
          : undefined,
      });

      const response = result.response;
      const functionCalls = response.candidates?.[0]?.content?.parts?.filter(p => p.functionCall).map(p => p.functionCall);
      const textResponse = response.text; 

      return {
        functionCalls: functionCalls,
        text: textResponse,
      };
    } catch (error: any) {
      console.error('Error calling Gemini API:', error.message, error.stack);
      throw new Error(`Gemini API error: ${error.message}`);
    }
  }
}
