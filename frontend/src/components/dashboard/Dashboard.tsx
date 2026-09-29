/**
 * The launcher: every project the user has, and one way to add another.
 *
 * Laid out the way a file browser is, because that is the job: a bar across the top for finding
 * and sorting, a rail on the left for narrowing (and for the app-level buttons that would
 * otherwise have to live in a menu), and the projects filling everything else as thumbnails you
 * can recognise. The IDE needs a project to exist at all, so this is what the window shows until
 * one is picked — and what the project name in the title bar returns to.
 */

import { useEffect, useMemo, useState } from "react";
import {
  ArrowUpDown,
  BookOpen,
  CloudOff,
  FileText,
  FolderGit2,
  LayoutGrid,
  List,
  Loader2,
  Plus,
  Search,
  SearchX,
  Settings,
} from "lucide-react";

import { useOpenProject } from "@/hooks/useOpenProject";
import { useProjectSync } from "@/hooks/useProjectSync";
import type { SyncedProject } from "@/lib/firestore";
import { useAppStore } from "@/store/app-store";
import { type ProjectEntry } from "@/types/protocol";
import { EmptyState } from "@/components/common/EmptyState";
import { Wordmark } from "@/components/common/Wordmark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DeleteProjectDialog } from "@/components/dashboard/DeleteProjectDialog";
import { EditProjectDialog } from "@/components/dashboard/EditProjectDialog";
import { LearnDialog } from "@/components/dashboard/LearnDialog";
import { NewProjectDialog } from "@/components/dashboard/NewProjectDialog";
import { ProfilePopover } from "@/components/panels/ProfilePopover";
import { ProjectCard, ProjectRow } from "@/components/dashboard/ProjectCard";
import { SyncPanel } from "@/components/dashboard/SyncPanel";
import { SyncedProjectCard, SyncedProjectRow } from "@/components/dashboard/SyncedProject";
import type { ProjectActionHandlers } from "@/components/dashboard/ProjectActions";

/** The sorts the corpus supports, in menu order. */
const SORTS = [
  { id: "opened", label: "Last opened" },
  { id: "name", label: "Name" },
  { id: "created", label: "Date created" },
] as const;
type SortId = (typeof SORTS)[number]["id"];

/**
 * The scopes the rail narrows to. Each is a window on the same list, and the counts are read off
 * the projects themselves rather than invented.
 */
const SCOPES = [
  { id: "all", label: "All projects" },
  { id: "recent", label: "Recent" },
  { id: "favourites", label: "Favourites" },
  { id: "week", label: "This week" },
  { id: "older", label: "Earlier" },
] as const;
type ScopeId = (typeof SCOPES)[number]["id"];

const DAY_MS = 86_400_000;

/**
 * What the filters and sorts need of a project. `ProjectEntry` satisfies it as it is, and a record
 * the account holds is adapted into it — one list of rules, so a stored project is searched,
 * scoped and sorted exactly like one from the registry.
 */
interface Listable {
  favourite: boolean;
  lastOpenedAt: number;
  createdAt: number;
  name: string;
  path: string;
  description: string | null;
}

function withinScope(project: Pick<Listable, "favourite" | "lastOpenedAt">, scope: ScopeId, now: number): boolean {
  if (scope === "all") return true;
  if (scope === "favourites") return project.favourite;
  // A project with no recorded opening (cleared from recents) belongs to no recent window.
  if (project.lastOpenedAt === 0) return scope === "older";
  const age = now - project.lastOpenedAt * 1000;
  if (scope === "recent") return age < DAY_MS;
  if (scope === "week") return age < 7 * DAY_MS;
  return age >= 7 * DAY_MS;
}

function matchesQuery(project: Pick<Listable, "name" | "path" | "description">, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return (
    project.name.toLowerCase().includes(needle) ||
    project.path.toLowerCase().includes(needle) ||
    (project.description ?? "").toLowerCase().includes(needle)
  );
}

