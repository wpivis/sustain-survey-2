import {
  Badge,
  Button,
  Card,
  Group,
  Progress,
  Stack,
  Text,
} from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { useResizeObserver } from '@mantine/hooks';
import {
  MantineReactTable,
  useMantineReactTable,
  type MRT_ColumnDef as MrtColumnDef,
} from 'mantine-react-table';
import cloud from 'd3-cloud';
import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { useAsync } from '../../../store/hooks/useAsync';
import { ParticipantData } from '../../../storage/types';
import { StudyConfig } from '../../../parser/types';
import { FirebaseStorageEngine } from '../../../storage/engines/FirebaseStorageEngine';
import {
  AspectAggregate,
  ClassifiedAspect,
  OverallCounts,
  OverallSentimentCard,
  Sentiment,
  StoredAudioAnalysis,
  analyseRecording,
  buildSpans,
  computeOverall,
  getTrialsForParticipant,
  getTrialComponent,
  getTrialKeywords,
  getTrialQuestion,
  isStoredAnalysisFresh,
} from './utils';

const WORD_CLOUD_HEIGHT = 260;

interface BatchState {
  running: boolean;
  done: number;
  failed: number;
  total: number;
}

interface CloudWord extends cloud.Word {
  mentions: number;
  dominant: Sentiment;
}

interface SentimentTask {
  participantId: string;
  task: string;
}

type StoredAnalysesByParticipant = Record<string, Record<string, StoredAudioAnalysis>>;

function aggregateOverall(analyzed: SentimentTask[], stored: StoredAnalysesByParticipant): OverallCounts {
  const totals: OverallCounts = { total: 0, counts: { positive: 0, negative: 0, neutral: 0 } };

  analyzed.forEach((t) => {
    const storedAnalysis = stored[t.participantId]?.[t.task];
    if (!storedAnalysis) return;

    const overall = computeOverall(buildSpans(storedAnalysis.analysedText, storedAnalysis.aspects));
    totals.total += overall.total;
    totals.counts.positive += overall.counts.positive;
    totals.counts.neutral += overall.counts.neutral;
    totals.counts.negative += overall.counts.negative;
  });

  return totals;
}

function aggregateTopAspects(analyzed: SentimentTask[], stored: StoredAnalysesByParticipant, limit = 20): AspectAggregate[] {
  const byAspect = new Map<string, { aspect: string; counts: Record<Sentiment, number> }>();

  analyzed.forEach((t) => {
    const storedAnalysis = stored[t.participantId]?.[t.task];
    if (!storedAnalysis) return;

    storedAnalysis.aspects.forEach((a: ClassifiedAspect) => {
      const key = a.aspect.trim().toLowerCase();
      if (!key) return;
      const entry = byAspect.get(key) ?? { aspect: a.aspect.trim(), counts: { positive: 0, neutral: 0, negative: 0 } };
      entry.counts[a.sentiment] += 1;
      byAspect.set(key, entry);
    });
  });

  return [...byAspect.values()]
    .map(({ aspect, counts }) => {
      const mentions = counts.positive + counts.neutral + counts.negative;
      const dominant = (['positive', 'neutral', 'negative'] as Sentiment[]).reduce((best, s) => (counts[s] > counts[best] ? s : best), 'neutral' as Sentiment);
      return {
        aspect, mentions, counts, dominant,
      };
    })
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, limit);
}

function buildTaskList(visibleParticipants: ParticipantData[], studyConfig: StudyConfig): SentimentTask[] {
  return visibleParticipants.flatMap((participant) => getTrialsForParticipant(participant, studyConfig)
    .map((task) => ({ participantId: participant.participantId, task })));
}

function getAllStoredAnalyses(storageEngine: FirebaseStorageEngine, authEmail: string) {
  if (storageEngine && authEmail) {
    return storageEngine.getAllAudioAnalyses(authEmail);
  }

  return null;
}

function partitionAnalyzed(
  taskList: SentimentTask[],
  stored: StoredAnalysesByParticipant,
  studyConfig: StudyConfig,
): { analyzed: SentimentTask[]; pending: SentimentTask[] } {
  const analyzed: SentimentTask[] = [];
  const pending: SentimentTask[] = [];

  taskList.forEach((t) => {
    const storedAnalysis = stored[t.participantId]?.[t.task];
    const trialComponent = getTrialComponent(studyConfig, t.task);
    const keywords = getTrialKeywords(studyConfig, trialComponent);
    const question = getTrialQuestion(trialComponent);

    if (storedAnalysis && isStoredAnalysisFresh(storedAnalysis, { keywords, question })) {
      analyzed.push(t);
    } else {
      pending.push(t);
    }
  });

  return { analyzed, pending };
}

