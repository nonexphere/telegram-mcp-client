import {
    GoogleGenAI,
    FunctionDeclaration,
    GenerationConfig,
    Tool,
} from '@google/genai/node';
import { UserConfiguration } from '../context/types.js'; // Import user config type
import crypto from 'crypto';

const ALGORITHM = 'aes-256-cbc';
let ENCRYPTION_KEY: Buffer | null = null;
let ENCRYPTION_IV: Buffer | null = null;

if (process.env.ENCRYPTION_KEY) {
    if (process.env.ENCRYPTION_KEY.length === 64 && /^[0-9a-fA-F]+$/.test(process.env.ENCRYPTION_KEY)) {
        ENCRYPTION_KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
    } else {
        console.error('ERROR: ENCRYPTION_KEY is set but not a 64-character hex string. API keys will not be securely decrypted.');
    }
}
if (process.env.ENCRYPTION_IV) {
    if (process.env.ENCRYPTION_IV.length === 32 && /^[0-9a-fA-F]+$/.test(process.env.ENCRYPTION_IV)) {
        ENCRYPTION_IV = Buffer.from(process.env.ENCRYPTION_IV, 'hex');
    } else {
        console.error('ERROR: ENCRYPTION_IV is set but not a 32-character hex string. API keys will not be securely decrypted.');
    }
}

function decrypt(encryptedText: string): string {
    if (!ENCRYPTION_KEY || !ENCRYPTION_IV || !encryptedText) {
        if (!encryptedText) return encryptedText; // if text is null/undefined, return as is
        // If keys are missing, assume plaintext. Warning about plaintext storage is in McpConfigStorage.
        return encryptedText;
    }
    try {
        // A simple check to see if it might be hex. If not, assume plaintext.
        // This is not foolproof but helps avoid errors if a plaintext key was stored.
        if (!/^[0-9a-fA-F]+$/.test(encryptedText) || encryptedText.length < 32) { // Encrypted keys are usually longer
            return encryptedText; // Likely plaintext
        }
        const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, ENCRYPTION_IV);
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (error) {
        // If decryption fails, it might be because the key was stored as plaintext
        // or the key/IV is wrong for this specific encrypted string.
        // console.warn("Decryption failed, attempting to use as plaintext. This might happen if the key was stored as plaintext or if encryption settings changed.", error);
        return encryptedText; // Fallback to using the text as is
    }
}

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
        let apiKey = userConfig.geminiApiKey;
        if (ENCRYPTION_KEY && ENCRYPTION_IV) {
            apiKey = decrypt(apiKey);
        } // If keys not set, apiKey is used as is (assumed plaintext)

        if (!this.userGeminiInstances.has(userConfig.userId) || 
            (this.userGeminiInstances.get(userConfig.userId) as any)?.options?.apiKey !== apiKey) { // Check if key changed
            console.log(`Creating or updating Gemini instance for user ${userConfig.userId}`);
            this.userGeminiInstances.set(
                userConfig.userId,
                new GoogleGenAI({ apiKey }),
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
