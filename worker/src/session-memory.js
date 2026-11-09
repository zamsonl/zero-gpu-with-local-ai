import {readCheckpoint,validCheckpoint} from './context.js';
import {listTranscript} from './store.js';
import {requireChat} from './chats.js';
import {json} from './http.js';

/** Review the exact memory used by context planning, without starting inference. */
export async function getSessionMemory({env,params}){
  await requireChat(env.DB,params.id);
  const [stored,transcript]=await Promise.all([readCheckpoint(env.DB,params.id),listTranscript(env.DB,params.id)]);
  const checkpoint=validCheckpoint(stored,transcript);
  return json({memory:checkpoint?{
    summary:checkpoint.summary,
    covered_count:checkpoint.covered_count,
    through_id:checkpoint.through_id,
    updated_at:checkpoint.updated_at,
    model:checkpoint.model,
  }:null});
}
