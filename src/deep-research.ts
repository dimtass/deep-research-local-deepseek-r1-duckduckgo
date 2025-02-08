import { generateObject } from 'ai';
import { compact } from 'lodash-es';
import pLimit from 'p-limit';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';

import { lmStudioModel, trimPrompt } from './ai/providers';
import { systemPrompt } from './prompt';

type ResearchResult = {
  learnings: string[];
  visitedUrls: string[];
};

// increase this if you have higher API rate limits
const ConcurrencyLimit = 2;

const execAsync = promisify(exec);

async function crawlWebsite(query: string): Promise<{ content: string; metadata: { sourceURL: string } }[]> {
  try {
    const { stdout, stderr } = await execAsync(`python3 duckduckgo-crawler/crawl.py "${query}"`);
    
    if (stderr) {
      console.error('Python script error:', stderr);
    }
    
    try {
      return JSON.parse(stdout);
    } catch (parseError) {
      console.error('Error parsing JSON output:', parseError);
      console.log('Raw output:', stdout);
      return [];
    }
  } catch (error) {
    console.error('Error executing Python script:', error);
    return [];
  }
}

// take en user query, return a list of SERP queries
async function generateSerpQueries({
  query,
  numQueries = 3,
  learnings,
}: {
  query: string;
  numQueries?: number;

  // optional, if provided, the research will continue from the last learning
  learnings?: string[];
}) {
  const res = await generateObject({
    model: lmStudioModel,
    system: systemPrompt(),
    prompt: `Given the following prompt from the user, generate a list of SERP queries to research the topic. Return a maximum of ${numQueries} queries, but feel free to return less if the original prompt is clear. Make sure each query is unique and not similar to each other: <prompt>${query}</prompt>\n\n${
      learnings
        ? `Here are some learnings from previous research, use them to generate more specific queries: ${learnings.join(
            '\n',
          )}`
        : ''
    }`,
    schema: z.object({
      queries: z
        .array(
          z.union([
            z.object({
              query: z.string().describe('The SERP query'),
              researchGoal: z
                .string()
                .describe(
                  'First talk about the goal of the research that this query is meant to accomplish, then go deeper into how to advance the research once the results are found, mention additional research directions. Be as specific as possible, especially for additional research directions.',
                ),
            }),
            z.string().describe('The SERP query'),
          ])
        )
        .describe(`List of SERP queries, max of ${numQueries}`),
    }),
  });
  console.log(
    `Created ${res.object.queries.length} queries`,
    res.object.queries,
  );

  // Process the queries to ensure they are all in object format
  const processedQueries = res.object.queries.map(query => {
    if (typeof query === 'string') {
      return {
        query,
        researchGoal: 'Explore this query to gather relevant information for the research topic.',
      };
    }
    return query;
  });

  return processedQueries.slice(0, numQueries);
}

async function processSerpResult({
  query,
  result,
  numLearnings = 3,
  numFollowUpQuestions = 3,
}: {
  query: string;
  result: { content: string; metadata: { sourceURL: string } }[];
  numLearnings?: number;
  numFollowUpQuestions?: number;
}) {
  const contents = result.map(item => trimPrompt(item.content, 25_000));
  console.log(`Ran ${query}, found ${contents.length} contents`);

  const res = await generateObject({
    model: lmStudioModel,
    abortSignal: AbortSignal.timeout(60_000),
    system: systemPrompt(),
    prompt: `Given the following contents from a SERP search for the query <query>${query}</query>, generate a list of learnings from the contents. Return a maximum of ${numLearnings} learnings, but feel free to return less if the contents are clear. Make sure each learning is unique and not similar to each other. The learnings should be concise and to the point, as detailed and infromation dense as possible. Make sure to include any entities like people, places, companies, products, things, etc in the learnings, as well as any exact metrics, numbers, or dates. The learnings will be used to research the topic further.\n\n<contents>${contents
      .map(content => `<content>\n${content}\n</content>`)
      .join('\n')}</contents>`,
    schema: z.object({
      learnings: z
        .array(z.string())
        .describe(`List of learnings, max of ${numLearnings}`),
      followUpQuestions: z
        .array(z.string())
        .describe(
          `List of follow-up questions to research the topic further, max of ${numFollowUpQuestions}`,
        )
        .optional(),
    }),
  });
  console.log(
    `Created ${res.object.learnings.length} learnings`,
    res.object.learnings,
  );

  return {
    learnings: res.object.learnings,
    followUpQuestions: res.object.followUpQuestions || [],
  };
}

