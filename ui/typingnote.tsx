import { useCtx } from './kit';
import { typingLine, useTypingIn } from './typing';

/** Under a conversation: who is writing to it right now. Takes no room when nobody is. */
export function TypingNote({ chan }: { chan: string }) {
  const { me, name } = useCtx();
  const who = useTypingIn(chan, me.id);
  if (who.length === 0) return null;
  return <p className="typing-note" role="status" aria-live="polite"><span className="dots" aria-hidden="true"><i /><i /><i /></span>{typingLine(who.map(name))}</p>;
}