function renderDominantSentimentCell(row: { original: AspectAggregate }) {
  const { dominant } = row.original;
  return <Badge color={{ positive: 'green', neutral: 'gray', negative: 'red' }[dominant]} tt="capitalize">{dominant}</Badge>;
}

function AspectWordCloud({ aspects }: { aspects: AspectAggregate[] }) {
  const [containerRef, { width }] = useResizeObserver();

  const inputWords = useMemo<CloudWord[]>(() => {
    const top = aspects.slice(0, 20);

    return top.map((a) => ({
      text: a.aspect,
      weight: a.mentions,
      mentions: a.mentions,
      dominant: a.dominant,
    }));
  }, [aspects]);

  const [placedWords, setPlacedWords] = useState<CloudWord[]>([]);

  useEffect(() => {
    if (inputWords.length === 0 || width === 0) {
      setPlacedWords([]);
      return undefined;
    }

    const mentionCounts = inputWords.map((w) => w.mentions);
    const minMentions = Math.min(...mentionCounts);
    const maxMentions = Math.max(...mentionCounts);
    const fontSize = (mentions: number) => (maxMentions === minMentions
      ? 24
      : 14 + ((mentions - minMentions) / (maxMentions - minMentions)) * 34);

    let cancelled = false;
    const layout = cloud<CloudWord>()
      .size([width, WORD_CLOUD_HEIGHT])
      .words(inputWords.map((w) => ({ ...w })))
      .padding(3)
      .rotate(0)
      .font('sans-serif')
      .fontSize((d) => fontSize(d.mentions))
      .on('end', (placed) => {
        if (!cancelled) setPlacedWords(placed);
      });

    layout.start();

    return () => {
      cancelled = true;
      layout.stop();
    };
  }, [inputWords, width]);

  if (inputWords.length === 0) {
    return <Text size="sm" c="dimmed">No analyzed aspects yet.</Text>;
  }

  return (
    <div ref={containerRef}>
      <svg width={width} height={WORD_CLOUD_HEIGHT} viewBox={`0 0 ${width} ${WORD_CLOUD_HEIGHT}`} role="img" aria-label="Word cloud of the most commonly mentioned aspects, sized by mention count and colored by dominant sentiment">
        <g transform={`translate(${width / 2}, ${WORD_CLOUD_HEIGHT / 2})`}>
          {placedWords.map((w) => (
            <text
              key={w.text}
              textAnchor="middle"
              transform={`translate(${w.x ?? 0}, ${w.y ?? 0})`}
              style={{
                fontSize: w.size,
                fontWeight: 600,
                fill: {
                  positive: 'var(--mantine-color-green-6)',
                  neutral: 'var(--mantine-color-gray-6)',
                  negative: 'var(--mantine-color-red-6)',
                }[w.dominant],
                cursor: 'default',
              }}
            >
              {w.text}
            </text>
          ))}
        </g>
      </svg>
    </div>
  );
}

