import { generateObject } from 'ai';
import { z } from 'zod';

import { lmStudioModel } from './ai/providers';
import { systemPrompt } from './prompt';

const questionSchema = z.object({
  questions: z.array(z.string()),
});

export async function generateFeedback({
  query,
  numQuestions = 3,
}: {
  query: string;
  numQuestions?: number;
}): Promise<string[]> {
  try {
    const userFeedback = await generateObject({
      model: lmStudioModel,
      system: systemPrompt(),
      prompt: `Given the following query from the user, generate an array of follow-up questions to clarify the research direction. Generate a maximum of ${numQuestions} questions, but feel free to generate fewer if the original query is clear. Query: "${query}"`,
      schema: z.object({
        questions: z.array(z.string()).optional(),
      }),
    });

    if (userFeedback.object && Array.isArray(userFeedback.object.questions)) {
      return userFeedback.object.questions.slice(0, numQuestions);
    }

    console.warn('AI model did not generate questions in the expected format. Using fallback questions.');
    throw new Error('Unable to extract questions from AI response');
  } catch (e) {
    console.error('Failed to generate or parse feedback:', e);
    if (e instanceof Error) {
      console.error('Error message:', e.message);
    }
    
    // Fallback: generate simple follow-up questions
    const fallbackQuestions = [
      `Can you provide more context about "${query}"?`,
      `What specific aspects of "${query}" are you most interested in?`,
      `Are there any particular time periods or geographic areas you want to focus on for "${query}"?`
    ];
    return fallbackQuestions.slice(0, numQuestions);
  }
}
