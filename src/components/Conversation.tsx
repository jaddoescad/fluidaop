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

/** One message. Ours right, theirs left — reading a thread should never require
 *  reading names to work out who spoke. */
export function ConversationTurn({
  side,
  sender,
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
      <div className="cv-bubble">
        {!grouped && (
          <div className="cv-head">
            <span className="cv-sender">{sender}</span>
            {automated && <span className="cv-auto">automated</span>}
            {flags}
            {marker && <span className="cv-marker">{marker}</span>}
            {time && <span className="cv-time">{time}</span>}
          </div>
        )}
        {tags}
        {subject && subject.trim() !== '' && <h3 className="cv-subject">{subject}</h3>}
        <div className="cv-body">{children}</div>
        {footer}
      </div>
    </article>
  );
}
