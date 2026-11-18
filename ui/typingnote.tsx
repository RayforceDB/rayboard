import { useEffect } from 'react';
import { useCtx } from './kit';
import { typingLine, useTypingIn } from './typing';

/** Under a conversation: who is writing to it right now. Takes no room when nobody is. */
export function TypingNote({ chan, onShown }: { chan: string; onShown?: () => void }) {
  const { me, name } = useCtx();
  const who = useTypingIn(chan, me.id);
  // Its appearing changes what is at the end of the conversation: whoever follows it there sees it.
  const shown = who.join(' ');
  useEffect(() => { if (shown !== '') onShown?.(); }, [shown]);
  if (who.length === 0) return null;
  return <p className="typing-note" role="status" aria-live="polite"><span className="dots" aria-hidden="true"><i /><i /><i /></span>{typingLine(who.map(name))}</p>;
}
