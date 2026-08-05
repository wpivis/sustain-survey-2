import { GoogleGenAI, Type } from '@google/genai';
import type { Schema } from '@google/genai';
import {
  Card, Group, Stack, Text,
} from '@mantine/core';
import { ParticipantData } from '../../../storage/types';
import { StoredAnswer } from '../../../store/types';
import { IndividualComponent, StudyConfig } from '../../../parser/types';
import { studyComponentToIndividualComponent } from '../../../utils/handleComponentInheritance';
import { parseTrialOrder } from '../../../utils/parseTrialOrder';

export type Sentiment = 'positive' | 'neutral' | 'negative';

export interface AspectAggregate {
  aspect: string;
  mentions: number;
  counts: Record<Sentiment, number>;
  dominant: Sentiment;
}

interface AudioPayload {
  base64: string;
  mimeType: string;
}

export interface ClassifiedAspect {
  aspect: string;
  sentiment: Sentiment;
  start?: number;
  end?: number;
}

export interface OverallCounts {
  total: number;
  counts: Record<Sentiment, number>;
}

export interface SentimentResult {
  transcript: string;
  aspects: ClassifiedAspect[];
}

export interface Span {
  type: 'plain' | 'aspect';
  text: string;
  sentiment?: Sentiment;
  aspect?: string;
  aspectIndex?: number;
}

export interface StoredAudioAnalysis {
  aspects: ClassifiedAspect[];
  analysedText: string;
  keywords?: string[];
  question?: string;
}

const SYSTEM_PROMPT = `You transcribe a spoken think-aloud survey response and perform aspect-based sentiment analysis on it. An "aspect" is a specific noun or short noun phrase the speaker expresses an opinion, feeling, or stance about.

Rules:
1. "transcript" is a clean verbatim transcription of the audio: add punctuation and casing, but do not remove filler words, paraphrase, or summarize. If a transcript is provided instead of audio, return that text unchanged as "transcript".
2. Every "aspect" MUST be an exact verbatim substring of your "transcript". Never paraphrase, pluralize, or shorten an aspect.
3. When audio is provided, use vocal tone, emphasis, and delivery to judge sentiment, not just the words.
4. Every provided keyword that the speaker actually mentions MUST be included as an aspect, even if the sentiment toward it is neutral. Never include keywords that are not mentioned.
5. Beyond the keywords, include only aspects the speaker expresses a clear stance on. Skip filler, pronouns, and generic words.
6. Return each distinct aspect only once.`;

const RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    transcript: { type: Type.STRING },
    aspects: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          aspect: { type: Type.STRING },
          sentiment: { type: Type.STRING, enum: ['positive', 'neutral', 'negative'] },
        },
        required: ['aspect', 'sentiment'],
        propertyOrdering: ['aspect', 'sentiment'],
      },
    },
  },
  required: ['transcript', 'aspects'],
  propertyOrdering: ['transcript', 'aspects'],
};

let client: GoogleGenAI | null = null;

export function OverallSentimentCard({
  total, positive, neutral, negative,
}: { total: number; positive: number; neutral: number; negative: number }) {
  return (
    <Card withBorder radius="md" padding="md">
      <Text fw={600} mb="sm">Overall Sentiment</Text>
      <Group gap="xl">
        <Stack gap={0}>
          <Text fw={700} size="xl">{total}</Text>
          <Text size="xs" c="dimmed">Total</Text>
        </Stack>
        <Stack gap={0}>
          <Text fw={700} size="xl" c="green">{positive}</Text>
          <Text size="xs" c="dimmed">Positive</Text>
        </Stack>
        <Stack gap={0}>
          <Text fw={700} size="xl" c="gray">{neutral}</Text>
          <Text size="xs" c="dimmed">Neutral</Text>
        </Stack>
        <Stack gap={0}>
          <Text fw={700} size="xl" c="red">{negative}</Text>
          <Text size="xs" c="dimmed">Negative</Text>
        </Stack>
      </Group>
    </Card>
  );
}

async function audioAsBase64(url: string, signal?: AbortSignal): Promise<AudioPayload | null> {
  const response = await fetch(url, { signal });
  if (!response.ok) return null;

  const blob = await response.blob();

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

  return {
    base64: dataUrl.slice(dataUrl.indexOf(',') + 1),
    mimeType: blob.type,
  };
}

export async function analyseRecording(req: {
  audioUrl: string | null;
  question: string;
  keywords: string[];
  signal?: AbortSignal;
}): Promise<SentimentResult | null> {
  req.signal?.throwIfAborted();

  const audio = req.audioUrl ? await audioAsBase64(req.audioUrl, req.signal) : null;
  if (!audio) return null;

  const userPrompts: string[] = ['Transcribe the attached audio recording and analyse it.'];

  if (req.question) {
    userPrompts.push(`Question the participant was answering:\n"""${req.question}"""`);
  }

  if (req.keywords.length > 0) {
    userPrompts.push(`Keywords to always evaluate (if mentioned):\n${req.keywords.join(', ')}`);
  }

  client = client ?? new GoogleGenAI({ apiKey: import.meta.env.VITE_GEMINI_API_KEY });
  const response = await client.models.generateContent({
    model: 'gemini-3.5-flash',
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: audio.mimeType, data: audio.base64 } },
        { text: userPrompts.join('\n\n') },
      ],
    }],
    config: {
      abortSignal: req.signal,
      systemInstruction: SYSTEM_PROMPT,
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    },
  });

  return JSON.parse(response.text!) as SentimentResult;
}

