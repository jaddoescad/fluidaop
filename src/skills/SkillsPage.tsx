import { ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { HermesSkill, HermesStatus, loadHermesSkills, loadHermesStatus } from '../agents/hermes';
import { SideNav } from '../components/AppChrome';
import '../variants/flow.css';
import '../variants/zen.css';
import './skills.css';

export function SkillsPage({
  onNavigate,
  header,
}: {
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
  const groups = useMemo(() => groupSkills(skills), [skills]);

  return (
    <div className="v v-flow v-zen sk-root">
      <div className="fl-shell">
        <SideNav active="Skills" onNav={onNavigate} />
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
                groups.map((group) => (
                  <section className="sk-group" key={group.key}>
                    <header className="sk-group-head">
                      <h2>{group.title}</h2>
                      <span>{group.skills.length}</span>
                      <p>{group.blurb}</p>
                    </header>
                    <div className="sk-list" aria-label={group.title}>
                      {group.skills.map((skill) => (
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
                            {skill.usedBy.length > 0 ? (
                              <span className="sk-used">
                                In use by {skill.usedBy.join(', ')}
                              </span>
                            ) : null}
                          </span>
                          <span className="sk-row-meta">
                            <span className={usageClass(skill)}>{usageLabel(skill)}</span>
                            <span>{sourceLabel(skill.source)}{skill.version === null ? '' : ` · v${skill.version}`}</span>
                            <span className={`sk-state${skill.enabled ? ' sk-state-active' : ''}`}>
                              {skill.enabled ? 'Available' : 'Disabled'}
                            </span>
                          </span>
                          <span className="sk-chevron" aria-hidden="true">›</span>
                        </button>
                      ))}
                    </div>
                  </section>
                ))
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
              <div><dt>Lifetime uses</dt><dd>{usageLabel(selectedSkill)}</dd></div>
            </dl>

            <div className={`sk-verdict sk-verdict-${retirementVerdict(selectedSkill).tone}`}>
              <strong>{retirementVerdict(selectedSkill).title}</strong>
              <p>{retirementVerdict(selectedSkill).detail}</p>
            </div>

            <section className="sk-detail-section">
              <h3>Instructions</h3>
              {selectedSkill.instructions === null ? (
                <p className="sk-detail-copy">
                  This Hermes deployment does not send skill instructions yet. Update the
                  fluid-history plugin on the Hermes host to read them here.
                </p>
              ) : (
                <>
                  <pre className="sk-instructions">{selectedSkill.instructions}</pre>
                  {selectedSkill.instructionsPath !== null ? (
                    <p className="sk-detail-copy sk-path">{selectedSkill.instructionsPath}</p>
                  ) : null}
                </>
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

interface SkillGroup {
  key: string;
  title: string;
  blurb: string;
  skills: HermesSkill[];
}

// Yours first — the built-ins outnumber them roughly three to one, so a flat
// alphabetical list buries the skills this workspace actually wrote.
const GROUP_ORDER: { key: string; title: string; blurb: string; match: (source: string) => boolean }[] = [
  {
    key: 'custom',
    title: 'Your skills',
    blurb: 'Written for this workspace. Agents that name a skill are almost always naming one of these.',
    match: (source) => source === 'custom',
  },
  {
    key: 'hub',
    title: 'Skill Hub',
    blurb: 'Installed from the community Skill Hub.',
    match: (source) => source === 'hub',
  },
  {
    key: 'bundled',
    title: 'Hermes built-in',
    blurb: 'Ship with Hermes. Available to every agent, nothing to maintain.',
    match: (source) => source === 'bundled',
  },
];

function groupSkills(skills: HermesSkill[] | null): SkillGroup[] {
  if (skills === null) return [];
  const remaining = new Set(skills);
  const groups: SkillGroup[] = [];

  for (const definition of GROUP_ORDER) {
    const matched = skills.filter((skill) => definition.match(skill.source));
    matched.forEach((skill) => remaining.delete(skill));
    if (matched.length > 0) groups.push({ ...definition, skills: sortSkills(matched) });
  }

  if (remaining.size > 0) {
    groups.push({
      key: 'other',
      title: 'Other',
      blurb: 'Hermes did not report a recognised source for these.',
      skills: sortSkills([...remaining]),
    });
  }
  return groups;
}

// Attached to an agent first, then by how much the skill has actually been
// invoked, so never-used skills sink to the bottom of their section.
function sortSkills(skills: HermesSkill[]): HermesSkill[] {
  return [...skills].sort((left, right) => {
    if ((left.usedBy.length > 0) !== (right.usedBy.length > 0)) {
      return left.usedBy.length > 0 ? -1 : 1;
    }
    if (left.usage !== right.usage) return right.usage - left.usage;
    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
  });
}

/** Lifetime invocation count Hermes records per skill, agent runs and chats alike. */
function usageLabel(skill: HermesSkill): string {
  if (skill.usage === 0) return 'Never used';
  return `${skill.usage.toLocaleString()} ${skill.usage === 1 ? 'use' : 'uses'}`;
}

function usageClass(skill: HermesSkill): string {
  return skill.usage === 0 ? 'sk-usage sk-usage-none' : 'sk-usage';
}

/** Is this skill safe to delete? The two signals disagree often enough to be worth stating. */
function retirementVerdict(skill: HermesSkill): { tone: string; title: string; detail: string } {
  const attached = skill.usedBy.length > 0;
  if (attached) {
    return {
      tone: 'live',
      title: 'In active use — do not delete',
      detail: `Attached to ${skill.usedBy.join(', ')}. Deleting it breaks that agent on its next run.`,
    };
  }
  // A disabled skill cannot be invoked, so a zero count proves nothing about it.
  if (skill.usage === 0 && !skill.enabled) {
    return {
      tone: 'check',
      title: 'Never used, but it has been switched off',
      detail: 'Disabled skills cannot be invoked, so a zero count says nothing about whether this is useful. Read the instructions before deciding — a switched-off skill can still hold knowledge worth keeping.',
    };
  }
  if (skill.usage === 0) {
    return {
      tone: 'dead',
      title: 'Never used — safe to delete',
      detail: 'Enabled, referenced by no agent, and Hermes has never recorded an invocation from a schedule or a chat.',
    };
  }
  return {
    tone: 'check',
    title: 'Used before, but nothing references it now',
    detail: `Invoked ${skill.usage.toLocaleString()} times historically, but no agent is attached today. This count is lifetime, not recent — it cannot tell a skill you retired last month from one you used yesterday in a chat.`,
  };
}

function sourceLabel(source: string): string {
  if (source === 'bundled') return 'Hermes built-in';
  if (source === 'hub') return 'Skill Hub';
  if (source === 'custom') return 'Custom';
  return source;
}
