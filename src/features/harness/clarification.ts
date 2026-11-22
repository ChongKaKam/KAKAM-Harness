import type { HarnessClarification } from '../../shared/types';

/** Keep the written question and its proposed answer in the transcript for subsequent user replies. */
export function clarificationText({ question, suggestion }: HarnessClarification) {
  return suggestion ? question + '\n\n初步建议：' + suggestion : question;
}
