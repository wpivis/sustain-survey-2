import { encryptIndex } from '../../../utils/encryptDecryptIndex';
import { parseTrialOrder } from '../../../utils/parseTrialOrder';

export function buildTaskNavigationTarget({
  answerIdentifier,
  trialOrder,
  isReplay,
  studyId,
  search,
  analysisTab = 'tagging',
}: {
  answerIdentifier: string;
  trialOrder: string;
  isReplay: boolean;
  studyId: string;
  search: string;
  analysisTab?: string;
}) {
  const { step, funcIndex } = parseTrialOrder(trialOrder);
  if (step === null) {
    return null;
  }

  if (!isReplay) {
    return {
      pathname: `/analysis/stats/${studyId}/${analysisTab}/${encodeURIComponent(answerIdentifier)}`,
      search,
    };
  }

  return {
    pathname: funcIndex === null
      ? `/${studyId}/${encryptIndex(step)}`
      : `/${studyId}/${encryptIndex(step)}/${encryptIndex(funcIndex)}`,
    search,
  };
}
