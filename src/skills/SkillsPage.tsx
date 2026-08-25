import { ReactNode, useCallback, useEffect, useState } from 'react';
import { HermesSkill, HermesStatus, loadHermesSkills, loadHermesStatus } from '../agents/hermes';
import { Derived } from '../variants/shared';
import { SideNav } from '../variants/kit';
import '../variants/flow.css';
import '../variants/zen.css';
import './skills.css';

export function SkillsPage({
  d,
  onNavigate,
  header,
}: {
  d: Derived;
  onNavigate: (label: string) => void;
  header: ReactNode;
}) {
  const [status, setStatus] = useState<HermesStatus | null>(null);
  const [skills, setSkills] = useState<HermesSkill[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextStatus, nextSkills] = await Promise.all([loadHermesStatus(), loadHermesSkills()]);
      setStatus(nextStatus);
      setSkills(nextSkills);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not read Hermes skills');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (selectedId === null) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedId(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [selectedId]);

  const online = status?.connected === true;
  const selectedSkill = skills?.find((skill) => skill.id === selectedId) ?? null;

  return (
    <div className="v v-flow v-zen sk-root">
      <div className="fl-shell">
        <SideNav d={d} active="Skills" onNav={onNavigate} />
        <div className="fl-frame">
          {header}
          <main className="sk-main">
            <div className="sk-inner">
              <header className="sk-head">
                <div>
                  <h1>Skills</h1>
                  <p>Capabilities available to your Hermes agents.</p>
                </div>
                <button type="button" className="sk-refresh" onClick={() => void refresh()}>
                  Refresh
                </button>
              </header>

              <section className={`sk-runtime${error !== null ? ' sk-runtime-error' : ''}`} aria-live="polite">
                <span className={`sk-dot${online ? ' sk-dot-online' : ''}`} />
                <div className="sk-runtime-copy">
                  <strong>{error !== null ? 'Hermes unavailable' : status === null ? 'Checking Hermes' : online ? 'Hermes online' : 'Hermes offline'}</strong>
                  <span>
                    {error !== null
                      ? error
                      : status === null
                        ? 'Connecting to the skill registry…'
                        : `v${status.version ?? 'unknown'} · ${status.profiles.length} profiles · ${skills?.length ?? 0} skills`}
                  </span>
                </div>
              </section>

              {error !== null ? (
                <SkillState title="Skills unavailable" detail={error} onRetry={() => void refresh()} error />
              ) : skills === null ? (
                <SkillState title="Loading skills" detail="Reading the live Hermes skill registry…" />
              ) : skills.length === 0 ? (
                <SkillState title="No skills installed" detail="Hermes is online but is not reporting any registered skills." />
              ) : (
                <div className="sk-list" aria-label="Hermes skills">
                  {skills.map((skill) => (
                    <button
                      type="button"
                      className="sk-row"
                      key={skill.id}
                      onClick={() => setSelectedId(skill.id)}
                      aria-haspopup="dialog"
                    >
                      <span className="sk-icon" aria-hidden="true">{skillIcon(skill)}</span>
                      <span className="sk-row-copy">
                        <strong>{skillName(skill)}</strong>
                        <span>{skill.description}</span>
                      </span>
                      <span className="sk-row-meta">
                        <span>{sourceLabel(skill.source)}{skill.version === null ? '' : ` · v${skill.version}`}</span>
                        <span className={`sk-state${skill.enabled ? ' sk-state-active' : ''}`}>
                          {skill.enabled ? 'Available' : 'Disabled'}
                        </span>
                      </span>
                      <span className="sk-chevron" aria-hidden="true">›</span>
                    </button>
                  ))}
                </div>
              )}

              <p className="sk-note">
                Agents run on schedules. Skills are reusable instructions and safety rules those agents can use.
              </p>
            </div>
          </main>
        </div>
      </div>

      {selectedSkill !== null ? (
        <div className="sk-overlay" onMouseDown={() => setSelectedId(null)}>
          <section
            className="sk-inspector"
            role="dialog"
            aria-modal="true"
            aria-labelledby="sk-inspector-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="sk-inspector-head">
              <span className="sk-inspector-icon" aria-hidden="true">{skillIcon(selectedSkill)}</span>
              <div>
                <span className="sk-eyebrow">Hermes skill</span>
                <h2 id="sk-inspector-title">{skillName(selectedSkill)}</h2>
              </div>
              <button
                type="button"
                className="sk-close"
                onClick={() => setSelectedId(null)}
                aria-label="Close skill details"
                autoFocus
              >
                ×
              </button>
            </header>

            <p className="sk-inspector-description">{selectedSkill.description}</p>

            <dl className="sk-facts">
              <div><dt>Source</dt><dd>{sourceLabel(selectedSkill.source)}</dd></div>
              <div><dt>Version</dt><dd>{selectedSkill.version === null ? 'Not declared' : `v${selectedSkill.version}`}</dd></div>
              <div><dt>State</dt><dd>{selectedSkill.enabled ? 'Available' : 'Disabled'}</dd></div>
            </dl>

            <section className="sk-detail-section">
              <h3>What it does</h3>
              {selectedSkill.id === 'agent-creator' ? (
                <ol className="sk-sequence">
                  <li><span>1</span><p>Turns a business workflow into an explicit agent contract.</p></li>
                  <li><span>2</span><p>Creates the skill, profile choice, schedule, and least-privilege tool access.</p></li>
                  <li><span>3</span><p>Adds idempotency, bounded retries, and visible failure handling.</p></li>
                  <li><span>4</span><p>Verifies the real Hermes job before Fluid displays it.</p></li>
                </ol>
              ) : (
                <p className="sk-detail-copy">The detailed instructions remain inside Hermes. Fluid reads metadata only.</p>
              )}
            </section>

            <section className="sk-detail-section">
              <h3>Available in</h3>
              <div className="sk-chips">
                {selectedSkill.profiles.map((profile) => <span key={profile}>{profile}</span>)}
              </div>
            </section>

            <section className="sk-detail-section">
              <h3>Used by</h3>
              {selectedSkill.usedBy.length > 0 ? (
                <div className="sk-chips">
                  {selectedSkill.usedBy.map((agent) => <span key={agent}>{agent}</span>)}
                </div>
              ) : (
                <p className="sk-detail-copy">Not currently attached to a scheduled agent.</p>
              )}
            </section>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function SkillState({
  title,
  detail,
  error = false,
  onRetry,
}: {
  title: string;
  detail: string;
  error?: boolean;
  onRetry?: () => void;
}) {
  return (
    <div className={`sk-empty${error ? ' sk-empty-error' : ''}`} role={error ? 'alert' : 'status'}>
      <strong>{title}</strong>
      <p>{detail}</p>
      {onRetry === undefined ? null : <button type="button" onClick={onRetry}>Try again</button>}
    </div>
  );
}

function skillName(skill: HermesSkill): string {
  if (skill.id === 'agent-creator') return 'Agent Creator';
  return skill.name
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function skillIcon(skill: HermesSkill): string {
  return skill.id === 'agent-creator' ? '🛠️' : '🧩';
}

function sourceLabel(source: string): string {
  if (source === 'bundled') return 'Hermes built-in';
  if (source === 'hub') return 'Skill Hub';
  if (source === 'custom') return 'Custom';
  return source;
}
