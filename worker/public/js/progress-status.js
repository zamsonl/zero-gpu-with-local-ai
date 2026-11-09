// Shared by Worker producers, the reply stream and live followers. Workflow
// phases describe model work; transport diagnostics never replace that work.
const STATES = {
  waiting: 'Waiting for Qwen output', connecting: 'Waiting for Qwen to start responding',
  loading: 'Loading Qwen', retrying: 'Retrying the Qwen connection',
  continuing: 'Continuing from saved work', following: 'Following the current reply',
  recovering: 'Preserving unfinished work', compacting: 'Summarizing earlier messages',
  reading: 'Reading the saved input', thinking: 'Thinking', answering: 'Writing the answer',
  saving: 'Saving progress', preparing: 'Preparing the next reply',
};
function count(status) {
  return Number.isInteger(status.chunk) && status.chunk > 0 && Number.isInteger(status.chunks) && status.chunks >= status.chunk
    ? ` (${status.chunk} of ${status.chunks})` : '';
}
function primary(status) {
  const {operation,phase}=status;
  if(phase==='thinking')return 'Thinking';
  if(phase==='answering')return operation==='long_input'?'Writing the answer from saved notes':'Writing the answer';
  if(operation==='reasoning_recovery'){
    if(phase==='saving')return 'Saving thinking progress';
    if(phase==='extracting')return 'Summarizing thinking'+count(status);
    if(phase==='fallback')return 'Summary unavailable; preserving thinking verbatim';
    if(phase==='resuming')return 'Continuing from saved work';
    if(phase==='finishing')return 'Writing the answer from saved work'+(status.finish_reason==='work_limit'?' (reasoning work limit reached)':status.finish_reason==='repeated_work'?' (repeated reasoning detected)':status.finish_reason==='summary_fallback'?' (using preserved thinking)':'');
  }
  if(operation==='compact'){
    if(phase==='extracting')return 'Summarizing earlier messages'+count(status);
    if(phase==='saving')return 'Saving conversation memory';
  }
  if(operation==='long_input'){
    if(phase==='reading')return 'Reading section'+count(status);
    if(phase==='preparing_answer')return 'Preparing the answer from saved notes';
    if(phase==='saving')return 'Saving reading progress';
  }
  if(operation==='generation'&&phase==='preparing')return 'Preparing the reply from saved conversation memory';
  if(operation==='generation'&&phase==='saving')return 'Saving reply progress';
  return status.detail || STATES[status.state] || 'Working on the reply';
}

/** One text value for every UI surface, without clocks or presentation markup. */
export function formatProgressStatus(status={}) {
  const base=primary(status);
  const transport=status.transport_state;
  if(transport==='loading')return `${base} · Loading Qwen`;
  if(transport==='retrying'||transport==='waiting'){
    const diagnostic=status.transport_detail || (transport==='retrying'?'Retrying the Qwen connection':'Waiting to retry the Qwen connection');
    return `${base} · ${diagnostic}`;
  }
  return base;
}

/** A fresh semantic phase also clears diagnostics left over from an earlier call. */
export function phaseStatus(operation,phase,extra={}) {
  const state=operation==='reasoning_recovery'?'recovering':operation==='compact'?'compacting'
    :phase==='reading'?'reading':phase==='saving'?'saving':phase==='thinking'?'thinking'
      :phase==='answering'||phase==='preparing_answer'?'answering':'preparing';
  const status={event:'status',operation,phase,state,...extra,transport_state:null,transport_detail:null,transport_attempt:null};
  status.detail=primary(status);
  return status;
}

/** A new inference request can connect normally while its workflow keeps running. */
export function withTransportProgress(base,transport={}) {
  return {...base,transport_state:transport.state??null,transport_detail:transport.detail??null,transport_attempt:transport.attempt??null};
}
