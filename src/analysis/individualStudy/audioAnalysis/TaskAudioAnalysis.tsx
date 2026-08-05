import {
  Button,
  Center,
  ColorSwatch,
  Flex,
  Group,
  Paper,
  Skeleton,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import {
  useLocation, useNavigate, useParams, useSearchParams,
} from 'react-router';
import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';

import { useResizeObserver } from '@mantine/hooks';
import debounce from 'lodash.debounce';
import { useAsync } from '../../../store/hooks/useAsync';
import { ParticipantData } from '../../../storage/types';
import { StudyConfig } from '../../../parser/types';
import { ThinkAloudFooter } from '../thinkAloud/ThinkAloudFooter';
import { FirebaseStorageEngine } from '../../../storage/engines/FirebaseStorageEngine';
import { ReplayContext, useReplay } from '../../../store/hooks/useReplay';
import {
  ClassifiedAspect, OverallSentimentCard, Sentiment, StoredAudioAnalysis, analyseRecording, buildSpans, compareTrialOrder, computeOverall, getTrialComponent, getTrialKeywords, getTrialQuestion, isStoredAnalysisFresh,
} from './utils';

interface SelectionMenu {
  quote: string;
  x: number;
  y: number;
  start?: number;
  end?: number;
  aspectIndex?: number;
}

function getFirstTrialIdentifier(participant: ParticipantData | null | undefined): string {
  if (!participant) {
    return '';
  }

  const [firstEntry] = Object.entries(participant.answers).sort(compareTrialOrder);
  return firstEntry?.[0] || '';
}

function getParticipantData(trackId: string | undefined, storageEngine: FirebaseStorageEngine) {
  if (storageEngine) {
    return storageEngine.getParticipantData(trackId);
  }

  return null;
}

function getRawTranscript(storageEngine: FirebaseStorageEngine, currentTrial: string, participantId: string, studyId: string | undefined) {
  if (storageEngine && studyId) {
    return storageEngine.getTranscription(currentTrial, participantId).then((data) => {
      if (!data || !data.results) {
        return null;
      }

      return {
        results: data.results.map((task) => ({
          ...task,
          resultEndTime: +(task.resultEndTime as string).split('s')[0],
        })),
      };
    });
  }

  return null;
}

function getStoredAnalysis(storageEngine: FirebaseStorageEngine, participantId: string, authEmail: string, task: string) {
  if (storageEngine && participantId && authEmail && task) {
    return storageEngine.getAudioAnalysis(participantId, authEmail, task);
  }

  return null;
}

export function TaskAudioAnalysis({
  visibleParticipants, storageEngine, studyConfig, authEmail,
}: {
  visibleParticipants: ParticipantData[];
  storageEngine: FirebaseStorageEngine;
  studyConfig: StudyConfig;
  authEmail: string;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();

  const participantId = useMemo(() => searchParams.get('participantId') || '', [searchParams]);
  const { studyId, trialId } = useParams();
  const currentTrial = useMemo(() => trialId || '', [trialId]);

  const { value: participant } = useAsync(getParticipantData, [participantId, storageEngine]);

  const replay = useReplay();

  const [hasAudio, setHasAudio] = useState<boolean>();
  const [ref, { width }] = useResizeObserver();

  const spansContainerRef = useRef<HTMLDivElement | null>(null);

  const { value: rawTranscript, status: rawTranscriptStatus } = useAsync(getRawTranscript, [storageEngine, currentTrial, participantId, studyId]);

  const transcriptText = useMemo(() => {
    if (!rawTranscript) return '';
    return rawTranscript.results
      .map((line) => line.alternatives[0]?.transcript?.trim() || '')
      .filter(Boolean)
      .join(' ');
  }, [rawTranscript]);

  const trialComponent = useMemo(() => getTrialComponent(studyConfig, currentTrial), [studyConfig, currentTrial]);

  const keywords = useMemo(() => getTrialKeywords(studyConfig, trialComponent), [studyConfig, trialComponent]);
  const question = useMemo(() => getTrialQuestion(trialComponent), [trialComponent]);

  const [isAnalysing, setIsAnalysing] = useState(false);
  const [analyseError, setAnalyseError] = useState<string | null>(null);
  const [classifiedAspects, setClassifiedAspects] = useState<ClassifiedAspect[]>([]);
  const [analysedText, setAnalysedText] = useState('');

  const [menu, setMenu] = useState<SelectionMenu | null>(null);

  const dirtyRef = useRef(false);

  const { value: storedAnalysis, status: storedStatus } = useAsync(getStoredAnalysis, [storageEngine, participantId, authEmail, currentTrial]);

  useEffect(() => {
    setMenu(null);
    setAnalyseError(null);
    dirtyRef.current = false;

    if (!participantId || !currentTrial) {
      setClassifiedAspects([]);
      setAnalysedText('');
      return undefined;
    }

    if (storedStatus !== 'success' || rawTranscriptStatus === 'idle' || rawTranscriptStatus === 'pending') {
      return undefined;
    }

    if (storedAnalysis && isStoredAnalysisFresh(storedAnalysis, { keywords, question })) {
      setClassifiedAspects(storedAnalysis.aspects);
      setAnalysedText(storedAnalysis.analysedText);
      setIsAnalysing(false);
      return undefined;
    }

    setClassifiedAspects([]);
    setAnalysedText('');

    const controller = new AbortController();
    setIsAnalysing(true);
    (async () => {
      const audioUrl = await storageEngine.getAudioUrl(currentTrial, participantId);
      const result = await analyseRecording({
        audioUrl,
        question,
        keywords,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;

      if (result) {
        dirtyRef.current = true;
        setClassifiedAspects(result.aspects);
        setAnalysedText(result.transcript);
      }
      setIsAnalysing(false);
    })().catch((e) => {
      if (controller.signal.aborted || e.name === 'AbortError') return;
      setAnalyseError(e.message);
      setIsAnalysing(false);
    });

    return () => controller.abort();
  }, [transcriptText, rawTranscriptStatus, storedAnalysis, storedStatus, keywords, question, storageEngine, currentTrial, participantId]);

  const debouncedSave = useMemo(() => {
    if (storageEngine && participantId && currentTrial) {
      return debounce(
        (data: StoredAudioAnalysis) => storageEngine.saveAudioAnalysis(participantId, authEmail, currentTrial, data),
        1000,
        { maxWait: 5000 },
      );
    }
    return (_data: StoredAudioAnalysis) => null;
  }, [storageEngine, participantId, authEmail, currentTrial]);

  useEffect(() => {
    if (!dirtyRef.current) return;
    if (!analysedText) return;
    debouncedSave({
      aspects: classifiedAspects, analysedText, keywords, question,
    });
  }, [classifiedAspects, analysedText, keywords, question, debouncedSave]);

  useEffect(() => {
    if (!participantId && visibleParticipants.length > 0) {
      setSearchParams((params) => {
        params.set('participantId', visibleParticipants[0].participantId);
        return params;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!studyId || !participant) {
      return;
    }

    if (currentTrial && participant.answers[currentTrial]) {
      return;
    }

    const firstTrialIdentifier = getFirstTrialIdentifier(participant);
    if (!firstTrialIdentifier) {
      return;
    }

    navigate(`/analysis/stats/${studyId}/audio-analysis/${encodeURIComponent(firstTrialIdentifier)}${location.search}`, { replace: true });
  }, [currentTrial, location.search, navigate, participant, studyId]);

  const spans = useMemo(() => (analysedText ? buildSpans(analysedText, classifiedAspects) : []), [analysedText, classifiedAspects]);
  const overall = useMemo(() => computeOverall(spans), [spans]);

  const handleMouseUp = useCallback(() => {
    const selection = window.getSelection();
    const container = spansContainerRef.current;
    if (!selection || selection.isCollapsed || !container) {
      return;
    }

    const range = selection.getRangeAt(0);
    if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) {
      return;
    }

    const raw = selection.toString();
    const quote = raw.trim();
    if (!quote) {
      return;
    }

    const pre = document.createRange();
    pre.setStart(container, 0);
    pre.setEnd(range.startContainer, range.startOffset);
    const start = pre.toString().length + (raw.length - raw.trimStart().length);
    const end = start + quote.length;

    const rect = range.getBoundingClientRect();
    setMenu({
      quote, start, end, x: rect.left + rect.width / 2, y: rect.bottom,
    });
  }, []);

  const handleAspectClick = useCallback((event: React.MouseEvent, aspectIndex: number, label: string) => {
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      quote: label, aspectIndex, x: rect.left + rect.width / 2, y: rect.bottom,
    });
  }, []);

  const applySentiment = useCallback((sentiment: Sentiment) => {
    if (!menu) return;
    dirtyRef.current = true;

    if (menu.aspectIndex !== undefined) {
      const targetIndex = menu.aspectIndex;
      setClassifiedAspects((prev) => prev.map((a, i) => (i === targetIndex ? { ...a, sentiment } : a)));
    } else {
      const cleaned = menu.quote.trim();
      const { start, end } = menu;
      setClassifiedAspects((prev) => {
        const existing = prev.findIndex((a) => a.start === start && a.end === end);
        if (existing !== -1) {
          return prev.map((a, i) => (i === existing ? { ...a, sentiment } : a));
        }
        return [...prev, {
          aspect: cleaned, sentiment, start, end,
        }];
      });
    }

    setMenu(null);
    window.getSelection()?.removeAllRanges();
  }, [menu]);

  useEffect(() => {
    if (!menu) return undefined;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      close();
    };
  }, [menu]);

  return (
    <ReplayContext.Provider value={replay}>
      <Stack ref={ref} style={{ width: '100%' }} gap={10}>
        {!participantId || !currentTrial ? (
          <Center mih={200}><Text c="dimmed" size="24">Select a Participant and Trial to view its transcript</Text></Center>
        ) : !hasAudio ? (
          <Center mih={200}><Text c="dimmed" size="24">No recording found for this task</Text></Center>
        ) : (
          <Flex gap="xl" align="flex-start" p="sm" wrap="nowrap">
            <Stack gap="xs" style={{ flex: 1, minWidth: 0 }}>
              <Title order={4}>Transcripts</Title>
              <Paper
                withBorder
                radius="md"
                p="md"
                onMouseUp={handleMouseUp}
                style={{ lineHeight: 2, maxHeight: '45vh', overflow: 'auto' }}
              >
                {analyseError && <Text size="sm" c="red" mb="sm">{analyseError}</Text>}
                <Text component="div" ref={spansContainerRef} style={{ lineHeight: 2 }}>
                  {spans.length > 0 ? spans.map((span, i) => {
                    if (span.type === 'plain') {
                      return <span key={i}>{span.text}</span>;
                    }
                    return (
                      <span
                        key={i}
                        role="button"
                        tabIndex={0}
                        onClick={(e) => handleAspectClick(e, span.aspectIndex!, span.aspect!)}
                        title={`${span.aspect}: ${span.sentiment}`}
                        style={{
                          textDecoration: 'underline',
                          textDecorationColor: {
                            positive: 'var(--mantine-color-green-6)',
                            neutral: 'var(--mantine-color-gray-5)',
                            negative: 'var(--mantine-color-red-6)',
                          }[span.sentiment!],
                          textDecorationThickness: 2,
                          textUnderlineOffset: 3,
                          cursor: 'pointer',
                        }}
                      >
                        {span.text}
                      </span>
                    );
                  }) : isAnalysing ? (
                    <Stack gap="sm" py="xs">
                      <Skeleton height={12} radius="xl" />
                      <Skeleton height={12} radius="xl" />
                      <Skeleton height={12} radius="xl" width="65%" />
                    </Stack>
                  ) : (
                    <Text size="sm" c="dimmed">No transcript available.</Text>
                  )}
                </Text>
              </Paper>

              <Group gap="lg">
                <Group key="positive" gap={6}>
                  <ColorSwatch color="var(--mantine-color-green-6)" size={12} />
                  <Text size="xs" c="dimmed">Positive Sentiment</Text>
                </Group>
                <Group key="neutral" gap={6}>
                  <ColorSwatch color="var(--mantine-color-gray-5)" size={12} />
                  <Text size="xs" c="dimmed">Neutral Sentiment</Text>
                </Group>
                <Group key="negative" gap={6}>
                  <ColorSwatch color="var(--mantine-color-red-6)" size={12} />
                  <Text size="xs" c="dimmed">Negative Sentiment</Text>
                </Group>
              </Group>
              <Text size="xs" c="dimmed">Highlight text to change sentiment.</Text>
            </Stack>

            <Stack gap="md" w={340} style={{ flexShrink: 0 }}>
              <Title order={4}>Analysis</Title>

              <OverallSentimentCard total={overall.total} positive={overall.counts.positive} neutral={overall.counts.neutral} negative={overall.counts.negative} />
            </Stack>
          </Flex>
        )}

        <ThinkAloudFooter
          key={`${participantId}-${currentTrial}`}
          setHasAudio={setHasAudio}
          saveProvenance={() => null}
          studyId={studyId || ''}
          jumpedToLine={0}
          editedTranscript={[]}
          currentTrial={currentTrial}
          isReplay={false}
          visibleParticipants={visibleParticipants.map((v) => v.participantId)}
          rawTranscript={rawTranscript}
          onTimeUpdate={() => null}
          currentShownTranscription={0}
          width={width}
          storageEngine={storageEngine}
          analysisTab="audio-analysis"
        />
      </Stack>

      {menu && (
        <Paper
          shadow="md"
          withBorder
          radius="md"
          p={6}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            top: menu.y + 6,
            left: menu.x,
            transform: 'translateX(-50%)',
            zIndex: 400,
          }}
        >
          <Group gap={6} wrap="nowrap">
            <Button
              key="positive"
              size="compact-xs"
              variant="light"
              color="green"
              onClick={() => applySentiment('positive')}
              tt="capitalize"
            >
              positive
            </Button>
            <Button
              key="neutral"
              size="compact-xs"
              variant="light"
              color="gray"
              onClick={() => applySentiment('neutral')}
              tt="capitalize"
            >
              neutral
            </Button>
            <Button
              key="negative"
              size="compact-xs"
              variant="light"
              color="red"
              onClick={() => applySentiment('negative')}
              tt="capitalize"
            >
              negative
            </Button>
          </Group>
        </Paper>
      )}
    </ReplayContext.Provider>
  );
}
