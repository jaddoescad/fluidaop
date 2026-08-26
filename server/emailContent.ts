import EmailReplyParser from 'email-reply-parser';

export const EMAIL_CONTENT_PARSER_VERSION = 'email-reply-parser@2.3.9:v1';

export interface ParsedEmailContent {
  currentMessageText: string;
  quotedText: string | null;
  signatureText: string | null;
  hasQuotedContent: boolean;
  parseMethod: 'email-reply-parser' | 'plain-text-fallback';
  parseConfidence: number;
  parserVersion: string;
}

const parser = new EmailReplyParser();

function normalize(value: string, maximum = 100_000): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
    .slice(0, maximum);
}

/**
 * Produces the provider-neutral message Fluid renders and gives to agents.
 * The immutable raw body stays on activities.raw_body_text for audit/reprocessing.
 */
export function parseEmailContent(rawBody: string | null | undefined): ParsedEmailContent {
  const source = normalize(rawBody ?? '');
  if (!source) {
    return {
      currentMessageText: '',
      quotedText: null,
      signatureText: null,
      hasQuotedContent: false,
      parseMethod: 'plain-text-fallback',
      parseConfidence: 1,
      parserVersion: EMAIL_CONTENT_PARSER_VERSION,
    };
  }

  try {
    const email = parser.read(source);
    const visible = normalize(email.getVisibleText());
    const quoted = normalize(email.getQuotedText());
    const signature = normalize(email.getFragments()
      .filter((fragment) => fragment.isSignature())
      .map((fragment) => fragment.getContent())
      .join('\n\n'));
    const currentMessageText = visible || source;
    const parsedSomething = currentMessageText !== source || Boolean(quoted || signature);

    return {
      currentMessageText,
      quotedText: quoted || null,
      signatureText: signature || null,
      hasQuotedContent: Boolean(quoted),
      parseMethod: 'email-reply-parser',
      parseConfidence: parsedSomething ? 0.98 : 0.9,
      parserVersion: EMAIL_CONTENT_PARSER_VERSION,
    };
  } catch {
    return {
      currentMessageText: source,
      quotedText: null,
      signatureText: null,
      hasQuotedContent: false,
      parseMethod: 'plain-text-fallback',
      parseConfidence: 0.5,
      parserVersion: EMAIL_CONTENT_PARSER_VERSION,
    };
  }
}

export function decorateEmailRecord<T extends Record<string, unknown>>(record: T): T {
  const source = record.source;
  if (source !== 'gmail') return record;
  const rawBody = typeof record.bodyText === 'string'
    ? record.bodyText
    : typeof record.body_text === 'string'
      ? record.body_text
      : null;
  const storedCurrent = typeof record.currentMessageText === 'string'
    ? record.currentMessageText
    : typeof record.current_message_text === 'string'
      ? record.current_message_text
      : null;
  const parsed = storedCurrent ? null : parseEmailContent(rawBody);
  const storedQuoted = typeof record.quotedText === 'string'
    ? record.quotedText
    : typeof record.quoted_text === 'string'
      ? record.quoted_text
      : null;

  return {
    ...record,
    currentMessageText: storedCurrent ?? parsed?.currentMessageText ?? '',
    quotedText: storedQuoted ?? parsed?.quotedText ?? null,
    hasQuotedContent: Boolean(
      record.hasQuotedContent ?? record.has_quoted_content ?? parsed?.hasQuotedContent,
    ),
    contentParserVersion: record.contentParserVersion ?? record.content_parser_version ?? parsed?.parserVersion,
    contentParseMethod: record.contentParseMethod ?? record.content_parse_method ?? parsed?.parseMethod,
    contentParseConfidence: record.contentParseConfidence ?? record.content_parse_confidence ?? parsed?.parseConfidence,
  };
}