export function buildSpans(text: string, aspects: ClassifiedAspect[]): Span[] {
  const lower = text.toLowerCase();
  const marked = new Array<number>(text.length).fill(-1);

  const hasRange = (a: ClassifiedAspect) => a.start !== undefined
    && a.end !== undefined
    && a.start >= 0
    && a.end <= text.length
    && a.start < a.end;

  const rangedAspects = aspects
    .map((aspect, idx) => ({ aspect, idx }))
    .filter(({ aspect }) => hasRange(aspect))
    .sort((a, b) => (b.aspect.end! - b.aspect.start!) - (a.aspect.end! - a.aspect.start!));

  for (const { aspect, idx } of rangedAspects) {
    for (let i = aspect.start!; i < aspect.end!; i += 1) {
      if (marked[i] === -1) marked[i] = idx;
    }
  }

  const occurrenceAspects = aspects
    .map((aspect, idx) => ({ aspect, idx }))
    .filter(({ aspect }) => !hasRange(aspect))
    .sort((a, b) => b.aspect.aspect.length - a.aspect.aspect.length);

  for (const { aspect, idx } of occurrenceAspects) {
    const needle = aspect.aspect.toLowerCase();
    let from = 0;
    while (needle && from <= text.length - needle.length) {
      const pos = lower.indexOf(needle, from);
      if (pos === -1) break;
      if (!marked.slice(pos, pos + needle.length).some((m) => m !== -1)) {
        for (let i = pos; i < pos + needle.length; i += 1) marked[i] = idx;
      }
      from = pos + 1;
    }
  }

  const spans: Span[] = [];
  let i = 0;
  while (i < text.length) {
    const owner = marked[i];
    let j = i;
    while (j < text.length && marked[j] === owner) j += 1;
    spans.push(owner === -1
      ? { type: 'plain', text: text.slice(i, j) }
      : {
        type: 'aspect', text: text.slice(i, j), sentiment: aspects[owner].sentiment, aspect: aspects[owner].aspect, aspectIndex: owner,
      });
    i = j;
  }
  return spans;
}

export function compareTrialOrder([identifierA, answerA]: [string, StoredAnswer], [identifierB, answerB]: [string, StoredAnswer]): number {
  const a = parseTrialOrder(answerA.trialOrder);
  const b = parseTrialOrder(answerB.trialOrder);

  if (a.step !== b.step) {
    return (a.step ?? Number.MAX_SAFE_INTEGER) - (b.step ?? Number.MAX_SAFE_INTEGER);
  }

  if (a.funcIndex !== b.funcIndex) {
    return (a.funcIndex ?? -1) - (b.funcIndex ?? -1);
  }

  return identifierA.localeCompare(identifierB);
}

export function computeOverall(spans: Span[]): OverallCounts {
  const counts = spans.filter((s) => s.type === 'aspect')
    .reduce((acc, s) => {
      if (s.sentiment) acc[s.sentiment] += 1;
      return acc;
    }, { positive: 0, neutral: 0, negative: 0 });

  return { total: counts.positive + counts.neutral + counts.negative, counts };
}

export function getTrialComponent(studyConfig: StudyConfig, trialIdentifier: string): IndividualComponent | undefined {
  const componentName = trialIdentifier.split('_').slice(0, -1).join('_');
  const rawComponent = studyConfig.components[componentName];
  return rawComponent ? studyComponentToIndividualComponent(rawComponent, studyConfig) : undefined;
}

export function getTrialsForParticipant(participant: ParticipantData, studyConfig: StudyConfig): string[] {
  return Object.entries(participant.answers)
    .filter(([identifier, answer]) => Boolean(identifier) && answer.endTime !== -1)
    .filter(([identifier]) => {
      const trialComponent = getTrialComponent(studyConfig, identifier);
      return Boolean(studyConfig.uiConfig.recordAudio || trialComponent?.recordAudio);
    })
    .sort(compareTrialOrder)
    .map(([identifier]) => identifier);
}

export function normalizeKeywords(keywords: string[] | undefined): string[] {
  return [...new Set((keywords ?? []).map((k) => k.toLowerCase().trim()).filter(Boolean))].sort();
}

export function getTrialKeywords(studyConfig: StudyConfig, trialComponent: IndividualComponent | undefined): string[] {
  const global = studyConfig.uiConfig.recordKeywords ?? [];
  const perQuestion = (trialComponent?.response ?? []).flatMap((r) => r.recordKeywords ?? []);
  return normalizeKeywords([...global, ...perQuestion]);
}

export function getTrialQuestion(trialComponent: IndividualComponent | undefined): string {
  if (!trialComponent) return '';
  const parameters = 'parameters' in trialComponent ? trialComponent.parameters as Record<string, unknown> | undefined : undefined;
  const questionText = typeof parameters?.questionText === 'string' ? parameters.questionText : '';
  return questionText || trialComponent.instruction || '';
}

export function isStoredAnalysisFresh(
  stored: StoredAudioAnalysis,
  current: { keywords: string[]; question: string },
): boolean {
  const storedKeywords = normalizeKeywords(stored.keywords);
  const currentKeywords = normalizeKeywords(current.keywords);
  return storedKeywords.length === currentKeywords.length
    && storedKeywords.every((k, i) => k === currentKeywords[i])
    && stored.question === current.question;
}
