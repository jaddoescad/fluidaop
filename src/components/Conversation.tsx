import { ReactNode } from 'react';
import './conversation.css';

/** Which side of the thread a turn belongs to.
 *
 * `none` is for a turn whose direction was never recorded: it stays full width
 * rather than claiming a side it cannot prove. */
export type TurnSide = 'you' | 'them' | 'none';

/** One divider per day, so a week of silence does not look like a prompt reply. */
export function ConversationDay({ label }: { label: string }) {
  return (
    <div className="cv-day" role="separator">
      <span>{label}</span>
    </div>
  );
}

/** Something that happened rather than something that was said — a call, most
 *  often. Deliberately not a bubble: mixing events and speech in one visual
 *  language is what made these threads hard to scan. */
export function ConversationEvent({
  side = 'none',
  icon,
  title,
  detail,
  time,
  children,
}: {
  side?: TurnSide;
  icon?: ReactNode;
  title: string;
  /** Duration, status — anything qualifying the event itself. */
  detail?: string | null;
  time?: string;
  /** Recording, transcript, summary. Expands the event out of its pill shape. */
  children?: ReactNode;
}) {
  return (
    <div className={`cv-event cv-${side}${children ? ' cv-event-rich' : ''}`}>
      <div className="cv-event-head">
        {icon}
        <strong>{title}</strong>
        {detail && <span className="cv-event-detail">{detail}</span>}
        {time && <span className="cv-event-time">{time}</span>}
      </div>
      {children}
    </div>
  );
}

/** One message.
 *
 * The speaker is identified outside the bubble — avatar, name, then how the
 * message arrived — so the attribution reads as a line about the message
 * rather than as part of it. Ours right, theirs left, so who spoke is legible
 * before any of it is read. */
export function ConversationTurn({
  side,
  sender,
  avatar,
  meta,
  time,
  automated = false,
  marker,
  flags,
  subject,
  grouped = false,
  highlighted = false,
  tags,
  children,
  footer,
  historyId,
}: {
  side: TurnSide;
  sender: string;
  /** Initials disc, or whatever identifies the speaker at a glance. */
  avatar?: ReactNode;
  /** How the message arrived — channel and source tags. */
  meta?: ReactNode;
  time?: string;
  automated?: boolean;
  /** e.g. "this one" on the signal a card points at. */
  marker?: string;
  /** Host-specific chips, such as "draft in Actions". */
  flags?: ReactNode;
  /** Email subject, shown above the body. */
  subject?: string | null;
  /** Same speaker as the turn above, so the header is not repeated. */
  grouped?: boolean;
  /** Outlined, for the one message the surrounding view is about. */
  highlighted?: boolean;
  /** Topic and urgency labels. */
  tags?: ReactNode;
  children: ReactNode;
  /** Attachments and other evidence, below the body but inside the turn. */
  footer?: ReactNode;
  historyId?: string;
}) {
  return (
    <article
      className={`cv-turn cv-${side}${grouped ? ' cv-grouped' : ''}${highlighted ? ' cv-marked' : ''}`}
      data-history-id={historyId}
    >
      <span className="cv-avatar" aria-hidden="true">{!grouped && avatar}</span>
      <div className="cv-main">
        {!grouped && (
          <div className="cv-head">
            <span className="cv-sender">{sender}</span>
            {meta && <span className="cv-meta">{meta}</span>}
            {automated && <span className="cv-auto">automated</span>}
            {flags}
            {marker && <span className="cv-marker">{marker}</span>}
            {time && <span className="cv-time">{time}</span>}
          </div>
        )}
        <div className="cv-bubble">
          {tags}
          {subject && subject.trim() !== '' && <h3 className="cv-subject">{subject}</h3>}
          <div className="cv-body">{children}</div>
          {footer}
        </div>
      </div>
    </article>
  );
}
