import './lead-notification.css';

/** Field labels these notifications use, longest first so "Email" cannot match
 *  inside a longer label. */
const LEAD_LABELS = [
  'Phone number',
  'Lead source',
  'First name',
  'Last name',
  'Address',
  'Email',
  'Phone',
] as const;

/** Everything from here on is the sender's footer, identical on every one. */
const BOILERPLATE = /\b(Visit your .{0,40}Pipeline|Powered by|DripJobs, Inc)\b/i;

const LABEL_PATTERN = new RegExp(`\\b(${LEAD_LABELS.join('|')})\\s*:`, 'gi');

export interface LeadField {
  label: string;
  value: string;
}

/** A lead notification is a form submission wearing an email costume.
 *
 * The fields arrive as "Label: value" pairs, often collapsed onto one line by
 * the HTML-to-text conversion, followed by the same footer every time. Reading
 * that as prose is the actual problem — normalising its whitespace only makes
 * the prose tidier. Returns null for anything that is not clearly this shape,
 * so ordinary mail is never mangled into a table. */
export function parseLeadNotification(text: string): LeadField[] | null {
  const body = text.split(BOILERPLATE)[0];
  if (body.trim() === '') return null;

  const marks: { label: string; from: number; to: number }[] = [];
  LABEL_PATTERN.lastIndex = 0;
  for (let match = LABEL_PATTERN.exec(body); match !== null; match = LABEL_PATTERN.exec(body)) {
    marks.push({ label: match[1], from: match.index, to: match.index + match[0].length });
  }
  if (marks.length < 3) return null;

  const fields = marks.map((mark, index) => ({
    label: mark.label,
    value: body.slice(mark.to, marks[index + 1]?.from ?? body.length).replace(/\s+/g, ' ').trim(),
  }));

  // A run of empty labels is a coincidence, not a form.
  if (fields.filter((field) => field.value !== '').length < 2) return null;
  return fields;
}

/** A one-line identity for the signal list: who the lead is and where from. */
export function leadHeadline(fields: LeadField[]): string {
  const find = (label: string) =>
    fields.find((field) => field.label.toLowerCase() === label)?.value ?? '';
  const name = [find('first name'), find('last name')].filter(Boolean).join(' ').trim();
  const source = find('lead source');
  const who = name || find('email') || find('phone number') || find('phone');
  return [who, source].filter(Boolean).join(' · ');
}

export function LeadNotification({ fields }: { fields: LeadField[] }) {
  const present = fields.filter((field) => field.value !== '');
  return (
    <dl className="ln-card">
      {present.map((field) => (
        <div className="ln-row" key={`${field.label}:${field.value}`}>
          <dt>{field.label}</dt>
          <dd>{field.value}</dd>
        </div>
      ))}
    </dl>
  );
}
