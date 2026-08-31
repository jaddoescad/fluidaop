import { CSSProperties, ReactNode, useEffect, useState } from 'react';
import { SideNav } from '../components/AppChrome';
import { apiJson as api } from '../lib/api';
import '../variants/flow.css';
import '../variants/zen.css';
import './labels.css';

const LABEL_NAME_MAX = 40;
const COLORS = ['#43c78f', '#f4587a', '#e0aa45', '#9d97f5', '#4cc4b8', '#e07bb4', '#d3a24b', '#8a8a96'];

type LabelKind = 'urgency' | 'topic';

interface Label {
  id: number;
  kind: LabelKind;
  key: string;
  name: string;
  color: string;
  description: string;
  enabled: boolean;
  sort_order: number;
}

interface SectionCopy {
  kind: LabelKind;
  title: string;
  blurb: string;
  createLabel: string;
  descPlaceholder: string;
}

const SECTIONS: SectionCopy[] = [
  {
    kind: 'urgency',
    title: 'Urgency labels',
    blurb:
      'Operational priority for a signal — how quickly it should be turned into action. ' +
      'These grade the work a signal creates, not the state of your inbox.',
    createLabel: 'New urgency label',
    descPlaceholder: 'Describe when this priority applies…',
  },
  {
    kind: 'topic',
    title: 'Topic labels',
    blurb:
      'What a Signal is about across Gmail emails, Quo messages, and calls. Keep descriptions ' +
      'specific so they remain useful for filtering and future automation.',
    createLabel: 'New topic label',
    descPlaceholder: 'Describe what this topic covers…',
  },
];

const tint = (color: string): CSSProperties => ({ ['--lc' as string]: color });

function nextColor(labels: Label[]): string {
  const used = (color: string) => labels.filter((label) => label.color === color).length;
  return COLORS.reduce((best, color) => (used(color) < used(best) ? color : best), COLORS[0]);
}

export function LabelsPage({
  onNavigate,
  header,
}: {
  onNavigate: (label: string) => void;
  header: ReactNode;
}) {
  const [labels, setLabels] = useState<Label[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creatingKind, setCreatingKind] = useState<LabelKind | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<number>>(new Set());
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api<{ labels: Label[] }>('/api/labels')
      .then((payload) => {
        if (!cancelled) setLabels(payload.labels);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const cancel = () => {
    setCreatingKind(null);
    setName('');
    setDescription('');
  };

  const open = (kind: LabelKind) => {
    setName('');
    setDescription('');
    setCreatingKind(kind);
  };

  const save = async (kind: LabelKind) => {
    const trimmed = name.trim();
    if (trimmed === '' || saving) return;
    if (labels.some((label) =>
      label.kind === kind && label.name.toLowerCase() === trimmed.toLowerCase()
    )) {
      setError(`An ${kind} label with that name already exists.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = await api<{ label: Label }>('/api/labels', {
        method: 'POST',
        body: JSON.stringify({
          kind,
          name: trimmed,
          description: description.trim(),
          color: nextColor(labels.filter((label) => label.kind === kind)),
          enabled: true,
        }),
      });
      setLabels((current) => [...current, payload.label]);
      cancel();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (label: Label) => {
    if (busyIds.has(label.id)) return;
    const enabled = !label.enabled;
    setBusyIds((current) => new Set(current).add(label.id));
    setError(null);
    try {
      const payload = await api<{ label: Label }>(`/api/labels/${label.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          kind: label.kind,
          name: label.name,
          description: label.description,
          color: label.color,
          enabled,
        }),
      });
      setLabels((current) => current.map((item) => item.id === label.id ? payload.label : item));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyIds((current) => {
        const next = new Set(current);
        next.delete(label.id);
        return next;
      });
    }
  };

  const onKey = (kind: LabelKind) => (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void save(kind);
    }
    if (event.key === 'Escape') cancel();
  };

  const renderSection = (section: SectionCopy) => {
    const sectionLabels = labels
      .filter((label) => label.kind === section.kind)
      .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
    const creating = creatingKind === section.kind;
    const color = nextColor(sectionLabels);
    const headingId = `lb-${section.kind}-title`;

    return (
      <section key={section.kind} className="lb-section" aria-labelledby={headingId}>
        <div className="lb-section-head">
          <h2 id={headingId}>{section.title}</h2>
          <p>{section.blurb}</p>
        </div>

        <div className="lb-list">
          {sectionLabels.map((label) => (
            <div
              key={label.id}
              className={`lb-row${label.enabled ? '' : ' is-disabled'}`}
              style={tint(label.color)}
            >
              <span className="lb-pill">{label.name}</span>
              <span className="lb-desc">{label.description}</span>
              <button
                type="button"
                className="lb-toggle"
                role="switch"
                aria-checked={label.enabled}
                aria-label={`${label.enabled ? 'Disable' : 'Enable'} ${label.name}`}
                title={`${label.enabled ? 'Disable' : 'Enable'} ${label.name}`}
                disabled={busyIds.has(label.id)}
                onClick={() => void toggle(label)}
              />
            </div>
          ))}

          {creating ? (
            <div className="lb-row lb-row-new" style={tint(color)}>
              <input
                className="lb-pill lb-pill-input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={onKey(section.kind)}
                placeholder="Name"
                aria-label={`${section.createLabel} name`}
                maxLength={LABEL_NAME_MAX}
                autoFocus
                size={Math.max(4, name.length)}
                disabled={saving}
              />
              <input
                className="lb-desc-input"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                onKeyDown={onKey(section.kind)}
                placeholder={section.descPlaceholder}
                aria-label={`${section.createLabel} description`}
                maxLength={500}
                disabled={saving}
              />
              <span className="lb-hint">
                {saving ? 'Saving…' : `${LABEL_NAME_MAX} characters max · Enter to save`}
              </span>
            </div>
          ) : (
            <button type="button" className="lb-ghost" onClick={() => open(section.kind)}>
              <span className="lb-ghost-plus">+</span> {section.createLabel}
            </button>
          )}
        </div>
      </section>
    );
  };

  return (
    <div className="v v-flow v-zen lb-root">
      <div className="fl-shell">
        <SideNav active="Labels" onNav={onNavigate} />
        <div className="fl-frame">
          {header}
          <main className="lb-main">
            <div className="lb-inner">
              <header className="lb-head">
                <h1>Labels</h1>
                <p>Fluid categories for individual signals. Nothing here changes Gmail.</p>
              </header>

              {error !== null && <p className="lb-error" role="alert">{error}</p>}
              {loading ? (
                <p className="lb-state" role="status">Loading labels…</p>
              ) : (
                SECTIONS.map(renderSection)
              )}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