/** The visible slice of one list: narrowed by scope and search, then ordered. */
function arrange<T extends Listable>(projects: readonly T[], scope: ScopeId, query: string, sort: SortId): T[] {
  const filtered = projects.filter(
    (project) => withinScope(project, scope, Date.now()) && matchesQuery(project, query),
  );
  const sorted = [...filtered];
  if (sort === "name") sorted.sort((a, b) => a.name.localeCompare(b.name));
  else if (sort === "created") sorted.sort((a, b) => b.createdAt - a.createdAt);
  else sorted.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  return sorted;
}

/**
 * A stored record as the list's own shape.
 *
 * It has no favourite (that is a local opinion, and the account does not hold it) and no separate
 * creation time — the only time a record carries is when it was last written, which is what both
 * orderings then read.
 */
function asListable(project: SyncedProject): SyncedProject & Listable {
  return {
    ...project,
    favourite: false,
    lastOpenedAt: project.updatedAt,
    createdAt: project.updatedAt,
    name: project.title,
    description: null,
  };
}

export function Dashboard() {
  const projects = useAppStore((state) => state.projects);
  const loading = useAppStore((state) => state.projectsLoading);
  const listError = useAppStore((state) => state.projectsError);
  const loadProjects = useAppStore((state) => state.loadProjects);
  const patchProject = useAppStore((state) => state.patchProject);
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen);

  const { open, error: openError } = useOpenProject();
  // The account's copy of this list lives here rather than in `App` because this is the surface
  // that shows projects: a user who never opens the launcher never syncs anything.
  const sync = useProjectSync();

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortId>("opened");
  const [scope, setScope] = useState<ScopeId>("all");
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const [sortOpen, setSortOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [learning, setLearning] = useState(false);
  const [editing, setEditing] = useState<ProjectEntry | null>(null);
  const [deleting, setDeleting] = useState<ProjectEntry | null>(null);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const now = Date.now();

  // Memoised because it re-runs on every keystroke; the plain filters below are cheap enough to
  // sit in the render.
  const visible = useMemo(() => arrange(projects, scope, query, sort), [projects, query, scope, sort]);

  // The account's records that are not on this machine: they are projects a person can search for
  // and recognise, so they go through the same filters rather than sitting in a fixed block.
  const stored = useMemo(() => sync.elsewhere.map(asListable), [sync.elsewhere]);
  const storedVisible = useMemo(() => arrange(stored, scope, query, sort), [stored, query, scope, sort]);

  // The rail's counts cover both lists: a record on the account is a project in its scope too, and
  // a count that disagreed with the tiles under it would be a small lie in the one place a user
  // goes to check what the launcher holds.
  const counts = useMemo(() => {
    const tally: Record<ScopeId, number> = { all: 0, recent: 0, favourites: 0, week: 0, older: 0 };
    for (const entry of SCOPES) {
      tally[entry.id] =
        projects.filter((project) => withinScope(project, entry.id, now)).length +
        stored.filter((project) => withinScope(project, entry.id, now)).length;
    }
    return tally;
  }, [projects, stored, now]);

  const handlers: ProjectActionHandlers = {
    onOpen: (project) => void open(project.path),
    onEdit: setEditing,
    onToggleFavourite: (project) => {
      void patchProject(project.id, { favourite: !project.favourite });
    },
    onClearRecent: (project) => {
      void patchProject(project.id, { clearRecent: true });
    },
    onDelete: setDeleting,
  };

  const handleCreated = (project: ProjectEntry) => {
    setCreating(false);
    void loadProjects();
    void open(project.path);
  };

  const showNewTile = query === "" && (scope === "all" || scope === "favourites");
  // A record the account holds is a project the launcher can show, so an account with nothing on
  // this machine is not an empty launcher — it is one showing projects from elsewhere.
  const known = projects.length + sync.elsewhere.length;
  const shown = visible.length + storedVisible.length;
  const empty = !loading && known === 0;
  const nothingHere = !loading && known > 0 && shown === 0;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Find and sort across the top, the way a file browser puts them. */}
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-border bg-chrome px-3">
        <Wordmark />
        <span aria-hidden className="h-3.5 w-px shrink-0 bg-border" />
        <span className="shrink-0 text-2xs text-muted-foreground">
          {projects.length === 1 ? "1 project" : `${projects.length} projects`}
        </span>

        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search projects"
            aria-label="Search projects"
            className="h-7 pl-7 pr-6 text-2xs"
          />
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Popover open={sortOpen} onOpenChange={setSortOpen}>
            <PopoverTrigger asChild>
              <Button size="sm" variant="ghost">
                <ArrowUpDown className="h-3.5 w-3.5" />
                {SORTS.find((entry) => entry.id === sort)?.label}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-40 p-1">
              {SORTS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  aria-pressed={sort === entry.id}
                  onClick={() => {
                    setSort(entry.id);
                    setSortOpen(false);
                  }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-chrome-raised aria-pressed:bg-primary/10 aria-pressed:text-foreground"
                >
                  {entry.label}
                </button>
              ))}
            </PopoverContent>
          </Popover>

          <div className="flex items-center rounded border border-border">
            {(
              [
                { id: "grid", icon: LayoutGrid, label: "Grid view" },
                { id: "list", icon: List, label: "List view" },
              ] as const
            ).map((entry, index) => (
              <button
                key={entry.id}
                type="button"
                aria-label={entry.label}
                aria-pressed={layout === entry.id}
                onClick={() => setLayout(entry.id)}
                className={
                  "flex h-7 w-7 items-center justify-center text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-primary/10 aria-pressed:text-foreground" +
                  (index > 0 ? " border-l border-border" : "")
                }
              >
                <entry.icon className="h-3.5 w-3.5" />
              </button>
            ))}
          </div>

          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" />
            New project
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* The rail narrows the list, and carries the app-level buttons: on the launcher there is
            no IDE sidebar to hold them, and burying them in a menu would hide the only way to
            reach the credential settings. */}
        <aside className="flex w-52 shrink-0 flex-col border-r border-border bg-chrome">
          <nav className="flex flex-col gap-0.5 p-2">
            {SCOPES.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => setScope(entry.id)}
                aria-pressed={scope === entry.id}
                className="flex items-center gap-2 rounded px-2 py-1 text-left text-2xs text-muted-foreground transition-colors hover:bg-chrome-raised hover:text-foreground aria-pressed:bg-primary/10 aria-pressed:text-foreground"
              >
                <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                <span className="shrink-0 font-mono text-2xs text-muted-foreground/70">
                  {counts[entry.id]}
                </span>
              </button>
            ))}
          </nav>

          <div className="mt-auto flex flex-col">
            <SyncPanel sync={sync} />
            <div className="flex flex-col gap-0.5 border-t border-border p-2">
              <button
                type="button"
                onClick={() => setLearning(true)}
                className="flex items-center gap-2 rounded px-2 py-1 text-left text-2xs text-muted-foreground transition-colors hover:bg-chrome-raised hover:text-foreground"
              >
                <BookOpen className="h-3.5 w-3.5" />
                Learn
              </button>
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                className="flex items-center gap-2 rounded px-2 py-1 text-left text-2xs text-muted-foreground transition-colors hover:bg-chrome-raised hover:text-foreground"
              >
                <Settings className="h-3.5 w-3.5" />
                Settings
              </button>
              <ProfilePopover label="Account" />
            </div>
          </div>
        </aside>

        <div className="flex min-h-0 flex-1 flex-col overflow-auto bg-background">
          {openError ? (
            <p className="border-b border-border px-4 py-2 text-2xs text-destructive">{openError}</p>
          ) : null}

          {empty ? (
            <div className="flex min-h-0 flex-1 items-center justify-center">
              <EmptyState
                icon={FolderGit2}
                title="No projects yet"
                hint="Create your first project — the folder is made for you, and Orbital plans, builds, tests and syncs it from there."
                action={
                  <Button size="sm" onClick={() => setCreating(true)}>
                    <Plus className="h-3.5 w-3.5" />
                    New project
                  </Button>
                }
              />
            </div>
          ) : nothingHere ? (
            <div className="flex min-h-0 flex-1 items-center justify-center">
              <EmptyState
                icon={query ? SearchX : FileText}
                title={query ? `Nothing matches “${query}”` : scope === "favourites" ? "No favourites yet" : "Nothing here"}
                hint={
                  query
                    ? "Search covers project names, their description and their folder path."
                    : scope === "favourites"
                      ? "Star a project from its menu, or right-click one, and it lands here."
                      : "Projects move between these scopes as you open them."
                }
                action={
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setQuery("");
                      setScope("all");
                    }}
                  >
                    Show all projects
                  </Button>
                }
              />
            </div>
          ) : (
            <div className="min-h-0 flex-1">
              {layout === "grid" ? (
                <ul className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {showNewTile ? (
                    <li>
                      {/* Shaped like a card, down to the thumbnail's ratio and the body block
                          below it, so a grid row holds two tiles of one height. */}
                      <button
                        type="button"
                        onClick={() => setCreating(true)}
                        className="flex h-full w-full flex-col overflow-hidden rounded border border-dashed border-border text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                      >
                        <span className="flex aspect-[4/3] w-full items-center justify-center">
                          <Plus className="h-5 w-5" />
                        </span>
                        <span className="flex flex-1 flex-col gap-0.5 px-3 py-2 text-left">
                          <span className="text-xs font-medium">New project</span>
                          <span className="text-2xs text-muted-foreground/70">
                            Create one in a folder of your choosing
                          </span>
                        </span>
                      </button>
                    </li>
                  ) : null}
                  {visible.map((project) => (
                    <ProjectCard
                      key={project.id}
                      project={project}
                      recentScope={scope === "recent"}
                      onOpen={(target) => void open(target.path)}
                      handlers={handlers}
                    />
                  ))}
                  {storedVisible.length > 0 ? (
                    <li className="col-span-full flex items-center gap-1.5 pt-2 text-2xs text-muted-foreground/70">
                      <CloudOff aria-hidden className="h-3 w-3" />
                      On your account, not on this machine
                    </li>
                  ) : null}
                  {storedVisible.map((project) => (
                    <SyncedProjectCard key={project.documentId} project={project} />
                  ))}
                </ul>
              ) : (
                <ul>
                  {visible.map((project) => (
                    <ProjectRow
                      key={project.id}
                      project={project}
                      recentScope={scope === "recent"}
                      onOpen={(target) => void open(target.path)}
                      handlers={handlers}
                    />
                  ))}
                  {storedVisible.length > 0 ? (
                    <li className="flex items-center gap-1.5 px-3 pt-2 text-2xs text-muted-foreground/70">
                      <CloudOff aria-hidden className="h-3 w-3" />
                      On your account, not on this machine
                    </li>
                  ) : null}
                  {storedVisible.map((project) => (
                    <SyncedProjectRow key={project.documentId} project={project} />
                  ))}
                </ul>
              )}

              {loading ? (
                <div className="flex items-center justify-center gap-2 py-10 text-2xs text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  Reading your projects…
                </div>
              ) : null}

              {listError ? (
                <p className="px-4 py-3 text-2xs leading-relaxed text-destructive">{listError}</p>
              ) : null}
            </div>
          )}
        </div>
      </div>

      <NewProjectDialog open={creating} onOpenChange={setCreating} onCreated={handleCreated} />
      <LearnDialog open={learning} onOpenChange={setLearning} />
      <EditProjectDialog
        project={editing}
        onOpenChange={(next) => (next ? undefined : setEditing(null))}
        onSaved={() => {
          setEditing(null);
          void loadProjects();
        }}
      />
      <DeleteProjectDialog
        project={deleting}
        onOpenChange={(next) => (next ? undefined : setDeleting(null))}
        onDeleted={() => {
          setDeleting(null);
          void loadProjects();
        }}
        onRemoved={() => {
          setDeleting(null);
          void loadProjects();
        }}
      />
    </div>
  );
}
