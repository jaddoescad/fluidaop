import { Channel, Person, Reminder, ScriptedEvent, SeqInstance, Sequence, Signal } from './types';
import { DAY, HOUR, MIN } from './time';

export const CHANNEL_LABEL: Record<Channel, string> = {
  sms: 'SMS · Quo',
  email: 'Email · Gmail',
  call: 'Call',
  form: 'Form · Website',
};

let seq = 0;
export function uid(prefix: string): string {
  seq += 1;
  return `${prefix}_${seq.toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

interface Seed {
  people: Person[];
  signals: Signal[];
  reminders: Reminder[];
  script: ScriptedEvent[];
  sequences: Sequence[];
  seqInstances: SeqInstance[];
}

function sig(
  personId: string,
  channel: Channel,
  at: number,
  text: string,
  requiresReply = false,
): Signal {
  return { id: uid('sig'), personId, channel, at, text, requiresReply };
}

/** Everything is generated client-side after mount, relative to t0 = Date.now(). */
export function buildSeed(t0: number): Seed {
  const people: Person[] = [
    {
      id: 'p_dana',
      name: 'Dana Whitfield',
      kind: 'residential',
      note: 'Kitchen + cabinet repaint, Maple Ct. Repeat client (2023 exterior).',
      tags: ['repeat client'],
      suggestedTags: ['cabinets', 'estimate pending'],
      nbas: [
        { id: 'nba_dana_est', label: 'Draft cabinet estimate' },
        { id: 'nba_dana_color', label: 'Book color consult' },
      ],
    },
    {
      id: 'p_marcus',
      name: 'Marcus Bell',
      company: 'Bell & Frame Realty',
      kind: 'commercial',
      note: 'Staging touch-ups across active listings. Net-30 account.',
      tags: ['realtor', 'net-30'],
      suggestedTags: ['priority'],
      nbas: [
        { id: 'nba_marcus_w9', label: 'Send W-9 for their records' },
        { id: 'nba_marcus_walk', label: 'Schedule Fairview walkthrough' },
      ],
    },
    {
      id: 'p_priya',
      name: 'Priya Raman',
      kind: 'residential',
      note: 'Full exterior repaint, Birchwood Ln. Quote #1042 accepted.',
      tags: ['exterior', 'scheduled'],
      suggestedTags: ['gate access'],
      nbas: [{ id: 'nba_priya_crew', label: 'Confirm crew for the 28th' }],
    },
    {
      id: 'p_tom',
      name: 'Tom Okafor',
      company: 'Okafor Logistics',
      kind: 'commercial',
      note: 'Office repaint completed last week. Warehouse is the next opportunity.',
      tags: ['commercial'],
      suggestedTags: ['warehouse'],
      nbas: [{ id: 'nba_tom_case', label: 'Ask for a referral quote' }],
    },
    {
      id: 'p_helen',
      name: 'Helen Marsh',
      kind: 'residential',
      note: 'New lead — 2-story colonial on Linden Ave, peeling trim.',
      tags: [],
      suggestedTags: ['new lead'],
      nbas: [{ id: 'nba_helen_visit', label: 'Offer a site-visit slot' }],
    },
    {
      id: 'p_gary',
      name: 'Gary Sutton',
      kind: 'residential',
      note: 'Deck staining quote sent last week — no answer yet.',
      tags: ['deck'],
      suggestedTags: [],
      nbas: [{ id: 'nba_gary_rev', label: 'Revise deck-staining quote' }],
    },
    {
      id: 'p_roz',
      name: 'Roz Dean',
      company: 'Dean Property Group',
      kind: 'commercial',
      note: 'Unit turnovers, 3 buildings. Reliable monthly volume.',
      tags: ['property mgmt', 'net-30'],
      suggestedTags: ['annual contract'],
      nbas: [{ id: 'nba_roz_plan', label: 'Propose annual maintenance plan' }],
    },
    {
      id: 'p_felix',
      name: 'Felix Arno',
      company: 'Larkspur HOA',
      kind: 'commercial',
      note: 'HOA board contact. Clubhouse repaint bid in progress.',
      tags: ['hoa'],
      suggestedTags: [],
      nbas: [{ id: 'nba_felix_bid', label: 'Finalize clubhouse bid' }],
    },
  ];

  // ---- Seeded history spread over past weeks (these appear in Streams too) ----
  const danaPlans = sig(
    'p_dana',
    'email',
    t0 - 5 * DAY - 3 * HOUR,
    'Sent over the floor plans and a few photos of the current cabinet finish. Let me know if you need measurements.',
  );
  const marcusOldCall = sig(
    'p_marcus',
    'call',
    t0 - 9 * DAY - 2 * HOUR,
    'Voicemail (0:51): walkthrough notes for the Alder St listing — wants satin white in both baths.',
  );
  const garyCall = sig(
    'p_gary',
    'call',
    t0 - 7 * DAY - 4 * HOUR,
    'Call (6:12): discussed deck staining, wants semi-transparent cedar tone. Asked for a quote.',
  );

  const history: Signal[] = [
    sig('p_tom', 'email', t0 - 20 * DAY - 5 * HOUR, 'PO attached for the office repaint — floors 2 and 3, off-hours crew.'),
    sig('p_felix', 'email', t0 - 18 * DAY - 1 * HOUR, 'Board approved the two trim colors. Sherwin SW 7008 and SW 9109 attached.'),
    sig('p_tom', 'email', t0 - 16 * DAY - 2 * HOUR, 'Final walkthrough looked great. Accounting has your invoice.'),
    sig('p_dana', 'email', t0 - 12 * DAY - 6 * HOUR, "We're finally ready to redo the kitchen cabinets we talked about last spring."),
    sig('p_felix', 'call', t0 - 11 * DAY - 3 * HOUR, 'Voicemail (0:33): asking when the clubhouse bid will be ready for the board packet.'),
    sig('p_roz', 'email', t0 - 10 * DAY - 2 * HOUR, 'Turnover list for September: units 2A, 4B, 7C. Standard eggshell throughout.'),
    marcusOldCall,
    sig('p_priya', 'form', t0 - 8 * DAY - 5 * HOUR, 'Quote request: full exterior repaint, 2,400 sq ft, stucco + wood trim.'),
    garyCall,
    sig('p_gary', 'email', t0 - 6 * DAY - 2 * HOUR, 'Quote #1046 for deck staining sent — $1,850, cedar semi-transparent, 2 coats.'),
    sig('p_priya', 'email', t0 - 6 * DAY - 1 * HOUR, 'Accepted quote #1042. Excited to get on the schedule!'),
    danaPlans,
    sig('p_helen', 'form', t0 - 26 * DAY - 4 * HOUR, 'Asked for a ballpark on exterior painting for a colonial. No follow-up since.'),
    sig('p_marcus', 'sms', t0 - 3 * DAY - 5 * HOUR, 'Invoice 218 paid this morning. Thanks for the quick turnaround on Alder St.'),
    sig('p_roz', 'sms', t0 - 2 * DAY - 3 * HOUR, 'Keys for unit 4B are at the office whenever your crew is ready.'),
    sig('p_felix', 'sms', t0 - 1 * DAY - 2 * HOUR, 'Board meets Thursday — hoping to have your clubhouse numbers by then.'),
    sig('p_dana', 'sms', t0 - 1 * DAY - 5 * HOUR, 'By the way — we emptied the upper cabinets so you can measure anytime.'),
  ];

  // ---- Pre-seeded reminders ----
  const reminders: Reminder[] = [
    {
      id: 'rem_gary',
      personId: 'p_gary',
      note: 'Follow up on the deck-staining quote',
      createdAt: t0 - 6 * DAY,
      dueAt: t0 + 45_000, // comes due while the viewer watches
      sourceSignalId: garyCall.id,
      sourceLabel: CHANNEL_LABEL.call,
      doneAt: null,
      snoozedUntil: 0,
      bornLive: false,
    },
    {
      id: 'rem_marcus_coi',
      personId: 'p_marcus',
      note: 'Send updated COI to Bell & Frame',
      createdAt: t0 - 4 * DAY,
      dueAt: t0 - 25 * MIN, // already overdue at boot
      sourceSignalId: marcusOldCall.id,
      sourceLabel: CHANNEL_LABEL.call,
      doneAt: null,
      snoozedUntil: 0,
      bornLive: false,
    },
    {
      id: 'rem_felix_bid',
      personId: 'p_felix',
      note: 'Larkspur clubhouse bid due to the board',
      createdAt: t0 - 11 * DAY,
      dueAt: t0 + 2 * DAY + 3 * HOUR,
      sourceSignalId: null,
      sourceLabel: 'Call',
      doneAt: null,
      snoozedUntil: 0,
      bornLive: false,
    },
    {
      id: 'rem_roz_walk',
      personId: 'p_roz',
      note: 'Quarterly walkthrough — Dean properties',
      createdAt: t0 - 20 * DAY,
      dueAt: t0 + 6 * DAY + 5 * HOUR,
      sourceSignalId: null,
      sourceLabel: 'Email · Gmail',
      doneAt: null,
      snoozedUntil: 0,
      bornLive: false,
    },
  ];

  // ---- Scripted opening story: past history causes today's signals ----
  const script: ScriptedEvent[] = [
    {
      at: t0 + 4_000,
      fired: false,
      signal: sig(
        'p_dana',
        'email',
        0,
        'Just checking in — any update on the estimate for the cabinets? We sent the floor plans last week.',
        true,
      ),
    },
    {
      at: t0 + 13_000,
      fired: false,
      signal: sig(
        'p_marcus',
        'call',
        0,
        "Missed call · voicemail (0:38): “Two units on Fairview need scuff repair before Friday's showing — can you fit us in?”",
        true,
      ),
    },
    {
      at: t0 + 22_000,
      fired: false,
      signal: sig(
        'p_priya',
        'sms',
        0,
        "We're all set for the 28th, right? Also the gate code changed — it's 4417 now.",
        true,
      ),
    },
    {
      at: t0 + 31_000,
      fired: false,
      signal: sig(
        'p_tom',
        'sms',
        0,
        "Office turned out great — the team loves it. We'll want the warehouse done too. Reach out in about three months?",
        true,
      ),
      reminder: { note: 'Reach out to Tom Okafor about the warehouse repaint', dueInMs: 90 * DAY },
    },
    {
      at: t0 + 40_000,
      fired: false,
      signal: sig(
        'p_helen',
        'form',
        0,
        'Quote request: 2-story colonial on Linden Ave — trim peeling badly on the south side. Prefers email contact.',
        true,
      ),
    },
  ];

  // ---- Automations: account-level playbooks ----
  const sequences: Sequence[] = [
    {
      id: 'seq_lead',
      name: 'New lead nurture',
      trigger: 'a website quote request arrives',
      enabled: true,
      steps: [
        { day: 0, kind: 'email', label: 'Intro + portfolio email' },
        { day: 2, kind: 'sms', label: 'Check-in text' },
        { day: 5, kind: 'call', label: 'Follow-up call' },
        { day: 9, kind: 'email', label: 'Final nudge email' },
      ],
    },
    {
      id: 'seq_est',
      name: 'Estimate follow-up',
      trigger: 'an estimate goes out and gets no reply',
      enabled: true,
      steps: [
        { day: 3, kind: 'email', label: 'Gentle nudge email' },
        { day: 7, kind: 'call', label: 'Follow-up call' },
        { day: 14, kind: 'email', label: 'Last-chance email' },
      ],
    },
    {
      id: 'seq_care',
      name: 'Post-job care',
      trigger: 'a job is marked complete',
      enabled: true,
      steps: [
        { day: 1, kind: 'email', label: 'Thank-you email' },
        { day: 7, kind: 'sms', label: 'Review request text' },
        { day: 90, kind: 'call', label: 'Touch-up check-in call' },
      ],
    },
    {
      id: 'seq_pay',
      name: 'Payment chase',
      trigger: 'an invoice goes out',
      enabled: true,
      steps: [
        { day: 7, kind: 'email', label: 'Payment reminder email' },
        { day: 14, kind: 'sms', label: 'Reminder text' },
        { day: 21, kind: 'task', label: 'Escalate to a call' },
      ],
    },
  ];

  // Running / finished instances seeded so the column is alive at boot.
  // Gary started 7 days ago (minus 75s) so his Day-7 call fires while the viewer watches.
  const garyStart = t0 - 7 * DAY + 75_000;
  const tomStart = t0 - 16 * DAY;
  const marcusStart = t0 - 10 * DAY;
  const seqInstances: SeqInstance[] = [
    {
      id: 'si_gary',
      seqId: 'seq_est',
      personId: 'p_gary',
      startedAt: garyStart,
      stepIdx: 1,
      nextAt: garyStart + 7 * DAY, // = t0 + 75s
      doneAt: null,
      lastStep: { label: 'Gentle nudge email', at: garyStart + 3 * DAY },
      triggerText: 'Quote #1046 for deck staining sent — $1,850, no reply since.',
    },
    {
      id: 'si_tom',
      seqId: 'seq_care',
      personId: 'p_tom',
      startedAt: tomStart,
      stepIdx: 2,
      nextAt: tomStart + 90 * DAY,
      doneAt: null,
      lastStep: { label: 'Review request text', at: tomStart + 7 * DAY },
      triggerText: 'Office repaint (floors 2–3) marked complete.',
    },
    {
      id: 'si_marcus',
      seqId: 'seq_pay',
      personId: 'p_marcus',
      startedAt: marcusStart,
      stepIdx: 1,
      nextAt: marcusStart + 14 * DAY,
      doneAt: t0 - 3 * DAY, // invoice paid → sequence retired early
      lastStep: { label: 'Payment reminder email', at: marcusStart + 7 * DAY },
      triggerText: 'Invoice 218 sent — Alder St touch-ups.',
    },
  ];

  return {
    people,
    signals: history.slice().sort((a, b) => a.at - b.at),
    reminders,
    script,
    sequences,
    seqInstances,
  };
}

// ---- Random plausible signals after the script ----

interface RandomTemplate {
  channel: Channel;
  text: string;
  requiresReply: boolean;
}

const RANDOM_POOL: RandomTemplate[] = [
  { channel: 'sms', text: 'Can your crew start an hour later on Thursday? We have an early meeting.', requiresReply: true },
  { channel: 'sms', text: 'Front door touch-up looks perfect, thank you!', requiresReply: false },
  { channel: 'sms', text: 'Do you still have the trim color code from last time on file?', requiresReply: true },
  { channel: 'sms', text: 'Left the side gate unlocked for tomorrow.', requiresReply: false },
  { channel: 'email', text: 'Attached the HOA color approval form, signed by the board.', requiresReply: false },
  { channel: 'email', text: 'Invoice received — payment scheduled for Friday.', requiresReply: false },
  { channel: 'email', text: 'Could we add the garage door to the current scope? Curious what that would run.', requiresReply: true },
  { channel: 'email', text: 'Neighbor asked who did our exterior — passed along your number.', requiresReply: false },
  { channel: 'call', text: 'Missed call · voicemail (0:24): asking about a touch-up on the hallway scuffs.', requiresReply: true },
  { channel: 'call', text: 'Call (2:10): confirmed access for the crew, parking behind the building.', requiresReply: false },
  { channel: 'form', text: 'Website form: quote request — 3-bed ranch, full interior, empty house.', requiresReply: true },
  { channel: 'form', text: 'Website form: asking whether you handle cabinet refinishing.', requiresReply: true },
  { channel: 'email', text: "We're ready to start the project — when can you begin?", requiresReply: true },
  { channel: 'sms', text: 'Just sent the deposit — you should see it today. Excited!', requiresReply: false },
  { channel: 'email', text: 'Payment sent for the final invoice. Pleasure working with you!', requiresReply: false },
  { channel: 'sms', text: "We'd like to go ahead with the quote. What's next?", requiresReply: true },
];

export function randomTemplate(): RandomTemplate {
  const t = RANDOM_POOL[Math.floor(Math.random() * RANDOM_POOL.length)];
  return t ?? RANDOM_POOL[0]!;
}
