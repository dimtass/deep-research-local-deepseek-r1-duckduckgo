import { createOpenAI } from '@ai-sdk/openai';
import { LanguageModelV1, LanguageModelV1CallOptions, LanguageModelV1Prompt } from 'ai';
import { getEncoding } from 'js-tiktoken';
import json5 from 'json5';

import { RecursiveCharacterTextSplitter } from './text-splitter';

class AIJSONParseError extends Error {
  constructor(message: string, public rawResponse: string) {
    super(message);
    this.name = 'AIJSONParseError';
  }
}

// Providers

const openai = createOpenAI({
  apiKey: process.env.OPENAI_KEY!,
});

// LM Studio provider
function extractJSONFromResponse(response: string): { text: string; isJSON: boolean } {
  // Remove the <think> section
  const cleanedResponse = response.replace(/<think>[\s\S]*?<\/think>\s*/, '').trim();
  
  // Remove markdown code block delimiters
  const content = cleanedResponse.replace(/^```json\s*|\s*```$/g, '').trim();
  
  try {
    const parsed = json5.parse(content);
    if (!parsed.queries && parsed.learnings) {
      parsed.queries = parsed.learnings.map((learning: string) => ({ query: learning, researchGoal: '' }));
    }
    if (!Array.isArray(parsed.queries)) {
      parsed.queries = [];
    }
    return { text: JSON.stringify(parsed), isJSON: true };
  } catch (error) {
    console.warn('Failed to parse response as JSON. Attempting to extract structured data from markdown.');
    
    const extractedData: any = {
      queries: [],
      learnings: [],
      followUpQuestions: []
    };

    const learningsMatch = content.match(/\*\*.*Learnings.*\*\*([\s\S]*?)(?:\*\*|$)/i);
    if (learningsMatch && learningsMatch[1]) {
      extractedData.learnings = learningsMatch[1].trim().split('\n\n').map(item => item.replace(/^\d+\.\s*\*\*/, '').replace(/:\*\*\s*/, ': ').trim());
      extractedData.queries = extractedData.learnings.map((learning: string) => ({ query: learning, researchGoal: '' }));
    }

    const questionsMatch = content.match(/\*\*Follow-Up Questions.*\*\*([\s\S]*?)(?:\n\n|$)/i);
    if (questionsMatch && questionsMatch[1]) {
      extractedData.followUpQuestions = questionsMatch[1].trim().split('\n').map(item => item.replace(/^-\s*/, '').trim());
    }

    console.log('Extracted data:', extractedData);
    return { text: JSON.stringify(extractedData), isJSON: true };
  }
}

const createLMStudio = (baseUrl: string): ((model: string, options: any) => LanguageModelV1) => {
  return (model: string, options: any): LanguageModelV1 => {
    const generate = async (messages: any[]): Promise<string> => {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          ...options,
        }),
      });

      if (!response.ok) {
        throw new Error(`LM Studio API error: ${response.statusText}`);
      }

      const result = await response.json();
      return result.choices[0].message.content;
    };

    return {
      specificationVersion: "v1",
      provider: "LM Studio",
      modelId: model,
      defaultObjectGenerationMode: 'json' as const,
      doGenerate: async (callOptions: LanguageModelV1CallOptions) => {
        let messages;
        if (typeof callOptions.prompt === 'string') {
          messages = [{ role: 'user', content: callOptions.prompt }];
        } else if (Array.isArray(callOptions.prompt)) {
          messages = callOptions.prompt;
        } else {
          throw new Error('Unsupported prompt type');
        }

        const fullResponse = await generate(messages);
        const { text, isJSON } = extractJSONFromResponse(fullResponse);
        
        let responseText: string;
        if (isJSON) {
          responseText = text;
        } else {
          console.warn('Response is not valid JSON. Attempting to extract JSON from the response.');
          const extractedJSON = text.match(/\{[\s\S]*\}/);
          if (extractedJSON) {
            responseText = extractedJSON[0];
          } else {
            console.warn('No JSON-like structure found. Returning raw text.');
            responseText = text;
          }
        }

        return {
          text: responseText,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          finishReason: 'stop' as const,
          rawCall: {
            rawPrompt: callOptions.prompt,
            rawSettings: options
          }
        };
      },
      doStream: async () => {
        throw new Error('Streaming is not supported for LM Studio');
      },
    };
  };
};

const lmStudio = createLMStudio('http://127.0.0.1:1234');

// Models

export const gpt4Model = openai('gpt-4o', {
  structuredOutputs: true,
});
export const gpt4MiniModel = openai('gpt-4o-mini', {
  structuredOutputs: true,
});
export const o3MiniModel = openai('o3-mini', {
  reasoningEffort: 'medium',
  structuredOutputs: true,
});
export const lmStudioModel = lmStudio('default', {
  temperature: 0.7,
  max_tokens: 1000,
}) as LanguageModelV1;

const MinChunkSize = 140;
const encoder = getEncoding('o200k_base');

// trim prompt to maximum context size
export function trimPrompt(prompt: string, contextSize = 120_000) {
  if (!prompt) {
    return '';
  }

  const length = encoder.encode(prompt).length;
  if (length <= contextSize) {
    return prompt;
  }

  const overflowTokens = length - contextSize;
  // on average it's 3 characters per token, so multiply by 3 to get a rough estimate of the number of characters
  const chunkSize = prompt.length - overflowTokens * 3;
  if (chunkSize < MinChunkSize) {
    return prompt.slice(0, MinChunkSize);
  }

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap: 0,
  });
  const trimmedPrompt = splitter.splitText(prompt)[0] ?? '';

  // last catch, there's a chance that the trimmed prompt is same length as the original prompt, due to how tokens are split & innerworkings of the splitter, handle this case by just doing a hard cut
  if (trimmedPrompt.length === prompt.length) {
    return trimPrompt(prompt.slice(0, chunkSize), contextSize);
  }

  // recursively trim until the prompt is within the context size
  return trimPrompt(trimmedPrompt, contextSize);
}