export async function writeFinalReport({
  prompt,
  learnings,
  visitedUrls,
}: {
  prompt: string;
  learnings: string[];
  visitedUrls: string[];
}) {
  const learningsString = trimPrompt(
    learnings
      .map(learning => `<learning>\n${learning}\n</learning>`)
      .join('\n'),
    150_000,
  );

  try {
    const res = await generateObject({
      model: lmStudioModel,
      system: systemPrompt(),
      prompt: `Given the following prompt from the user, write a final report on the topic using the learnings from research. Make it as as detailed as possible, aim for 3 or more pages, include ALL the learnings from research:\n\n<prompt>${prompt}</prompt>\n\nHere are all the learnings from previous research:\n\n<learnings>\n${learningsString}\n</learnings>`,
      schema: z.object({
        reportMarkdown: z
          .string()
          .describe('Final report on the topic in Markdown')
          .optional(),
      }),
    });

    let report: string;

    if (res.object && res.object.reportMarkdown) {
      report = res.object.reportMarkdown;
    } else {
      console.warn('AI model did not generate a detailed report. Using a simple structure with learnings.');
      report = `# Research Findings

## Summary of Learnings

${learnings.map(learning => `- ${learning}`).join('\n')}`;
    }

    // Append the visited URLs section to the report
    const urlsSection = `\n\n## Sources\n\n${visitedUrls.map(url => `- ${url}`).join('\n')}`;
    return report + urlsSection;
  } catch (error) {
    console.error('Error generating final report:', error);
    return `Error generating report. Please review the following learnings:\n\n${learnings.join('\n\n')}\n\n## Sources\n\n${visitedUrls.map(url => `- ${url}`).join('\n')}`;
  }
}

export async function deepResearch({
  query,
  breadth,
  depth,
  learnings = [],
  visitedUrls = [],
}: {
  query: string;
  breadth: number;
  depth: number;
  learnings?: string[];
  visitedUrls?: string[];
}): Promise<ResearchResult> {
  const serpQueries = await generateSerpQueries({
    query,
    learnings,
    numQueries: breadth,
  });
  const limit = pLimit(ConcurrencyLimit);

  const results = await Promise.all(
    serpQueries.map(serpQuery =>
      limit(async () => {
        try {
          const result = await crawlWebsite(serpQuery.query);

          // Collect URLs from this search
          const newUrls = result.map(item => item.metadata.sourceURL);
          const newBreadth = Math.ceil(breadth / 2);
          const newDepth = depth - 1;

          const newLearnings = await processSerpResult({
            query: serpQuery.query,
            result,
            numFollowUpQuestions: newBreadth,
          });
          const allLearnings = [...learnings, ...newLearnings.learnings];
          const allUrls = [...visitedUrls, ...newUrls];

          if (newDepth > 0) {
            console.log(
              `Researching deeper, breadth: ${newBreadth}, depth: ${newDepth}`,
            );

            const nextQuery = `
            Previous research goal: ${serpQuery.researchGoal}
            Follow-up research directions: ${newLearnings.followUpQuestions.map(q => `\n${q}`).join('')}
          `.trim();

            return deepResearch({
              query: nextQuery,
              breadth: newBreadth,
              depth: newDepth,
              learnings: allLearnings,
              visitedUrls: allUrls,
            });
          } else {
            return {
              learnings: allLearnings,
              visitedUrls: allUrls,
            };
          }
        } catch (e) {
          console.error(`Error running query: ${serpQuery.query}: `, e);
          return {
            learnings: [],
            visitedUrls: [],
          };
        }
      }),
    ),
  );

  return {
    learnings: [...new Set(results.flatMap(r => r.learnings))],
    visitedUrls: [...new Set(results.flatMap(r => r.visitedUrls))],
  };
}