export function SummaryAudioAnalysis({
  visibleParticipants, storageEngine, studyConfig, authEmail,
}: {
  visibleParticipants: ParticipantData[];
  storageEngine: FirebaseStorageEngine;
  studyConfig: StudyConfig;
  authEmail: string;
}) {
  const { value: initialStored, status: initialStatus } = useAsync(getAllStoredAnalyses, [storageEngine, authEmail]);
  const [stored, setStored] = useState<StoredAnalysesByParticipant>({});

  useEffect(() => {
    if (initialStored) setStored(initialStored);
  }, [initialStored]);

  const [batch, setBatch] = useState<BatchState | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortControllerRef.current?.abort(), []);

  const taskList = useMemo(() => buildTaskList(visibleParticipants, studyConfig), [visibleParticipants, studyConfig]);
  const { analyzed, pending } = useMemo(() => partitionAnalyzed(taskList, stored, studyConfig), [taskList, stored, studyConfig]);
  const overall = useMemo(() => aggregateOverall(analyzed, stored), [analyzed, stored]);
  const topAspects = useMemo(() => aggregateTopAspects(analyzed, stored, 200), [analyzed, stored]);

  const aspectColumns = useMemo<MrtColumnDef<AspectAggregate>[]>(() => [
    { accessorKey: 'aspect', header: 'Aspect' },
    { accessorKey: 'mentions', header: 'Mentions', size: 100 },
    {
      accessorKey: 'dominant',
      header: 'Dominant Sentiment',
      Cell: ({ row }) => renderDominantSentimentCell(row),
    },
  ], []);

  const aspectsTable = useMantineReactTable({
    columns: aspectColumns,
    data: topAspects,
    mantinePaperProps: {
      style: { overflow: 'hidden' },
    },
  });

  const runBatch = useCallback(async (tasksToRun: SentimentTask[]) => {
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setBatch({
      running: true, done: 0, failed: 0, total: tasksToRun.length,
    });

    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < tasksToRun.length) {
        const current = tasksToRun[nextIndex];
        nextIndex += 1;
        if (controller.signal.aborted) return;

        try {
          const trialComponent = getTrialComponent(studyConfig, current.task);
          const keywords = getTrialKeywords(studyConfig, trialComponent);
          const question = getTrialQuestion(trialComponent);

          // eslint-disable-next-line no-await-in-loop
          const audioUrl = await storageEngine.getAudioUrl(current.task, current.participantId).catch(() => null);

          // eslint-disable-next-line no-await-in-loop
          const result = await analyseRecording({
            audioUrl, question, keywords, signal: controller.signal,
          });
          if (controller.signal.aborted) return;

          if (result) {
            const newAnalysis: StoredAudioAnalysis = {
              aspects: result.aspects, analysedText: result.transcript, keywords, question,
            };
            // eslint-disable-next-line no-await-in-loop
            await storageEngine.saveAudioAnalysis(current.participantId, authEmail, current.task, newAnalysis);
            if (controller.signal.aborted) return;

            setStored((prev) => ({
              ...prev,
              [current.participantId]: { ...prev[current.participantId], [current.task]: newAnalysis },
            }));
            setBatch((prev) => (prev ? { ...prev, done: prev.done + 1 } : prev));
          } else {
            setBatch((prev) => (prev ? { ...prev, failed: prev.failed + 1 } : prev));
          }
        } catch (e) {
          if (controller.signal.aborted || (e as Error).name === 'AbortError') return;
          setBatch((prev) => (prev ? { ...prev, failed: prev.failed + 1 } : prev));
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(3, tasksToRun.length) }, worker));

    if (!controller.signal.aborted) {
      setBatch((prev) => (prev ? { ...prev, running: false } : prev));
    }
  }, [studyConfig, storageEngine, authEmail]);

  const handleAnalyzeRemaining = useCallback(() => {
    openConfirmModal({
      title: 'Analyze remaining recordings',
      children: (
        <Text size="sm">
          {`This will send ${pending.length} recording${pending.length === 1 ? '' : 's'} to Gemini for sentiment analysis. This may take a while and will call the Gemini API once per recording.`}
        </Text>
      ),
      labels: { confirm: `Analyze ${pending.length}`, cancel: 'Cancel' },
      onConfirm: () => { runBatch(pending); },
    });
  }, [pending, runBatch]);

  const handleCancelBatch = useCallback(() => {
    abortControllerRef.current?.abort();
    setBatch((prev) => (prev ? { ...prev, running: false } : prev));
  }, []);

  return (
    <Stack gap="md" p="sm">
      <Group align="flex-start" gap="md" grow>
        <Stack gap="md">
          <Card withBorder radius="md" padding="md">
            <Group justify="space-between" align="center" mb="sm">
              <Text fw={600}>
                {initialStatus === 'pending' ? 'Loading stored analyses...' : `${analyzed.length} of ${taskList.length} recordings analyzed`}
              </Text>
              {batch?.running ? (
                <Group gap="xs">
                  <Text size="xs" c="dimmed">{`${batch.done + batch.failed} / ${batch.total}`}</Text>
                  <Button size="xs" variant="light" color="red" onClick={handleCancelBatch}>Cancel</Button>
                </Group>
              ) : pending.length > 0 && (
                <Button size="xs" onClick={handleAnalyzeRemaining}>{`Analyze ${pending.length} remaining`}</Button>
              )}
            </Group>
            <Progress value={taskList.length > 0 ? (analyzed.length / taskList.length) * 100 : 0} size="sm" />
            {batch && batch.failed > 0 && (
              <Text size="xs" c="red" mt="xs">{`${batch.failed} recording(s) failed to analyze.`}</Text>
            )}
          </Card>

          <OverallSentimentCard total={overall.total} positive={overall.counts.positive} neutral={overall.counts.neutral} negative={overall.counts.negative} />

          <Card withBorder radius="md" padding="md">
            <Text fw={600} mb="sm">Word Cloud</Text>
            <AspectWordCloud aspects={topAspects} />
          </Card>
        </Stack>

        <MantineReactTable table={aspectsTable} />
      </Group>
    </Stack>
  );
}
