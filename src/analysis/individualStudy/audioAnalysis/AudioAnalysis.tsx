import {
  Group, SegmentedControl, Stack,
} from '@mantine/core';
import { useMemo, useState } from 'react';
import { useAuth } from '../../../store/hooks/useAuth';
import { ParticipantData } from '../../../storage/types';
import { StudyConfig } from '../../../parser/types';
import { FirebaseStorageEngine } from '../../../storage/engines/FirebaseStorageEngine';
import { TaskAudioAnalysis } from './TaskAudioAnalysis';
import { SummaryAudioAnalysis } from './SummaryAudioAnalysis';

export function AudioAnalysis({ visibleParticipants, storageEngine, studyConfig } : { visibleParticipants: ParticipantData[], storageEngine: FirebaseStorageEngine, studyConfig: StudyConfig }) {
  const auth = useAuth();
  const authEmail = useMemo(() => auth.user.user?.email || 'temp', [auth.user.user?.email]);

  const [mode, setMode] = useState<'task' | 'summary'>('task');

  return (
    <Group wrap="nowrap" gap={25} align="stretch">
      <Stack style={{ width: '100%' }} gap={10}>
        <Group justify="flex-end" p="sm" pb={0}>
          <SegmentedControl
            value={mode}
            onChange={(value) => setMode(value as 'task' | 'summary')}
            data={[
              { label: 'Participant', value: 'task' },
              { label: 'All Participants', value: 'summary' },
            ]}
          />
        </Group>

        {mode === 'summary' ? (
          <SummaryAudioAnalysis
            visibleParticipants={visibleParticipants}
            storageEngine={storageEngine}
            studyConfig={studyConfig}
            authEmail={authEmail}
          />
        ) : (
          <TaskAudioAnalysis
            visibleParticipants={visibleParticipants}
            storageEngine={storageEngine}
            studyConfig={studyConfig}
            authEmail={authEmail}
          />
        )}
      </Stack>
    </Group>
  );
}
