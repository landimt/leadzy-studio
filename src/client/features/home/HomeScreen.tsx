import { useCallback, useEffect, useMemo, useState, type JSX, useRef } from 'react';
import {
  BotIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleDashedIcon,
  Clock3Icon,
  Code2Icon,
  CopyIcon,
  FilmIcon,
  FolderOpenIcon,
  HardDriveIcon,
  MoonIcon,
  PlusIcon,
  SearchIcon,
  SunIcon,
  WandSparklesIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import {
  StudioDialog,
  StudioDialogBody,
  StudioDialogError,
  StudioDialogFooter,
} from '@/components/StudioDialog';
import logoUrl from '../../../../assets/brand/leadzy-studio-mark.svg';
import {
  buildAgentSetupPrompt,
  copyTextToClipboard,
  type DesktopBridge,
  type IntegrationStatus,
  type LauncherState,
  type RecentProject,
} from '../../lib/desktop.js';
import { t } from '../../i18n/index.js';
import { applyTheme, nextTheme, readTheme, type StudioTheme } from '../../theme/theme.js';
import { StartupScreen } from '../startup/StartupScreen.js';
import { basename } from '../inspector/basename.js';

type HomeSection = 'home' | 'projects' | 'system';

function formatDuration(durationS: number | null): string | null {
  if (durationS === null) return null;
  const minutes = Math.floor(durationS / 60);
  const seconds = Math.round(durationS % 60)
    .toString()
    .padStart(2, '0');
  return `${String(minutes)}:${seconds}`;
}

function formatOpenedAt(value: string): string {
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' }).format(date);
}

function integrationReady(integration: IntegrationStatus): boolean {
  const agent = Object.values(integration.agents).some(
    (status) => status.binaryPath !== null && status.skillInstalled,
  );
  return integration.bridgePath !== null && integration.ffmpeg && integration.ffprobe && agent;
}

function ProjectArtwork({ project }: { project: RecentProject }): JSX.Element {
  return (
    <div className="home-project-artwork" aria-hidden="true">
      {project.thumbnailDataUrl ? (
        <img src={project.thumbnailDataUrl} alt="" />
      ) : (
        <div className="home-project-placeholder">
          <span />
          <FilmIcon />
        </div>
      )}
      <div className="home-project-status">
        {project.hasFinal
          ? t('home.project.final')
          : project.hasPreview
            ? t('home.project.preview')
            : t('home.project.draft')}
      </div>
    </div>
  );
}

function ProjectCard({
  project,
  onOpen,
  onAgent,
}: {
  project: RecentProject;
  onOpen: () => void;
  onAgent: () => void;
}): JSX.Element {
  const duration = formatDuration(project.durationS);
  return (
    <article className="home-project-card">
      <button type="button" className="home-project-open" onClick={onOpen}>
        <ProjectArtwork project={project} />
        <span className="home-project-copy">
          <strong>{project.name}</strong>
          <span>{project.parentDir}</span>
          <small>
            <Clock3Icon /> {formatOpenedAt(project.openedAt)}
            {duration ? ` · ${duration}` : ''}
            {project.aspectRatio ? ` · ${project.aspectRatio}` : ''}
          </small>
        </span>
      </button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        className="home-project-agent"
        title={t('home.project.agent')}
        aria-label={`${t('home.project.agent')}: ${project.name}`}
        onClick={onAgent}
      >
        <WandSparklesIcon />
      </Button>
    </article>
  );
}

function ReadinessRow({
  label,
  ready,
  detail,
}: {
  label: string;
  ready: boolean;
  detail: string;
}): JSX.Element {
  return (
    <div className="home-readiness-row">
      {ready ? <CheckCircle2Icon className="is-ready" /> : <CircleDashedIcon />}
      <span>
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
      <em>{ready ? t('home.system.ready') : t('home.system.missing')}</em>
    </div>
  );
}

export function HomeScreen({ bridge }: { bridge: DesktopBridge }): JSX.Element {
  const [snapshot, setSnapshot] = useState<LauncherState | null>(null);
  const [section, setSection] = useState<HomeSection>('home');
  const [query, setQuery] = useState('');
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<StudioTheme>(() => readTheme());
  const [promptProject, setPromptProject] = useState<
    RecentProject | { path: string; name: string } | null
  >(null);
  const [promptCopied, setPromptCopied] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installMessage, setInstallMessage] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      setSnapshot(await bridge.getLauncherState());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('home.loadError'));
    }
  }, [bridge]);

  useEffect(() => {
    void load();
  }, [load]);

  const filteredProjects = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('pt-BR');
    const projects = snapshot?.recentProjects ?? [];
    if (!needle) return projects;
    return projects.filter((project) =>
      `${project.name} ${project.path}`.toLocaleLowerCase('pt-BR').includes(needle),
    );
  }, [query, snapshot]);

  const openProject = async (projectDir: string, name: string): Promise<void> => {
    setError(null);
    setOpening(name);
    try {
      const result = await bridge.openProject(projectDir);
      if (!result.accepted) throw new Error(t('home.openError'));
    } catch (cause) {
      setOpening(null);
      setError(cause instanceof Error ? cause.message : t('home.openError'));
    }
  };

  const chooseAndOpen = async (): Promise<void> => {
    const projectDir = await bridge.chooseProject();
    if (projectDir) await openProject(projectDir, basename(projectDir));
  };

  const createAndOpen = async (): Promise<void> => {
    const projectDir = await bridge.createProject();
    if (projectDir) await openProject(projectDir, basename(projectDir));
  };

  const chooseForAgent = async (): Promise<void> => {
    const projectDir = await bridge.chooseProject();
    if (projectDir) {
      setPromptProject({ path: projectDir, name: basename(projectDir) });
    }
  };

  const installIntegration = async (): Promise<void> => {
    setInstalling(true);
    setError(null);
    try {
      const result = await bridge.installIntegration();
      setSnapshot((current) =>
        current === null ? current : { ...current, integration: result.integration },
      );
      setInstallMessage(t('home.agent.installed'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setInstalling(false);
    }
  };

  if (opening !== null) {
    return (
      <StartupScreen title={`${t('home.loading')} ${opening}`} detail={t('home.loadingDetail')} />
    );
  }

  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', focusSearch);
    return () => {
      window.removeEventListener('keydown', focusSearch);
    };
  }, []);
  const latest = snapshot?.recentProjects[0] ?? null;
  const integration = snapshot?.integration ?? null;
  const ready = integration !== null && integrationReady(integration);
  const projectsForSection = section === 'home' ? filteredProjects.slice(0, 4) : filteredProjects;

  return (
    <main className="home-shell">
      <header className="home-header">
        <button
          type="button"
          className="home-brand"
          onClick={() => {
            setSection('home');
          }}
        >
          <img src={logoUrl} alt="" />
          <span>
            <strong>Leadzy Studio</strong>
            <small>{t('app.localAgentNative')}</small>
          </span>
        </button>
        <label className="home-search">
          <SearchIcon aria-hidden="true" />
          <input
            ref={searchRef}
            className="home-search-input"
            type="search"
            value={query}
            placeholder={t('home.search')}
            aria-label={t('home.search')}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
          <Kbd>⌘K</Kbd>
        </label>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title={t('home.theme')}
          aria-label={t('home.theme')}
          onClick={() => {
            const next = nextTheme(theme);
            applyTheme(next);
            setTheme(next);
          }}
        >
          {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        </Button>
      </header>

      <aside className="home-nav" aria-label="Leadzy Studio">
        <nav>
          {(
            [
              ['home', t('home.nav.home'), FilmIcon],
              ['projects', t('home.nav.projects'), HardDriveIcon],
              ['system', t('home.nav.system'), Code2Icon],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              type="button"
              key={id}
              className={section === id ? 'is-active' : ''}
              aria-current={section === id ? 'page' : undefined}
              onClick={() => {
                setSection(id);
              }}
            >
              <Icon />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="home-nav-status">
          <span className={ready ? 'is-ready' : ''} />
          <p>
            <strong>{ready ? t('home.agent.ready') : t('home.agent.setup')}</strong>
            <small>v{snapshot?.appVersion ?? '…'}</small>
          </p>
        </div>
      </aside>

      <div className="home-content">
        {error && (
          <div className="home-error" role="alert">
            <span>{error}</span>
            <Button type="button" size="xs" variant="ghost" onClick={() => void load()}>
              {t('app.retry')}
            </Button>
          </div>
        )}

        {section === 'home' && (
          <>
            <section className="home-hero">
              <div className="home-hero-copy">
                <span>{t('home.hero.eyebrow')}</span>
                <h1>{t('home.hero.title')}</h1>
                <p>{t('home.hero.body')}</p>
                {latest !== null && (
                  <button
                    type="button"
                    className="home-resume"
                    onClick={() => void openProject(latest.path, latest.name)}
                  >
                    <ProjectArtwork project={latest} />
                    <span className="home-resume-copy">
                      <small>{t('home.resume.eyebrow')}</small>
                      <strong>{latest.name}</strong>
                      <span>
                        {formatOpenedAt(latest.openedAt)}
                        {formatDuration(latest.durationS)
                          ? ` · ${formatDuration(latest.durationS) ?? ''}`
                          : ''}
                        {latest.hasFinal
                          ? ` · ${t('home.project.final')}`
                          : latest.hasPreview
                            ? ` · ${t('home.project.preview')}`
                            : ''}
                      </span>
                    </span>
                    <span className="home-resume-cta">
                      {t('home.resume.cta')} <ChevronRightIcon aria-hidden="true" />
                    </span>
                  </button>
                )}
                <div className="home-hero-actions">
                  <Button type="button" size="lg" onClick={() => void createAndOpen()}>
                    <PlusIcon /> {t('home.newProject')}
                  </Button>
                  <Button
                    type="button"
                    size="lg"
                    variant="outline"
                    onClick={() => void chooseAndOpen()}
                  >
                    <FolderOpenIcon /> {t('home.openFolder')}
                  </Button>
                </div>
              </div>
              <div className="home-hero-agent">
                <BotIcon aria-hidden="true" />
                <div>
                  <span>{t('home.agent.title')}</span>
                  <p>{t('home.agent.body')}</p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => void chooseForAgent()}
                >
                  {t('home.prepareWithAi')} <ChevronRightIcon />
                </Button>
              </div>
            </section>
          </>
        )}

        {section !== 'system' && (
          <section className="home-projects-section">
            <header>
              <div>
                <span>
                  {section === 'home' ? t('home.recent.title') : t('home.projects.title')}
                </span>
                {section === 'projects' && (
                  <small>
                    {filteredProjects.length} {t('home.projects.count')}
                  </small>
                )}
              </div>
              {section === 'home' && (snapshot?.recentProjects.length ?? 0) > 4 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSection('projects');
                  }}
                >
                  {t('home.recent.all')} <ChevronRightIcon />
                </Button>
              )}
            </header>
            {snapshot === null && error === null ? (
              <div className="home-project-grid is-loading" aria-label={t('app.loading')}>
                {[0, 1, 2].map((item) => (
                  <i key={item} />
                ))}
              </div>
            ) : projectsForSection.length > 0 ? (
              <div className="home-project-grid">
                {projectsForSection.map((project) => (
                  <ProjectCard
                    key={project.path}
                    project={project}
                    onOpen={() => void openProject(project.path, project.name)}
                    onAgent={() => {
                      setPromptProject(project);
                    }}
                  />
                ))}
              </div>
            ) : (
              <div className="home-empty">
                <FolderOpenIcon />
                <strong>{query ? t('home.projects.noMatch') : t('home.recent.empty.title')}</strong>
                {!query && <p>{t('home.recent.empty.body')}</p>}
                {!query && (
                  <Button type="button" size="sm" onClick={() => void createAndOpen()}>
                    <PlusIcon /> {t('home.newProject')}
                  </Button>
                )}
              </div>
            )}
          </section>
        )}

        {section === 'system' && integration !== null && (
          <section className="home-system">
            <header>
              <span>{t('home.system.title')}</span>
              <p>{t('home.system.body')}</p>
            </header>
            <div className="home-readiness">
              <ReadinessRow
                label={t('home.system.bridge')}
                ready={integration.bridgePath !== null}
                detail={integration.bridgePath ?? t('home.system.missing')}
              />
              <ReadinessRow
                label="FFmpeg + FFprobe"
                ready={integration.ffmpeg && integration.ffprobe}
                detail={
                  integration.ffmpeg && integration.ffprobe
                    ? t('home.system.detected')
                    : t('home.system.missing')
                }
              />
              <ReadinessRow
                label="Claude Code"
                ready={
                  integration.agents.claude.binaryPath !== null &&
                  integration.agents.claude.skillInstalled
                }
                detail={
                  integration.agents.claude.skillInstalled
                    ? t('home.system.skill')
                    : t('home.system.missing')
                }
              />
              <ReadinessRow
                label="Codex"
                ready={
                  integration.agents.codex.binaryPath !== null &&
                  integration.agents.codex.skillInstalled
                }
                detail={
                  integration.agents.codex.skillInstalled
                    ? t('home.system.skill')
                    : t('home.system.missing')
                }
              />
            </div>
            <footer>
              <div>
                <strong>{installMessage ?? t('home.agent.setup')}</strong>
                <small>{t('home.system.pathHint')}</small>
              </div>
              <Button
                type="button"
                size="lg"
                disabled={installing}
                onClick={() => void installIntegration()}
              >
                <Code2Icon /> {installing ? t('home.agent.installing') : t('home.system.action')}
              </Button>
            </footer>
          </section>
        )}
      </div>

      <StudioDialog
        open={promptProject !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPromptProject(null);
            setPromptCopied(false);
          }
        }}
        title={t('home.agent.promptTitle')}
        description={t('home.agent.promptDescription')}
        size="lg"
      >
        <StudioDialogBody>
          <textarea
            className="home-agent-prompt"
            readOnly
            value={
              promptProject && integration
                ? buildAgentSetupPrompt(promptProject.path, integration)
                : ''
            }
            aria-label={t('home.agent.promptTitle')}
          />
          <StudioDialogError>{integration === null ? t('home.loadError') : null}</StudioDialogError>
        </StudioDialogBody>
        <StudioDialogFooter>
          {!ready && (
            <Button
              type="button"
              variant="outline"
              onClick={() => void installIntegration()}
              disabled={installing}
            >
              <Code2Icon /> {installing ? t('home.agent.installing') : t('home.system.action')}
            </Button>
          )}
          <Button
            type="button"
            disabled={promptProject === null || integration === null}
            onClick={() => {
              if (promptProject === null || integration === null) return;
              void copyTextToClipboard(buildAgentSetupPrompt(promptProject.path, integration)).then(
                () => {
                  setPromptCopied(true);
                },
              );
            }}
          >
            <CopyIcon /> {promptCopied ? t('qa.copied') : t('home.agent.copy')}
          </Button>
        </StudioDialogFooter>
      </StudioDialog>
    </main>
  );
}
